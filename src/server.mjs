import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

let supabaseUrl = process.env.SUPABASE_URL || '';
if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);
if (supabaseUrl.endsWith('/rest/v1')) supabaseUrl = supabaseUrl.replace('/rest/v1', '');
if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);

// Service-role client: trusted server-side operations (webhook upgrades, grading).
// RLS is bypassed with this key, which is why all writes below run through it.
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && serviceKey) ? createClient(supabaseUrl, serviceKey) : null;

// Anon client: used for Supabase Auth (sign-up / sign-in) on behalf of users.
const anonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseAuth = (supabaseUrl && anonKey) ? createClient(supabaseUrl, anonKey) : null;

// Canonical profile table. The live schema keys premium status on `account_tier`
// ('free' | 'premium') and links to the auth user via `user_id` (NOT `id`, which
// is the row's own gen_random_uuid). There is no `is_premium` column.
const PROFILE_TABLE = 'user_profiles';
const PROGRESS_TABLE = 'user_progress';
const FREE_TIER_CEILING = 100;

// Feature flag: when true, /api/questions serves only SME-approved content
// (status='published'). Default false keeps the demo working while the bank is
// still being authored/reviewed. Flip to 'true' on Render once a published set
// exists to retire the legacy 'unreviewed' filler from what students see.
const SERVE_PUBLISHED_ONLY = String(process.env.SERVE_PUBLISHED_ONLY || '').toLowerCase() === 'true';

// choices may be stored as a JSON string (text/jsonb-as-string) or a native array.
function parseChoices(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch (e) { return []; }
    }
    if (raw && typeof raw === 'object') return Array.isArray(raw) ? raw : [];
    return [];
}

// ---------------------------------------------------------------------------
// Stripe webhook — MUST be registered before express.json() so the raw body
// is available for signature verification. This is the ONLY webhook route.
// Point the Stripe dashboard at: POST /api/webhooks/stripe
// ---------------------------------------------------------------------------
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe || !webhookSecret) {
        console.error('Stripe or webhook secret not configured.');
        return res.status(500).send('Webhook configuration missing.');
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = (session.customer_details?.email || session.customer_email || '')
            .toLowerCase()
            .trim();

        console.log(`Checkout completed for: ${customerEmail}`);

        if (supabase && customerEmail) {
            try {
                // Match the profile by the email we recorded at registration, and
                // flip it to premium. We never INSERT here: user_profiles.user_id is
                // a FK to auth.users, so a fabricated row would violate the constraint.
                const { data, error } = await supabase
                    .from(PROFILE_TABLE)
                    .update({ account_tier: 'premium', premium_unlocked_at: new Date().toISOString() })
                    .eq('email', customerEmail)
                    .select('user_id');

                if (error) throw error;

                if (!data || data.length === 0) {
                    console.warn(`PAID-BUT-NO-PROFILE: ${customerEmail} paid but has no ${PROFILE_TABLE} row. Reconcile manually.`);
                } else {
                    console.log(`Upgraded ${customerEmail} to premium.`);
                }
            } catch (dbErr) {
                console.error(`Webhook DB sync error: ${dbErr.message}`);
                return res.status(500).send('Database sync failure.');
            }
        }
    }

    res.json({ received: true });
});

// ---------------------------------------------------------------------------
// Static-asset guard. express.static below is rooted at the project directory,
// which would otherwise serve source (server.mjs, *.mjs scripts), the answer
// bank (questions.json), and internal docs (AUDIT.md, BLUEPRINT.md) to anyone.
// Block those file types up front; only HTML/CSS/JS/images/fonts fall through.
// ---------------------------------------------------------------------------
const BLOCKED_STATIC = /\.(mjs|ts|tsx|json|md|rtf|lock|sh|ya?ml|env)$/i;
app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    if (p.startsWith('/api/')) return next();
    if (BLOCKED_STATIC.test(p) || p.startsWith('/data/') || p.startsWith('/.')) {
        return res.status(404).end();
    }
    next();
});

// ---------------------------------------------------------------------------
// JSON parsing + static assets for all normal routes
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

// ---------------------------------------------------------------------------
// Health/version check — lets you confirm at a glance which build is live
// (e.g. curl https://www.macprep.org/api/health). Bump `build` when deploying.
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'macprep',
        build: 'auth-grading-security',
        auth_endpoint: '/api/authenticate',
        supabase: !!supabase,
        serve_published_only: SERVE_PUBLISHED_ONLY,
        time: new Date().toISOString(),
    });
});

// ---------------------------------------------------------------------------
// Helper: verify a Supabase access token and return the user (or null).
// ---------------------------------------------------------------------------
async function getUserFromToken(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token || !supabaseAuth) return null;
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error) return null;
    return data.user || null;
}

// Helper: is this authenticated user premium? Keyed on user_id + account_tier.
async function isUserPremium(userId) {
    if (!supabase || !userId) return false;
    const { data } = await supabase
        .from(PROFILE_TABLE)
        .select('account_tier')
        .eq('user_id', userId)
        .maybeSingle();
    return data?.account_tier === 'premium';
}

// ---------------------------------------------------------------------------
// Auth — single real endpoint backed by Supabase Auth.
// Requires the Email provider to be enabled in Supabase Auth settings.
// ---------------------------------------------------------------------------
app.post('/api/authenticate', async (req, res) => {
    const { action } = req.body || {};
    const email = (req.body?.email || '').toLowerCase().trim();
    const password = req.body?.password || '';
    const name = req.body?.name || '';

    if (!supabaseAuth) return res.status(500).json({ success: false, error: 'Auth not configured.' });
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required.' });

    try {
        if (action === 'register') {
            const { data, error } = await supabaseAuth.auth.signUp({
                email,
                password,
                options: { data: { name } },
            });
            if (error) return res.status(400).json({ success: false, error: error.message });

            // Create the profile row so the payment webhook has a target to match
            // by email, and so premium status has somewhere to live.
            if (supabase && data.user) {
                await supabase
                    .from(PROFILE_TABLE)
                    .upsert({ user_id: data.user.id, email, account_tier: 'free' }, { onConflict: 'user_id' })
                    .then(({ error: pErr }) => { if (pErr) console.warn(`Profile create warning: ${pErr.message}`); });
            }

            return res.json({
                success: true,
                needsConfirmation: !data.session, // true when email confirmation is on
                profile: { email, premium_unlocked: false },
            });
        }

        // Default action: login
        const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ success: false, error: error.message });

        const isPremium = await isUserPremium(data.user?.id);

        return res.json({
            success: true,
            token: data.session?.access_token || null,
            profile: { email, premium_unlocked: isPremium },
        });
    } catch (err) {
        console.error('Auth error:', err.message);
        return res.status(500).json({ success: false, error: 'Authentication failure.' });
    }
});

// ---------------------------------------------------------------------------
// Questions — authenticated. Answers/explanations are NEVER sent here; grading
// happens server-side via /api/grade.
// ---------------------------------------------------------------------------
app.get('/api/questions', async (req, res) => {
    try {
        const user = await getUserFromToken(req);
        if (!user) return res.status(401).json({ error: 'Authentication required.', questions: [] });
        if (!supabase) return res.json({ questions: [] });

        let query = supabase
            .from('questions')
            .select('id, specialty, domain, domain_name, subtopic, stem, choices, telemetry');
        if (SERVE_PUBLISHED_ONLY) query = query.eq('status', 'published');
        const { data, error } = await query;
        if (error) throw error;

        // choices may be a JSON string or native array. Normalize, then strip any
        // correctness flags so answers never reach the client.
        const safe = (data || []).map((q) => ({
            ...q,
            choices: parseChoices(q.choices).map((c) => (typeof c === 'object' && c !== null
                ? { text: c.text ?? c.value ?? '' }
                : { text: c })),
        }));

        return res.json({ questions: safe });
    } catch (err) {
        console.error('Questions route failure:', err.message);
        return res.status(500).json({ error: 'Database communication failure', questions: [] });
    }
});

// ---------------------------------------------------------------------------
// Grade a single answer server-side. Authenticated. The free-tier ceiling is
// enforced from the server's own count of distinct questions the user has
// answered (user_progress) — never from a client-reported number.
// ---------------------------------------------------------------------------
app.post('/api/grade', async (req, res) => {
    const { questionId, choiceIndex } = req.body || {};
    if (!supabase) return res.status(500).json({ error: 'Database not configured.' });

    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });

    if (!questionId || choiceIndex === undefined) {
        return res.status(400).json({ error: 'questionId and choiceIndex are required.' });
    }

    try {
        const isPremium = await isUserPremium(user.id);

        // Enforce the free ceiling on distinct questions already answered. Re-answering
        // a question the user has already seen is always allowed (doesn't add to the
        // distinct count), so this can't be gamed by replaying the same item.
        if (!isPremium) {
            const { data: seen, error: seenErr } = await supabase
                .from(PROGRESS_TABLE)
                .select('question_id')
                .eq('user_id', user.id);
            if (seenErr) throw seenErr;

            const distinct = new Set((seen || []).map((r) => r.question_id));
            if (!distinct.has(String(questionId)) && distinct.size >= FREE_TIER_CEILING) {
                return res.status(402).json({ error: 'paywall', paywall: true });
            }
        }

        const { data: q, error } = await supabase
            .from('questions')
            .select('specialty, correct_answer, choices, explanation')
            .eq('id', questionId)
            .maybeSingle();
        if (error) throw error;
        if (!q) return res.status(404).json({ error: 'Question not found.' });

        // Resolve the correct index from choices[].correct, falling back to the
        // letter column ("A" -> 0).
        const choices = parseChoices(q.choices);
        let correctIndex = choices.findIndex((c) => c && typeof c === 'object' && c.correct === true);
        if (correctIndex < 0 && typeof q.correct_answer === 'string' && q.correct_answer.trim()) {
            correctIndex = q.correct_answer.trim().toUpperCase().charCodeAt(0) - 65;
        }

        const isCorrect = Number(choiceIndex) === correctIndex;

        // Record the attempt for progress + free-tier accounting (best-effort).
        await supabase.from(PROGRESS_TABLE).insert({
            user_id: user.id,
            question_id: String(questionId),
            specialty: q.specialty || null,
            selected_label: String.fromCharCode(65 + Number(choiceIndex)),
            is_correct: isCorrect,
        }).then(({ error: pErr }) => { if (pErr) console.warn(`Progress insert warning: ${pErr.message}`); });

        return res.json({
            correct: isCorrect,
            correctIndex,
            explanation: q.explanation || '',
        });
    } catch (err) {
        console.error('Grade route failure:', err.message);
        return res.status(500).json({ error: 'Grading failure.' });
    }
});

// ---------------------------------------------------------------------------
// Profile — identity is derived from the verified token, never from a
// client-supplied email (AUDIT.md §2.1).
// ---------------------------------------------------------------------------
app.get('/api/user/profile', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.json({ profile: null });

    try {
        const { data: profile, error } = await supabase
            .from(PROFILE_TABLE)
            .select('email, account_tier, premium_unlocked_at, created_at')
            .eq('user_id', user.id)
            .maybeSingle();
        if (error) throw error;

        // Derive simple study stats from recorded progress.
        const { data: progress } = await supabase
            .from(PROGRESS_TABLE)
            .select('question_id, is_correct')
            .eq('user_id', user.id);

        const answeredIds = new Set((progress || []).map((r) => r.question_id));
        const correct = (progress || []).filter((r) => r.is_correct).length;

        return res.json({
            profile: {
                email: profile?.email || user.email || null,
                premium_unlocked: profile?.account_tier === 'premium',
                premium_unlocked_at: profile?.premium_unlocked_at || null,
                stats: { answered: answeredIds.size, attempts: (progress || []).length, correct },
            },
        });
    } catch (err) {
        console.error('Profile route failure:', err.message);
        return res.status(500).json({ profile: null });
    }
});

// ---------------------------------------------------------------------------
// Stripe checkout session. Prefers the authenticated user's email so the
// webhook can match the resulting payment back to their profile.
// ---------------------------------------------------------------------------
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: 'Payments not configured.' });
        const priceId = process.env.STRIPE_PRODUCTION_PRICE_ID;
        if (!priceId) return res.status(500).json({ error: 'Price not configured.' });

        const user = await getUserFromToken(req);
        const email = (user?.email || req.body?.email || '').trim();
        if (!email) return res.status(400).json({ error: 'Missing user email.' });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: `${req.headers.origin}/?session_id={CHECKOUT_SESSION_ID}&status=success`,
            cancel_url: `${req.headers.origin}/?status=cancelled`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Checkout API failure:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Start server (all routes are declared above this line)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MACPrep server running on port ${PORT}`);
    console.log(`Supabase: ${supabase ? 'CONNECTED (service role)' : 'OFFLINE'} | Auth: ${supabaseAuth ? 'ready' : 'OFFLINE'}`);
});

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
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && serviceKey) ? createClient(supabaseUrl, serviceKey) : null;

// Anon client: used for Supabase Auth (sign-up / sign-in) on behalf of users.
const anonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseAuth = (supabaseUrl && anonKey) ? createClient(supabaseUrl, anonKey) : null;

// Canonical profile table. (Was previously the non-existent table "profiles".)
const PROFILE_TABLE = 'user_profiles';
const FREE_TIER_CEILING = 100;

// choices may be stored as a JSON string (text column) or a native JSONB array.
function parseChoices(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch (e) { return []; }
    }
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
                // Upgrade the existing profile row. We do NOT insert a new row here,
                // because user_profiles.id is a UUID tied to the auth user; inserting
                // a fabricated id would risk a foreign-key violation. If no row exists
                // yet, we log it for manual reconciliation rather than guess.
                const { data, error } = await supabase
                    .from(PROFILE_TABLE)
                    .update({ is_premium: true })
                    .eq('email', customerEmail)
                    .select('id');

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
// JSON parsing + static assets for all normal routes
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

// ---------------------------------------------------------------------------
// Auth — single real endpoint backed by Supabase Auth.
// Replaces the three dead paths (/api/auth/login, /api/auth/register, /api/authenticate).
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

            // Best-effort: create the profile row so future webhook upgrades have a target.
            if (supabase && data.user) {
                await supabase
                    .from(PROFILE_TABLE)
                    .upsert({ id: data.user.id, email, is_premium: false }, { onConflict: 'id' })
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

        let isPremium = false;
        if (supabase) {
            const { data: profile } = await supabase
                .from(PROFILE_TABLE)
                .select('is_premium')
                .eq('email', email)
                .maybeSingle();
            isPremium = !!profile?.is_premium;
        }

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

// ---------------------------------------------------------------------------
// Questions — answers and explanations are NEVER sent to the client here.
// Grading happens server-side via /api/grade.
// ---------------------------------------------------------------------------
app.get('/api/questions', async (req, res) => {
    try {
        if (!supabase) return res.json({ questions: [] });

        const { data, error } = await supabase
            .from('questions')
            .select('id, specialty, stem, choices, telemetry');
        if (error) throw error;

        // choices may be stored as a JSON string or a native array. Normalize,
        // then strip any correctness flags so answers never reach the client.
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

// Grade a single answer server-side. Returns correctness + explanation.
// Free users are limited to the first FREE_TIER_CEILING questions of a session
// (enforced via the answeredCount the client reports until full auth gating lands).
app.post('/api/grade', async (req, res) => {
    const { questionId, choiceIndex, answeredCount } = req.body || {};
    if (!supabase) return res.status(500).json({ error: 'Database not configured.' });
    if (!questionId || choiceIndex === undefined) {
        return res.status(400).json({ error: 'questionId and choiceIndex are required.' });
    }

    // Determine premium status (if a valid token is supplied).
    let isPremium = false;
    const user = await getUserFromToken(req);
    if (user && supabase) {
        const { data: profile } = await supabase
            .from(PROFILE_TABLE)
            .select('is_premium')
            .eq('id', user.id)
            .maybeSingle();
        isPremium = !!profile?.is_premium;
    }

    if (!isPremium && Number(answeredCount) >= FREE_TIER_CEILING) {
        return res.status(402).json({ error: 'paywall', paywall: true });
    }

    try {
        const { data: q, error } = await supabase
            .from('questions')
            .select('correct_answer, choices, explanation')
            .eq('id', questionId)
            .maybeSingle();
        if (error) throw error;
        if (!q) return res.status(404).json({ error: 'Question not found.' });

        // Resolve the correct index from either choices[].correct or the letter column.
        const choices = parseChoices(q.choices);
        let correctIndex = choices.findIndex((c) => c && typeof c === 'object' && c.correct === true);
        if (correctIndex < 0 && typeof q.correct_answer === 'string') {
            correctIndex = q.correct_answer.trim().toUpperCase().charCodeAt(0) - 65; // "A" -> 0
        }

        return res.json({
            correct: Number(choiceIndex) === correctIndex,
            correctIndex,
            explanation: q.explanation || '',
        });
    } catch (err) {
        console.error('Grade route failure:', err.message);
        return res.status(500).json({ error: 'Grading failure.' });
    }
});

// ---------------------------------------------------------------------------
// Profile — TODO(auth): these still trust a client-supplied email. They should
// derive identity from the Supabase token (getUserFromToken) before going to
// production. Left functional but flagged; see AUDIT.md §2.1.
// ---------------------------------------------------------------------------
app.get('/api/user/profile', async (req, res) => {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Missing account email.' });
    try {
        if (!supabase) return res.json({ profile: null });
        const { data, error } = await supabase
            .from(PROFILE_TABLE)
            .select('*')
            .eq('email', email)
            .maybeSingle();
        if (error) throw error;
        return res.json({ profile: data || null });
    } catch (err) {
        return res.json({ profile: null });
    }
});

app.post('/api/user/profile', async (req, res) => {
    // TODO(auth): authorize via token and ignore any client-supplied identity.
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });

    const { name, performance } = req.body || {};
    try {
        if (!supabase) return res.json({ success: true });
        const { error } = await supabase
            .from(PROFILE_TABLE)
            .update({
                name,
                progress_ledger: typeof performance === 'object' ? performance : undefined,
            })
            .eq('id', user.id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Stripe checkout session
// ---------------------------------------------------------------------------
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: 'Payments not configured.' });
        const email = (req.body?.email || '').trim();
        if (!email) return res.status(400).json({ error: 'Missing user email.' });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{ price: process.env.STRIPE_PRODUCTION_PRICE_ID, quantity: 1 }],
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

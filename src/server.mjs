import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Behind Render + Cloudflare; trust the proxy so req.ip reflects the real client
// (needed for rate limiting).
app.set('trust proxy', true);

// ---------------------------------------------------------------------------
// Security headers (helmet-equivalent, no extra dependency). frame-ancestors
// 'none' blocks clickjacking; nosniff blocks MIME sniffing; HSTS forces HTTPS.
// The CSP is intentionally permissive for inline styles/handlers the app uses,
// while still restricting object/base and locking the framing.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://browser.sentry-cdn.com https://js.sentry-cdn.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self' https://*.sentry.io https://*.ingest.sentry.io",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
    ].join('; '));
    next();
});

// ---------------------------------------------------------------------------
// Lightweight in-memory rate limiter (per-IP sliding window). Single Render
// instance, so a Map is sufficient; protects against password brute-forcing
// and feedback spam without a new dependency.
// ---------------------------------------------------------------------------
function rateLimit({ windowMs, max }) {
    const hits = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
        if (arr.length >= max) {
            res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
            return res.status(429).json({ error: 'Too many attempts. Please wait a moment and try again.' });
        }
        arr.push(now);
        hits.set(ip, arr);
        if (hits.size > 5000) { // crude memory bound
            for (const [k, v] of hits) { if (!v.some((t) => now - t < windowMs)) hits.delete(k); }
        }
        next();
    };
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const feedbackLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 8 });

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

// The legacy mass-generated bank is tagged status='unreviewed'. By default we do
// NOT serve it — students only ever see authored, journal-sourced content
// (status 'sme_review' or 'published'). Set SERVE_FILLER=true to temporarily
// include the legacy filler (not recommended; its answers are unreliable).
const SERVE_FILLER = String(process.env.SERVE_FILLER || '').toLowerCase() === 'true';
// Once enough questions are SME-approved, set SERVE_PUBLISHED_ONLY=true on Render
// so students see ONLY clinician-reviewed (status='published') content.
const SERVE_PUBLISHED_ONLY = String(process.env.SERVE_PUBLISHED_ONLY || '').toLowerCase() === 'true';
const SERVED_STATUSES = SERVE_PUBLISHED_ONLY ? ['published'] : ['sme_review', 'published'];
function applyServedFilter(query) {
    return SERVE_FILLER ? query : query.in('status', SERVED_STATUSES);
}

// Free users may access 10% of the *served* question bank. Computed from the
// live count and cached briefly so we don't COUNT on every grade.
const FREE_TIER_FRACTION = 0.10;
let _freeCeilingCache = { value: 50, at: 0 };
async function getFreeTierCeiling() {
    const now = Date.now();
    if (now - _freeCeilingCache.at < 5 * 60 * 1000) return _freeCeilingCache.value;
    if (!supabase) return _freeCeilingCache.value;
    try {
        const q = applyServedFilter(supabase.from('questions').select('id', { count: 'exact', head: true }));
        const { count } = await q;
        const ceiling = Math.max(1, Math.ceil((count || 0) * FREE_TIER_FRACTION));
        _freeCeilingCache = { value: ceiling, at: now };
        return ceiling;
    } catch (e) {
        return _freeCeilingCache.value;
    }
}

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
        // Prefer the authenticated user_id we attached at checkout (robust even if
        // the buyer pays with a different email than their account); fall back to
        // email matching for any legacy/Payment-Link purchases.
        const userId = session.client_reference_id || session.metadata?.user_id || null;
        const customerEmail = (session.customer_details?.email || session.customer_email || '')
            .toLowerCase()
            .trim();

        console.log(`Checkout completed: user_id=${userId || 'n/a'} email=${customerEmail || 'n/a'}`);

        if (supabase && (userId || customerEmail)) {
            try {
                const upgrade = { account_tier: 'premium', premium_unlocked_at: new Date().toISOString() };
                let data = null;
                if (userId) {
                    const r = await supabase.from(PROFILE_TABLE).update(upgrade).eq('user_id', userId).select('user_id');
                    if (r.error) throw r.error;
                    data = r.data;
                }
                if ((!data || data.length === 0) && customerEmail) {
                    const r = await supabase.from(PROFILE_TABLE).update(upgrade).eq('email', customerEmail).select('user_id');
                    if (r.error) throw r.error;
                    data = r.data;
                }
                if (!data || data.length === 0) {
                    console.warn(`PAID-BUT-NO-PROFILE: user_id=${userId} email=${customerEmail} paid but no ${PROFILE_TABLE} row matched. Reconcile manually.`);
                } else {
                    console.log(`Upgraded ${data[0].user_id} to premium.`);
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
        serve_filler: SERVE_FILLER,
        monitoring: !!process.env.SENTRY_BROWSER_DSN,
        time: new Date().toISOString(),
    });
});

// Public client config — lets the frontend self-configure error monitoring
// without hardcoding a DSN. Set SENTRY_BROWSER_DSN on Render to turn it on.
// (Browser Sentry DSNs are public by design.)
app.get('/api/config', (req, res) => {
    res.json({
        sentryDsn: process.env.SENTRY_BROWSER_DSN || null,
        environment: process.env.NODE_ENV || 'production',
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

// Returns the authenticated user only if they are an admin (program director).
async function getAdminUser(req) {
    const user = await getUserFromToken(req);
    if (!user || !supabase) return null;
    const { data } = await supabase.from(PROFILE_TABLE).select('is_program_director').eq('user_id', user.id).maybeSingle();
    return data?.is_program_director ? user : null;
}

// ---------------------------------------------------------------------------
// Auth — single real endpoint backed by Supabase Auth.
// Requires the Email provider to be enabled in Supabase Auth settings.
// ---------------------------------------------------------------------------
app.post('/api/authenticate', authLimiter, async (req, res) => {
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
            refresh_token: data.session?.refresh_token || null,
            profile: { email, premium_unlocked: isPremium },
        });
    } catch (err) {
        console.error('Auth error:', err.message);
        return res.status(500).json({ success: false, error: 'Authentication failure.' });
    }
});

// Exchange a refresh token for a fresh access token so a study session survives
// the 1-hour access-token TTL instead of abruptly logging the user out.
app.post('/api/auth/refresh', async (req, res) => {
    const refresh_token = req.body?.refresh_token;
    if (!supabaseAuth || !refresh_token) return res.status(400).json({ error: 'Missing refresh token.' });
    try {
        const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });
        if (error || !data.session) return res.status(401).json({ error: 'Could not refresh session.' });
        return res.json({ token: data.session.access_token, refresh_token: data.session.refresh_token });
    } catch (err) {
        return res.status(401).json({ error: 'Could not refresh session.' });
    }
});

// Send a password-reset email (Supabase recovery link → /reset.html).
app.post('/api/auth/reset-request', authLimiter, async (req, res) => {
    const email = (req.body?.email || '').toLowerCase().trim();
    if (!supabaseAuth || !email) return res.status(400).json({ error: 'Email is required.' });
    const base = req.headers.origin || process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
    try {
        await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo: `${base.replace(/\/$/, '')}/reset.html` });
    } catch (err) { /* do not reveal whether the email exists */ }
    // Always return success to avoid email enumeration.
    return res.json({ success: true });
});

// Set a new password. Accepts the recovery access token from the reset email
// (sent to /reset.html as a URL hash) and updates the resolved user's password
// via the service-role admin API.
app.post('/api/auth/update-password', authLimiter, async (req, res) => {
    const access_token = req.body?.access_token;
    const new_password = req.body?.new_password || '';
    if (!supabase || !supabaseAuth) return res.status(500).json({ error: 'Not configured.' });
    if (!access_token || new_password.length < 8) {
        return res.status(400).json({ error: 'A valid reset link and an 8+ character password are required.' });
    }
    try {
        const { data, error } = await supabaseAuth.auth.getUser(access_token);
        if (error || !data.user) return res.status(401).json({ error: 'Reset link is invalid or expired.' });
        const { error: upErr } = await supabase.auth.admin.updateUserById(data.user.id, { password: new_password });
        if (upErr) throw upErr;
        return res.json({ success: true });
    } catch (err) {
        console.error('Password update failure:', err.message);
        return res.status(500).json({ error: 'Could not update password.' });
    }
});

// Change password for a signed-in user (requires their current session token).
app.post('/api/user/change-password', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    const new_password = req.body?.new_password || '';
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
        const { error } = await supabase.auth.admin.updateUserById(user.id, { password: new_password });
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Could not change password.' });
    }
});

// Delete the signed-in user's account and all associated data (GDPR/privacy).
app.post('/api/user/delete', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    try {
        await supabase.from(PROGRESS_TABLE).delete().eq('user_id', user.id);
        await supabase.from(PROFILE_TABLE).delete().eq('user_id', user.id);
        await supabase.from('user_flags').delete().eq('user_id', user.id).then(() => {}, () => {});
        const { error } = await supabase.auth.admin.deleteUser(user.id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        console.error('Account deletion failure:', err.message);
        return res.status(500).json({ error: 'Could not delete account.' });
    }
});

// ---------------------------------------------------------------------------
// Admin content review queue (program directors / SMEs only). Returns full
// questions INCLUDING correct flags so a clinician can vet and publish them.
// ---------------------------------------------------------------------------
app.get('/api/admin/questions', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    const status = (req.query.status || 'sme_review').toString();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    try {
        const { data, error } = await supabase
            .from('questions')
            .select('id, category, domain_name, subtopic, difficulty, stem, choices, correct_answer, explanation, "references", status')
            .eq('status', status)
            .order('id', { ascending: true })
            .limit(limit);
        if (error) throw error;
        const out = (data || []).map((q) => ({ ...q, choices: parseChoices(q.choices) }));
        // counts by status for the queue header
        const counts = {};
        for (const st of ['sme_review', 'published', 'rejected', 'draft', 'unreviewed']) {
            const { count } = await supabase.from('questions').select('id', { count: 'exact', head: true }).eq('status', st);
            counts[st] = count || 0;
        }
        return res.json({ questions: out, counts });
    } catch (err) {
        console.error('Admin list failure:', err.message);
        return res.status(500).json({ error: 'Could not load questions.' });
    }
});

// Update a question's status and/or edit its content (admin only).
app.post('/api/admin/question', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    const b = req.body || {};
    const id = String(b.id || '');
    if (!id) return res.status(400).json({ error: 'id required.' });
    const update = {};
    if (b.status && ['sme_review', 'published', 'rejected', 'draft'].includes(b.status)) update.status = b.status;
    for (const f of ['stem', 'explanation', 'correct_answer']) {
        if (typeof b[f] === 'string') update[f] = b[f];
    }
    if (Array.isArray(b.choices)) update.choices = b.choices;
    if (Array.isArray(b.references)) update.references = b.references;
    if (b.status === 'published') update.reviewed_by = admin.id;
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    try {
        const { error } = await supabase.from('questions').update(update).eq('id', id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        console.error('Admin update failure:', err.message);
        return res.status(500).json({ error: 'Could not update question.' });
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

        // PostgREST caps each request at ~1000 rows, so page through the full
        // bank (3,500+ items) instead of silently truncating it.
        const PAGE = 1000;
        let data = [];
        for (let from = 0; ; from += PAGE) {
            let query = supabase
                .from('questions')
                .select('id, specialty, domain, domain_name, subtopic, category, difficulty, stem, choices, telemetry')
                .order('id', { ascending: true })
                .range(from, from + PAGE - 1);
            query = applyServedFilter(query);
            const { data: page, error } = await query;
            if (error) throw error;
            data = data.concat(page || []);
            if (!page || page.length < PAGE) break;
        }

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
            const ceiling = await getFreeTierCeiling();
            const { data: seen, error: seenErr } = await supabase
                .from(PROGRESS_TABLE)
                .select('question_id')
                .eq('user_id', user.id);
            if (seenErr) throw seenErr;

            const distinct = new Set((seen || []).map((r) => r.question_id));
            if (!distinct.has(String(questionId)) && distinct.size >= ceiling) {
                return res.status(402).json({ error: 'paywall', paywall: true, limit: ceiling });
            }
        }

        const { data: q, error } = await supabase
            .from('questions')
            .select('specialty, category, correct_answer, choices, explanation, "references"')
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
        const confidence = ['low', 'medium', 'high'].includes(req.body?.confidence) ? req.body.confidence : null;

        // Record the attempt for progress + free-tier accounting (best-effort).
        await supabase.from(PROGRESS_TABLE).insert({
            user_id: user.id,
            question_id: String(questionId),
            specialty: q.specialty || null,
            category: q.category || null,
            selected_label: String.fromCharCode(65 + Number(choiceIndex)),
            is_correct: isCorrect,
            confidence,
        }).then(({ error: pErr }) => { if (pErr) console.warn(`Progress insert warning: ${pErr.message}`); });

        // Peer stats: % of all attempts on this question that were correct.
        let peerPct = null;
        try {
            const { data: rows } = await supabase.from(PROGRESS_TABLE).select('is_correct').eq('question_id', String(questionId));
            if (rows && rows.length >= 3) peerPct = Math.round((rows.filter((r) => r.is_correct).length / rows.length) * 100);
        } catch (e) { /* peer stats best-effort */ }

        // Per-choice rationale (so the client can show why each option is right/wrong)
        // and the source references (journal links). Never reveal the `correct`
        // flag positions until after the answer — but at grade time it's fine.
        const rationales = choices.map((c) => (c && typeof c === 'object' ? (c.rationale || '') : ''));
        let references = q.references;
        if (typeof references === 'string') { try { references = JSON.parse(references); } catch (e) { references = []; } }
        if (!Array.isArray(references)) references = [];

        return res.json({
            correct: isCorrect,
            correctIndex,
            explanation: q.explanation || '',
            rationales,
            references,
            peer_correct_pct: peerPct,
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
            .select('email, account_tier, premium_unlocked_at, created_at, is_program_director, full_name, credential, training_program, target_exam_date, phone')
            .eq('user_id', user.id)
            .maybeSingle();
        if (error) throw error;

        // Derive study stats from recorded progress, including accuracy by specialty.
        const { data: progress } = await supabase
            .from(PROGRESS_TABLE)
            .select('question_id, is_correct, category, created_at')
            .eq('user_id', user.id);

        const answeredIds = new Set((progress || []).map((r) => r.question_id));
        const correct = (progress || []).filter((r) => r.is_correct).length;
        const ceiling = await getFreeTierCeiling();

        // Missed question ids = answered incorrectly and never since gotten right.
        const everCorrect = new Set((progress || []).filter((r) => r.is_correct).map((r) => r.question_id));
        const missed_ids = Array.from(new Set((progress || [])
            .filter((r) => !r.is_correct && !everCorrect.has(r.question_id))
            .map((r) => r.question_id)));

        const { data: flags } = await supabase.from('user_flags').select('question_id').eq('user_id', user.id);
        const flagged_ids = (flags || []).map((f) => f.question_id);

        // Per-specialty (category) accuracy from attempts.
        const byCat = {};
        (progress || []).forEach((r) => {
            const c = r.category || 'Uncategorized';
            byCat[c] = byCat[c] || { attempts: 0, correct: 0 };
            byCat[c].attempts++;
            if (r.is_correct) byCat[c].correct++;
        });
        const by_specialty = Object.entries(byCat)
            .map(([category, v]) => ({ category, attempts: v.attempts, correct: v.correct, accuracy: Math.round((v.correct / v.attempts) * 100) }))
            .sort((a, b) => b.attempts - a.attempts);

        // Coverage: distinct answered vs total served per category.
        const { data: bankRows } = await applyServedFilter(supabase.from('questions').select('category'));
        const bankTotal = {};
        (bankRows || []).forEach((r) => { const c = r.category || 'Uncategorized'; bankTotal[c] = (bankTotal[c] || 0) + 1; });
        const answeredByCat = {};
        (progress || []).forEach((r) => {
            const c = r.category || 'Uncategorized';
            (answeredByCat[c] = answeredByCat[c] || new Set()).add(r.question_id);
        });
        const coverage = Object.keys(bankTotal).map((c) => ({
            category: c, total: bankTotal[c], answered: (answeredByCat[c] ? answeredByCat[c].size : 0),
        })).sort((a, b) => b.total - a.total);

        // Study streak: consecutive days (ending today or yesterday) with activity.
        const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
        const activeDays = new Set((progress || []).map((r) => dayKey(r.created_at)));
        let streak = 0;
        const today = new Date();
        for (let i = 0; i < 365; i++) {
            const d = new Date(today.getTime() - i * 86400000);
            if (activeDays.has(dayKey(d))) streak++;
            else if (i === 0) continue; // today not yet studied — keep counting from yesterday
            else break;
        }

        // Accuracy trend: last 7 active days.
        const byDay = {};
        (progress || []).forEach((r) => { const k = dayKey(r.created_at); (byDay[k] = byDay[k] || { a: 0, c: 0 }); byDay[k].a++; if (r.is_correct) byDay[k].c++; });
        const trend = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-7)
            .map(([day, v]) => ({ day, accuracy: Math.round((v.c / v.a) * 100), attempts: v.a }));

        // Readiness estimate: overall accuracy scaled by how much of the bank seen.
        const totalServed = (bankRows || []).length || 1;
        const seenFrac = Math.min(1, answeredIds.size / totalServed);
        const overallAcc = (progress || []).length ? correct / (progress || []).length : 0;
        const readiness = Math.round(overallAcc * 100 * (0.5 + 0.5 * seenFrac));
        let days_to_exam = null;
        if (profile?.target_exam_date) {
            days_to_exam = Math.ceil((new Date(profile.target_exam_date) - today) / 86400000);
        }

        return res.json({
            profile: {
                email: profile?.email || user.email || null,
                premium_unlocked: profile?.account_tier === 'premium',
                premium_unlocked_at: profile?.premium_unlocked_at || null,
                is_admin: !!profile?.is_program_director,
                full_name: profile?.full_name || '',
                credential: profile?.credential || '',
                training_program: profile?.training_program || '',
                target_exam_date: profile?.target_exam_date || '',
                phone: profile?.phone || '',
                free_tier_limit: ceiling,
                stats: { answered: answeredIds.size, attempts: (progress || []).length, correct },
                by_specialty,
                coverage,
                streak,
                trend,
                readiness,
                days_to_exam,
                missed_ids,
                flagged_ids,
                answered_ids: Array.from(answeredIds),
            },
        });
    } catch (err) {
        console.error('Profile route failure:', err.message);
        return res.status(500).json({ profile: null });
    }
});

// Update the authenticated user's personal profile fields. Premium status and
// admin flags are NOT writable here — only the user's own descriptive info.
app.post('/api/user/profile', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Database not configured.' });

    const b = req.body || {};
    const update = {};
    for (const f of ['full_name', 'credential', 'training_program', 'phone']) {
        if (typeof b[f] === 'string') update[f] = b[f].slice(0, 200);
    }
    if (b.target_exam_date === '' || b.target_exam_date === null) update.target_exam_date = null;
    else if (typeof b.target_exam_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.target_exam_date)) {
        update.target_exam_date = b.target_exam_date;
    }
    update.updated_at = new Date().toISOString();

    try {
        const { error } = await supabase.from(PROFILE_TABLE).update(update).eq('user_id', user.id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        console.error('Profile update failure:', err.message);
        return res.status(500).json({ error: 'Could not save profile.' });
    }
});

// ---------------------------------------------------------------------------
// Feedback — suggestions / bug reports. Stored in user_suggestions. Auth optional
// (signed-in users have their email attached automatically).
// ---------------------------------------------------------------------------
// Flag / unflag a question for later review.
app.post('/api/user/flag', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    const questionId = String(req.body?.questionId || '');
    const flagged = req.body?.flagged !== false;
    if (!questionId) return res.status(400).json({ error: 'questionId required.' });
    try {
        if (flagged) {
            await supabase.from('user_flags').upsert({ user_id: user.id, question_id: questionId }, { onConflict: 'user_id,question_id' });
        } else {
            await supabase.from('user_flags').delete().eq('user_id', user.id).eq('question_id', questionId);
        }
        return res.json({ success: true, flagged });
    } catch (err) {
        return res.status(500).json({ error: 'Could not update flag.' });
    }
});

// Per-question personal notes.
app.get('/api/user/note', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    const questionId = String(req.query.questionId || '');
    if (!questionId) return res.status(400).json({ error: 'questionId required.' });
    const { data } = await supabase.from('user_notes').select('note').eq('user_id', user.id).eq('question_id', questionId).maybeSingle();
    return res.json({ note: data?.note || '' });
});

app.post('/api/user/note', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    const questionId = String(req.body?.questionId || '');
    const note = (req.body?.note || '').toString().slice(0, 5000);
    if (!questionId) return res.status(400).json({ error: 'questionId required.' });
    try {
        if (note.trim() === '') {
            await supabase.from('user_notes').delete().eq('user_id', user.id).eq('question_id', questionId);
        } else {
            await supabase.from('user_notes').upsert({ user_id: user.id, question_id: questionId, note, updated_at: new Date().toISOString() }, { onConflict: 'user_id,question_id' });
        }
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Could not save note.' });
    }
});

app.post('/api/feedback', feedbackLimiter, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const user = await getUserFromToken(req);
    const kind = (req.body?.kind || 'suggestion').toString().slice(0, 40);
    const message = (req.body?.message || '').toString().trim();
    if (!message) return res.status(400).json({ error: 'A message is required.' });
    const email = (user?.email || req.body?.email || 'anonymous').toString().slice(0, 200);
    try {
        const { error } = await supabase.from('user_suggestions').insert({
            user_email: email,
            suggestion_text: `[${kind}] ${message}`.slice(0, 4000),
        });
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        console.error('Feedback insert failure:', err.message);
        return res.status(500).json({ error: 'Could not submit feedback.' });
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

        // Build an absolute base URL. Prefer the Origin header, then a configured
        // PUBLIC_BASE_URL, then the Host header — so checkout works even when the
        // request carries no Origin (Stripe requires absolute success/cancel URLs).
        let base = req.headers.origin || process.env.PUBLIC_BASE_URL || '';
        if (!base && req.headers.host) base = `https://${req.headers.host}`;
        base = base.replace(/\/$/, '');

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            // Attach the authenticated user so the webhook can match the payment by
            // id, not just email (robust if the buyer's Stripe email differs).
            ...(user ? { client_reference_id: user.id, metadata: { user_id: user.id } } : {}),
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: `${base}/?session_id={CHECKOUT_SESSION_ID}&status=success`,
            cancel_url: `${base}/?status=cancelled`,
        });

        res.json({ url: session.url });
    } catch (err) {
        console.error('Checkout API failure:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Friendly 404 for anything not matched above (API or unknown page). API gets
// JSON; everything else gets the branded 404 page.
// ---------------------------------------------------------------------------
app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
    res.status(404).sendFile(path.join(__dirname, '../404.html'), (err) => {
        if (err) res.status(404).send('Not found.');
    });
});

// Express error handler — logs (visible in Render logs / observability) and
// returns a clean JSON error instead of leaking a stack trace to the client.
app.use((err, req, res, next) => {
    console.error('Unhandled route error:', err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Something went wrong.' });
});

// Surface crashes in logs rather than dying silently.
process.on('unhandledRejection', (reason) => console.error('UnhandledRejection:', reason));
process.on('uncaughtException', (err) => console.error('UncaughtException:', err && err.stack ? err.stack : err));

// ---------------------------------------------------------------------------
// Start server (all routes are declared above this line)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MACPrep server running on port ${PORT}`);
    console.log(`Supabase: ${supabase ? 'CONNECTED (service role)' : 'OFFLINE'} | Auth: ${supabaseAuth ? 'ready' : 'OFFLINE'}`);
});

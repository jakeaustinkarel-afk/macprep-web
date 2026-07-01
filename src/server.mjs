// Sentry.init() must run BEFORE express/http are imported (Sentry v8+ uses
// OpenTelemetry auto-instrumentation set up at init), so this side-effect import
// is first. Server-side error monitoring is dormant until SENTRY_DSN is set.
import './instrument.mjs';
import express from 'express';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { randomBytes, createHmac, createHash } from 'crypto';
import * as Sentry from '@sentry/node';

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
// Gzip all responses (notably the large /api/questions JSON) to cut bandwidth
// and first-load time, especially on mobile.
app.use(compression());

app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
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
        // Cloudflare fronts Render and sets CF-Connecting-IP to the true client IP
        // (overwriting any client-supplied value), so it can't be spoofed the way a
        // raw X-Forwarded-For prepend can. Fall back to the proxy-resolved req.ip —
        // never the raw header.
        const ip = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
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
const voucherLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const eventLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
const demoLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });
// Checkout + payment-verification: generous enough for real buyers, tight enough
// to stop anyone hammering Stripe session creation or replaying session-id guesses.
const checkoutLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

// Allowlist of hosts we will build absolute URLs for (password-reset links,
// Stripe success/cancel). Prevents host-header injection from pointing those
// URLs at an attacker-controlled domain. Override via ALLOWED_HOSTS env.
const ALLOWED_HOSTS = new Set(
    (process.env.ALLOWED_HOSTS || 'macprep.org,www.macprep.org,localhost:3000')
        .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
);
function hostOf(u) { try { return new URL(u).host.toLowerCase(); } catch (e) { return ''; } }
function safeBaseUrl(req) {
    const canonical = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const origin = req.headers.origin;
    if (origin && ALLOWED_HOSTS.has(hostOf(origin))) return origin.replace(/\/$/, '');
    if (canonical) return canonical;
    const host = (req.headers.host || '').toLowerCase();
    if (ALLOWED_HOSTS.has(host)) return `https://${host}`;
    return 'https://www.macprep.org';
}
// Decode a Supabase JWT's auth-method references (amr) WITHOUT verifying the
// signature — used only to distinguish a recovery session from a normal login.
function tokenAuthMethods(jwt) {
    try {
        const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
        return Array.isArray(payload.amr) ? payload.amr.map((a) => (a && a.method) || '').filter(Boolean) : [];
    } catch (e) { return []; }
}

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

// --- Fail fast on missing/incorrect critical config -----------------------
// In production a missing key silently degrades (checkout 500s, grading returns
// empty) or — worse — a Stripe TEST key lets real customers "pay" in test mode
// with no charge. Refuse to boot instead of failing quietly.
const IS_PROD = process.env.NODE_ENV === 'production';
if (IS_PROD) {
    const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRODUCTION_PRICE_ID',
        'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
        .filter((k) => !process.env[k]);
    if (missing.length) {
        console.error(`FATAL: missing required env in production: ${missing.join(', ')}`);
        process.exit(1);
    }
    if (process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
        console.error('FATAL: STRIPE_SECRET_KEY is a Stripe TEST key (sk_test_) in production — refusing to start so real customers are not charged in test mode.');
        process.exit(1);
    }
} else if ((process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')) {
    console.warn('[config] Using a Stripe TEST key — fine for dev; must be a live key in production.');
}

// Canonical profile table. The live schema keys premium status on `account_tier`
// ('free' | 'premium') and links to the auth user via `user_id` (NOT `id`, which
// is the row's own gen_random_uuid). There is no `is_premium` column.
const PROFILE_TABLE = 'user_profiles';

// Site admin is an explicit allowlist of account emails — the OWNER only. This is
// deliberately decoupled from the `is_program_director` profile flag: a program
// director is a paying customer persona (cohort licenses), NOT a site admin, and
// must never inherit the review queue, metrics dashboard, or voucher generation.
// Override/extend via the ADMIN_EMAILS env (comma-separated); defaults to the owner.
const ADMIN_EMAILS = new Set(
    (process.env.ADMIN_EMAILS || 'jakeaustin.karel@gmail.com')
        .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const isAdminEmail = (email) => ADMIN_EMAILS.has(String(email || '').trim().toLowerCase());
const PROGRESS_TABLE = 'user_progress';

// The legacy mass-generated bank is tagged status='unreviewed'. By default we do
// NOT serve it — students only ever see authored, journal-sourced content
// (status 'sme_review' or 'published'). Set SERVE_FILLER=true to temporarily
// include the legacy filler (not recommended; its answers are unreliable).
const SERVE_FILLER = String(process.env.SERVE_FILLER || '').toLowerCase() === 'true';
// The public sees ONLY clinician-approved (status='published') questions by default.
// Questions awaiting the CAA's sign-off (status='sme_review') are NOT served. For a
// dev/preview environment that wants to see pending content too, set
// SERVE_PUBLISHED_ONLY=false.
const SERVE_PUBLISHED_ONLY = String(process.env.SERVE_PUBLISHED_ONLY ?? 'true').toLowerCase() !== 'false';
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

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object;
        // Only unlock once the payment has actually settled. Async payment methods can
        // fire 'completed' while still 'unpaid' — never grant premium in that state.
        if (session.payment_status && session.payment_status !== 'paid') {
            console.log(`Checkout completed but payment_status=${session.payment_status}; deferring unlock.`);
            return res.json({ received: true });
        }
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
                    // Auto-reconcile: nothing matched, but we have the verified buyer id
                    // from checkout — upsert their profile so a paid user is never left
                    // without access.
                    if (userId) {
                        const up = { user_id: userId, ...upgrade };
                        if (customerEmail) up.email = customerEmail;
                        const r = await supabase.from(PROFILE_TABLE).upsert(up, { onConflict: 'user_id' }).select('user_id');
                        if (r.error) throw r.error;
                        console.log(`Reconciled + upgraded ${userId} to premium (no prior profile row).`);
                    } else {
                        console.warn(`PAID-BUT-NO-PROFILE: email=${customerEmail} paid but no ${PROFILE_TABLE} row and no user_id to reconcile.`);
                    }
                } else {
                    console.log(`Upgraded ${data[0].user_id} to premium.`);
                }
                // Funnel analytics: record the purchase server-side (fire-and-forget).
                const grantedUser = (data && data[0] && data[0].user_id) || userId;
                if (grantedUser) {
                    supabase.from('analytics_events').insert({ name: 'purchase', user_id: grantedUser, meta: { via: 'stripe' } }).then(() => {}, () => {});
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
// Note: .txt is intentionally NOT blocked so /robots.txt is served. Answer-key
// generators (.sql/.cjs/.cts/.mts) and the whole seeds/ dir are blocked outright.
const BLOCKED_STATIC = /\.(mjs|cjs|cts|mts|ts|tsx|json|md|rtf|lock|sh|ya?ml|env|sql|pdf|csv|xlsx?|docx?|pem|key|crt|cer|p12|pfx)$/i;
app.use((req, res, next) => {
    const p = req.path.toLowerCase();
    if (p.startsWith('/api/')) return next();
    if (BLOCKED_STATIC.test(p) || p.startsWith('/data/') || p.startsWith('/seeds/') || p.startsWith('/.')) {
        return res.status(404).end();
    }
    next();
});

// ---------------------------------------------------------------------------
// JSON parsing + static assets for all normal routes
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, '../'), {
    etag: true,
    setHeaders: (res, filePath) => {
        if (/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf)$/i.test(filePath)) {
            // Images/fonts rarely change — cache hard.
            res.setHeader('Cache-Control', 'public, max-age=2592000');
        } else if (/\.(html|js|css)$/i.test(filePath)) {
            // Markup/code must stay fresh across deploys — revalidate via etag each load.
            res.setHeader('Cache-Control', 'no-cache');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
    },
}));

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

// Public live count of published questions — powers the landing "X+ questions
// and growing" counter. Cached 10 min.
let _statsCache = { at: 0, published: 0, users: 0 };
app.get('/api/stats', async (req, res) => {
    try {
        if (supabase && Date.now() - _statsCache.at > 10 * 60 * 1000) {
            const [{ count }, { count: users }] = await Promise.all([
                supabase.from('questions').select('id', { count: 'exact', head: true }).eq('status', 'published'),
                supabase.from(PROFILE_TABLE).select('id', { count: 'exact', head: true }),
            ]);
            _statsCache = {
                at: Date.now(),
                published: typeof count === 'number' ? count : _statsCache.published,
                users: typeof users === 'number' ? users : _statsCache.users,
            };
        }
    } catch (e) { /* serve cached value */ }
    res.json({ published: _statsCache.published, users: _statsCache.users });
});

// ---------------------------------------------------------------------------
// Retention: daily "come back and study" reminder emails (via Resend). Dormant
// unless RESEND_API_KEY is set. Targets users with spaced-repetition questions
// due, skips anyone who studied in the last 18h, throttles to once/~20h each,
// and includes a one-click unsubscribe (CAN-SPAM).
// ---------------------------------------------------------------------------
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'MACPrep <noreply@macprep.org>';
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://www.macprep.org').replace(/\/+$/, '');
const MAILING_ADDRESS = process.env.MAILING_ADDRESS || 'MACPrep LLC · Roswell, GA, USA';
const NUDGE_SECRET = serviceKey ? createHash('sha256').update(serviceKey + '|nudge-unsub').digest('hex') : 'dev-nudge-secret';
function unsubToken(userId) { return createHmac('sha256', NUDGE_SECRET).update(String(userId)).digest('hex').slice(0, 32); }
function unsubLink(userId) { return `${BASE_URL}/api/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubToken(userId)}`; }
function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function sendEmail({ to, subject, html }) {
    if (!RESEND_API_KEY) return { skipped: true };
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r.json();
}

function nudgeEmailHtml({ name, dueCount, unsubUrl }) {
    const hi = name ? `Hi ${escHtml(String(name).split(' ')[0])},` : 'Hi there,';
    const qword = dueCount === 1 ? 'question' : 'questions';
    return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;max-width:480px;width:100%;">
      <tr><td style="background:#0D0E10;padding:20px 28px;">
        <span style="font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:800;letter-spacing:-1px;color:#F9FAFB;">MAC<span style="color:#00A86B;">Prep</span></span>
      </td></tr>
      <tr><td style="padding:32px 28px;">
        <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 6px;">${hi}</p>
        <h1 style="font-size:21px;color:#111827;margin:0 0 12px;">You have ${dueCount} ${qword} due for review 🔥</h1>
        <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 24px;">A few minutes of spaced review today locks these in right before your brain would forget them. Keep the momentum going.</p>
        <a href="${BASE_URL}/" style="display:inline-block;background:#00A86B;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:6px;">Resume studying →</a>
      </td></tr>
      <tr><td style="background:#fafafa;border-top:1px solid #e5e7eb;padding:16px 28px;">
        <p style="font-size:12px;color:#9ca3af;margin:0 0 6px;">MACPrep · NCCAA board review · <a href="${BASE_URL}" style="color:#00A86B;text-decoration:none;">macprep.org</a></p>
        <p style="font-size:11px;color:#9ca3af;margin:0;">${escHtml(MAILING_ADDRESS)} · <a href="${escHtml(unsubUrl)}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe from study reminders</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

async function sendRetentionNudges(opts) {
    opts = opts || {};
    if (!supabase) return { error: 'no db' };
    if (!RESEND_API_KEY && !opts.dry) return { error: 'RESEND_API_KEY not set' };
    const nowIso = new Date().toISOString();
    const { data: due } = await supabase.from('review_state').select('user_id').lte('due_at', nowIso).limit(20000);
    const counts = {};
    (due || []).forEach((r) => { counts[r.user_id] = (counts[r.user_id] || 0) + 1; });
    const userIds = Object.keys(counts);
    if (!userIds.length) return { sent: 0, candidates: 0 };
    const activeCutoff = new Date(Date.now() - 18 * 3600 * 1000).toISOString();
    const { data: active } = await supabase.from(PROGRESS_TABLE).select('user_id').gte('created_at', activeCutoff).limit(20000);
    const activeSet = new Set((active || []).map((r) => r.user_id));
    const { data: profiles } = await supabase.from(PROFILE_TABLE)
        .select('user_id, email, full_name, last_nudged_at, nudge_opt_out')
        .in('user_id', userIds.slice(0, 1000));
    const throttle = Date.now() - 20 * 3600 * 1000;
    let sent = 0, eligible = 0;
    for (const p of (profiles || [])) {
        if (!p.email || p.nudge_opt_out) continue;
        if (activeSet.has(p.user_id)) continue;
        if (p.last_nudged_at && new Date(p.last_nudged_at).getTime() > throttle) continue;
        eligible++;
        if (opts.dry) continue;
        try {
            const n = counts[p.user_id];
            await sendEmail({ to: p.email, subject: `${n} ${n === 1 ? 'question' : 'questions'} due for review on MACPrep`, html: nudgeEmailHtml({ name: p.full_name, dueCount: n, unsubUrl: unsubLink(p.user_id) }) });
            await supabase.from(PROFILE_TABLE).update({ last_nudged_at: nowIso }).eq('user_id', p.user_id);
            sent++;
        } catch (e) { console.error('[nudges] send failed:', p.user_id, e.message); }
    }
    return { sent, eligible, candidates: userIds.length };
}

// One-click unsubscribe (token-signed, no login needed).
app.get('/api/unsubscribe', async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const u = req.query.u, t = req.query.t;
    const page = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MACPrep</title><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;"><div style="text-align:center;max-width:420px;padding:32px;"><div style="font-family:ui-monospace,monospace;font-size:24px;font-weight:800;">MAC<span style="color:#047857;">Prep</span></div><p style="font-size:16px;line-height:1.6;margin-top:18px;">${msg}</p><a href="${BASE_URL}/" style="color:#047857;">Back to MACPrep</a></div></body>`;
    if (!u || !t || !supabase || t !== unsubToken(u)) return res.status(400).send(page('This unsubscribe link is invalid or expired.'));
    try { await supabase.from(PROFILE_TABLE).update({ nudge_opt_out: true }).eq('user_id', u); } catch (e) {}
    res.send(page("You've been unsubscribed from study reminders. Email support@macprep.org if you'd like them back on."));
});

// Admin-only manual trigger for testing. { testTo:"you@x.com" } sends one sample
// reminder there; { dry:true } counts who would get one without sending.
app.post('/api/admin/run-nudges', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Forbidden' });
    try {
        if (req.body?.testTo) {
            await sendEmail({ to: req.body.testTo, subject: '3 questions due for review on MACPrep (test)', html: nudgeEmailHtml({ name: (admin.email || '').split('@')[0], dueCount: 3, unsubUrl: unsubLink(admin.id) }) });
            return res.json({ ok: true, test_sent_to: req.body.testTo });
        }
        res.json(await sendRetentionNudges({ dry: !!req.body?.dry }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin-only funnel/metrics for the founder dashboard (/metrics.html).
app.get('/api/admin/metrics', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Forbidden' });
    if (!supabase) return res.status(500).json({ error: 'no db' });
    try {
        const PRICE = 50;
        const now = Date.now();
        const windowDays = 30;
        const since = new Date(now - windowDays * 86400000).toISOString();
        const [{ data: users }, { data: events }, allPurchases, { data: feedback }] = await Promise.all([
            supabase.from(PROFILE_TABLE).select('email, account_tier, target_exam_date, premium_unlocked_at, created_at'),
            supabase.from('analytics_events').select('name, created_at, meta, user_id').gte('created_at', since).limit(100000),
            supabase.from('analytics_events').select('id', { count: 'exact', head: true }).eq('name', 'purchase'),
            supabase.from('user_suggestions').select('user_email, suggestion_text, created_at').order('created_at', { ascending: false }).limit(25),
        ]);
        const U = users || [], E = events || [];
        const ec = {};
        E.forEach((e) => { ec[e.name] = (ec[e.name] || 0) + 1; });
        const sum = (...names) => names.reduce((a, n) => a + (ec[n] || 0), 0);
        // Unique anonymous visitors: dedupe landing_view by visitor id (meta.vid). Older
        // events lacking a vid fall back to created_at (≈ one per event).
        const visitSet = new Set();
        E.forEach((e) => { if (e.name === 'landing_view') visitSet.add((e.meta && e.meta.vid) || e.created_at); });
        const visitCount = visitSet.size;
        const premium = U.filter((u) => u.account_tier === 'premium').length;
        const paid = (allPurchases && allPurchases.count) || 0;

        // Count DISTINCT users per stage (events carry user_id once signed in) so the
        // funnel reads as a real user journey instead of summing raw events (which let
        // "started practicing" exceed signups).
        const usersWith = (...names) => {
            const s = new Set();
            E.forEach((e) => { if (names.includes(e.name) && e.user_id) s.add(e.user_id); });
            return s.size;
        };
        const funnel = [
            { key: 'visits', label: 'Landing views', n: visitCount },
            { key: 'signups', label: 'Signups', n: Math.max(sum('signup'), usersWith('signup')) },
            { key: 'practiced', label: 'Started practicing', n: usersWith('session_start', 'quiz_start', 'session_complete') },
            { key: 'paywall', label: 'Hit paywall', n: usersWith('paywall_hit') },
            { key: 'checkout', label: 'Started checkout', n: usersWith('checkout_started', 'upgrade_click') },
            { key: 'purchase', label: 'Purchased', n: paid },
        ];

        const nDays = 21;
        const buckets = {};
        for (let i = nDays - 1; i >= 0; i--) {
            const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
            buckets[d] = { date: d, visits: 0, signups: 0, sessions: 0, purchases: 0 };
        }
        const dayVids = {};
        E.forEach((e) => {
            const d = (e.created_at || '').slice(0, 10); const b = buckets[d]; if (!b) return;
            if (e.name === 'landing_view') { (dayVids[d] = dayVids[d] || new Set()).add((e.meta && e.meta.vid) || e.created_at); }
            else if (e.name === 'session_start' || e.name === 'quiz_start') b.sessions++;
            else if (e.name === 'purchase') b.purchases++; // server-authoritative; avoids double-count with client upgrade_success
        });
        Object.keys(dayVids).forEach((d) => { if (buckets[d]) buckets[d].visits = dayVids[d].size; });
        U.forEach((u) => { const d = (u.created_at || '').slice(0, 10); if (buckets[d]) buckets[d].signups++; });

        res.json({
            generated_at: new Date(now).toISOString(),
            window_days: windowDays,
            totals: { users: U.length, premium, free: U.length - premium, with_exam_date: U.filter((u) => u.target_exam_date).length },
            revenue: { paid_conversions: paid, est_revenue: paid * PRICE, price: PRICE },
            funnel,
            event_counts: ec,
            daily: Object.values(buckets),
            recent_signups: U.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 12)
                .map((u) => ({ email: u.email, tier: u.account_tier, joined: u.created_at, exam_date: u.target_exam_date || null })),
            feedback_count: (feedback || []).length,
            recent_feedback: (feedback || []).map((f) => ({ email: f.user_email, text: f.suggestion_text, at: f.created_at })),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Daily reminder scheduler (in-process; dormant without RESEND_API_KEY). Fires in
// a US-morning window; the per-user 20h throttle makes restarts safe.
if (RESEND_API_KEY) {
    let _lastNudgeDay = null;
    setInterval(async () => {
        try {
            const now = new Date();
            const day = now.toISOString().slice(0, 10);
            const h = now.getUTCHours();
            if (h >= 13 && h < 15 && _lastNudgeDay !== day) {
                _lastNudgeDay = day;
                const r = await sendRetentionNudges();
                console.log(`[nudges] daily run: sent ${r.sent}/${r.eligible} eligible (${r.candidates} with due questions)`);
            }
        } catch (e) { console.error('[nudges] scheduler error:', e.message); }
    }, 30 * 60 * 1000);
    console.log('[nudges] daily study-reminder scheduler active');
}

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

// Grant premium to a user, idempotently. Updates their profile row, or creates
// one if none exists yet (so a paid/redeemed user is never left without access).
// Used by the checkout-return verification path.
async function grantPremium(userId, email) {
    if (!supabase || !userId) return false;
    const upg = { account_tier: 'premium', premium_unlocked_at: new Date().toISOString() };
    const { data, error } = await supabase.from(PROFILE_TABLE).update(upg).eq('user_id', userId).select('user_id');
    if (error) throw error;
    if (!data || data.length === 0) {
        const up = { user_id: userId, ...upg };
        if (email) up.email = email;
        const { error: insErr } = await supabase.from(PROFILE_TABLE).upsert(up, { onConflict: 'user_id' });
        if (insErr) throw insErr;
    }
    return true;
}

// Returns the authenticated user only if their (verified) account email is on the
// admin allowlist — the site owner only. Not derived from any DB profile flag, so
// it can never be granted by accident when a customer is flagged is_program_director.
async function getAdminUser(req) {
    const user = await getUserFromToken(req);
    if (!user) return null;
    return isAdminEmail(user.email) ? user : null;
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
                token: data.session?.access_token || null,
                refresh_token: data.session?.refresh_token || null,
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
    const base = safeBaseUrl(req);
    try {
        await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo: `${base}/reset.html` });
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
        // Only honor tokens minted by the email-recovery flow — a normal login/OAuth
        // session token (amr=password/oauth) must not be usable to reset the password.
        const methods = tokenAuthMethods(access_token).map((m) => String(m).toLowerCase());
        const RECOVERY_OK = ['recovery', 'otp', 'magiclink', 'email', 'email_otp', 'emailotp'];
        if (methods.length && !methods.some((m) => RECOVERY_OK.includes(m))) {
            return res.status(403).json({ error: 'This action requires a password-reset link. Use the "Forgot password" option to get one.' });
        }
        const { error: upErr } = await supabase.auth.admin.updateUserById(data.user.id, { password: new_password });
        if (upErr) throw upErr;
        return res.json({ success: true });
    } catch (err) {
        console.error('Password update failure:', err.message);
        return res.status(500).json({ error: 'Could not update password.' });
    }
});

// Change password for a signed-in user (requires their current session token).
app.post('/api/user/change-password', authLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    const current_password = req.body?.current_password || '';
    const new_password = req.body?.new_password || '';
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!current_password) return res.status(400).json({ error: 'Your current password is required.' });
    if (!supabase || !supabaseAuth) return res.status(500).json({ error: 'Not configured.' });
    try {
        // Re-authenticate with the current password before changing it, so a
        // leftover or stolen session token alone cannot lock the owner out.
        const { error: authErr } = await supabaseAuth.auth.signInWithPassword({ email: user.email, password: current_password });
        if (authErr) return res.status(403).json({ error: 'Current password is incorrect.' });
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
        await supabase.from('user_notes').delete().eq('user_id', user.id).then(() => {}, () => {});
        const { error } = await supabase.auth.admin.deleteUser(user.id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        console.error('Account deletion failure:', err.message);
        return res.status(500).json({ error: 'Could not delete account.' });
    }
});

// Reset a user's practice progress (coverage / accuracy / answered stats), keeping
// the account, saved notes, and flags. PREMIUM-ONLY on purpose: the free-tier ceiling
// counts distinct answered questions from user_progress, so letting a free user wipe it
// would hand back their free allowance repeatedly (a paywall bypass).
app.post('/api/user/reset-progress', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    const admin = await getAdminUser(req);
    const allowed = admin ? true : await isUserPremium(user.id);
    if (!allowed) return res.status(403).json({ error: 'Progress reset is available with full access.' });
    try {
        const { error } = await supabase.from(PROGRESS_TABLE).delete().eq('user_id', user.id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        console.error('Progress reset failure:', err.message);
        return res.status(500).json({ error: 'Could not reset progress.' });
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
        const STATUSES = ['sme_review', 'published', 'rejected', 'draft', 'unreviewed'];
        const countResults = await Promise.all(STATUSES.map((st) =>
            supabase.from('questions').select('id', { count: 'exact', head: true }).eq('status', st)));
        const counts = {};
        STATUSES.forEach((st, i) => { counts[st] = countResults[i].count || 0; });
        return res.json({ questions: out, counts });
    } catch (err) {
        console.error('Admin list failure:', err.message);
        return res.status(500).json({ error: 'Could not load questions.' });
    }
});

// ---------------------------------------------------------------------------
// Privacy-friendly, self-hosted analytics. No third party, no cookies, no PII
// beyond an optional user_id. Only whitelisted event names are accepted.
// ---------------------------------------------------------------------------
const ANALYTICS_EVENTS = new Set([
    'page_view', 'landing_view', 'signup', 'login', 'session_start', 'quiz_start',
    'session_complete', 'demo_started', 'demo_completed', 'paywall_hit',
    'checkout_started', 'upgrade_click', 'upgrade_success', 'feedback_submitted',
]);
app.post('/api/event', eventLimiter, async (req, res) => {
    if (!supabase) return res.json({ ok: true });
    const name = String(req.body?.name || '');
    if (!ANALYTICS_EVENTS.has(name)) return res.json({ ok: true }); // silently ignore unknown
    const user = await getUserFromToken(req);
    let meta = (req.body && typeof req.body.meta === 'object' && req.body.meta && !Array.isArray(req.body.meta)) ? req.body.meta : {};
    // Bound the stored payload so the events table can't be flooded with large blobs.
    try { if (JSON.stringify(meta).length > 2000) meta = {}; } catch (e) { meta = {}; }
    try {
        await supabase.from('analytics_events').insert({ name, user_id: user?.id || null, meta });
    } catch (e) { /* analytics is best-effort */ }
    return res.json({ ok: true });
});

// Admin analytics summary.
app.get('/api/admin/analytics', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    try {
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        const { data } = await supabase.from('analytics_events').select('name, user_id, created_at').gte('created_at', since);
        const rows = data || [];
        const total = {}; const last7 = {};
        const weekAgo = Date.now() - 7 * 86400000;
        rows.forEach((r) => {
            total[r.name] = (total[r.name] || 0) + 1;
            if (new Date(r.created_at).getTime() >= weekAgo) last7[r.name] = (last7[r.name] || 0) + 1;
        });
        // distinct users active in last 7 days
        const activeUsers = new Set(rows.filter((r) => r.user_id && new Date(r.created_at).getTime() >= weekAgo).map((r) => r.user_id)).size;
        return res.json({ total, last7, activeUsers, window: '30d' });
    } catch (err) {
        return res.status(500).json({ error: 'Could not load analytics.' });
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
// Cohort vouchers — a program director generates codes and hands them to their
// students; each code grants one premium unlock when redeemed.
// ---------------------------------------------------------------------------
function newVoucherCode() {
    return 'MACP-' + randomBytes(4).toString('hex').toUpperCase(); // e.g. MACP-9F3A1C2B
}

app.post('/api/admin/vouchers', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 0, 1), 200);
    const label = String(req.body?.label || '').trim().slice(0, 80) || null;
    try {
        const rows = Array.from({ length: count }, () => ({ owner_director_id: admin.id, voucher_key: newVoucherCode(), is_claimed: false, label }));
        const { data, error } = await supabase.from('program_vouchers').insert(rows).select('voucher_key');
        if (error) throw error;
        return res.json({ success: true, codes: (data || []).map((d) => d.voucher_key), label });
    } catch (err) {
        console.error('Voucher generate failure:', err.message);
        return res.status(500).json({ error: 'Could not generate vouchers.' });
    }
});

app.get('/api/admin/vouchers', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    try {
        const { data } = await supabase.from('program_vouchers')
            .select('voucher_key, is_claimed, claimed_by_email, claimed_at, created_at, label')
            .eq('owner_director_id', admin.id).order('created_at', { ascending: false }).limit(500);
        const list = data || [];
        return res.json({ vouchers: list, total: list.length, claimed: list.filter((v) => v.is_claimed).length });
    } catch (err) {
        return res.status(500).json({ error: 'Could not load vouchers.' });
    }
});

// Redeem a voucher → grants premium to the signed-in user.
app.post('/api/redeem-voucher', voucherLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Enter a code.' });
    try {
        const { data: v } = await supabase.from('program_vouchers')
            .select('id, is_claimed').eq('voucher_key', code).maybeSingle();
        if (!v) return res.status(404).json({ error: 'That code was not found.' });
        if (v.is_claimed) return res.status(409).json({ error: 'That code has already been used.' });
        // Claim it and upgrade the user (only if still unclaimed — guards double-claim).
        const { data: claimed, error: cErr } = await supabase.from('program_vouchers')
            .update({ is_claimed: true, claimed_by_id: user.id, claimed_by_email: user.email, claimed_at: new Date().toISOString() })
            .eq('id', v.id).eq('is_claimed', false).select('id');
        if (cErr) throw cErr;
        if (!claimed || claimed.length === 0) return res.status(409).json({ error: 'That code has already been used.' });
        const upg = { account_tier: 'premium', premium_unlocked_at: new Date().toISOString() };
        const { data: updated, error: uErr } = await supabase.from(PROFILE_TABLE).update(upg).eq('user_id', user.id).select('user_id');
        if (uErr) throw uErr;
        if (!updated || updated.length === 0) {
            // No profile row yet — create one so the redeemed code actually grants access.
            const { error: insErr } = await supabase.from(PROFILE_TABLE).upsert({ user_id: user.id, email: user.email, ...upg }, { onConflict: 'user_id' });
            if (insErr) throw insErr;
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Voucher redeem failure:', err.message);
        return res.status(500).json({ error: 'Could not redeem code.' });
    }
});

// ---------------------------------------------------------------------------
// Weekly study leaderboard (global). Ranks opted-in users by questions answered
// this week (resets Monday 00:00 UTC) and shows each player's study streak.
// Privacy: opt-in only, shown by a chosen handle — never email or real name.
// ---------------------------------------------------------------------------
function lbWeekStartUTC() {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
    return d;
}
function lbDayKey(d) { return new Date(d).toISOString().slice(0, 10); }
function lbStreak(daySet) {
    let s = 0;
    const now = Date.now();
    for (let i = 0; i < 400; i++) {
        const k = lbDayKey(new Date(now - i * 86400000));
        if (daySet.has(k)) s++;
        else if (i === 0) continue; // today not yet studied — keep counting from yesterday
        else break;
    }
    return s;
}

app.get('/api/leaderboard', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.json({ leaderboard: [], me: null });
    try {
        const weekStart = lbWeekStartUTC();
        const weekResetsAt = new Date(weekStart.getTime() + 7 * 86400000).toISOString();
        const { data: players } = await supabase.from(PROFILE_TABLE)
            .select('user_id, leaderboard_handle')
            .eq('leaderboard_opt_in', true).not('leaderboard_handle', 'is', null);
        const playerList = players || [];
        const allIds = Array.from(new Set([...playerList.map((p) => p.user_id), user.id])).slice(0, 1000);
        const weekCount = {}, daysByUser = {};
        if (allIds.length) {
            const { data: wp } = await supabase.from(PROGRESS_TABLE)
                .select('user_id').in('user_id', allIds).gte('created_at', weekStart.toISOString());
            (wp || []).forEach((r) => { weekCount[r.user_id] = (weekCount[r.user_id] || 0) + 1; });
            const since = new Date(Date.now() - 120 * 86400000).toISOString();
            const { data: ap } = await supabase.from(PROGRESS_TABLE)
                .select('user_id, created_at').in('user_id', allIds).gte('created_at', since);
            (ap || []).forEach((r) => { (daysByUser[r.user_id] = daysByUser[r.user_id] || new Set()).add(lbDayKey(r.created_at)); });
        }
        const rows = playerList.map((p) => ({
            handle: p.leaderboard_handle,
            weekly: weekCount[p.user_id] || 0,
            streak: lbStreak(daysByUser[p.user_id] || new Set()),
            is_me: p.user_id === user.id,
        })).sort((a, b) => b.weekly - a.weekly || b.streak - a.streak || a.handle.localeCompare(b.handle));
        rows.forEach((r, i) => { r.rank = i + 1; });
        const mineRow = rows.find((r) => r.is_me);
        const myProfile = playerList.find((p) => p.user_id === user.id);
        const me = {
            opted_in: !!myProfile,
            handle: myProfile ? myProfile.leaderboard_handle : null,
            weekly: weekCount[user.id] || 0,
            streak: lbStreak(daysByUser[user.id] || new Set()),
            rank: mineRow ? mineRow.rank : null,
            players: rows.length,
        };
        return res.json({ week_resets_at: weekResetsAt, leaderboard: rows.slice(0, 50), me });
    } catch (err) {
        console.error('Leaderboard failure:', err.message);
        return res.status(500).json({ error: 'Could not load the leaderboard.' });
    }
});

app.post('/api/leaderboard/settings', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const optIn = !!(req.body && req.body.opt_in);
    const handle = ((req.body && req.body.handle) || '').toString().trim();
    if (handle && !/^[A-Za-z0-9_]{3,20}$/.test(handle)) {
        return res.status(400).json({ error: 'Handle must be 3-20 letters, numbers, or underscores.' });
    }
    try {
        if (optIn && !handle) {
            const { data: cur } = await supabase.from(PROFILE_TABLE).select('leaderboard_handle').eq('user_id', user.id).maybeSingle();
            if (!cur || !cur.leaderboard_handle) return res.status(400).json({ error: 'Choose a handle to appear on the leaderboard.' });
        }
        const upd = { leaderboard_opt_in: optIn };
        if (handle) upd.leaderboard_handle = handle;
        const { data, error } = await supabase.from(PROFILE_TABLE).update(upd).eq('user_id', user.id).select('user_id');
        if (error) {
            if (error.code === '23505' || String(error.message || '').toLowerCase().includes('duplicate')) {
                return res.status(409).json({ error: 'That handle is already taken - pick another.' });
            }
            throw error;
        }
        if (!data || !data.length) {
            const { error: insErr } = await supabase.from(PROFILE_TABLE).upsert({ user_id: user.id, email: user.email, ...upd }, { onConflict: 'user_id' });
            if (insErr) {
                if (insErr.code === '23505') return res.status(409).json({ error: 'That handle is already taken - pick another.' });
                throw insErr;
            }
        }
        return res.json({ success: true, opt_in: optIn, handle: handle || null });
    } catch (err) {
        console.error('Leaderboard settings failure:', err.message);
        return res.status(500).json({ error: 'Could not save your leaderboard settings.' });
    }
});

// ---------------------------------------------------------------------------
// Public "try before you sign up" demo. A small, bounded pool of PUBLISHED
// questions powers an interactive 3-question demo on the landing page. Grading
// is restricted to this pool, so the public endpoint can't be used to scrape
// answers for the rest of the paid bank. Rate-limited on top of that.
// ---------------------------------------------------------------------------
const DEMO_POOL_SIZE = 24;
let _demoPool = { at: 0, items: [] };
async function getDemoPool() {
    if (_demoPool.items.length && Date.now() - _demoPool.at < 30 * 60 * 1000) return _demoPool.items;
    if (!supabase) return _demoPool.items;
    const { data } = await supabase.from('questions').select('*')
        .eq('status', 'published').order('id').limit(DEMO_POOL_SIZE);
    if (data && data.length) _demoPool = { at: Date.now(), items: data.map((q) => ({ ...q, choices: parseChoices(q.choices) })) };
    return _demoPool.items;
}
function pickRandom(arr, n) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, n);
}

app.get('/api/demo/questions', demoLimiter, async (req, res) => {
    try {
        const picks = pickRandom(await getDemoPool(), 3).map((q) => ({
            id: q.id,
            specialty: q.specialty || q.category || '',
            stem: q.stem,
            choices: (q.choices || []).map((c) => ({ label: c.label, text: c.text })),
        }));
        res.json({ questions: picks });
    } catch (e) { res.status(500).json({ error: 'Demo temporarily unavailable.', questions: [] }); }
});

app.post('/api/demo/grade', demoLimiter, async (req, res) => {
    try {
        const id = req.body?.id;
        const sel = req.body?.choiceIndex;
        const q = (await getDemoPool()).find((x) => x.id === id);
        if (!q) return res.status(403).json({ error: 'That question is not part of the demo.' });
        const choices = q.choices || [];
        let chosenLabel = null;
        if (typeof sel === 'number' && choices[sel]) chosenLabel = choices[sel].label;
        else if (typeof sel === 'string') chosenLabel = sel;
        res.json({
            correct: chosenLabel != null && chosenLabel === q.correct_answer,
            correct_answer: q.correct_answer,
            choices: choices.map((c) => ({ label: c.label, text: c.text, correct: !!c.correct, rationale: c.rationale })),
            explanation: q.explanation,
            references: q.references || [],
        });
    } catch (e) { res.status(500).json({ error: 'Demo temporarily unavailable.' }); }
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
                .select('id, specialty, domain, domain_name, subtopic, category, difficulty, stem, choices, telemetry, status')
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
        const safe = (data || []).map((q) => {
            const { status, ...rest } = q;
            return {
                ...rest,
                reviewed: status === 'published', // CAA-signed-off; surfaced as a trust badge
                choices: parseChoices(q.choices).map((c) => (typeof c === 'object' && c !== null
                    ? { text: c.text ?? c.value ?? '' }
                    : { text: c })),
            };
        });

        return res.json({ questions: safe });
    } catch (err) {
        console.error('Questions route failure:', err.message);
        return res.status(500).json({ error: 'Database communication failure', questions: [] });
    }
});

// Printable take-home exam (premium). Returns full questions WITH answers/explanations
// so the client can render a print-to-PDF page — gated to premium since it reveals keys.
app.get('/api/exam-export', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!(await isUserPremium(user.id))) {
        return res.status(402).json({ error: 'Printable exams are a premium feature.', paywall: true });
    }
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 25, 1), 200);
    const category = (req.query.category || 'all').toString();
    try {
        let query = supabase.from('questions').select('id, category, domain_name, stem, choices, correct_answer, explanation, "references"');
        query = applyServedFilter(query);
        if (category && category !== 'all') query = query.eq('category', category);
        const { data, error } = await query.limit(1500);
        if (error) throw error;
        const pool = data || [];
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const picked = pool.slice(0, count).map((q) => {
            const choices = parseChoices(q.choices);
            let correctIndex = choices.findIndex((c) => c && typeof c === 'object' && c.correct === true);
            if (correctIndex < 0 && typeof q.correct_answer === 'string' && q.correct_answer.trim()) {
                correctIndex = q.correct_answer.trim().toUpperCase().charCodeAt(0) - 65;
            }
            let references = q.references;
            if (typeof references === 'string') { try { references = JSON.parse(references); } catch (e) { references = []; } }
            return {
                category: q.category || q.domain_name || 'General',
                stem: q.stem || '',
                choices: choices.map((c) => (typeof c === 'object' && c ? (c.text || '') : c)),
                correctLetter: correctIndex >= 0 ? String.fromCharCode(65 + correctIndex) : '?',
                explanation: q.explanation || '',
                references: Array.isArray(references) ? references : [],
            };
        });
        return res.json({ questions: picked });
    } catch (err) {
        console.error('Exam export failure:', err.message);
        return res.status(500).json({ error: 'Could not build exam.' });
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
            // Cheap first: re-answering a question already seen is always free.
            const { count: seenThis } = await supabase
                .from(PROGRESS_TABLE)
                .select('question_id', { count: 'exact', head: true })
                .eq('user_id', user.id).eq('question_id', String(questionId));
            if (!seenThis) {
                // Only then check the distinct count — server-side, not a full table pull.
                const { data: distinctCount, error: dcErr } = await supabase.rpc('distinct_answered', { p_user: user.id });
                if (dcErr) throw dcErr;
                if ((distinctCount || 0) >= ceiling) {
                    return res.status(402).json({ error: 'paywall', paywall: true, limit: ceiling });
                }
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

        // If we can't resolve exactly one in-range correct answer, refuse to grade
        // rather than silently scoring the attempt wrong (and never record it).
        if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= choices.length) {
            console.error(`UNSCORABLE question id=${questionId}: no resolvable correct answer.`);
            return res.status(422).json({ error: 'This question could not be scored and has been flagged for review.' });
        }

        // Validate the submitted choice is an in-range integer.
        const selIndex = Number(choiceIndex);
        if (!Number.isInteger(selIndex) || selIndex < 0 || selIndex >= choices.length) {
            return res.status(400).json({ error: 'Invalid answer choice.' });
        }

        const isCorrect = selIndex === correctIndex;
        const confidence = ['low', 'medium', 'high'].includes(req.body?.confidence) ? req.body.confidence : null;

        // Record the attempt for progress + free-tier accounting (best-effort).
        const { error: pErr } = await supabase.from(PROGRESS_TABLE).insert({
            user_id: user.id,
            question_id: String(questionId),
            specialty: q.specialty || null,
            category: q.category || null,
            selected_label: String.fromCharCode(65 + selIndex),
            is_correct: isCorrect,
            confidence,
        });
        if (pErr) {
            // The DB trigger rejects free-tier users who slip past the app-level check
            // under a concurrent-request race — treat that as the paywall.
            if (/free_tier/i.test(pErr.message || '') || pErr.code === '23514') {
                return res.status(402).json({ error: 'paywall', paywall: true, limit: await getFreeTierCeiling() });
            }
            console.warn(`Progress insert warning: ${pErr.message}`);
        }

        // Update the spaced-repetition (SM-2) schedule for this question — best-effort.
        // Map correctness + stated confidence to a 0-5 recall quality.
        const sm2q = isCorrect
            ? (confidence === 'high' ? 5 : confidence === 'medium' ? 4 : 3)
            : (confidence === 'high' ? 0 : 2);
        supabase.rpc('sm2_review', { p_user: user.id, p_question: String(questionId), p_quality: sm2q })
            .then(({ error: sErr }) => { if (sErr) console.warn(`sm2_review warning: ${sErr.message}`); }, () => {});

        // Peer stats: % correct + per-choice answer distribution for this question
        // (so tutor mode can show how the user's pick compares to everyone else's).
        // Includes the attempt just inserted above. Best-effort.
        let peerPct = null;
        let choiceDistribution = null; // [pct per choice index] once enough responses
        let responseCount = 0;
        try {
            const { data: rows } = await supabase.from(PROGRESS_TABLE).select('is_correct, selected_label').eq('question_id', String(questionId));
            if (rows && rows.length) {
                responseCount = rows.length;
                if (rows.length >= 3) peerPct = Math.round((rows.filter((r) => r.is_correct).length / rows.length) * 100);
                const counts = new Array(choices.length).fill(0);
                let total = 0;
                rows.forEach((r) => {
                    const i = String(r.selected_label || '').toUpperCase().charCodeAt(0) - 65;
                    if (Number.isInteger(i) && i >= 0 && i < choices.length) { counts[i]++; total++; }
                });
                // Surface once there are a few responses (same floor as peer_correct_pct);
                // avoids a misleading "100%" off a single answer.
                if (total >= 3) choiceDistribution = counts.map((c) => Math.round((c / total) * 100));
            }
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
            choice_distribution: choiceDistribution,
            response_count: responseCount,
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
            .select('email, account_tier, premium_unlocked_at, created_at, is_program_director, full_name, credential, training_program, target_exam_date, phone, study_goal, theme, font, leaderboard_handle, leaderboard_opt_in')
            .eq('user_id', user.id)
            .maybeSingle();
        if (error) throw error;

        // Derive study stats from recorded progress, including accuracy by specialty.
        const { data: progress } = await supabase
            .from(PROGRESS_TABLE)
            .select('question_id, is_correct, category, created_at, confidence')
            .eq('user_id', user.id);

        const answeredIds = new Set((progress || []).map((r) => r.question_id));
        const correct = (progress || []).filter((r) => r.is_correct).length;
        const ceiling = await getFreeTierCeiling();

        // Missed question ids = answered incorrectly and never since gotten right.
        const everCorrect = new Set((progress || []).filter((r) => r.is_correct).map((r) => r.question_id));
        const missed_ids = Array.from(new Set((progress || [])
            .filter((r) => !r.is_correct && !everCorrect.has(r.question_id))
            .map((r) => r.question_id)));

        // "Confident but wrong": answered with high confidence yet still not gotten right.
        const confident_missed_ids = Array.from(new Set((progress || [])
            .filter((r) => !r.is_correct && r.confidence === 'high' && !everCorrect.has(r.question_id))
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

        // Confidence calibration: accuracy on questions the user marked "Confident".
        // Low accuracy here = overconfidence (a genuinely actionable, novel insight).
        const calByCat = {};
        (progress || []).forEach((r) => {
            if (r.confidence !== 'high') return;
            const c = r.category || 'Uncategorized';
            (calByCat[c] = calByCat[c] || { n: 0, correct: 0 });
            calByCat[c].n++;
            if (r.is_correct) calByCat[c].correct++;
        });
        const calibration = Object.entries(calByCat)
            .filter(([, v]) => v.n >= 3)
            .map(([category, v]) => ({ category, attempts: v.n, accuracy: Math.round((v.correct / v.n) * 100) }))
            .sort((a, b) => a.accuracy - b.accuracy);

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
        // Day boundaries use the user's LOCAL timezone (tz = browser getTimezoneOffset
        // in minutes) so streaks, "answered today", and the trend roll over at local
        // midnight, not UTC (which flipped ~7-8pm for US users).
        const tzOffset = Math.max(-840, Math.min(840, Number(req.query.tz) || 0));
        const dayKey = (d) => new Date(new Date(d).getTime() - tzOffset * 60000).toISOString().slice(0, 10);
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

        // Questions answered today (for the daily-goal indicator).
        const todayKey = dayKey(today);
        const answered_today = (progress || []).filter((r) => dayKey(r.created_at) === todayKey).length;

        // Spaced repetition (SM-2): questions whose scheduled review is now due.
        let due_ids = [];
        try {
            const { data: dueRows } = await supabase.from('review_state')
                .select('question_id').eq('user_id', user.id).lte('due_at', new Date().toISOString());
            due_ids = (dueRows || []).map((r) => r.question_id);
        } catch (e) { /* review_state optional */ }

        return res.json({
            profile: {
                email: profile?.email || user.email || null,
                premium_unlocked: profile?.account_tier === 'premium',
                premium_unlocked_at: profile?.premium_unlocked_at || null,
                is_admin: isAdminEmail(user.email),
                full_name: profile?.full_name || '',
                credential: profile?.credential || '',
                training_program: profile?.training_program || '',
                target_exam_date: profile?.target_exam_date || '',
                study_goal: profile?.study_goal || null,
                theme: profile?.theme || null,
                font: profile?.font || null,
                leaderboard_handle: profile?.leaderboard_handle || null,
                leaderboard_opt_in: !!profile?.leaderboard_opt_in,
                phone: profile?.phone || '',
                free_tier_limit: ceiling,
                stats: { answered: answeredIds.size, attempts: (progress || []).length, correct },
                by_specialty,
                calibration,
                coverage,
                streak,
                active_days: Array.from(activeDays),
                trend,
                readiness,
                days_to_exam,
                answered_today,
                missed_ids,
                confident_missed_ids,
                due_ids,
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
    if (typeof b.study_goal === 'string' && ['exam', 'practice', 'none'].includes(b.study_goal)) {
        update.study_goal = b.study_goal;
        if (b.study_goal !== 'exam') update.target_exam_date = null; // practice/none → no exam countdown
    }
    if (typeof b.theme === 'string' && ['light', 'dark', 'midnight', 'warm', 'slate', 'forest', 'rose', 'contrast', 'ocean', 'indigo', 'nord', 'sky', 'lavender', 'sandstone'].includes(b.theme)) {
        update.theme = b.theme;
    }
    if (typeof b.font === 'string' && ['modern', 'serif', 'mono', 'rounded', 'charter', 'times', 'grotesk', 'reader'].includes(b.font)) {
        update.font = b.font;
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

// My Notebook: all of the user's notes + flagged questions, with question context.
app.get('/api/user/notebook', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.json({ notes: [], flagged: [] });
    try {
        const { data: notes } = await supabase.from('user_notes').select('question_id, note, updated_at').eq('user_id', user.id);
        const { data: flags } = await supabase.from('user_flags').select('question_id').eq('user_id', user.id);
        const ids = Array.from(new Set([...(notes || []).map((n) => n.question_id), ...(flags || []).map((f) => f.question_id)]));
        const qmap = {};
        if (ids.length) {
            const { data: qs } = await supabase.from('questions').select('id, category, domain_name, stem').in('id', ids);
            (qs || []).forEach((q) => { qmap[String(q.id)] = { category: q.category || q.domain_name || 'General', stem: q.stem || '' }; });
        }
        const ctx = (id) => qmap[String(id)] || { category: '', stem: '' };
        const noteList = (notes || []).filter((n) => (n.note || '').trim())
            .map((n) => ({ question_id: n.question_id, note: n.note, updated_at: n.updated_at, ...ctx(n.question_id) }))
            .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        const flagList = (flags || []).map((f) => ({ question_id: f.question_id, ...ctx(f.question_id) }));
        return res.json({ notes: noteList, flagged: flagList });
    } catch (err) {
        console.error('Notebook failure:', err.message);
        return res.status(500).json({ error: 'Could not load notebook.' });
    }
});

app.post('/api/feedback', feedbackLimiter, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const user = await getUserFromToken(req);
    const kind = (req.body?.kind || 'suggestion').toString().slice(0, 40);
    const message = (req.body?.message || '').toString().trim();
    if (!message) return res.status(400).json({ error: 'A message is required.' });
    // Feedback is deliberately ANONYMOUS — we do not store or surface who sent it,
    // so users feel free to be candid. (Auth is still checked for rate-limit purposes.)
    const email = 'anonymous';
    try {
        const { error } = await supabase.from('user_suggestions').insert({
            user_email: email,
            suggestion_text: `[${kind}] ${message}`.slice(0, 4000),
        });
        if (error) throw error;
        // Notify the founder by email (best-effort; only fires if RESEND_API_KEY is set).
        sendEmail({
            to: 'support@macprep.org',
            subject: `New MACPrep feedback (${kind})`,
            html: `<table width="100%" cellpadding="0" cellspacing="0" style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;max-width:520px;">
  <tr><td>
    <p style="font-size:15px;color:#111827;margin:0 0 6px;"><strong>New feedback — ${escHtml(kind)}</strong></p>
    <p style="font-size:13px;color:#6b7280;margin:0 0 12px;">From: ${escHtml(email)}</p>
    <p style="font-size:15px;color:#111827;white-space:pre-wrap;background:#f6f7f9;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin:0 0 14px;">${escHtml(message)}</p>
    <p style="font-size:12px;color:#9ca3af;margin:0;">Read all feedback on your dashboard: <a href="${BASE_URL}/metrics.html" style="color:#00A86B;">${BASE_URL}/metrics.html</a></p>
  </td></tr>
</table>`,
        }).then(() => {}, () => {});
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
app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: 'Payments not configured.' });
        const priceId = process.env.STRIPE_PRODUCTION_PRICE_ID;
        if (!priceId) return res.status(500).json({ error: 'Price not configured.' });

        const user = await getUserFromToken(req);
        if (!user) return res.status(401).json({ error: 'Please sign in before upgrading.' });
        const email = (user.email || '').trim();

        // Build an absolute base URL. Prefer the Origin header, then a configured
        // PUBLIC_BASE_URL, then the Host header — so checkout works even when the
        // request carries no Origin (Stripe requires absolute success/cancel URLs).
        const base = safeBaseUrl(req);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: email,
            // Always attach the authenticated buyer so the webhook matches the payment
            // by verified id — never by a client-supplied email.
            client_reference_id: user.id,
            metadata: { user_id: user.id },
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            // Let buyers enter Stripe promotion codes (founding-member, student,
            // referral, etc. — created in the Stripe dashboard).
            allow_promotion_codes: true,
            // Collect/charge sales tax automatically — only when STRIPE_AUTOMATIC_TAX
            // is set (requires Stripe Tax to be active with registrations, or Stripe
            // will reject the session).
            ...(String(process.env.STRIPE_AUTOMATIC_TAX || '').toLowerCase() === 'true'
                ? { automatic_tax: { enabled: true } } : {}),
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
// Verify a checkout session on the buyer's return — a belt-and-suspenders to the
// webhook. The browser sends the session_id from the Stripe success redirect; we
// ask Stripe directly whether it's paid and whether it belongs to THIS signed-in
// user, then grant access. Guarantees a paying customer is unlocked immediately
// even if the webhook is delayed or missed — and refuses to unlock on anyone
// else's or an unpaid session.
// ---------------------------------------------------------------------------
app.post('/api/verify-checkout-session', checkoutLimiter, async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: 'Payments not configured.' });
        const user = await getUserFromToken(req);
        if (!user) return res.status(401).json({ error: 'Authentication required.' });

        const sessionId = String(req.body?.session_id || '').trim();
        // Stripe checkout session ids look like cs_live_... / cs_test_... — reject
        // anything else outright so we never hand arbitrary input to the API.
        if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: 'Invalid session.' });

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        // The session must (a) be fully paid and (b) belong to this authenticated
        // buyer — the id we attached at checkout. This blocks anyone from passing a
        // stranger's session id to claim a payment that isn't theirs.
        const owner = session.client_reference_id || session.metadata?.user_id || null;
        const paid = session.payment_status === 'paid';
        if (!paid || owner !== user.id) {
            const already = await isUserPremium(user.id);
            return res.json({ premium_unlocked: already });
        }
        await grantPremium(user.id, (session.customer_details?.email || user.email || '').toLowerCase().trim());
        return res.json({ premium_unlocked: true });
    } catch (err) {
        console.error('verify-checkout-session failure:', err.message);
        return res.status(500).json({ error: 'Could not verify payment.' });
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

// Sentry's Express error handler captures anything thrown/propagated to Express
// (no-op without a DSN) and MUST be registered before the response handler below.
Sentry.setupExpressErrorHandler(app);

// Log (visible in Render logs) and return a clean JSON error instead of leaking a
// stack trace to the client.
app.use((err, req, res, next) => {
    console.error('Unhandled route error:', err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Something went wrong.' });
});

// Surface crashes in logs (and Sentry) rather than dying silently.
process.on('unhandledRejection', (reason) => {
    console.error('UnhandledRejection:', reason);
    Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
    console.error('UncaughtException:', err && err.stack ? err.stack : err);
    // The process is in an undefined state after an uncaught exception — capture,
    // flush to Sentry, then exit so the platform (Render) restarts a clean instance.
    Sentry.captureException(err);
    Sentry.flush(2000).finally(() => process.exit(1));
});

// ---------------------------------------------------------------------------
// Start server (all routes are declared above this line)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MACPrep server running on port ${PORT}`);
    console.log(`Supabase: ${supabase ? 'CONNECTED (service role)' : 'OFFLINE'} | Auth: ${supabaseAuth ? 'ready' : 'OFFLINE'}`);
});

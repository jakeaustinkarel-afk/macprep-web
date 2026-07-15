// Sentry.init() must run BEFORE express/http are imported (Sentry v8+ uses
// OpenTelemetry auto-instrumentation set up at init), so this side-effect import
// is first. Server-side error monitoring is dormant until SENTRY_DSN is set.
import './instrument.mjs';
import express from 'express';
import compression from 'compression';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { randomBytes, createHmac, createHash } from 'crypto';
import * as Sentry from '@sentry/node';
import webpush from 'web-push';
import { initializeApp as fbInitApp, cert as fbCert, getApps as fbGetApps } from 'firebase-admin/app';
import { getMessaging as fbGetMessaging } from 'firebase-admin/messaging';
import apn from '@parse/node-apn';

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
// Cohort dashboard does a full served-bank + full-cohort scan per call — cap it so a
// faculty/PD (or admin) can't hammer it into a resource-exhaustion problem.
const cohortLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

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
// App Store / Play review demo accounts — NOT real users. They get full premium
// browse access (so reviewers can see everything) and are surfaced as program
// "REVIEW" in admin metrics + exempted from the mandatory program prompt so a
// reviewer is never blocked by an onboarding gate. Override via REVIEW_EMAILS env.
const REVIEW_EMAILS = new Set(
    (process.env.REVIEW_EMAILS || 'applereview@macprep.org')
        .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const isReviewEmail = (email) => REVIEW_EMAILS.has(String(email || '').trim().toLowerCase());
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

// Free accounts may try a fixed number of NEW questions total (changed 2026-07-06 from
// 10% of the bank to a flat 25 — clearer for users, and it doesn't balloon as the bank grows).
const FREE_TIER_LIMIT = 25;
let _freeCeilingCache = { value: 50, at: 0 };
async function getFreeTierCeiling() {
    const now = Date.now();
    if (now - _freeCeilingCache.at < 5 * 60 * 1000) return _freeCeilingCache.value;
    if (!supabase) return _freeCeilingCache.value;
    try {
        const q = applyServedFilter(supabase.from('questions').select('id', { count: 'exact', head: true }));
        const { count } = await q;
        const ceiling = FREE_TIER_LIMIT;
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
// Clean URLs — 301 /foo.html → /foo (canonical, shareable, SEO-friendly) and
// serve /foo from foo.html. Old .html links keep working via the redirect, so
// no traffic is lost. Query strings are preserved; #hash is client-side only.
// ---------------------------------------------------------------------------
app.get(/\.html$/i, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const clean = req.path.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '') || '/';
    const qs = req.originalUrl.slice(req.path.length);
    res.redirect(301, clean + qs);
});
app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path === '/' || req.path.startsWith('/api/') || path.extname(req.path)) return next();
    const file = path.join(__dirname, '../', decodeURIComponent(req.path).replace(/\/+$/, '') + '.html');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file, (err) => { if (err) { res.removeHeader('Cache-Control'); next(); } });
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
// ---------------------------------------------------------------------------
// Referral code — a 20%-off Stripe promo code that ROTATES MONTHLY to stay fresh.
// The app shows the current month's code (CLASS20<MMM><YY>, e.g. CLASS20JUL26); the
// server ensures that code exists as a Stripe promotion code on the 20% referral
// coupon, auto-creating each new month's code on boot, every 6h, and lazily on the
// first /api/config hit of a new month. Each code carries a ~45-day grace expiry so a
// code shared near a month boundary keeps working for a few weeks. Idempotent + best-
// effort — a Stripe hiccup never breaks the app (the code just may lag by minutes).
// ---------------------------------------------------------------------------
const STRIPE_REFERRAL_COUPON_ID = process.env.STRIPE_REFERRAL_COUPON_ID || 'nPRELK5j'; // "Classmate Referral 20%"
const _REF_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const referralCodeFor = (d = new Date()) => `CLASS20${_REF_MONTHS[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(-2)}`;
let _referralEnsuredKey = null;
async function ensureReferralCode() {
    const now = new Date();
    const key = now.getUTCFullYear() + '-' + now.getUTCMonth();
    if (_referralEnsuredKey === key || !stripe) return;
    const code = referralCodeFor(now);
    try {
        const found = await stripe.promotionCodes.list({ code, limit: 1 });
        if (!(found.data && found.data.length)) {
            await stripe.promotionCodes.create({ coupon: STRIPE_REFERRAL_COUPON_ID, code, expires_at: Math.floor((Date.now() + 45 * 86400000) / 1000) });
            console.log(`[referral] created monthly 20% code ${code}`);
        }
        _referralEnsuredKey = key; // this month handled — no more Stripe calls until it rolls over
    } catch (e) { console.error('[referral] ensure failed:', e.message); }
}
ensureReferralCode();                                 // on boot
setInterval(ensureReferralCode, 6 * 60 * 60 * 1000);  // every 6h — picks up the month rollover same day

// Public runtime config for the browser (no secrets — browser Sentry DSNs are public
// by design). Set SENTRY_BROWSER_DSN on Render to turn on error monitoring.
app.get('/api/config', (req, res) => {
    ensureReferralCode(); // fire-and-forget; idempotent, creates the new month's code on first hit
    res.json({
        sentryDsn: process.env.SENTRY_BROWSER_DSN || null,
        environment: process.env.NODE_ENV || 'production',
        referralCode: referralCodeFor(),
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

// Web Push (PWA notifications) — fully dormant until VAPID keys are set in env.
// Generate with `npx web-push generate-vapid-keys`, then set VAPID_PUBLIC_KEY +
// VAPID_PRIVATE_KEY (+ optional VAPID_SUBJECT mailto) on the host.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@macprep.org';
const PUSH_ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
    try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY); console.log('[push] web-push configured'); }
    catch (e) { console.error('[push] VAPID config failed:', e.message); }
}

// Native push (App Store / Play Store apps) — SPLIT channel because the iOS project
// is SPM-only (Firebase's iOS SDK can't cleanly resolve there): iOS APNs tokens are
// sent with the .p8 via @parse/node-apn; Android FCM tokens via firebase-admin.
// Both stay dormant until their secrets are set, mirroring the VAPID gate above.
const FCM_ENABLED = !!process.env.FIREBASE_SERVICE_ACCOUNT;
const APNS_ENABLED = !!(process.env.APNS_KEY_P8 && process.env.APNS_KEY_ID && process.env.APPLE_TEAM_ID);
const NATIVE_PUSH_ENABLED = FCM_ENABLED || APNS_ENABLED;
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'org.macprep.app';
let fcm = null, apnProvider = null;
if (FCM_ENABLED) {
    try {
        // Accept the service-account JSON either raw or base64 (base64 avoids any
        // newline mangling when pasting into an env-var UI).
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
        const sa = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
        if (sa.private_key && sa.private_key.includes('\\n')) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
        if (!fbGetApps().length) fbInitApp({ credential: fbCert(sa) });
        fcm = fbGetMessaging();
        console.log('[native-push] FCM (Android) configured');
    } catch (e) { console.error('[native-push] FCM init failed:', e.message); }
}
if (APNS_ENABLED) {
    try {
        // Accept the .p8 either as the raw PEM or base64 (base64 sidesteps PEM-newline issues).
        const p8raw = process.env.APNS_KEY_P8.trim();
        const p8 = p8raw.includes('BEGIN') ? p8raw : Buffer.from(p8raw, 'base64').toString('utf8');
        apnProvider = new apn.Provider({ token: { key: p8, keyId: process.env.APNS_KEY_ID, teamId: process.env.APPLE_TEAM_ID }, production: process.env.APNS_PRODUCTION !== 'false' });
        console.log(`[native-push] APNs (iOS) configured (production:${process.env.APNS_PRODUCTION !== 'false'})`);
    } catch (e) { console.error('[native-push] APNs init failed:', e.message); }
}

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

// Shared eligibility for every reminder channel (email / web push / native push):
// users with due reviews who haven't studied in 18h. Returns per-user due counts
// plus the inactive user ids. Each channel then applies its own 20h throttle.
async function computeReminderTargets() {
    const { data: due } = await supabase.from('review_state').select('user_id').lte('due_at', new Date().toISOString()).limit(20000);
    const counts = {};
    (due || []).forEach((r) => { counts[r.user_id] = (counts[r.user_id] || 0) + 1; });
    const targetIds = Object.keys(counts);
    if (!targetIds.length) return { counts, inactive: [] };
    const activeCutoff = new Date(Date.now() - 18 * 3600 * 1000).toISOString();
    const { data: active } = await supabase.from(PROGRESS_TABLE).select('user_id').gte('created_at', activeCutoff).limit(20000);
    const activeSet = new Set((active || []).map((r) => r.user_id));
    return { counts, inactive: targetIds.filter((uid) => !activeSet.has(uid)) };
}
function reminderBody(n) { return n ? `${n} question${n === 1 ? '' : 's'} due for review — keep your streak alive.` : 'Time for a quick review session.'; }

// Web Push reminders (installed PWAs + browsers). Dormant unless VAPID keys are set.
async function sendPushReminders() {
    if (!PUSH_ENABLED || !supabase) return { error: 'push not configured' };
    const nowIso = new Date().toISOString();
    const { counts, inactive } = await computeReminderTargets();
    if (!inactive.length) return { sent: 0, candidates: Object.keys(counts).length };
    const throttle = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const { data: subs } = await supabase.from('push_subscriptions')
        .select('id, user_id, subscription, last_pushed_at')
        .in('user_id', inactive.slice(0, 1000));
    let sent = 0, eligible = 0;
    for (const s of (subs || [])) {
        if (s.last_pushed_at && s.last_pushed_at > throttle) continue;
        eligible++;
        const payload = JSON.stringify({ title: 'MACPrep', body: reminderBody(counts[s.user_id] || 0), url: '/', tag: 'macprep-review' });
        try {
            await webpush.sendNotification(s.subscription, payload);
            await supabase.from('push_subscriptions').update({ last_pushed_at: nowIso }).eq('id', s.id);
            sent++;
        } catch (e) {
            // 404/410 = the subscription is gone (uninstalled / permission revoked) → prune it.
            if (e.statusCode === 404 || e.statusCode === 410) { await supabase.from('push_subscriptions').delete().eq('id', s.id).then(() => {}, () => {}); }
            else { console.error('[push] send failed:', s.user_id, e.statusCode || e.message); }
        }
    }
    return { sent, eligible, candidates: Object.keys(counts).length };
}

// One APNs push to a set of the SAME user's iOS token (personalized body).
async function apnsSendOne(t, body, nowIso) {
    const note = new apn.Notification();
    note.topic = APNS_BUNDLE_ID;
    note.alert = { title: 'MACPrep', body };
    note.sound = 'default';
    note.payload = { url: '/' };
    note.expiry = Math.floor(Date.now() / 1000) + 3600;
    const res = await apnProvider.send(note, t.token);
    if (res.sent && res.sent.length) { if (nowIso) await supabase.from('native_device_tokens').update({ last_pushed_at: nowIso }).eq('id', t.id).then(() => {}, () => {}); return true; }
    for (const f of (res.failed || [])) {
        const reason = (f.response && f.response.reason) || '';
        if (['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason)) await supabase.from('native_device_tokens').delete().eq('id', t.id).then(() => {}, () => {});
        else console.error('[native-push] apns failed:', reason || (f.error && f.error.message));
    }
    return false;
}
// One FCM push to the SAME user's Android token (personalized body).
async function fcmSendOne(t, body, nowIso) {
    try {
        await fcm.send({ token: t.token, notification: { title: 'MACPrep', body }, data: { url: '/' }, android: { priority: 'high', notification: { color: '#146A4A' } } });
        if (nowIso) await supabase.from('native_device_tokens').update({ last_pushed_at: nowIso }).eq('id', t.id).then(() => {}, () => {});
        return true;
    } catch (e) {
        if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-argument') await supabase.from('native_device_tokens').delete().eq('id', t.id).then(() => {}, () => {});
        else console.error('[native-push] fcm failed:', e.code || e.message);
        return false;
    }
}
// Native reminders — same eligibility, delivered to store-app devices. iOS via APNs
// (.p8 / node-apn), Android via FCM (firebase-admin). Dormant unless native env set.
async function sendNativeReminders() {
    if (!NATIVE_PUSH_ENABLED || !supabase) return { error: 'native push not configured' };
    const nowIso = new Date().toISOString();
    const { counts, inactive } = await computeReminderTargets();
    if (!inactive.length) return { sent: 0, candidates: Object.keys(counts).length };
    const throttle = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const { data: toks } = await supabase.from('native_device_tokens')
        .select('id, user_id, token, platform, last_pushed_at')
        .in('user_id', inactive.slice(0, 1000));
    let sent = 0, eligible = 0;
    for (const t of (toks || [])) {
        if (t.last_pushed_at && t.last_pushed_at > throttle) continue;
        const body = reminderBody(counts[t.user_id] || 0);
        if (t.platform === 'ios' && apnProvider) { eligible++; if (await apnsSendOne(t, body, nowIso)) sent++; }
        else if (t.platform === 'android' && fcm) { eligible++; if (await fcmSendOne(t, body, nowIso)) sent++; }
    }
    return { sent, eligible, candidates: Object.keys(counts).length };
}
// One-off test push to a user's OWN native devices (admin test path).
async function sendNativeTest(userId) {
    if (!NATIVE_PUSH_ENABLED || !supabase) return 0;
    const { data: toks } = await supabase.from('native_device_tokens').select('id, token, platform').eq('user_id', userId);
    let sent = 0;
    for (const t of (toks || [])) {
        const body = 'Test push — reminders are working ✓';
        if (t.platform === 'ios' && apnProvider) { if (await apnsSendOne(t, body, null)) sent++; }
        else if (t.platform === 'android' && fcm) { if (await fcmSendOne(t, body, null)) sent++; }
    }
    return sent;
}

// Expose the VAPID public key so the client can subscribe (returns enabled:false if keys aren't set).
app.get('/api/push/vapid-public', (req, res) => {
    // `native` is surfaced even when VAPID is unset so the store apps can show the
    // reminders card off the native flag alone.
    if (!PUSH_ENABLED) return res.json({ enabled: false, native: NATIVE_PUSH_ENABLED });
    res.json({ enabled: true, publicKey: VAPID_PUBLIC_KEY, native: NATIVE_PUSH_ENABLED });
});
app.post('/api/push/subscribe', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const sub = req.body?.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Bad subscription.' });
    try {
        await supabase.from('push_subscriptions').upsert({ user_id: user.id, endpoint: sub.endpoint, subscription: sub }, { onConflict: 'endpoint' });
        return res.json({ success: true });
    } catch (e) { console.error('[push] subscribe failed:', e.message); return res.status(500).json({ error: 'Could not save.' }); }
});
app.post('/api/push/unsubscribe', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    try {
        const endpoint = req.body?.endpoint;
        if (endpoint) await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', user.id);
        else await supabase.from('push_subscriptions').delete().eq('user_id', user.id);
        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ error: 'Could not remove.' }); }
});

// Native store-app device tokens (@capacitor/push-notifications): iOS APNs / Android FCM.
app.post('/api/push/register-native', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const { token, platform } = req.body || {};
    if (!token || (platform !== 'ios' && platform !== 'android')) return res.status(400).json({ error: 'Bad token.' });
    try {
        await supabase.from('native_device_tokens').upsert({ user_id: user.id, token, platform, updated_at: new Date().toISOString() }, { onConflict: 'token' });
        return res.json({ success: true });
    } catch (e) { console.error('[native-push] register failed:', e.message); return res.status(500).json({ error: 'Could not save.' }); }
});
app.post('/api/push/unregister-native', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    try {
        const token = req.body?.token;
        if (token) await supabase.from('native_device_tokens').delete().eq('token', token).eq('user_id', user.id);
        else await supabase.from('native_device_tokens').delete().eq('user_id', user.id);
        return res.json({ success: true });
    } catch (e) { return res.status(500).json({ error: 'Could not remove.' }); }
});

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
        // { pushTest: true } sends a push to the admin's own devices right now (once VAPID keys are set).
        if (req.body?.pushTest) {
            if (!PUSH_ENABLED && !NATIVE_PUSH_ENABLED) return res.json({ error: 'push not configured — set VAPID and/or native keys' });
            let webSent = 0;
            if (PUSH_ENABLED) {
                const { data: subs } = await supabase.from('push_subscriptions').select('id, subscription').eq('user_id', admin.id);
                for (const s of (subs || [])) {
                    try { await webpush.sendNotification(s.subscription, JSON.stringify({ title: 'MACPrep', body: 'Test push — reminders are working ✓', url: '/', tag: 'macprep-test' })); webSent++; }
                    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await supabase.from('push_subscriptions').delete().eq('id', s.id).then(() => {}, () => {}); }
                }
            }
            const nativeSent = await sendNativeTest(admin.id);
            return res.json({ ok: true, web_test_sent: webSent, native_test_sent: nativeSent });
        }
        const dry = !!req.body?.dry;
        const email = await sendRetentionNudges({ dry });
        const push = (!dry && PUSH_ENABLED) ? await sendPushReminders() : { skipped: dry ? 'dry-run (no push sent)' : 'push not configured' };
        const push_native = (!dry && NATIVE_PUSH_ENABLED) ? await sendNativeReminders() : { skipped: dry ? 'dry-run (no native push sent)' : 'native push not configured' };
        res.json({ email, push, push_native });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin-only funnel/metrics for the founder dashboard (/metrics.html).
app.get('/api/admin/metrics', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Forbidden' });
    if (!supabase) return res.status(500).json({ error: 'no db' });
    try {
        const PRICE = 100;
        const now = Date.now();
        const windowDays = 30;
        const since = new Date(now - windowDays * 86400000).toISOString();
        const [{ data: users }, { data: events }, allPurchases, { data: feedback }] = await Promise.all([
            supabase.from(PROFILE_TABLE).select('email, account_tier, credential, target_exam_date, premium_unlocked_at, created_at, training_program, is_program_director'),
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

        // Credential mix (SAA students vs CAA certified) — normalized from new codes
        // and any legacy long labels. "over time" is visible via recent_signups credentials.
        const normCred = (c) => { if (!c) return null; const u = String(c).trim().toUpperCase(); return u.startsWith('SAA') ? 'SAA' : u.startsWith('CAA') ? 'CAA' : 'other'; };
        const credential_mix = { saa: 0, caa: 0, other: 0, unset: 0 };
        U.forEach((u) => { const c = normCred(u.credential); if (c === 'SAA') credential_mix.saa++; else if (c === 'CAA') credential_mix.caa++; else if (c === 'other') credential_mix.other++; else credential_mix.unset++; });

        // Program (training institution) distribution — how many users belong to each program.
        const progCounts = {};
        U.forEach((u) => { const p = isReviewEmail(u.email) ? 'REVIEW' : (u.training_program || '').trim(); if (p) progCounts[p] = (progCounts[p] || 0) + 1; });
        const program_mix = Object.entries(progCounts).map(([program, n]) => ({ program, n })).sort((a, b) => b.n - a.n);
        const program_unset = U.filter((u) => !isReviewEmail(u.email) && !(u.training_program || '').trim()).length;

        res.json({
            generated_at: new Date(now).toISOString(),
            window_days: windowDays,
            totals: { users: U.length, premium, free: U.length - premium, with_exam_date: U.filter((u) => u.target_exam_date).length },
            credential_mix,
            program_mix,
            program_unset,
            revenue: { paid_conversions: paid, est_revenue: paid * PRICE, price: PRICE },
            funnel,
            event_counts: ec,
            daily: Object.values(buckets),
            recent_signups: U.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, 12)
                .map((u) => ({ email: u.email, tier: u.account_tier, credential: normCred(u.credential), joined: u.created_at, exam_date: u.target_exam_date || null, program: isReviewEmail(u.email) ? 'REVIEW' : (u.training_program || null) })),
            feedback_count: (feedback || []).length,
            recent_feedback: (feedback || []).map((f) => ({ email: f.user_email, text: f.suggestion_text, at: f.created_at })),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Daily reminder scheduler (in-process; dormant without RESEND_API_KEY). Fires in
// a US-morning window; the per-user 20h throttle makes restarts safe.
if (RESEND_API_KEY || PUSH_ENABLED || NATIVE_PUSH_ENABLED) {
    let _lastNudgeDay = null;
    setInterval(async () => {
        try {
            const now = new Date();
            const day = now.toISOString().slice(0, 10);
            const h = now.getUTCHours();
            if (h >= 13 && h < 15 && _lastNudgeDay !== day) {
                _lastNudgeDay = day;
                if (RESEND_API_KEY) { const r = await sendRetentionNudges(); console.log(`[nudges] daily email run: sent ${r.sent}/${r.eligible} eligible (${r.candidates} due)`); }
                if (PUSH_ENABLED) { const rp = await sendPushReminders(); console.log(`[push] daily run: sent ${rp.sent}/${rp.eligible} eligible (${rp.candidates} due)`); }
                if (NATIVE_PUSH_ENABLED) { const rn = await sendNativeReminders(); console.log(`[native-push] daily run: sent ${rn.sent}/${rn.eligible} eligible (${rn.candidates} due)`); }
            }
        } catch (e) { console.error('[nudges] scheduler error:', e.message); }
    }, 30 * 60 * 1000);
    console.log(`[nudges] daily reminder scheduler active (email:${!!RESEND_API_KEY} push:${PUSH_ENABLED} native:${NATIVE_PUSH_ENABLED})`);
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

// Cohort-dashboard authorization — a SEPARATE tier from site-admin. Returns
// { user, program, role, isAdmin } only if the caller may view a cohort:
//   • the site owner (admin) may view ANY program, passed explicitly as ?program=
//   • a faculty/program_director may view ONLY their own assigned faculty_program.
// The program (tenant key) is resolved from the verified token's DB profile — NEVER
// from a client-supplied program id for non-admins. This is the multi-tenant boundary;
// because the service-role client bypasses RLS, this check IS the isolation. Returns
// null for students and unassigned faculty (→ 403). getFacultyUser is read-only; setting
// roles/programs stays admin-only (POST /api/admin/faculty).
async function getFacultyUser(req) {
    const user = await getUserFromToken(req);
    if (!user || !supabase) return null;
    if (isAdminEmail(user.email)) {
        const requested = typeof req.query?.program === 'string' ? req.query.program.trim() : '';
        return { user, program: requested || null, role: 'admin', isAdmin: true };
    }
    const { data: p } = await supabase.from(PROFILE_TABLE)
        .select('is_program_director, is_faculty, faculty_program').eq('user_id', user.id).maybeSingle();
    if (!p) return null;
    const program = (p.faculty_program || '').trim();
    if (!(p.is_program_director || p.is_faculty) || !program) return null;
    return { user, program, role: p.is_program_director ? 'program_director' : 'faculty', isAdmin: false };
}

// Known program-director accounts from the verified-personal-email rows of the outreach
// roster (marketing/program-outreach). Used ONLY to SURFACE likely PD signups in the admin
// faculty panel with their program pre-filled — never to silently auto-elevate (elevation is
// always an explicit admin action on a confirmed-email account). email → { name, program }.
const PD_ROSTER = {
    'leclerc@nova.edu': { name: 'Jermaine Leclerc', program: 'Nova Southeastern University (Fort Lauderdale)' },
    'ec846@nova.edu': { name: 'Elizabeth Carter', program: 'Nova Southeastern University (Tampa)' },
    'ashley.tilton@nova.edu': { name: 'Ashley Tilton', program: 'Nova Southeastern University (Orlando)' },
    'gregg.mastropolo@nova.edu': { name: 'Gregg Mastropolo', program: 'Nova Southeastern University (Jacksonville)' },
    'jk1087@nova.edu': { name: 'Jason Kotun', program: 'Nova Southeastern University (Denver)' },
    'lbeaulieu@southuniversity.edu': { name: 'Leon Beaulieu', program: 'South University (West Palm Beach)' },
    'amills@southuniversity.edu': { name: 'Amanda Mills', program: 'South University (Orlando)' },
    'carie.twichell@case.edu': { name: 'Carie Twichell', program: 'Case Western Reserve University (Cleveland)' },
    'cxt12@case.edu': { name: 'Carie Twichell', program: 'Case Western Reserve University (Cleveland)' },
    'kenneth.maloney@case.edu': { name: 'Kenneth Maloney', program: 'Case Western Reserve University (Houston)' },
    'khm34@case.edu': { name: 'Kenneth Maloney', program: 'Case Western Reserve University (Houston)' },
    'ty.townsend@case.edu': { name: 'Ty Townsend', program: 'Case Western Reserve University (Austin)' },
    'daniel.pistone@case.edu': { name: 'Daniel Pistone', program: 'Case Western Reserve University (Washington DC)' },
    'nflath@neomed.edu': { name: 'Nathaniel Flath', program: 'Northeast Ohio Medical University (NEOMED)' },
    'grabovia@ohiodominican.edu': { name: 'Aaron Grabovich', program: 'Ohio Dominican University' },
    'rbassi@iu.edu': { name: 'Richard Bassi', program: 'Indiana University' },
    'serena.younes@cuanschutz.edu': { name: 'Serena Younes', program: 'University of Colorado (Anschutz)' },
    'carterla@umsystem.edu': { name: 'Lance Crawford Carter', program: 'University of Missouri–Kansas City' },
    'tgoodridge@umhb.edu': { name: 'Timothy Goodridge', program: 'University of Mary Hardin-Baylor' },
    'todd.christian@lipscomb.edu': { name: 'Todd Christian', program: 'Lipscomb University' },
    'toddchristiancaa@gmail.com': { name: 'Todd Christian', program: 'Lipscomb University' },
};
const pdRosterMatch = (email) => PD_ROSTER[String(email || '').trim().toLowerCase()] || null;

// ---------------------------------------------------------------------------
// "All SAAs" benchmark — the anonymized aggregate that STUDENTS compare themselves
// to (per Jake: students see how they stack up against ALL SAAs, never their own
// cohort; per-cohort analysis stays faculty/PD/admin-only). Cached in-memory with a
// short TTL since it scans the whole SAA attempt set. Reused by: the student dashboard
// (you-vs-all-SAAs), per-question grading (SAA peer %), and the faculty cohort
// dashboard (cohort-vs-all-SAAs). At larger scale, replace with a Postgres RPC/matview.
// ---------------------------------------------------------------------------
const SAA_BENCH_TTL = 10 * 60 * 1000;
let _saaBench = { at: 0, byDomain: {}, saaIds: new Set() };
const isSaaCred = (c) => String(c || '').trim().toUpperCase().startsWith('SAA');
async function getSaaBenchmark() {
    if (_saaBench.at && (Date.now() - _saaBench.at) < SAA_BENCH_TTL) return _saaBench;
    if (!supabase) return _saaBench;
    try {
        const { data: profs, error: pErr } = await supabase.from(PROFILE_TABLE).select('user_id, credential');
        if (pErr) throw pErr;
        const saaIds = new Set((profs || []).filter((p) => isSaaCred(p.credential)).map((p) => p.user_id));
        // Served-bank domain map (published-only-consistent with the individual dashboard).
        const qMeta = {};
        for (let from = 0; from < 50000; from += 1000) {
            const { data: chunk, error } = await applyServedFilter(supabase.from('questions').select('id, domain_name')).range(from, from + 999);
            if (error) throw error;
            if (!chunk || !chunk.length) break;
            chunk.forEach((q) => { qMeta[q.id] = q.domain_name || 'General'; });
            if (chunk.length < 1000) break;
        }
        // Aggregate all SAA attempts by domain. Page ALL progress ordered by PK and filter
        // to SAA in JS — avoids a giant .in(user_id) URL as the SAA population grows.
        const byDomain = {};
        if (saaIds.size) {
            for (let from = 0; from < 2000000; from += 1000) {
                const { data: chunk, error } = await supabase.from(PROGRESS_TABLE)
                    .select('user_id, question_id, is_correct').order('id', { ascending: true }).range(from, from + 999);
                if (error) throw error;
                if (!chunk || !chunk.length) break;
                chunk.forEach((r) => {
                    if (!saaIds.has(r.user_id)) return;
                    const dom = qMeta[r.question_id]; if (!dom) return;
                    const bd = byDomain[dom] || (byDomain[dom] = { a: 0, c: 0 });
                    bd.a++; if (r.is_correct) bd.c++;
                });
                if (chunk.length < 1000) break;
            }
        }
        _saaBench = { at: Date.now(), byDomain, saaIds };
    } catch (e) { console.error('[saa-benchmark]', e.message); }
    return _saaBench;
}
// Per-domain SAA accuracy %, only where there's enough signal (keeps it an anonymized
// aggregate, never a stat derived from one or two students).
function saaDomainBenchmark(bench, minAttempts = 20) {
    const out = {};
    Object.entries((bench && bench.byDomain) || {}).forEach(([dom, v]) => { if (v.a >= minAttempts) out[dom] = Math.round((v.c / v.a) * 100); });
    return out;
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
    const credential = ['SAA', 'CAA'].includes(req.body?.credential) ? req.body.credential : null;
    const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const gradDate = isDate(req.body?.graduation_date) ? req.body.graduation_date : null;
    const examDate = isDate(req.body?.target_exam_date) ? req.body.target_exam_date : null;

    if (!supabaseAuth) return res.status(500).json({ success: false, error: 'Auth not configured.' });
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required.' });

    try {
        if (action === 'register') {
            // Credential is required at signup; students (SAA) must add a graduation
            // date so the account can auto-promote to CAA when they graduate.
            if (!credential) return res.status(400).json({ success: false, error: 'Please select your credential (SAA or CAA).' });
            if (credential === 'SAA' && !gradDate) return res.status(400).json({ success: false, error: 'Students (SAA) must add a graduation date.' });
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
                    .upsert({ user_id: data.user.id, email, account_tier: 'free', full_name: (typeof name === 'string' && name.trim()) ? name.trim().replace(/\s+/g, ' ') : null, credential, graduation_date: gradDate, target_exam_date: examDate }, { onConflict: 'user_id' })
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
        // resetPasswordForEmail returns { error } rather than throwing for most
        // failures (bad SMTP config, provider rejection, rate limit) — capture BOTH
        // paths. Password recovery is critical, so failures must be observable in the
        // server logs even though the client always gets the same generic response.
        const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, { redirectTo: `${base}/reset.html` });
        if (error) console.error(`[reset-request] resetPasswordForEmail failed: ${error.message || error}`);
    } catch (err) { console.error(`[reset-request] unexpected error: ${err?.message || err}`); }
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
        await supabase.from('user_flashcards').delete().eq('user_id', user.id).then(() => {}, () => {});
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
        // PostgREST caps a request at ~1000 rows, so page through the full 30-day
        // window instead of silently seeing only the oldest 1000 events (which made
        // every "last 7 days" count read ~0).
        const PAGE = 1000;
        let rows = [];
        for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabase.from('analytics_events')
                .select('name, user_id, created_at')
                .gte('created_at', since)
                .order('created_at', { ascending: false })
                .range(from, from + PAGE - 1);
            if (error) throw error;
            rows = rows.concat(data || []);
            if (!data || data.length < PAGE) break;
        }
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
// Question-edit review queue. Proposed choice rewrites (e.g. answer-length
// rebalancing) live in `question_edits` as status='pending' and NEVER touch the
// live published question until an admin approves — preserving clinician sign-off.
// ---------------------------------------------------------------------------
app.get('/api/admin/edits', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    try {
        const { data, error } = await supabase
            .from('question_edits')
            .select('id, question_id, batch, kind, original_choices, proposed_choices, note, status, created_at')
            .eq('status', 'pending')
            .order('id', { ascending: true })
            .limit(500);
        if (error) throw error;
        const ids = [...new Set((data || []).map((e) => e.question_id))];
        const qmap = {};
        if (ids.length) {
            const { data: qs } = await supabase.from('questions').select('id, stem, category, subtopic, difficulty').in('id', ids);
            (qs || []).forEach((q) => { qmap[q.id] = q; });
        }
        const edits = (data || []).map((e) => ({ ...e, question: qmap[e.question_id] || null }));
        const STATUSES = ['pending', 'approved', 'rejected'];
        const cr = await Promise.all(STATUSES.map((s) => supabase.from('question_edits').select('id', { count: 'exact', head: true }).eq('status', s)));
        const counts = {}; STATUSES.forEach((s, i) => { counts[s] = cr[i].count || 0; });
        return res.json({ edits, counts });
    } catch (err) {
        console.error('Edits list failure:', err.message);
        return res.status(500).json({ error: 'Could not load edits.' });
    }
});

app.post('/api/admin/edit', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    const id = parseInt(req.body?.id, 10);
    const action = String(req.body?.action || '');
    if (!id || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Bad request.' });
    try {
        const { data: edit, error: e1 } = await supabase.from('question_edits').select('id, question_id, proposed_choices, status').eq('id', id).maybeSingle();
        if (e1) throw e1;
        if (!edit) return res.status(404).json({ error: 'Edit not found.' });
        if (edit.status !== 'pending') return res.json({ success: true, already: true });
        if (action === 'approve') {
            const finalChoices = Array.isArray(req.body?.choices) && req.body.choices.length ? req.body.choices : edit.proposed_choices;
            // Answer-key guard: exactly one correct choice must remain, or refuse.
            const nCorrect = (finalChoices || []).filter((c) => c && c.correct === true).length;
            if (nCorrect !== 1) return res.status(400).json({ error: 'Edit must keep exactly one correct choice.' });
            const { error: e2 } = await supabase.from('questions').update({ choices: finalChoices }).eq('id', edit.question_id);
            if (e2) throw e2;
            const { error: e3 } = await supabase.from('question_edits').update({ status: 'approved', proposed_choices: finalChoices, reviewed_at: new Date().toISOString() }).eq('id', id);
            if (e3) throw e3;
        } else {
            const { error: e4 } = await supabase.from('question_edits').update({ status: 'rejected', reviewed_at: new Date().toISOString() }).eq('id', id);
            if (e4) throw e4;
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('Edit action failure:', err.message);
        return res.status(500).json({ error: 'Could not apply edit.' });
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
// Program-director / faculty COHORT DASHBOARD.
//   • Admin-only: list current faculty/PD + elevate/assign (POST /api/admin/faculty).
//   • Faculty/PD-only: read THEIR OWN program's cohort roll-up (GET /api/faculty/cohort).
// Isolation is enforced entirely in application code (service-role bypasses RLS): the
// program (tenant key) is resolved from the verified token's DB profile via getFacultyUser,
// never from a client-supplied program id. Elevation requires a confirmed email.
// ---------------------------------------------------------------------------
app.get('/api/admin/faculty', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    if (!supabase) return res.status(500).json({ error: 'no db' });
    try {
        const { data: rows } = await supabase.from(PROFILE_TABLE)
            .select('email, full_name, credential, training_program, is_program_director, is_faculty, faculty_program');
        const U = rows || [];
        const faculty = U.filter((u) => u.is_program_director || u.is_faculty)
            .map((u) => ({ email: u.email, name: u.full_name || null, role: u.is_program_director ? 'program_director' : 'faculty', program: u.faculty_program || null }))
            .sort((a, b) => (a.program || '').localeCompare(b.program || ''));
        // Likely PD signups (verified-personal-email roster match) not yet elevated — one-click confirm.
        const suggestions = U.filter((u) => pdRosterMatch(u.email) && !(u.is_program_director || u.is_faculty))
            .map((u) => { const m = pdRosterMatch(u.email); return { email: u.email, name: u.full_name || m.name, suggested_program: m.program }; });
        // Distinct captured programs + student counts (populates the assign dropdown).
        const progCounts = {};
        U.forEach((u) => { const p = (u.training_program || '').trim(); if (p) progCounts[p] = (progCounts[p] || 0) + 1; });
        const programs = Object.entries(progCounts).map(([program, students]) => ({ program, students })).sort((a, b) => a.program.localeCompare(b.program));
        return res.json({ faculty, suggestions, programs });
    } catch (err) {
        console.error('admin/faculty list failure:', err.message);
        return res.status(500).json({ error: 'Could not load faculty.' });
    }
});

app.post('/api/admin/faculty', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    if (!supabase) return res.status(500).json({ error: 'no db' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = ['program_director', 'faculty', 'none'].includes(req.body?.role) ? req.body.role : null;
    const program = typeof req.body?.program === 'string' ? req.body.program.trim().slice(0, 200) : '';
    if (!email || !role) return res.status(400).json({ error: 'email and role are required.' });
    if (role !== 'none' && !program) return res.status(400).json({ error: 'A program is required to grant faculty/PD access.' });
    try {
        // Resolve the target by email server-side (never a client-supplied id).
        const { data: prof } = await supabase.from(PROFILE_TABLE).select('user_id, email').eq('email', email).maybeSingle();
        if (!prof) return res.status(404).json({ error: 'No MACPrep account with that email.' });
        // SECURITY: only elevate a VERIFIED account. Profile rows are created at signup BEFORE
        // email confirmation, so an email-match alone is an impersonation vector — require a
        // confirmed auth email before granting access to a cohort's student data.
        if (role !== 'none') {
            let confirmed = false;
            try {
                const { data: au } = await supabase.auth.admin.getUserById(prof.user_id);
                confirmed = !!(au && au.user && au.user.email_confirmed_at);
            } catch (e) { confirmed = false; }
            if (!confirmed) return res.status(400).json({ error: 'That account has not confirmed its email — cannot grant cohort access until it does.' });
        }
        const update = role === 'none'
            ? { is_program_director: false, is_faculty: false, faculty_program: null }
            : { is_program_director: role === 'program_director', is_faculty: role === 'faculty', faculty_program: program };
        update.updated_at = new Date().toISOString();
        const { error } = await supabase.from(PROFILE_TABLE).update(update).eq('user_id', prof.user_id);
        if (error) throw error;
        return res.json({ success: true, email, role, program: role === 'none' ? null : program });
    } catch (err) {
        console.error('admin/faculty set failure:', err.message);
        return res.status(500).json({ error: 'Could not update faculty role.' });
    }
});

app.get('/api/faculty/cohort', cohortLimiter, async (req, res) => {
    const ctx = await getFacultyUser(req);
    if (!ctx) return res.status(403).json({ error: 'The cohort dashboard is for program directors and faculty.' });
    if (!supabase) return res.status(500).json({ error: 'no db' });
    try {
        // For admins: the full program list (with student counts) for the program-switcher
        // dropdown, attached to EVERY response so an admin can jump between programs without
        // leaving the page. Faculty/PD never get this — they only ever see their own program.
        let adminPrograms = null;
        if (ctx.isAdmin) {
            const { data: rows, error: pErr } = await supabase.from(PROFILE_TABLE).select('training_program');
            if (pErr) throw pErr;
            const counts = {};
            (rows || []).forEach((r) => { const p = (r.training_program || '').trim(); if (p) counts[p] = (counts[p] || 0) + 1; });
            adminPrograms = Object.entries(counts).map(([program, students]) => ({ program, students })).sort((a, b) => a.program.localeCompare(b.program));
        }
        // Admin without ?program= → prompt to pick one (faculty always have their own).
        if (!ctx.program) {
            return res.json({ role: ctx.role, is_admin: ctx.isAdmin, need_program: true, programs: adminPrograms || [] });
        }
        const program = ctx.program;
        // Cohort = student accounts whose training_program is this program (exclude faculty/PD/review).
        const { data: members, error: mErr } = await supabase.from(PROFILE_TABLE)
            .select('user_id, email, full_name, credential, graduation_date, is_program_director, is_faculty')
            .eq('training_program', program);
        if (mErr) throw mErr;
        // Cohort = CURRENT students only. A program director sees SAAs enrolled in their
        // program — never CAAs (alumni who previously attended). We exclude stored-CAA
        // accounts AND SAAs whose graduation date has passed (they are effectively CAAs now).
        const nowMs = Date.now();
        const cohort = (members || []).filter((m) => {
            if (m.is_program_director || m.is_faculty || isReviewEmail(m.email)) return false;
            if (!isSaaCred(m.credential)) return false;
            if (m.graduation_date) { const g = new Date(m.graduation_date + 'T00:00:00Z'); if (!isNaN(g.getTime()) && g.getTime() <= nowMs) return false; }
            return true;
        });
        const perStudent = {};
        const cohortIds = [];
        cohort.forEach((m) => { perStudent[m.user_id] = { attempts: 0, correct: 0, answered: new Set(), last: null }; cohortIds.push(m.user_id); });
        if (!cohortIds.length) {
            return res.json({ role: ctx.role, is_admin: ctx.isAdmin, programs: adminPrograms, program, cohort_size: 0, roster: [], by_domain: [], summary: { attempts: 0, answered: 0, accuracy: null, active_7d: 0 } });
        }
        // Served-bank snapshot: question_id -> NCCAA domain_name (same source of truth as the
        // individual dashboard; keep published-only consistent so student + PD views reconcile).
        const qMeta = {};
        for (let from = 0; from < 50000; from += 1000) {
            const { data: chunk, error: qErr } = await applyServedFilter(supabase.from('questions').select('id, domain_name')).range(from, from + 999);
            if (qErr) throw qErr;
            if (!chunk || !chunk.length) break;
            chunk.forEach((q) => { qMeta[q.id] = q.domain_name || 'General'; });
            if (chunk.length < 1000) break;
        }
        // All cohort attempts, PAGINATED (PostgREST caps 1000 rows/request; a cohort exceeds it).
        const attempts = [];
        for (let from = 0; from < 500000; from += 1000) {
            const { data: chunk, error: aErr } = await supabase.from(PROGRESS_TABLE)
                .select('user_id, question_id, is_correct, created_at, time_ms, answer_changed').in('user_id', cohortIds).range(from, from + 999);
            if (aErr) throw aErr;
            if (!chunk || !chunk.length) break;
            attempts.push(...chunk);
            if (chunk.length < 1000) break;
        }
        const NCCAA = ['Principles of Anesthesia', 'Physiology, Pathophysiology & Management', 'Instrumentation, Monitoring & Anesthetic Delivery Systems', 'Subspecialty Care', 'Pharmacology', 'Regional Anesthesia & Pain Management'];
        const domAcc = {}; NCCAA.forEach((d) => { domAcc[d] = { attempts: 0, correct: 0 }; });
        const perQ = {}; // per-question cohort stats for the per-item ("hardest questions") view
        const now = Date.now(); let active7 = 0;
        attempts.forEach((r) => {
            const s = perStudent[r.user_id]; if (!s) return;
            s.attempts++; if (r.is_correct) s.correct++; s.answered.add(r.question_id);
            if (!s.last || r.created_at > s.last) s.last = r.created_at;
            const dom = qMeta[r.question_id];
            if (dom && domAcc[dom]) { domAcc[dom].attempts++; if (r.is_correct) domAcc[dom].correct++; }
            const pq = perQ[r.question_id] || (perQ[r.question_id] = { a: 0, c: 0, tSum: 0, tN: 0, chN: 0, chTot: 0 });
            pq.a++; if (r.is_correct) pq.c++;
            if (Number.isFinite(r.time_ms) && r.time_ms > 0) { pq.tSum += r.time_ms; pq.tN++; }
            if (typeof r.answer_changed === 'boolean') { pq.chTot++; if (r.answer_changed) pq.chN++; }
        });
        // Benchmark each domain against ALL SAAs (anonymized aggregate) so a PD sees how
        // their cohort compares to the whole student population.
        const saaBench = saaDomainBenchmark(await getSaaBenchmark(), 20);
        const by_domain = NCCAA.map((d) => ({ domain: d, attempts: domAcc[d].attempts, correct: domAcc[d].correct, accuracy: domAcc[d].attempts ? Math.round(domAcc[d].correct / domAcc[d].attempts * 100) : null, saa_accuracy: (saaBench[d] != null ? saaBench[d] : null) }));
        const roster = cohort.map((m) => {
            const s = perStudent[m.user_id];
            if (s.last && (now - new Date(s.last).getTime()) < 7 * 86400000) active7++;
            return { name: m.full_name || null, email: m.email, credential: m.credential || null, attempts: s.attempts, answered: s.answered.size, accuracy: s.attempts ? Math.round(s.correct / s.attempts * 100) : null, last_active: s.last };
        }).sort((a, b) => b.attempts - a.attempts);
        const totAtt = attempts.length;
        const totCorrect = attempts.reduce((a, r) => a + (r.is_correct ? 1 : 0), 0);
        const answeredAll = new Set(attempts.map((r) => r.question_id)).size;
        // Per-item cohort analytics (Phase 3): the questions the cohort misses most
        // (lowest %-correct, >=3 cohort attempts) with avg time-on-item + answer-change rate.
        const ranked = Object.entries(perQ)
            .filter(([, v]) => v.a >= 3)
            .map(([qid, v]) => ({ qid, attempts: v.a, pct_correct: Math.round((v.c / v.a) * 100), avg_time_ms: v.tN ? Math.round(v.tSum / v.tN) : null, change_rate: v.chTot ? Math.round((v.chN / v.chTot) * 100) : null }))
            .sort((a, b) => (a.pct_correct - b.pct_correct) || (b.attempts - a.attempts))
            .slice(0, 15);
        let hardest_items = [];
        if (ranked.length) {
            const { data: qrows } = await supabase.from('questions').select('id, stem, domain_name, question_type').in('id', ranked.map((x) => x.qid));
            const qm = {}; (qrows || []).forEach((q) => { qm[q.id] = q; });
            hardest_items = ranked.map((x) => {
                const q = qm[x.qid] || {};
                const stem = String(q.stem || '').replace(/\s+/g, ' ').trim();
                return { question_id: x.qid, stem: stem.length > 160 ? stem.slice(0, 157) + '…' : stem, domain: q.domain_name || null, question_type: q.question_type || null, attempts: x.attempts, pct_correct: x.pct_correct, avg_time_ms: x.avg_time_ms, change_rate: x.change_rate };
            });
        }
        return res.json({
            role: ctx.role, is_admin: ctx.isAdmin, programs: adminPrograms, program, cohort_size: cohort.length,
            summary: { attempts: totAtt, answered: answeredAll, accuracy: totAtt ? Math.round(totCorrect / totAtt * 100) : null, active_7d: active7 },
            by_domain, roster, hardest_items, generated_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error('faculty/cohort failure:', err.message);
        return res.status(500).json({ error: 'Could not load cohort.' });
    }
});

// ---------------------------------------------------------------------------
// Weekly study leaderboard (global). Ranks opted-in users by questions answered
// this week (resets Monday 00:00 UTC) and shows each player's study streak.
// Privacy: opt-in only, shown by a chosen handle — never email or real name.
// ---------------------------------------------------------------------------
function lbNyParts(d) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' });
    const p = {}; f.formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return p;
}
// UTC ms for a given America/New_York wall-clock time (DST-correct via convergence).
function lbEtWallToUTC(y, mo, da, hh, mm, ss) {
    const target = Date.UTC(y, mo - 1, da, hh, mm, ss);
    let ts = target;
    for (let i = 0; i < 3; i++) {
        const p = lbNyParts(new Date(ts));
        const diff = target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
        if (diff === 0) break;
        ts += diff;
    }
    return ts;
}
// Most recent Monday 07:00 America/New_York — the weekly reset boundary — as a UTC Date.
function lbWeekStartUTC() {
    const now = new Date();
    const p = lbNyParts(now);
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    const sinceMon = (wd + 6) % 7;
    const mon = new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - sinceMon * 86400000);
    let ts = lbEtWallToUTC(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate(), 7, 0, 0);
    if (now.getTime() < ts) { const prev = new Date(mon.getTime() - 7 * 86400000); ts = lbEtWallToUTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 7, 0, 0); }
    return new Date(ts);
}
// Day key in ET calendar days, so streaks track the user's own days, not UTC.
function lbDayKey(d) { const p = lbNyParts(new Date(d)); return `${p.year}-${p.month}-${p.day}`; }
// "First name + last initial" — the only identity shown on the board (never full name/email).
// Strips any credential/comma a user may have typed into their name (e.g. "Lee, CAA").
function lbShortName(full) {
    const clean = String(full || '')
        .replace(/\b(SAA|CAA|C-AA|AA-C|MD|DO|CRNA|RN|SRNA)\b\.?/gi, '')
        .replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = clean.split(' ').filter(Boolean);
    if (!parts.length) return '';
    const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    return parts.length === 1 ? first : `${first} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}
const LB_MIN_ACCURACY_QS = 20; // minimum questions this week to qualify for the accuracy board
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
    if (!supabase) return res.json({ boards: { streak: [], weekly: [], accuracy: [] }, me: null });
    try {
        const weekStart = lbWeekStartUTC();
        const weekResetsAt = new Date(weekStart.getTime() + 7 * 86400000).toISOString();
        // Board = opted-in players who have added a real name (a "First L." to show).
        const { data: players } = await supabase.from(PROFILE_TABLE)
            .select('user_id, full_name, selected_title')
            .eq('leaderboard_opt_in', true).not('full_name', 'is', null);
        const playerList = (players || []).filter((p) => lbShortName(p.full_name));
        const allIds = Array.from(new Set([...playerList.map((p) => p.user_id), user.id])).slice(0, 2000);
        const weekAtt = {}, weekCorrect = {}, daysByUser = {};
        if (allIds.length) {
            const { data: wp } = await supabase.from(PROGRESS_TABLE)
                .select('user_id, is_correct').in('user_id', allIds).gte('created_at', weekStart.toISOString());
            (wp || []).forEach((r) => { weekAtt[r.user_id] = (weekAtt[r.user_id] || 0) + 1; if (r.is_correct) weekCorrect[r.user_id] = (weekCorrect[r.user_id] || 0) + 1; });
            const since = new Date(Date.now() - 120 * 86400000).toISOString();
            const { data: ap } = await supabase.from(PROGRESS_TABLE)
                .select('user_id, created_at').in('user_id', allIds).gte('created_at', since);
            (ap || []).forEach((r) => { (daysByUser[r.user_id] = daysByUser[r.user_id] || new Set()).add(lbDayKey(r.created_at)); });
        }
        const stat = (uid) => {
            const attempts = weekAtt[uid] || 0, correct = weekCorrect[uid] || 0;
            return { weekly: attempts, correct, attempts, accuracy: attempts ? Math.round((correct / attempts) * 1000) / 10 : 0, streak: lbStreak(daysByUser[uid] || new Set()) };
        };
        const enriched = playerList.map((p) => ({ user_id: p.user_id, name: lbShortName(p.full_name), title: p.selected_title || '', is_me: p.user_id === user.id, ...stat(p.user_id) }));
        const rankBoard = (metric, tiebreak, filterFn) => enriched
            .filter(filterFn || (() => true))
            .sort((a, b) => (b[metric] - a[metric]) || (b[tiebreak] - a[tiebreak]) || a.name.localeCompare(b.name))
            .map((p, i) => ({ rank: i + 1, name: p.name, title: p.title, streak: p.streak, weekly: p.weekly, accuracy: p.accuracy, attempts: p.attempts, is_me: p.is_me }))
            .slice(0, 50);
        const boards = {
            streak: rankBoard('streak', 'weekly'),
            weekly: rankBoard('weekly', 'streak'),
            accuracy: rankBoard('accuracy', 'attempts', (p) => p.attempts >= LB_MIN_ACCURACY_QS),
        };
        const rankIn = (b) => { const r = boards[b].find((x) => x.is_me); return r ? r.rank : null; };
        // My own opt-in + name, even if I haven't made the board (e.g. no name yet).
        let myOptIn = true, myName = null;
        const mine = playerList.find((p) => p.user_id === user.id);
        if (mine) { myOptIn = true; myName = lbShortName(mine.full_name); }
        else {
            const { data: mp } = await supabase.from(PROFILE_TABLE).select('leaderboard_opt_in, full_name').eq('user_id', user.id).maybeSingle();
            myOptIn = mp ? !!mp.leaderboard_opt_in : true;
            myName = mp && lbShortName(mp.full_name) ? lbShortName(mp.full_name) : null;
        }
        const mv = stat(user.id);
        return res.json({
            week_resets_at: weekResetsAt,
            min_accuracy_qs: LB_MIN_ACCURACY_QS,
            boards,
            me: {
                opted_in: myOptIn, has_name: !!myName, name: myName,
                weekly: mv.weekly, streak: mv.streak, accuracy: mv.accuracy, attempts: mv.attempts,
                rank_streak: rankIn('streak'), rank_weekly: rankIn('weekly'), rank_accuracy: rankIn('accuracy'),
                qualifies_accuracy: (mv.attempts || 0) >= LB_MIN_ACCURACY_QS,
                players: enriched.length,
            },
        });
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
    try {
        const { data, error } = await supabase.from(PROFILE_TABLE).update({ leaderboard_opt_in: optIn }).eq('user_id', user.id).select('user_id');
        if (error) throw error;
        if (!data || !data.length) {
            const { error: insErr } = await supabase.from(PROFILE_TABLE).upsert({ user_id: user.id, email: user.email, leaderboard_opt_in: optIn }, { onConflict: 'user_id' });
            if (insErr) throw insErr;
        }
        return res.json({ success: true, opt_in: optIn });
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
            specialty: q.category || q.domain_name || '',   // broad category only — q.specialty is granular and can name the answer
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

// Flashcard deck (premium). Returns questions WITH the correct answer text,
// rationale, and sources so the client can render type-then-flip active-recall
// cards. Gated to premium since it reveals answer keys. This is a read-only
// reveal — it does NOT record a graded attempt (recall is self-assessed).
app.get('/api/flashcards', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!(await isUserPremium(user.id))) {
        return res.status(402).json({ error: 'Flashcard mode is a premium feature.', paywall: true });
    }
    const idsParam = (req.query.ids || '').toString().trim();
    const ids = idsParam ? idsParam.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200) : [];
    const count = ids.length ? ids.length : Math.min(Math.max(parseInt(req.query.count, 10) || 20, 1), 100);
    const category = (req.query.category || 'all').toString();
    try {
        let query = supabase.from('questions').select('id, category, domain_name, subtopic, stem, choices, correct_answer, explanation, "references"');
        query = applyServedFilter(query);
        if (ids.length) query = query.in('id', ids);
        else if (category && category !== 'all') query = query.eq('category', category);
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
            const cc = choices[correctIndex];
            const correctText = cc ? (typeof cc === 'object' && cc ? (cc.text || '') : cc) : '';
            let references = q.references;
            if (typeof references === 'string') { try { references = JSON.parse(references); } catch (e) { references = []; } }
            return {
                id: q.id,
                category: q.category || q.domain_name || 'General',
                subtopic: q.subtopic || '',
                stem: q.stem || '',
                correctLetter: correctIndex >= 0 ? String.fromCharCode(65 + correctIndex) : '?',
                correctText,
                explanation: q.explanation || '',
                references: Array.isArray(references) ? references : [],
            };
        });
        return res.json({ cards: picked });
    } catch (err) {
        console.error('Flashcards failure:', err.message);
        return res.status(500).json({ error: 'Could not build flashcards.' });
    }
});

// Critical Event cards (premium). Clinician-reviewed rapid-reference cards for
// anesthesia crises. The content bundle (data/critical-events.json — card HTML +
// scoped CSS) is NOT served statically (see BLOCKED_STATIC / the /data/ guard);
// it is delivered only through this premium-gated endpoint so free users can't
// read the paid content by hitting a URL.
let _ceBundle = null;
function loadCriticalEvents() {
    if (_ceBundle) return _ceBundle;
    try {
        _ceBundle = JSON.parse(readFileSync(path.join(__dirname, '../data/critical-events.json'), 'utf8'));
    } catch (e) {
        console.error('Critical Events bundle load failed:', e.message);
        _ceBundle = { count: 0, css: '', html: '' };
    }
    return _ceBundle;
}
app.get('/api/critical-events', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!(await isUserPremium(user.id))) {
        return res.status(402).json({ error: 'Critical Event cards are a premium feature.', paywall: true });
    }
    const ce = loadCriticalEvents();
    if (!ce.count) return res.status(500).json({ error: 'Critical Events are unavailable right now.' });
    res.set('Cache-Control', 'private, max-age=300');
    return res.json(ce);
});

// Gamification sync (authenticated). Bonus XP, claimed achievements, and daily-quest
// state used to live only in each browser (localStorage), so a phone and a laptop
// drifted apart. Persist them on the account; the client merges its local copy on load
// and posts here, where we UNION so no device can clobber another's progress.
app.post('/api/gamification', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const b = req.body || {};
    try {
        const { data: cur } = await supabase.from(PROFILE_TABLE).select('bonus_xp, ach_claimed, daily_state').eq('user_id', user.id).maybeSingle();
        const ach_claimed = [...new Set([...(Array.isArray(cur?.ach_claimed) ? cur.ach_claimed : []), ...(Array.isArray(b.ach_claimed) ? b.ach_claimed : [])].filter((x) => typeof x === 'string'))].slice(0, 500);
        const mergeDaily = (A0, B0) => {
            const out = {}; const keys = new Set([...Object.keys(A0 || {}), ...Object.keys(B0 || {})]);
            for (const k of keys) { const A = (A0 && A0[k]) || {}, B2 = (B0 && B0[k]) || {};
                out[k] = { answered: Math.max(+A.answered || 0, +B2.answered || 0), correct: Math.max(+A.correct || 0, +B2.correct || 0), specs: [...new Set([...(A.specs || []), ...(B2.specs || [])])].slice(0, 12), rewarded: [...new Set([...(A.rewarded || []), ...(B2.rewarded || [])])].slice(0, 12), chest: !!(A.chest || B2.chest) }; }
            const trimmed = {}; Object.keys(out).sort().slice(-5).forEach((k) => { trimmed[k] = out[k]; }); return trimmed;
        };
        const daily_state = mergeDaily(cur?.daily_state, b.daily_state);
        const bonus_xp = Math.max(+(cur?.bonus_xp) || 0, +(b.bonus_xp) || 0);
        const { error } = await supabase.from(PROFILE_TABLE).update({ bonus_xp, ach_claimed, daily_state }).eq('user_id', user.id);
        if (error) throw error;
        return res.json({ bonus_xp, ach_claimed, daily_state });
    } catch (err) {
        console.error('Gamification sync failure:', err.message);
        return res.status(500).json({ error: 'Could not sync progress.' });
    }
});

// ---------------------------------------------------------------------------
// Grade a single answer server-side. Authenticated. The free-tier ceiling is
// enforced from the server's own count of distinct questions the user has
// answered (user_progress) — never from a client-reported number.
// ---------------------------------------------------------------------------
app.post('/api/grade', async (req, res) => {
    const { questionId, choiceIndex, time_ms: timeMsRaw, answer_changed: changedRaw } = req.body || {};
    // Per-attempt analytics (Phase 3): time-on-item (ms, capped at 30 min to drop
    // "left the tab open" outliers) + whether the user changed their selection.
    const timeMs = (Number.isFinite(Number(timeMsRaw)) && Number(timeMsRaw) > 0 && Number(timeMsRaw) <= 1800000) ? Math.round(Number(timeMsRaw)) : null;
    const answerChanged = (typeof changedRaw === 'boolean') ? changedRaw : null;
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
            time_ms: timeMs,
            answer_changed: answerChanged,
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
            // Peer comparison is scoped to ALL SAAs (students) — never the user's own cohort
            // (Jake's rule). saaIds comes from the cached SAA benchmark; we filter this
            // question's responses to SAA accounts before computing %-correct + choice mix.
            const bench = await getSaaBenchmark();
            const saaIds = bench.saaIds || new Set();
            const { data: rows } = await supabase.from(PROGRESS_TABLE).select('is_correct, selected_label, user_id').eq('question_id', String(questionId));
            const saaRows = (rows || []).filter((r) => saaIds.has(r.user_id));
            if (saaRows.length) {
                responseCount = saaRows.length;
                if (saaRows.length >= 3) peerPct = Math.round((saaRows.filter((r) => r.is_correct).length / saaRows.length) * 100);
                const counts = new Array(choices.length).fill(0);
                let total = 0;
                saaRows.forEach((r) => {
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
            peer_group: 'SAA',
            choice_distribution: choiceDistribution,
            response_count: responseCount,
        });
    } catch (err) {
        console.error('Grade route failure:', err.message);
        return res.status(500).json({ error: 'Grading failure.' });
    }
});

// User cosmetics — active title, shown on the dashboard, sidebar, and
// leaderboard. Unlock-gating is enforced client-side (low-stakes flair earned
// from achievements); the server stores the selection and echoes it back.
app.post('/api/user/cosmetics', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const b = req.body || {};
    const upd = {};
    if ('title' in b) upd.selected_title = String(b.title || '').trim().slice(0, 40) || null;
    if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update.' });
    try {
        const { error } = await supabase.from(PROFILE_TABLE).update(upd).eq('user_id', user.id);
        if (error) throw error;
        return res.json({ success: true, ...upd });
    } catch (err) {
        console.error('Cosmetics update failure:', err.message);
        return res.status(500).json({ error: 'Could not save.' });
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
            .select('email, account_tier, premium_unlocked_at, created_at, is_program_director, is_faculty, faculty_program, full_name, credential, graduation_date, training_program, target_exam_date, phone, study_goal, theme, font, leaderboard_handle, leaderboard_opt_in, selected_title, bonus_xp, ach_claimed, daily_state')
            .eq('user_id', user.id)
            .maybeSingle();
        if (error) throw error;

        // Derive study stats from recorded progress, including accuracy by specialty.
        const { data: progress } = await supabase
            .from(PROGRESS_TABLE)
            .select('question_id, is_correct, category, created_at, confidence')
            .eq('user_id', user.id)
            .order('created_at', { ascending: true });

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
        const { data: fcards } = await supabase.from('user_flashcards').select('question_id').eq('user_id', user.id);
        const flashcard_ids = (fcards || []).map((f) => f.question_id);

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

        // Coverage: distinct answered vs total served per category. Paginate the bank —
        // a plain .select() is capped at 1000 rows, so once the bank grew past 1000 every
        // category was undercounted (totals summed to 1000 instead of the real bank size).
        const bankRows = [];
        for (let from = 0; from < 50000; from += 1000) {
            const { data: chunk } = await applyServedFilter(supabase.from('questions').select('id, category, domain_name, difficulty')).range(from, from + 999);
            if (!chunk || !chunk.length) break;
            bankRows.push(...chunk);
            if (chunk.length < 1000) break;
        }
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

        // ---- Adaptive engine inputs: per-domain ability (Elo) + mastery -------
        // The served bank rows (paged above) carry each question's domain + difficulty.
        // Replay the user's attempts in time order as a lightweight Elo per NCCAA
        // domain: each answer nudges the domain rating toward/away from the
        // question's difficulty rating. The client uses `target` to serve
        // difficulty matched to the learner (with a slight upward stretch) and
        // `mastery` to rank weakest domains + drive the readiness view. All
        // derived on the fly from history — no schedule table, works retroactively.
        const qMeta = {};
        const bankByDomain = {};
        (bankRows || []).forEach((r) => {
            const dn = r.domain_name || 'General';
            qMeta[r.id] = { domain: dn, difficulty: String(r.difficulty || 'medium').toLowerCase() };
            bankByDomain[dn] = (bankByDomain[dn] || 0) + 1;
        });
        const DIFF_RATING = { easy: 900, medium: 1100, hard: 1300 };
        const ELO_K = 24, ELO_START = 1100;
        const domAbility = {};
        const ensureDom = (d) => (domAbility[d] = domAbility[d] || { theta: ELO_START, attempts: 0, correct: 0, answered: new Set() });
        Object.keys(bankByDomain).forEach(ensureDom); // every served domain appears, even untouched
        (progress || []).forEach((r) => {
            const meta = qMeta[r.question_id];
            if (!meta) return; // attempt on a question no longer served — skip ability update
            const D = ensureDom(meta.domain);
            const qr = DIFF_RATING[meta.difficulty] || ELO_START;
            const expected = 1 / (1 + Math.pow(10, (qr - D.theta) / 400));
            D.theta += ELO_K * ((r.is_correct ? 1 : 0) - expected);
            if (D.theta < 700) D.theta = 700; else if (D.theta > 1500) D.theta = 1500;
            D.attempts++; if (r.is_correct) D.correct++;
            D.answered.add(r.question_id);
        });
        const DOMAIN_ORDER = [
            'Principles of Anesthesia',
            'Physiology, Pathophysiology & Management',
            'Instrumentation, Monitoring & Anesthetic Delivery Systems',
            'Subspecialty Care',
            'Pharmacology',
            'Regional Anesthesia & Pain Management',
        ];
        const by_domain = Object.keys(domAbility).map((d) => {
            const D = domAbility[d];
            const theta = Math.round(D.theta);
            const target = theta + 40; // desirable-difficulty stretch just above current ability
            return {
                domain: d,
                attempts: D.attempts,
                correct: D.correct,
                accuracy: D.attempts ? Math.round((D.correct / D.attempts) * 100) : null,
                answered: D.answered.size,
                total: bankByDomain[d] || 0,
                ability: theta,
                target,
                target_tier: target >= 1200 ? 'hard' : target >= 1000 ? 'medium' : 'easy',
                mastery: D.attempts >= 5 ? Math.max(0, Math.min(100, Math.round(((theta - 800) / 600) * 100))) : null,
            };
        }).sort((a, b) => {
            const ia = DOMAIN_ORDER.indexOf(a.domain), ib = DOMAIN_ORDER.indexOf(b.domain);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });

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

        // Effective credential: an SAA (student) whose graduation date has passed is
        // treated as a CAA from that day on (computed, no scheduled job) — this is what
        // gates the future CME section to CAAs. Source of truth stays credential + grad date.
        const rawCred = profile?.credential || null;
        const gradDate = profile?.graduation_date || null;
        // Normalize both new codes ("SAA"/"CAA") and legacy long labels ("SAA (student …)")
        // to a bare code so the auto-upgrade + gating logic is consistent. Non-AA values
        // (e.g. "Anesthesiologist", "Other") pass through unchanged and never prompt.
        let credCode = rawCred;
        if (rawCred) { const u = rawCred.trim().toUpperCase(); credCode = u.startsWith('SAA') ? 'SAA' : u.startsWith('CAA') ? 'CAA' : rawCred; }
        let credentialEffective = credCode;
        if (credCode === 'SAA' && gradDate) {
            const g = new Date(gradDate + 'T00:00:00Z');
            if (!isNaN(g.getTime()) && g.getTime() <= Date.now()) credentialEffective = 'CAA';
        }
        // Prompt for credential when it's missing, or when an SAA has no graduation date yet.
        const needsCredential = !credCode || (credCode === 'SAA' && !gradDate);
        // Peer benchmark: how this user's domains compare to ALL SAAs (anonymized aggregate;
        // students compare to the whole SAA population, never their own cohort).
        const saa_domain_benchmark = saaDomainBenchmark(await getSaaBenchmark());

        return res.json({
            profile: {
                email: profile?.email || user.email || null,
                premium_unlocked: profile?.account_tier === 'premium' || isReviewEmail(profile?.email || user.email),
                premium_unlocked_at: profile?.premium_unlocked_at || null,
                is_admin: isAdminEmail(user.email),
                is_review: isReviewEmail(profile?.email || user.email),
                is_program_director: !!profile?.is_program_director,
                is_faculty: !!profile?.is_faculty,
                faculty_program: profile?.faculty_program || null,
                // Drives the in-app "Cohort dashboard" nav item. Admin (owner) can view any
                // program; a faculty/PD only if they've been assigned one. Server re-checks on every call.
                can_view_cohort: isAdminEmail(user.email) || !!((profile?.is_program_director || profile?.is_faculty) && profile?.faculty_program),
                full_name: profile?.full_name || '',
                credential: credCode || '',
                graduation_date: gradDate || '',
                credential_effective: credentialEffective || '',
                is_caa: credentialEffective === 'CAA',
                needs_credential: needsCredential,
                training_program: profile?.training_program || '',
                target_exam_date: profile?.target_exam_date || '',
                study_goal: profile?.study_goal || null,
                theme: profile?.theme || null,
                font: profile?.font || null,
                leaderboard_handle: profile?.leaderboard_handle || null,
                leaderboard_opt_in: !!profile?.leaderboard_opt_in,
                selected_title: profile?.selected_title || null,
                bonus_xp: Number(profile?.bonus_xp) || 0,
                ach_claimed: Array.isArray(profile?.ach_claimed) ? profile.ach_claimed : [],
                daily_state: (profile && profile.daily_state && typeof profile.daily_state === 'object') ? profile.daily_state : {},
                phone: profile?.phone || '',
                free_tier_limit: ceiling,
                stats: { answered: answeredIds.size, attempts: (progress || []).length, correct },
                by_specialty,
                calibration,
                coverage,
                by_domain,
                saa_domain_benchmark,
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
                flashcard_ids,
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
    if (b.graduation_date === '' || b.graduation_date === null) update.graduation_date = null;
    else if (typeof b.graduation_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.graduation_date)) {
        update.graduation_date = b.graduation_date;
    }
    if (typeof b.study_goal === 'string' && ['exam', 'practice', 'none'].includes(b.study_goal)) {
        update.study_goal = b.study_goal;
        if (b.study_goal !== 'exam') update.target_exam_date = null; // practice/none → no exam countdown
    }
    // Accept any well-formed theme/font id — they only set a CSS data-attribute, and an
    // unknown value harmlessly falls back to defaults. Regex-validated (not a hardcoded
    // list) so it never goes stale as themes/fonts are added, which was silently rejecting
    // newer themes and breaking cross-device sync.
    if (typeof b.theme === 'string' && /^[a-z0-9_-]{1,24}$/.test(b.theme)) update.theme = b.theme;
    if (typeof b.font === 'string' && /^[a-z0-9_-]{1,24}$/.test(b.font)) update.font = b.font;
    update.updated_at = new Date().toISOString();

    try {
        const { error } = await supabase.from(PROFILE_TABLE).update(update).eq('user_id', user.id);
        if (error) throw error;
        // A member picked "Program not listed" and typed a program not yet in the dropdown —
        // alert the owner (best-effort) + log it so the AA_PROGRAMS roster stays current.
        if (b.program_unlisted && typeof update.training_program === 'string' && update.training_program.trim()) {
            const prog = update.training_program.trim();
            const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
            sendEmail({
                to: Array.from(ADMIN_EMAILS),
                subject: `MACPrep: new AA program to add — ${prog.slice(0, 80)}`,
                html: `<p>A member selected <b>Program not listed</b> and entered a program that isn't in the MACPrep dropdown yet:</p>`
                    + `<p style="font-size:17px;margin:12px 0;"><b>${esc(prog)}</b></p>`
                    + `<p>Member: ${esc(user.email || user.id)}${update.credential ? ' &middot; ' + esc(update.credential) : ''}</p>`
                    + `<p style="color:#666;">If it's a real accredited AA program, add it to AA_PROGRAMS in src/app.js (and the outreach roster).</p>`,
            }).catch((e) => console.error('[program-alert] email failed:', e.message));
            try { await supabase.from('analytics_events').insert({ name: 'program_not_listed', user_id: user.id, meta: { program: prog } }); } catch (e) { /* non-fatal */ }
        }
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

// Personal flashcard deck — add/remove a question the user wants to drill as a flashcard.
app.post('/api/user/flashcard', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const questionId = String(req.body?.questionId || '');
    const saved = req.body?.saved !== false;
    if (!questionId) return res.status(400).json({ error: 'questionId required.' });
    try {
        if (saved) {
            await supabase.from('user_flashcards').upsert({ user_id: user.id, question_id: questionId }, { onConflict: 'user_id,question_id' });
        } else {
            await supabase.from('user_flashcards').delete().eq('user_id', user.id).eq('question_id', questionId);
        }
        return res.json({ success: true, saved });
    } catch (err) {
        return res.status(500).json({ error: 'Could not update flashcard deck.' });
    }
});

// ---- Async 1v1 duels — a fixed question set shared by code; scores compared ----
function duelCode() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L
    let c = ''; for (let i = 0; i < 6; i++) c += abc[Math.floor(Math.random() * abc.length)];
    return c;
}
async function duelName(userId) {
    try {
        const { data } = await supabase.from(PROFILE_TABLE).select('full_name').eq('user_id', userId).maybeSingle();
        const n = data && data.full_name ? lbShortName(data.full_name) : '';
        return n || 'A classmate';
    } catch (e) { return 'A classmate'; }
}
app.post('/api/duel/create', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 10, 5), 20);
    try {
        let q = supabase.from('questions').select('id');
        q = applyServedFilter(q);
        const { data: qs } = await q.limit(1500);
        const pool = (qs || []).map((r) => r.id);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const ids = pool.slice(0, count);
        if (ids.length < 3) return res.status(400).json({ error: 'Not enough questions available for a duel.' });
        const name = await duelName(user.id);
        let code = duelCode(), tries = 0, ok = false;
        while (tries < 6) {
            const { error } = await supabase.from('duels').insert({ code, creator_id: user.id, creator_name: name, question_ids: ids });
            if (!error) { ok = true; break; }
            code = duelCode(); tries++;
        }
        if (!ok) return res.status(500).json({ error: 'Could not create duel — try again.' });
        return res.json({ success: true, code, questionIds: ids, creatorName: name });
    } catch (err) {
        return res.status(500).json({ error: 'Could not create duel.' });
    }
});
// Random matchmaking — join an open random duel someone's waiting on, else start one.
app.post('/api/duel/random', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 10, 5), 20);
    try {
        const name = await duelName(user.id);
        // 1) Try to claim an open random duel another student is waiting on (creator already played).
        const { data: open } = await supabase.from('duels').select('code, question_ids, creator_name')
            .eq('is_random', true).is('opponent_id', null).neq('creator_id', user.id)
            .not('creator_score', 'is', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
        if (open) {
            const { data: claimed } = await supabase.from('duels')
                .update({ opponent_id: user.id, opponent_name: name })
                .eq('code', open.code).is('opponent_id', null).select('code').maybeSingle();
            if (claimed) return res.json({ success: true, matched: true, code: open.code, questionIds: open.question_ids || [], creatorName: open.creator_name, role: 'opponent', isRandom: true });
        }
        // 2) None open → create one and wait in the pool for the next random dueler.
        let q = supabase.from('questions').select('id');
        q = applyServedFilter(q);
        const { data: qs } = await q.limit(1500);
        const pool = (qs || []).map((r) => r.id);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const ids = pool.slice(0, count);
        if (ids.length < 3) return res.status(400).json({ error: 'Not enough questions available for a duel.' });
        let code = duelCode(), tries = 0, ok = false;
        while (tries < 6) {
            const { error } = await supabase.from('duels').insert({ code, creator_id: user.id, creator_name: name, question_ids: ids, is_random: true });
            if (!error) { ok = true; break; }
            code = duelCode(); tries++;
        }
        if (!ok) return res.status(500).json({ error: 'Could not start a random duel — try again.' });
        return res.json({ success: true, matched: false, code, questionIds: ids, creatorName: name, role: 'creator', isRandom: true });
    } catch (err) { return res.status(500).json({ error: 'Could not start a random duel.' }); }
});
// A user's recent duels (so a waiting random-duel creator can see the result when an opponent joins).
app.get('/api/duel/mine', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    try {
        const { data } = await supabase.from('duels').select('*')
            .or(`creator_id.eq.${user.id},opponent_id.eq.${user.id}`)
            .order('created_at', { ascending: false }).limit(8);
        const duels = (data || []).map((d) => ({
            code: d.code, youAre: d.creator_id === user.id ? 'creator' : 'opponent', isRandom: d.is_random,
            creatorName: d.creator_name, creatorScore: d.creator_score, creatorTotal: d.creator_total,
            opponentName: d.opponent_name, opponentScore: d.opponent_score, opponentTotal: d.opponent_total,
            completed: d.creator_score != null && d.opponent_score != null,
        }));
        return res.json({ duels });
    } catch (err) { return res.status(500).json({ error: 'Could not load your duels.' }); }
});
app.get('/api/duel/:code', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    try {
        const { data: d } = await supabase.from('duels').select('*').eq('code', code).maybeSingle();
        if (!d) return res.status(404).json({ error: 'That duel code was not found.' });
        const youAre = d.creator_id === user.id ? 'creator' : (d.opponent_id === user.id ? 'opponent' : (d.opponent_id ? 'spectator' : 'new'));
        return res.json({
            code: d.code, creatorName: d.creator_name, questionIds: d.question_ids || [],
            creatorScore: d.creator_score, creatorTotal: d.creator_total,
            opponentName: d.opponent_name, opponentScore: d.opponent_score, opponentTotal: d.opponent_total,
            youAre, isRandom: d.is_random,
        });
    } catch (err) { return res.status(500).json({ error: 'Could not load that duel.' }); }
});
app.post('/api/duel/score', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const code = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const score = Math.max(0, Math.min(parseInt(req.body?.score, 10) || 0, 200));
    const total = Math.max(1, Math.min(parseInt(req.body?.total, 10) || 1, 200));
    try {
        const { data: d } = await supabase.from('duels').select('*').eq('code', code).maybeSingle();
        if (!d) return res.status(404).json({ error: 'That duel code was not found.' });
        const name = await duelName(user.id);
        const upd = {};
        if (d.creator_id === user.id) { upd.creator_score = score; upd.creator_total = total; if (d.opponent_score != null) upd.completed_at = new Date().toISOString(); }
        else if (!d.opponent_id || d.opponent_id === user.id) { upd.opponent_id = user.id; upd.opponent_name = name; upd.opponent_score = score; upd.opponent_total = total; if (d.creator_score != null) upd.completed_at = new Date().toISOString(); }
        else { return res.status(409).json({ error: 'This duel already has two players.' }); }
        await supabase.from('duels').update(upd).eq('code', code);
        const m = { ...d, ...upd };
        return res.json({ success: true, code, creatorName: m.creator_name, creatorScore: m.creator_score, creatorTotal: m.creator_total, opponentName: m.opponent_name, opponentScore: m.opponent_score, opponentTotal: m.opponent_total, isRandom: m.is_random });
    } catch (err) { return res.status(500).json({ error: 'Could not save your duel score.' }); }
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
// Reviews / testimonials. The public /reviews page shows APPROVED reviews;
// logged-in users can submit (→ pending); the founder moderates in admin. Kept
// separate from anonymous feedback, since reviews are public and attributed.
//
// Reviews normally post live, but any submission containing slurs, hate speech,
// threats, or strong profanity is held as `pending` so the founder can vet it in
// the Content review queue before it reaches the public page. The submitter is
// deliberately NOT told their review was held — no tip-off that invites a reword.
// ---------------------------------------------------------------------------
const REVIEW_FLAG_WORDS = [
    // strong profanity
    'fuck', 'motherfucker', 'shit', 'bullshit', 'bitch', 'cunt', 'asshole', 'dickhead',
    'cock', 'prick', 'twat', 'wanker', 'bastard', 'whore', 'slut', 'skank', 'douchebag',
    'jackass', 'dumbass', 'bollocks',
    // common vowel-censored skeletons (f*ck, sh*t, b*tch, c*nt → stripped to consonants)
    'fck', 'fuk', 'sht', 'btch', 'cnt',
    // slurs / hate speech (blocklist is deliberately blunt)
    'nigger', 'nigga', 'faggot', 'fag', 'retard', 'spic', 'chink', 'kike', 'gook',
    'tranny', 'dyke', 'coon', 'wetback', 'beaner', 'paki', 'raghead', 'towelhead',
    // threats / violence
    'kys', 'rape', 'rapist',
];
const REVIEW_FLAG_PHRASES = [
    'kill yourself', 'kill your self', 'kill you', 'i will kill', 'go die', 'hope you die',
    'die in a fire', 'shoot up', 'i will find you', 'piss off',
];
function reviewNeedsModeration(text) {
    const norm = String(text || '').toLowerCase()
        .replace(/[@4]/g, 'a').replace(/[$5]/g, 's').replace(/[!1|]/g, 'i')
        .replace(/0/g, 'o').replace(/3/g, 'e').replace(/7/g, 't')
        .replace(/[()*_.\-]/g, '')          // strip in-word separators: f.u.c.k, a**hole
        .replace(/([a-z])\1{2,}/g, '$1');   // collapse 3+ repeats: fuuuuck -> fuck
    // Full word boundaries + common suffixes → catches inflections without Scunthorpe-style
    // false positives (e.g. "spic" won't fire on "spicy", "cock" won't fire on "cocktail").
    for (const w of REVIEW_FLAG_WORDS) {
        if (new RegExp('\\b' + w + '(s|es|ing|ed|er|in)?\\b').test(norm)) return true;
    }
    for (const p of REVIEW_FLAG_PHRASES) {
        if (new RegExp('\\b' + p.replace(/ /g, '\\s+')).test(norm)) return true;
    }
    return false;
}
app.get('/api/reviews', async (req, res) => {
    if (!supabase) return res.json({ reviews: [] });
    try {
        const { data, error } = await supabase.from('reviews')
            .select('id, author_name, credential, rating, body, created_at, featured')
            .eq('status', 'approved')
            .order('featured', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) throw error;
        return res.json({ reviews: data || [] });
    } catch (err) {
        console.error('Reviews list failure:', err.message);
        return res.status(500).json({ error: 'Could not load reviews.', reviews: [] });
    }
});

app.post('/api/reviews', feedbackLimiter, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in to leave a review.' });
    const b = req.body || {};
    const author_name = String(b.author_name || '').trim().slice(0, 80);
    const credential = String(b.credential || '').trim().slice(0, 80) || null;
    const rating = Math.min(5, Math.max(1, Math.round((parseFloat(b.rating) || 5) * 2) / 2)); // half-star steps
    const body = String(b.body || '').trim().slice(0, 2000);
    if (!author_name || !body) return res.status(400).json({ error: 'Name and review text are required.' });
    // Account must be >24h old to write a review — curbs drive-by / throwaway-account reviews.
    const acctMs = user.created_at ? Date.parse(user.created_at) : NaN;
    if (!Number.isFinite(acctMs) || (Date.now() - acctMs) < 24 * 60 * 60 * 1000) {
        return res.status(403).json({ error: 'Reviews can be posted once your account is 24 hours old. Thanks for joining — check back tomorrow to share your thoughts!' });
    }
    try {
        // Clean reviews post live; anything with flagged language is HELD as `pending`
        // (not shown publicly) for the founder to approve in the Content review queue.
        // One review per account: re-submitting UPDATES the account's existing review
        // (upsert on the unique user_id index).
        const held = reviewNeedsModeration(body) || reviewNeedsModeration(author_name) || reviewNeedsModeration(credential);
        const status = held ? 'pending' : 'approved';
        const { error } = await supabase.from('reviews').upsert(
            { user_id: user.id, author_name, credential, rating, body, status },
            { onConflict: 'user_id' }
        );
        if (error) throw error;
        sendEmail({
            to: 'support@macprep.org',
            subject: held ? `Review HELD for moderation — ${author_name}` : `New MACPrep review (live) — ${author_name}`,
            html: `<p style="font-family:sans-serif;font-size:15px;"><strong>${escHtml(author_name)}</strong> ${escHtml(credential || '')} · ${rating}★</p><p style="font-family:sans-serif;font-size:15px;background:#f6f7f9;border:1px solid #e5e7eb;border-radius:8px;padding:14px;">${escHtml(body)}</p>` + (held
                ? `<p style="font-size:13px;color:#b45309;"><strong>⚠ Auto-held (flagged language).</strong> It is NOT on the public page. Approve or remove it in the admin Content review queue.</p>`
                : `<p style="font-size:12px;color:#9ca3af;">This is live on the Reviews page. Remove it from the admin Reviews panel if needed.</p>`),
        }).then(() => {}, () => {});
        // Always report success — never signal to the submitter that a review was held.
        return res.json({ success: true });
    } catch (err) {
        console.error('Review submit failure:', err.message);
        return res.status(500).json({ error: 'Could not submit your review.' });
    }
});

app.get('/api/admin/reviews', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    try {
        // Reviews auto-publish now, so show ALL of them (newest first) — admin moderates
        // by removing/rejecting anything abusive rather than approving up front.
        const { data, error } = await supabase.from('reviews')
            .select('id, author_name, credential, rating, body, status, featured, created_at')
            .neq('status', 'rejected').order('created_at', { ascending: false }).limit(300);
        if (error) throw error;
        const STATUSES = ['pending', 'approved', 'rejected'];
        const cr = await Promise.all(STATUSES.map((s) => supabase.from('reviews').select('id', { count: 'exact', head: true }).eq('status', s)));
        const counts = {}; STATUSES.forEach((s, i) => { counts[s] = cr[i].count || 0; });
        return res.json({ reviews: data || [], counts });
    } catch (err) {
        console.error('Admin reviews failure:', err.message);
        return res.status(500).json({ error: 'Could not load reviews.' });
    }
});

app.post('/api/admin/review', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    const b = req.body || {};
    try {
        // Admin can CREATE a curated testimonial (published straight to approved) —
        // e.g. paste in one a classmate texted over.
        if (b.create) {
            const author_name = String(b.author_name || '').trim().slice(0, 80);
            const body = String(b.body || '').trim().slice(0, 2000);
            if (!author_name || !body) return res.status(400).json({ error: 'Name and text required.' });
            const { error } = await supabase.from('reviews').insert({
                author_name, credential: String(b.credential || '').trim().slice(0, 80) || null,
                rating: Math.min(5, Math.max(1, Math.round((parseFloat(b.rating) || 5) * 2) / 2)),
                body, status: 'approved', featured: !!b.featured, reviewed_at: new Date().toISOString(),
            });
            if (error) throw error;
            return res.json({ success: true });
        }
        const id = parseInt(b.id, 10);
        const action = String(b.action || '');
        if (!id || !['approve', 'reject', 'feature', 'unfeature', 'delete'].includes(action)) return res.status(400).json({ error: 'Bad request.' });
        if (action === 'delete') { const { error } = await supabase.from('reviews').delete().eq('id', id); if (error) throw error; return res.json({ success: true }); }
        const upd = { reviewed_at: new Date().toISOString() };
        if (action === 'approve') upd.status = 'approved';
        else if (action === 'reject') upd.status = 'rejected';
        else if (action === 'feature') upd.featured = true;
        else if (action === 'unfeature') upd.featured = false;
        const { error } = await supabase.from('reviews').update(upd).eq('id', id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        console.error('Admin review action failure:', err.message);
        return res.status(500).json({ error: 'Could not update review.' });
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

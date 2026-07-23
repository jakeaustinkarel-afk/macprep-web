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
import { AppStoreServerAPIClient, Environment, NotificationTypeV2, SignedDataVerifier, Type as AppleProductType } from '@apple/app-store-server-library';
import { google } from 'googleapis';
import * as Sentry from '@sentry/node';
import webpush from 'web-push';
import { initializeApp as fbInitApp, cert as fbCert, getApps as fbGetApps } from 'firebase-admin/app';
import { getMessaging as fbGetMessaging } from 'firebase-admin/messaging';
import apn from '@parse/node-apn';
import { fetchAllPostgrestRows } from './lib/postgrest-pagination.mjs';
import { publicAAProgramDirectory } from './lib/aa-program-directory.mjs';
import { validateQuestionForPublication } from './lib/question-validation.mjs';
import { buildAdaptiveStudyPlan, MAX_ADAPTIVE_PLAN_DAYS } from './lib/study-plan.mjs';
import { normalizeTeachingDebrief, validateTeachingDebrief } from './lib/teaching-debrief.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

export const app = express();
app.disable('x-powered-by');

function reportOperationalError(area, error, context = {}) {
    const message = error?.message || String(error || 'Unknown error');
    console.error(`[${area}] ${message}`);
    Sentry.withScope((scope) => {
        scope.setTag('macprep.area', area);
        if (context && Object.keys(context).length) scope.setContext('operation', context);
        Sentry.captureException(error instanceof Error ? error : new Error(message));
    });
}

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
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self' https://*.sentry.io https://*.ingest.sentry.io",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'",
    ].join('; '));
    next();
});

// Authenticated responses can contain progress, profile, and purchase state.
// Do not let a shared browser or intermediary cache any API response.
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    next();
});

// ---------------------------------------------------------------------------
// Fast in-process rate limiting protects each instance. Critical auth/payment
// routes also consume an atomic Postgres bucket, so horizontal scaling cannot
// multiply their limits. Only hashes, never emails/tokens/addresses, reach the
// shared table.
// ---------------------------------------------------------------------------
let lastSharedLimitWarningAt = 0;
function rateLimit({ windowMs, max, identity, sharedBucket }) {
    const hits = new Map();
    return async (req, res, next) => {
        const now = Date.now();
        // Keep the proxy-resolved address and Cloudflare's address as independent
        // ceilings when both are present. Account/cookie identity is a third key.
        const addresses = new Set([String(req.ip || 'unknown').slice(0, 96)]);
        const cfAddress = String(req.headers['cf-connecting-ip'] || '').trim().slice(0, 96);
        if (cfAddress) addresses.add(cfAddress);
        const identityValue = typeof identity === 'function' ? identity(req) : '';
        const keys = Array.from(addresses, (address) => `ip:${address}`);
        if (identityValue) {
            keys.push(`id:${createHash('sha256').update(String(identityValue).toLowerCase()).digest('hex').slice(0, 32)}`);
        }
        for (const key of keys) {
            const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
            if (arr.length >= max) {
                res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
                return res.status(429).json({ error: 'Too many attempts. Please wait a moment and try again.' });
            }
        }

        if (sharedBucket && supabase) {
            try {
                for (const key of keys) {
                    const identityHash = createHash('sha256').update(key).digest('hex');
                    const { data, error } = await supabase.rpc('consume_macprep_rate_limit', {
                        p_bucket: sharedBucket,
                        p_identity_hash: identityHash,
                        p_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)),
                        p_max_hits: max,
                    });
                    if (error) throw error;
                    if (data?.allowed === false) {
                        res.setHeader('Retry-After', Math.max(1, Number(data.retry_after) || Math.ceil(windowMs / 1000)));
                        return res.status(429).json({ error: 'Too many attempts. Please wait a moment and try again.' });
                    }
                }
            } catch (error) {
                // Keep the per-instance ceiling available during a database incident;
                // the underlying route will still perform its normal database checks.
                if (now - lastSharedLimitWarningAt > 60000) {
                    lastSharedLimitWarningAt = now;
                    console.warn(`[rate-limit] shared limiter unavailable: ${error.message}`);
                }
            }
        }

        for (const key of keys) {
            const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
            arr.push(now);
            hits.set(key, arr);
        }
        if (hits.size > 5000) { // crude memory bound
            for (const [k, v] of hits) { if (!v.some((t) => now - t < windowMs)) hits.delete(k); }
        }
        next();
    };
}
const requestIdentity = (req) => req.body?.email || req.body?.access_token || req.headers.authorization || authCookie(req, ACCESS_COOKIE) || '';
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, identity: requestIdentity, sharedBucket: 'auth' });
const feedbackLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 8, identity: requestIdentity, sharedBucket: 'feedback' });
const voucherLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, identity: requestIdentity, sharedBucket: 'voucher' });
const eventLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
const demoLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });
// Checkout + payment-verification: generous enough for real buyers, tight enough
// to stop anyone hammering Stripe session creation or replaying session-id guesses.
const checkoutLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, identity: requestIdentity, sharedBucket: 'checkout' });
// Cohort dashboard does a full served-bank + full-cohort scan per call — cap it so a
// faculty/PD (or admin) can't hammer it into a resource-exhaustion problem.
const cohortLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const studySessionLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });
const sessionLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const gradeLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
const profileLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const pushLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30 });
const mobilePurchaseLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 25, identity: requestIdentity, sharedBucket: 'mobile_purchase' });

// Allowlist of hosts we will build absolute URLs for (password-reset links,
// Stripe success/cancel). Prevents host-header injection from pointing those
// URLs at an attacker-controlled domain. Override via ALLOWED_HOSTS env.
const ALLOWED_HOSTS = new Set(
    (process.env.ALLOWED_HOSTS || 'macprep.org,www.macprep.org,localhost:3000')
        .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
);
export function trustedBaseUrl(value) {
    try {
        const url = new URL(value);
        const host = url.host.toLowerCase();
        const allowLocalHttp = !IS_PROD && url.protocol === 'http:' && url.hostname === 'localhost';
        if (!ALLOWED_HOSTS.has(host) || (url.protocol !== 'https:' && !allowLocalHttp)) return '';
        return url.origin;
    } catch (e) {
        return '';
    }
}
function safeBaseUrl(req) {
    const origin = trustedBaseUrl(req.headers.origin);
    if (origin) return origin;
    const canonical = trustedBaseUrl(process.env.PUBLIC_BASE_URL || '');
    if (canonical) return canonical;
    const host = (req.headers.host || '').toLowerCase();
    if (ALLOWED_HOSTS.has(host)) return !IS_PROD && host === 'localhost:3000' ? `http://${host}` : `https://${host}`;
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
const SERVER_AUTH_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const supabase = (supabaseUrl && serviceKey) ? createClient(supabaseUrl, serviceKey, SERVER_AUTH_OPTIONS) : null;

// Anon client: used for Supabase Auth (sign-up / sign-in) on behalf of users.
const anonKey = process.env.SUPABASE_ANON_KEY || '';
const supabaseAuth = (supabaseUrl && anonKey) ? createClient(supabaseUrl, anonKey, SERVER_AUTH_OPTIONS) : null;

// --- Fail fast on missing/incorrect critical config -----------------------
// In production a missing key silently degrades (checkout 500s, grading returns
// empty) or — worse — a Stripe TEST key lets real customers "pay" in test mode
// with no charge. Refuse to boot instead of failing quietly.
const IS_PROD = process.env.NODE_ENV === 'production';
const MIN_PASSWORD_LENGTH = 12;
const ACCESS_COOKIE = 'macprep_access';
const REFRESH_COOKIE = 'macprep_refresh';
export function readCookieHeader(header, name) {
    const prefix = `${name}=`;
    for (const part of String(header || '').split(';')) {
        const value = part.trim();
        if (value.startsWith(prefix)) {
            try { return decodeURIComponent(value.slice(prefix.length)); } catch (e) { return ''; }
        }
    }
    return '';
}
function authCookie(req, name) {
    return readCookieHeader(req.headers.cookie, name);
}
function authCookieLine(name, value, maxAge) {
    const secure = IS_PROD ? '; Secure' : '';
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function setAuthCookies(res, session) {
    if (!session?.access_token || !session?.refresh_token) return;
    const accessAge = Math.max(60, Math.min(86400, Number(session.expires_in) || 3600));
    res.setHeader('Set-Cookie', [
        authCookieLine(ACCESS_COOKIE, session.access_token, accessAge),
        authCookieLine(REFRESH_COOKIE, session.refresh_token, 30 * 86400),
    ]);
}
function clearAuthCookies(res) {
    res.setHeader('Set-Cookie', [
        authCookieLine(ACCESS_COOKIE, '', 0),
        authCookieLine(REFRESH_COOKIE, '', 0),
    ]);
}
class AuthPasswordUpdateError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'AuthPasswordUpdateError';
        this.status = status;
    }
}
async function updatePasswordWithAccessToken(accessToken, password, currentPassword = '') {
    const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
        method: 'PUT',
        headers: {
            apikey: anonKey,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            password,
            ...(currentPassword ? { current_password: currentPassword } : {}),
        }),
    });
    let body = {};
    try { body = await response.json(); } catch (error) { /* map below */ }
    if (response.ok) return body;

    const code = String(body?.code || body?.error_code || '').toLowerCase();
    const detail = String(body?.msg || body?.message || body?.error_description || '').toLowerCase();
    if (code === 'weak_password' || /weak|pwn|breach|security requirements/.test(detail)) {
        throw new AuthPasswordUpdateError('Choose a different 12+ character password that has not appeared in a known breach.');
    }
    if (code === 'same_password' || /same password/.test(detail)) {
        throw new AuthPasswordUpdateError('Choose a password you have not used for this account.');
    }
    if (/current password/.test(detail)) {
        throw new AuthPasswordUpdateError('Current password is incorrect.', 403);
    }
    throw new AuthPasswordUpdateError('Password did not meet the account security requirements.', response.status >= 400 && response.status < 500 ? response.status : 400);
}
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
const MOBILE_PURCHASE_TABLE = 'mobile_purchase_entitlements';
// This product identifier is intentionally shared by both stores. It must match the
// non-consumable / managed product created in App Store Connect and Play Console.
const MOBILE_PREMIUM_PRODUCT_ID = process.env.MOBILE_PREMIUM_PRODUCT_ID || 'org.macprep.app.full_access';
const MOBILE_APP_BUNDLE_ID = process.env.MOBILE_APP_BUNDLE_ID || 'org.macprep.app';

export function configuredStripePriceIds(env = process.env) {
    const configured = [
        env.STRIPE_PRODUCTION_PRICE_ID,
        ...String(env.STRIPE_FULL_ACCESS_PRICE_IDS || '').split(','),
    ]
        .map((value) => String(value || '').trim())
        .filter(Boolean);
    return [...new Set(configured)];
}

export function stripeCheckoutIdempotencyKey(userId, priceId, now = Date.now()) {
    const thirtyMinuteWindow = Math.floor(Number(now) / (30 * 60 * 1000));
    const digest = createHash('sha256')
        .update(`${String(userId)}:${String(priceId)}:${thirtyMinuteWindow}`)
        .digest('hex');
    return `macprep-checkout-${digest}`;
}

export function mobilePurchaseVerificationConfigured(env = process.env) {
    let appleRootsConfigured = false;
    try {
        const roots = JSON.parse(String(env.APPLE_IAP_ROOT_CERTIFICATES_BASE64 || ''));
        appleRootsConfigured = Array.isArray(roots) && roots.some((entry) => {
            try { return Buffer.from(String(entry), 'base64').length > 0; }
            catch (error) { return false; }
        });
    } catch (error) { /* false below */ }

    let googleCredentialsConfigured = false;
    try {
        const raw = String(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
        const credentials = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
        googleCredentialsConfigured = !!(credentials?.client_email && credentials?.private_key);
    } catch (error) { /* false below */ }

    const appleAppId = Number(env.APPLE_IAP_APP_ID);
    return {
        ios: !!(
            env.APPLE_IAP_PRIVATE_KEY
            && env.APPLE_IAP_KEY_ID
            && env.APPLE_IAP_ISSUER_ID
            && Number.isSafeInteger(appleAppId)
            && appleAppId > 0
            && appleRootsConfigured
        ),
        android: googleCredentialsConfigured,
    };
}

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
// App Store / Play review demo accounts — NOT real users. They get premium
// board-prep access and are surfaced as program "REVIEW" in admin metrics, but
// they do not inherit owner-only cross-lifecycle or admin access. Override via
// REVIEW_EMAILS env.
const REVIEW_EMAILS = new Set(
    (process.env.REVIEW_EMAILS || 'applereview@macprep.org')
        .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const isReviewEmail = (email) => REVIEW_EMAILS.has(String(email || '').trim().toLowerCase());
const hasVerifiedEmail = (user) => Boolean(user?.email && user.email_confirmed_at);
const isAdminUser = (user) => hasVerifiedEmail(user) && isAdminEmail(user.email);
const isReviewUser = (user) => hasVerifiedEmail(user) && isReviewEmail(user.email);
export function normalizeTrainingProgram(value) {
    return typeof value === 'string'
        ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 200)
        : '';
}
export function isValidProfileDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const LIFECYCLE_STAGES = new Set(['applicant', 'incoming_student', 'student', 'practicing']);
const PROFILE_SELECTION_LIFECYCLE_STAGES = new Set(['applicant', 'student', 'practicing']);
const SIGNUP_LIFECYCLE_STAGES = new Set([...PROFILE_SELECTION_LIFECYCLE_STAGES, 'incoming_student']);
const BOARD_PREP_LIFECYCLE_STAGES = new Set(['student', 'practicing']);
export function resolveLifecycleCapabilities(lifecycleStage, { isAdmin = false, isReview = false } = {}) {
    const stage = normalizeLifecycleStage(lifecycleStage);
    const admin = !!isAdmin;
    return {
        applicant_workspace: admin || stage === 'applicant' || stage === 'incoming_student',
        board_prep: admin || !!isReview || BOARD_PREP_LIFECYCLE_STAGES.has(stage),
        professional_resources: admin || stage === 'practicing',
        admin_tools: admin,
    };
}
export function normalizeLifecycleStage(value) {
    return typeof value === 'string' && LIFECYCLE_STAGES.has(value.trim().toLowerCase())
        ? value.trim().toLowerCase()
        : null;
}
export function lifecycleCredential(stage) {
    if (stage === 'student') return 'SAA';
    if (stage === 'practicing') return 'CAA';
    return null;
}
export function resolveSignupLifecycleStage(lifecycleStage, matriculationDate, today = new Date().toISOString().slice(0, 10)) {
    const stage = normalizeLifecycleStage(lifecycleStage);
    if (stage === 'incoming_student' && isValidProfileDate(matriculationDate) && matriculationDate <= today) {
        return 'student';
    }
    return stage;
}
export function registrationProfileError({ lifecycleStage, credential, matriculationDate, graduationDate, trainingProgram }) {
    const stage = normalizeLifecycleStage(lifecycleStage)
        || (credential === 'SAA' ? 'student' : credential === 'CAA' ? 'practicing' : null);
    if (!SIGNUP_LIFECYCLE_STAGES.has(stage)) return 'Please select where you are in your AA journey.';
    if (stage === 'applicant') return '';
    if (stage === 'incoming_student' && !isValidProfileDate(matriculationDate)) {
        return 'Accepted students must add a valid expected matriculation date.';
    }
    if (stage === 'student' && !isValidProfileDate(graduationDate)) return 'Current AA students must add a valid expected graduation date.';
    if (stage === 'incoming_student' && !isValidProfileDate(graduationDate)) {
        return 'Accepted students must add a valid expected graduation date.';
    }
    if (stage === 'incoming_student' && graduationDate <= matriculationDate) {
        return 'Graduation must be after matriculation.';
    }
    if (!normalizeTrainingProgram(trainingProgram) || normalizeTrainingProgram(trainingProgram).toLowerCase() === 'program not listed') {
        return 'Please select your AA program.';
    }
    return '';
}

const DAY_MS = 86400000;
export function applicantCheckInDue({
    lifecycleStage,
    accountCreatedAt,
    lastCheckinAt,
    snoozedUntil,
    now = Date.now(),
    isAdmin = false,
    isReview = false,
} = {}) {
    if (isAdmin || isReview || normalizeLifecycleStage(lifecycleStage) !== 'applicant') return false;
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const createdMs = Date.parse(accountCreatedAt || '');
    if (!Number.isFinite(nowMs) || !Number.isFinite(createdMs) || nowMs - createdMs < 30 * DAY_MS) return false;
    const lastCheckinMs = Date.parse(lastCheckinAt || '');
    if (Number.isFinite(lastCheckinMs) && nowMs - lastCheckinMs < 30 * DAY_MS) return false;
    const today = new Date(nowMs).toISOString().slice(0, 10);
    if (isValidProfileDate(snoozedUntil) && snoozedUntil > today) return false;
    return true;
}

const APPLICANT_TASK_KEYS = new Set([
    'research_programs', 'verify_prerequisites', 'arrange_shadowing',
    'request_evaluations', 'draft_statement', 'submit_casaa',
    'prepare_interviews', 'financial_plan', 'relocation_plan',
]);
const APPLICANT_PREREQUISITE_KEYS = new Set([
    'biology', 'general_chemistry', 'organic_or_biochemistry', 'physics',
    'calculus', 'statistics', 'anatomy_physiology',
]);
const APPLICANT_PREREQUISITE_STATES = new Set(['not_started', 'in_progress', 'complete', 'verify']);
const APPLICANT_PROGRAM_STATES = new Set(['researching', 'planned', 'submitted', 'interview', 'accepted', 'closed']);
export function sanitizeApplicantProgress(value) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const clean = { tasks: {}, prerequisites: {}, programs: [] };
    const cycle = String(raw.target_cycle || '').trim();
    if (/^20\d{2}$/.test(cycle)) clean.target_cycle = cycle;
    const shadowingHours = Number(raw.shadowing_hours);
    clean.shadowing_hours = Number.isFinite(shadowingHours)
        ? Math.max(0, Math.min(5000, Math.round(shadowingHours * 10) / 10))
        : 0;
    const tasks = raw.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks) ? raw.tasks : {};
    APPLICANT_TASK_KEYS.forEach((key) => { clean.tasks[key] = tasks[key] === true; });
    const prerequisites = raw.prerequisites && typeof raw.prerequisites === 'object' && !Array.isArray(raw.prerequisites)
        ? raw.prerequisites : {};
    APPLICANT_PREREQUISITE_KEYS.forEach((key) => {
        clean.prerequisites[key] = APPLICANT_PREREQUISITE_STATES.has(prerequisites[key])
            ? prerequisites[key] : 'not_started';
    });
    const programs = Array.isArray(raw.programs) ? raw.programs : [];
    clean.programs = programs.slice(0, 15).map((entry) => {
        const name = normalizeTrainingProgram(entry?.name).slice(0, 120);
        const status = APPLICANT_PROGRAM_STATES.has(entry?.status) ? entry.status : 'researching';
        return name ? { name, status } : null;
    }).filter(Boolean);
    return clean;
}
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
export function applyServedFilter(query) {
    return SERVE_FILLER ? query : query.in('status', SERVED_STATUSES);
}

// Use the same publication gate for delivery and grading. A client that guesses
// an ID must not be able to turn an unpublished item into an answer-key oracle.
export function getServedQuestionQuery(client, questionId) {
    return applyServedFilter(
        client
            .from('questions')
            .select('id, specialty, category, correct_answer, choices, explanation, "references", answer_revision, teaching_debrief, debrief_reviewed_at')
            .eq('id', questionId)
    );
}

export async function deleteMacprepAccount(client, userId) {
    const { error } = await client.rpc('delete_macprep_account', { p_user: userId });
    if (error) throw error;
}

// Free accounts may try a fixed number of NEW questions total (changed 2026-07-06 from
// 10% of the bank to a flat 25 — clearer for users, and it doesn't balloon as the bank grows).
const FREE_TIER_LIMIT = 25;
export function isFreeTrialSessionPurpose(purpose) {
    return purpose === 'recommended';
}
let _freeCeilingCache = { value: FREE_TIER_LIMIT, at: 0 };
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

function choiceText(choice) {
    return String(choice && typeof choice === 'object' ? (choice.text ?? choice.value ?? '') : (choice ?? '')).trim();
}

// Choice positions can change during editorial balancing. This identifier stays
// attached to the answer text so an old browser can never silently turn A into
// a different answer after a reorder.
export function answerChoiceId(questionId, choice) {
    return createHash('sha256')
        .update(`${String(questionId || '')}\0${choiceText(choice)}`)
        .digest('base64url')
        .slice(0, 20);
}

function staleQuestionError() {
    const error = new Error('This question was updated while it was open. MACPrep will refresh it before grading.');
    error.status = 409;
    error.code = 'stale_question';
    return error;
}

export function resolveSubmittedChoiceIndex(question, answer = {}) {
    const choices = parseChoices(question?.choices);
    if (Object.prototype.hasOwnProperty.call(answer, 'choiceId')) {
        const submittedId = String(answer.choiceId || '');
        const matches = choices
            .map((choice, index) => (answerChoiceId(question?.id, choice) === submittedId ? index : -1))
            .filter((index) => index >= 0);
        if (matches.length !== 1) throw staleQuestionError();
        return matches[0];
    }
    const selectedIndex = Number(answer.choiceIndex);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= choices.length) {
        const error = new Error('Invalid answer choice.');
        error.status = 400;
        throw error;
    }
    return selectedIndex;
}

function assertCurrentChoiceIdentity(question, answer = {}) {
    const currentRevision = Math.max(1, Number(question?.answer_revision) || 1);
    if (Object.prototype.hasOwnProperty.call(answer, 'answerRevision')
        && Number(answer.answerRevision) !== currentRevision) {
        throw staleQuestionError();
    }
    // Revision 2 is the first reordered bank. Older clients only submit a
    // position, which is unsafe for those questions and must be refreshed.
    if (currentRevision > 1 && !Object.prototype.hasOwnProperty.call(answer, 'choiceId')) {
        throw staleQuestionError();
    }
}

export function resolveCorrectChoiceIndex(question) {
    const choices = parseChoices(question?.choices);
    const flagged = choices
        .map((choice, index) => (choice && typeof choice === 'object' && choice.correct === true ? index : -1))
        .filter((index) => index >= 0);
    if (flagged.length > 1) return -1;
    if (flagged.length === 1) return flagged[0];
    if (typeof question?.correct_answer !== 'string' || !question.correct_answer.trim()) return -1;
    const index = question.correct_answer.trim().toUpperCase().charCodeAt(0) - 65;
    return Number.isInteger(index) && index >= 0 && index < choices.length ? index : -1;
}

function normalizeGradeInput(question, answer = {}) {
    const choices = parseChoices(question?.choices);
    const correctIndex = resolveCorrectChoiceIndex(question);
    if (correctIndex < 0) {
        const error = new Error('This question could not be scored and has been flagged for review.');
        error.status = 422;
        throw error;
    }
    const selectedIndex = resolveSubmittedChoiceIndex(question, answer);
    const timeValue = Number(answer.time_ms);
    const timeMs = Number.isFinite(timeValue) && timeValue > 0 && timeValue <= 1800000
        ? Math.round(timeValue)
        : null;
    const answerChanged = typeof answer.answer_changed === 'boolean' ? answer.answer_changed : null;
    const confidence = ['low', 'medium', 'high'].includes(answer.confidence) ? answer.confidence : null;
    const isCorrect = selectedIndex === correctIndex;
    let references = question.references;
    if (typeof references === 'string') {
        try { references = JSON.parse(references); } catch (error) { references = []; }
    }
    if (!Array.isArray(references)) references = [];
    return {
        selectedIndex,
        correctIndex,
        isCorrect,
        confidence,
        timeMs,
        answerChanged,
        choices,
        result: {
            correct: isCorrect,
            correctIndex,
            correctChoiceId: answerChoiceId(question?.id, choices[correctIndex]),
            explanation: question.explanation || '',
            rationales: choices.map((choice) => (choice && typeof choice === 'object' ? (choice.rationale || '') : '')),
            references,
            teaching_debrief: question.debrief_reviewed_at
                ? normalizeTeachingDebrief(question.teaching_debrief)
                : null,
        },
    };
}

function safeQuestionForClient(q) {
    const { status, ...rest } = q;
    return {
        ...rest,
        reviewed: status === 'published',
        choices: parseChoices(q.choices).map((c) => (typeof c === 'object' && c !== null
            ? { id: answerChoiceId(q.id, c), text: c.text ?? c.value ?? '' }
            : { id: answerChoiceId(q.id, c), text: c })),
    };
}

const MAX_STUDY_SESSION_SIZE = 200;
const FREE_STUDY_POOL_SIZE = FREE_TIER_LIMIT;
const QUESTION_CATALOG_TTL = 10 * 60 * 1000;
let _questionCatalog = { at: 0, value: { total: 0, categories: [] } };

function applyQuestionFilters(query, { category, difficulty } = {}) {
    if (category && category !== 'all') {
        // Legacy rows use domain_name while newer content uses category. Quote the
        // value for PostgREST's filter grammar before composing the OR expression.
        const literal = `"${String(category).replace(/[\\"]/g, '\\$&')}"`;
        query = query.or(`category.eq.${literal},domain_name.eq.${literal}`);
    }
    if (difficulty && difficulty !== 'all') query = query.eq('difficulty', difficulty);
    return query;
}

async function fetchAllServedQuestionRows(select, { ids = [], category, difficulty } = {}) {
    return fetchAllPostgrestRows((from, to) => {
        let query = applyServedFilter(supabase.from('questions').select(select));
        if (ids.length) query = query.in('id', ids);
        else query = applyQuestionFilters(query, { category, difficulty });
        return query.order('id', { ascending: true }).range(from, to);
    });
}

async function getQuestionCatalog() {
    if (_questionCatalog.at && (Date.now() - _questionCatalog.at) < QUESTION_CATALOG_TTL) return _questionCatalog.value;
    const rows = await fetchAllPostgrestRows((from, to) => applyServedFilter(
        supabase.from('questions').select('category, domain_name')
    ).range(from, to));
    const categories = {};
    rows.forEach((q) => {
        const category = q.category || q.domain_name || 'General';
        categories[category] = (categories[category] || 0) + 1;
    });
    const value = {
        total: rows.length,
        categories: Object.entries(categories)
            .map(([category, total]) => ({ category, total }))
            .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
    };
    _questionCatalog = { at: Date.now(), value };
    return value;
}

function fixedPoolOffset(userId, total) {
    if (!total) return 0;
    return createHash('sha256').update(String(userId)).digest().readUInt32BE(0) % total;
}

function qotdDayKey(now = new Date()) {
    const shifted = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(shifted);
    } catch (error) {
        return shifted.toISOString().slice(0, 10);
    }
}

function qotdOffset(total, now = new Date()) {
    if (!total) return 0;
    return createHash('sha256').update(qotdDayKey(now)).digest().readUInt32BE(0) % total;
}

async function fetchServedQuestionRows({ ids = [], category, difficulty, offset = 0, limit = MAX_STUDY_SESSION_SIZE } = {}) {
    let query = supabase
        .from('questions')
        .select('id, specialty, domain, domain_name, subtopic, category, difficulty, stem, choices, telemetry, status, answer_revision')
        .order('id', { ascending: true });
    query = applyServedFilter(query);
    if (ids.length) query = query.in('id', ids);
    else query = applyQuestionFilters(query, { category, difficulty }).range(offset, offset + limit - 1);
    const { data, error } = await query;
    if (error) throw error;
    if (!ids.length) return data || [];
    const byId = new Map((data || []).map((q) => [String(q.id), q]));
    return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

export function selectUnansweredFreePool(pool, answeredIds, size) {
    const answered = new Set((answeredIds || []).map(String));
    return pool.filter((question) => !answered.has(String(question.id))).slice(0, size);
}

async function fetchFixedFreePool(userId, size) {
    const catalog = await getQuestionCatalog();
    const poolSize = Math.min(FREE_STUDY_POOL_SIZE, catalog.total);
    if (!poolSize) return [];
    const offset = fixedPoolOffset(userId, catalog.total);
    const first = await fetchServedQuestionRows({ offset, limit: poolSize });
    const pool = first.length >= poolSize || offset === 0
        ? first.slice(0, poolSize)
        : [...first, ...(await fetchServedQuestionRows({ offset: 0, limit: poolSize - first.length }))].slice(0, poolSize);
    const ids = pool.map((question) => String(question.id));
    const { data: attempts, error } = await supabase
        .from(PROGRESS_TABLE)
        .select('question_id')
        .eq('user_id', userId)
        .in('question_id', ids);
    if (error) throw error;
    return selectUnansweredFreePool(pool, (attempts || []).map((attempt) => attempt.question_id), size);
}

async function fetchQuestionOfTheDay() {
    const catalog = await getQuestionCatalog();
    if (!catalog.total) return [];
    return fetchServedQuestionRows({ offset: qotdOffset(catalog.total), limit: 1 });
}

async function countServedQuestions({ category, difficulty } = {}) {
    let query = supabase.from('questions').select('id', { count: 'exact', head: true });
    query = applyServedFilter(query);
    query = applyQuestionFilters(query, { category, difficulty });
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
}

async function fetchPremiumSessionQuestions(userId, {
    size,
    category = 'all',
    difficulty = 'all',
    questionIds = [],
    poolMode = 'all',
    answeredIds,
}) {
    if (questionIds.length) return fetchServedQuestionRows({ ids: questionIds.slice(0, size) });
    const filteredTotal = await countServedQuestions({ category, difficulty });
    if (!filteredTotal) return [];

    const candidateCount = Math.min(Math.max(size * 4, 100), 500, filteredTotal);
    const offset = Math.floor(Math.random() * Math.max(1, filteredTotal));
    const first = await fetchServedQuestionRows({ category, difficulty, offset, limit: candidateCount });
    const candidates = first.length >= candidateCount || offset === 0
        ? first
        : [...first, ...await fetchServedQuestionRows({ category, difficulty, offset: 0, limit: candidateCount - first.length })];
    if (poolMode !== 'new') return pickRandom(candidates, size);

    const answered = answeredIds || new Set((await fetchAllPostgrestRows((from, to) => supabase
        .from(PROGRESS_TABLE)
        .select('question_id')
        .eq('user_id', userId)
        .range(from, to))).map((row) => String(row.question_id)));
    const unseen = candidates.filter((q) => !answered.has(String(q.id)));
    return pickRandom([...unseen, ...candidates.filter((q) => answered.has(String(q.id)))], size);
}

function proportionalCategoryAllocations(categories, size) {
    const total = categories.reduce((sum, category) => sum + category.total, 0);
    if (!total || !size) return [];
    const allocations = categories.map((category) => {
        const exact = (size * category.total) / total;
        return { ...category, count: Math.floor(exact), remainder: exact % 1 };
    });
    let remaining = size - allocations.reduce((sum, category) => sum + category.count, 0);
    allocations.sort((a, b) => b.remainder - a.remainder || b.total - a.total || a.category.localeCompare(b.category));
    for (let index = 0; remaining > 0 && allocations.length; index = (index + 1) % allocations.length) {
        allocations[index].count += 1;
        remaining -= 1;
    }
    return allocations.filter((category) => category.count > 0);
}

async function fetchBalancedPremiumSessionQuestions(userId, { size, poolMode = 'all' }) {
    const catalog = await getQuestionCatalog();
    const allocations = proportionalCategoryAllocations(catalog.categories, Math.min(size, catalog.total));
    const answeredIds = poolMode === 'new'
        ? new Set((await fetchAllPostgrestRows((from, to) => supabase
            .from(PROGRESS_TABLE)
            .select('question_id')
            .eq('user_id', userId)
            .range(from, to))).map((row) => String(row.question_id)))
        : undefined;
    const groups = await Promise.all(allocations.map((allocation) => fetchPremiumSessionQuestions(userId, {
        size: allocation.count,
        category: allocation.category,
        poolMode,
        answeredIds,
    })));
    const selected = groups.flat();
    const selectedIds = new Set(selected.map((question) => String(question.id)));
    if (selected.length >= size) return pickRandom(selected, size);
    const fill = await fetchPremiumSessionQuestions(userId, {
        size: size - selected.length,
        poolMode,
        answeredIds,
    });
    return [...selected, ...fill.filter((question) => !selectedIds.has(String(question.id)))].slice(0, size);
}

async function getRecommendedPriorityIds(userId, size) {
    const dueCap = Math.max(1, Math.ceil(size * 0.4));
    const missedCap = Math.max(1, Math.ceil(size * 0.4));
    let due = [];
    try {
        const { data, error } = await supabase.from('review_state')
            .select('question_id')
            .eq('user_id', userId)
            .lte('due_at', new Date().toISOString())
            .order('due_at', { ascending: true })
            .limit(dueCap);
        if (error) throw error;
        due = (data || []).map((row) => String(row.question_id));
    } catch (error) {
        console.warn('Recommended-session due lookup:', error.message);
    }

    const progress = await fetchAllPostgrestRows((from, to) => supabase
        .from(PROGRESS_TABLE)
        .select('id, question_id, is_correct, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to));
    const latest = new Map();
    progress.forEach((row) => {
        const questionId = String(row.question_id);
        if (!latest.has(questionId)) latest.set(questionId, row);
    });
    const missed = Array.from(latest.entries())
        .filter(([, row]) => !row.is_correct)
        .map(([questionId]) => questionId)
        .slice(0, missedCap);
    return Array.from(new Set([...due, ...missed]));
}

async function fetchPrioritySessionQuestions(userId, { size, questionIds = [], purpose }) {
    const priorityIds = purpose === 'recommended'
        ? await getRecommendedPriorityIds(userId, size)
        : questionIds;
    const priority = priorityIds.length
        ? await fetchServedQuestionRows({ ids: priorityIds.slice(0, size) })
        : [];
    if (priority.length >= size) return pickRandom(priority, size);
    const fill = await fetchPremiumSessionQuestions(userId, {
        size: Math.max((size - priority.length) * 2, 20),
        category: 'all',
        difficulty: 'all',
        questionIds: [],
        poolMode: 'new',
    });
    const seen = new Set(priority.map((q) => String(q.id)));
    return [...priority, ...fill.filter((q) => !seen.has(String(q.id)))].slice(0, size);
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
        return res.status(400).send('Invalid webhook signature.');
    }

    try {
        if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
            const session = event.data.object;
            if (session.payment_status !== 'paid') {
                console.log(`Checkout completed but payment_status=${session.payment_status}; deferring unlock.`);
                return res.json({ received: true });
            }
            const lineItem = await verifyStripeCheckoutProduct(session);
            const customerEmail = (session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
            let userId = session.client_reference_id || session.metadata?.user_id || null;
            if (!validUuid(userId) && customerEmail && supabase) {
                const { data: profile, error } = await supabase
                    .from(PROFILE_TABLE)
                    .select('user_id')
                    .eq('email', customerEmail)
                    .maybeSingle();
                if (error) throw error;
                userId = profile?.user_id || null;
            }
            if (!validUuid(userId)) {
                throw new Error('Verified paid checkout has no resolvable MACPrep account.');
            }
            await syncPaidStripeCheckout({
                session,
                lineItem,
                userId,
                email: customerEmail,
                metadata: { checkout_event_id: event.id, livemode: !!event.livemode },
            });
            recordPurchaseOnce(userId);
        } else if (event.type === 'charge.refunded') {
            const charge = event.data.object;
            if (charge.refunded === true) {
                const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
                if (paymentIntent) {
                    const matched = await syncStripePaymentStatus({
                        paymentIntentId: paymentIntent,
                        status: 'refunded',
                        fallbackEmail: charge.billing_details?.email || '',
                        eventId: event.id,
                    });
                    if (!matched) reportOperationalError('stripe.refund.unmatched', new Error('A refund event did not match a MACPrep entitlement.'), { eventType: event.type });
                }
            }
        } else if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
            const dispute = event.data.object;
            const paymentIntent = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
            let status = event.type === 'charge.dispute.closed' && dispute.status === 'won' ? 'active' : 'disputed';
            if (paymentIntent) {
                // Stripe does not guarantee webhook order. A delayed dispute win
                // may reactivate access only after a fresh provider lookup confirms
                // the charge has not since been refunded or disputed again.
                if (status === 'active') status = await currentStripeEntitlementStatus(paymentIntent);
                const matched = await syncStripePaymentStatus({
                    paymentIntentId: paymentIntent,
                    status,
                    eventId: event.id,
                    allowReactivate: status === 'active',
                });
                if (!matched) reportOperationalError('stripe.dispute.unmatched', new Error('A dispute event did not match a MACPrep entitlement.'), { eventType: event.type });
            }
        }
    } catch (syncError) {
        reportOperationalError('stripe.webhook', syncError, { eventType: event.type });
        return res.status(500).send('Entitlement sync failure.');
    }

    res.json({ received: true });
});

// Public delivery is allowlist-only. The deployment contains server code,
// migrations, native projects, and private operational documents; none of those
// should become web assets merely because a new file extension was overlooked.
const PUBLIC_HTML_FILES = new Set([
    'index.html', '404.html', 'about.html', 'cookies.html', 'faculty.html',
    'faq.html', 'login.html', 'metrics.html', 'offline.html', 'pricing.html',
    'privacy.html', 'register.html', 'reset.html', 'reviews.html', 'terms.html',
    'updates.html', 'why-trust-us.html',
    'guides/index.html', 'guides/caa-recertification-guide.html',
    'guides/caa-vs-crna-board-exams.html', 'guides/high-yield-topics-nccaa-exam.html',
    'guides/how-long-to-study-for-the-nccaa-exam.html',
    'guides/how-to-pass-the-nccaa-certification-exam.html',
    'guides/nccaa-exam-pass-rates.html',
]);
const PUBLIC_ASSET_FILES = new Set([
    'public-shell.css', 'product-refresh.css', 'guide-tools.js', 'sentry.min.js',
    'src/app.js', 'sw.js', 'manifest.webmanifest', 'robots.txt', 'sitemap.xml',
    'apple-touch-icon.png', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png',
    'favicon.ico', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
    'logo.png', 'og-image.png', 'founder.jpg', 'partner-bagmask.png',
    'partner-caa-discord.png', 'partner-cmeforcaas.png', 'brand/macprep-mark.svg',
    'img/anes-machine.jpg', 'img/or-scene.jpg',
]);

function normalizedPublicPath(requestPath) {
    try {
        const decoded = decodeURIComponent(requestPath);
        if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return '';
        const relative = decoded.replace(/^\/+/, '');
        return relative.split('/').some((part) => part === '..' || part === '.') ? '' : relative;
    } catch (error) {
        return '';
    }
}

function htmlFileForCleanPath(requestPath) {
    if (requestPath === '/') return 'index.html';
    const relative = normalizedPublicPath(requestPath).replace(/\/+$/, '');
    if (!relative) return 'index.html';
    const candidate = relative === 'guides' ? 'guides/index.html' : `${relative}.html`;
    return PUBLIC_HTML_FILES.has(candidate) ? candidate : '';
}

// ---------------------------------------------------------------------------
// Clean URLs — 301 /foo.html → /foo (canonical, shareable, SEO-friendly) and
// serve /foo from foo.html. Old .html links keep working via the redirect, so
// no traffic is lost. Query strings are preserved; #hash is client-side only.
// ---------------------------------------------------------------------------
app.get(/\.html$/i, (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const relative = normalizedPublicPath(req.path);
    if (!PUBLIC_HTML_FILES.has(relative)) return next();
    const clean = req.path.replace(/\/index\.html$/i, '/').replace(/\.html$/i, '') || '/';
    const qs = req.originalUrl.slice(req.path.length);
    res.redirect(301, clean + qs);
});
app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/') || path.extname(req.path)) return next();
    const file = htmlFileForCleanPath(req.path);
    if (!file) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file, { root: PROJECT_ROOT, dotfiles: 'deny' }, (err) => {
        if (err) { res.removeHeader('Cache-Control'); next(); }
    });
});

// ---------------------------------------------------------------------------
// JSON parsing + explicit static assets for all normal routes
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '64kb' }));
app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const cookieAuthenticated = !!(authCookie(req, ACCESS_COOKIE) || authCookie(req, REFRESH_COOKIE));
    if (!cookieAuthenticated || String(req.headers.authorization || '').startsWith('Bearer ')) return next();
    if (!trustedBaseUrl(req.headers.origin || '')) {
        return res.status(403).json({ error: 'Cross-site request rejected.' });
    }
    next();
});
app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api/')) return next();
    const relative = normalizedPublicPath(req.path);
    const criticalEventImage = relative.startsWith('critical-events-img/')
        && /^critical-events-img\/[a-z0-9-]+\.(?:png|jpe?g|webp)$/i.test(relative);
    if (!PUBLIC_ASSET_FILES.has(relative) && !criticalEventImage) return next();
    if (/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf)$/i.test(relative)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000');
    } else if (/\.(js|css)$/i.test(relative)) {
        res.setHeader('Cache-Control', 'no-cache');
    } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    if (relative === 'sw.js') res.setHeader('Service-Worker-Allowed', '/');
    return res.sendFile(relative, { root: PROJECT_ROOT, dotfiles: 'deny' }, (error) => {
        if (error) next();
    });
});

// ---------------------------------------------------------------------------
// Health/version check — lets you confirm at a glance which build is live
// (e.g. curl https://www.macprep.org/api/health). Bump `build` when deploying.
// ---------------------------------------------------------------------------
const DATABASE_HEALTH_TIMEOUT_MS = 5000;
const DATABASE_HEALTH_REPORT_AFTER = 2;
const DATABASE_HEALTH_REPORT_COOLDOWN_MS = 15 * 60 * 1000;
let consecutiveDatabaseHealthFailures = 0;
let lastDatabaseHealthReportAt = 0;

export async function runDatabaseHealthProbe(startProbe, timeoutMs = DATABASE_HEALTH_TIMEOUT_MS) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    try {
        const result = await startProbe(controller.signal);
        if (timedOut) throw new Error(`Database health check timed out after ${timeoutMs} ms.`);
        if (result?.error) throw result.error;
        return result;
    } catch (error) {
        if (timedOut) throw new Error(`Database health check timed out after ${timeoutMs} ms.`);
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export function shouldReportDatabaseHealthFailure({
    consecutiveFailures,
    lastReportedAt,
    now = Date.now(),
    reportAfter = DATABASE_HEALTH_REPORT_AFTER,
    cooldownMs = DATABASE_HEALTH_REPORT_COOLDOWN_MS,
}) {
    return consecutiveFailures >= reportAfter
        && (!lastReportedAt || now - lastReportedAt >= cooldownMs);
}

app.get('/api/health', async (req, res) => {
    let database = supabase ? 'reachable' : 'not_configured';
    if (supabase) {
        try {
            await runDatabaseHealthProbe((signal) => supabase
                .from(PROFILE_TABLE)
                .select('user_id', { head: true })
                .limit(1)
                .retry(false)
                .abortSignal(signal));
            if (consecutiveDatabaseHealthFailures) {
                console.info(`[health.database] Probe recovered after ${consecutiveDatabaseHealthFailures} failure(s).`);
            }
            consecutiveDatabaseHealthFailures = 0;
        } catch (error) {
            database = 'unreachable';
            consecutiveDatabaseHealthFailures += 1;
            const now = Date.now();
            if (shouldReportDatabaseHealthFailure({
                consecutiveFailures: consecutiveDatabaseHealthFailures,
                lastReportedAt: lastDatabaseHealthReportAt,
                now,
            })) {
                lastDatabaseHealthReportAt = now;
                reportOperationalError('health.database', error, {
                    route: '/api/health',
                    consecutiveFailures: consecutiveDatabaseHealthFailures,
                });
            } else {
                console.warn(`[health.database] Probe failure ${consecutiveDatabaseHealthFailures}: ${error?.message || error}`);
            }
        }
    }
    const ok = database !== 'unreachable';
    res.status(ok ? 200 : 503).json({
        ok,
        service: 'macprep',
        build: 'security-hardening-20260723.1',
        auth_endpoint: '/api/authenticate',
        supabase: database === 'reachable',
        database,
        serve_filler: SERVE_FILLER,
        monitoring: !!process.env.SENTRY_DSN,
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
function startReferralCodeScheduler() {
    ensureReferralCode();                                 // on boot
    setInterval(ensureReferralCode, 6 * 60 * 60 * 1000);  // every 6h — picks up the month rollover same day
}

// Public runtime config for the browser (no secrets — browser Sentry DSNs are public
// by design). Set SENTRY_BROWSER_DSN on Render to turn on error monitoring.
app.get('/api/config', (req, res) => {
    ensureReferralCode(); // fire-and-forget; idempotent, creates the new month's code on first hit
    res.json({
        sentryDsn: process.env.SENTRY_BROWSER_DSN || null,
        environment: process.env.NODE_ENV || 'production',
        referralCode: referralCodeFor(),
        nativePurchaseBridgeMinVersion: 1,
        nativePremiumProductId: MOBILE_PREMIUM_PRODUCT_ID,
        nativePurchaseVerificationConfigured: mobilePurchaseVerificationConfigured(),
    });
});

// Public, sanitized CAAHEP snapshot for the applicant information workspace.
// Program-director names and contact details are intentionally excluded.
app.get('/api/public/aa-programs', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.json(publicAAProgramDirectory());
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

async function fetchRowsForUserIds(table, columns, userIds, chunkSize = 200) {
    const rows = [];
    for (let offset = 0; offset < userIds.length; offset += chunkSize) {
        const ids = userIds.slice(offset, offset + chunkSize);
        const chunkRows = await fetchAllPostgrestRows((from, to) => supabase
            .from(table)
            .select(columns)
            .in('user_id', ids)
            .order('user_id', { ascending: true })
            .range(from, to));
        rows.push(...chunkRows);
    }
    return rows;
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
    const due = await fetchAllPostgrestRows((from, to) => supabase.from('review_state')
        .select('user_id, question_id').lte('due_at', nowIso)
        .order('user_id', { ascending: true }).order('question_id', { ascending: true }).range(from, to));
    const counts = {};
    (due || []).forEach((r) => { counts[r.user_id] = (counts[r.user_id] || 0) + 1; });
    const userIds = Object.keys(counts);
    if (!userIds.length) return { sent: 0, candidates: 0 };
    const activeCutoff = new Date(Date.now() - 18 * 3600 * 1000).toISOString();
    const active = await fetchAllPostgrestRows((from, to) => supabase.from(PROGRESS_TABLE)
        .select('user_id, created_at').gte('created_at', activeCutoff)
        .order('created_at', { ascending: true }).range(from, to));
    const activeSet = new Set((active || []).map((r) => r.user_id));
    const profiles = await fetchRowsForUserIds(
        PROFILE_TABLE,
        'user_id, email, full_name, last_nudged_at, nudge_opt_out',
        userIds
    );
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
        } catch (e) { console.error('[nudges] send failed:', e.message); }
    }
    return { sent, eligible, candidates: userIds.length };
}

// Shared eligibility for every reminder channel (email / web push / native push):
// users with due reviews who haven't studied in 18h. Returns per-user due counts
// plus the inactive user ids. Each channel then applies its own 20h throttle.
async function computeReminderTargets() {
    const due = await fetchAllPostgrestRows((from, to) => supabase.from('review_state')
        .select('user_id, question_id').lte('due_at', new Date().toISOString())
        .order('user_id', { ascending: true }).order('question_id', { ascending: true }).range(from, to));
    const counts = {};
    (due || []).forEach((r) => { counts[r.user_id] = (counts[r.user_id] || 0) + 1; });
    const targetIds = Object.keys(counts);
    if (!targetIds.length) return { counts, inactive: [] };
    const activeCutoff = new Date(Date.now() - 18 * 3600 * 1000).toISOString();
    const active = await fetchAllPostgrestRows((from, to) => supabase.from(PROGRESS_TABLE)
        .select('user_id, created_at').gte('created_at', activeCutoff)
        .order('created_at', { ascending: true }).range(from, to));
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
    const subs = await fetchRowsForUserIds(
        'push_subscriptions',
        'id, user_id, subscription, last_pushed_at',
        inactive
    );
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
            else { console.error('[push] send failed:', e.statusCode || e.message); }
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
    const toks = await fetchRowsForUserIds(
        'native_device_tokens',
        'id, user_id, token, platform, last_pushed_at',
        inactive
    );
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
    const { data: toks, error } = await supabase.from('native_device_tokens').select('id, token, platform').eq('user_id', userId);
    if (error) throw error;
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
app.post('/api/push/subscribe', pushLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const sub = req.body?.subscription;
    const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint.trim() : '';
    const serialized = sub && typeof sub === 'object' ? JSON.stringify(sub) : '';
    if (!endpoint.startsWith('https://') || endpoint.length > 2048 || serialized.length > 8192) {
        return res.status(400).json({ error: 'Bad subscription.' });
    }
    try {
        const { data: existing, error: lookupError } = await supabase
            .from('push_subscriptions').select('user_id').eq('endpoint', endpoint).maybeSingle();
        if (lookupError) throw lookupError;
        if (existing?.user_id && existing.user_id !== user.id) {
            return res.status(409).json({ error: 'This browser notification subscription belongs to another account.' });
        }
        const { error } = await supabase
            .from('push_subscriptions')
            .upsert({ user_id: user.id, endpoint, subscription: sub }, { onConflict: 'endpoint' });
        if (error) throw error;
        return res.json({ success: true });
    } catch (e) { console.error('[push] subscribe failed:', e.message); return res.status(500).json({ error: 'Could not save.' }); }
});
app.post('/api/push/unsubscribe', pushLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    try {
        const endpoint = req.body?.endpoint;
        const result = endpoint
            ? await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', user.id)
            : await supabase.from('push_subscriptions').delete().eq('user_id', user.id);
        if (result.error) throw result.error;
        return res.json({ success: true });
    } catch (e) { reportOperationalError('push.unsubscribe', e); return res.status(500).json({ error: 'Could not remove.' }); }
});

// Native store-app device tokens (@capacitor/push-notifications): iOS APNs / Android FCM.
app.post('/api/push/register-native', pushLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    const { token, platform } = req.body || {};
    const normalizedToken = typeof token === 'string' ? token.trim() : '';
    if (!normalizedToken || normalizedToken.length > 4096 || (platform !== 'ios' && platform !== 'android')) {
        return res.status(400).json({ error: 'Bad token.' });
    }
    try {
        const { data: existing, error: lookupError } = await supabase
            .from('native_device_tokens').select('user_id').eq('token', normalizedToken).maybeSingle();
        if (lookupError) throw lookupError;
        if (existing?.user_id && existing.user_id !== user.id) {
            return res.status(409).json({ error: 'This device notification token belongs to another account.' });
        }
        const { error } = await supabase
            .from('native_device_tokens')
            .upsert({ user_id: user.id, token: normalizedToken, platform, updated_at: new Date().toISOString() }, { onConflict: 'token' });
        if (error) throw error;
        return res.json({ success: true });
    } catch (e) { console.error('[native-push] register failed:', e.message); return res.status(500).json({ error: 'Could not save.' }); }
});
app.post('/api/push/unregister-native', pushLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Please sign in.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    try {
        const token = req.body?.token;
        const result = token
            ? await supabase.from('native_device_tokens').delete().eq('token', token).eq('user_id', user.id)
            : await supabase.from('native_device_tokens').delete().eq('user_id', user.id);
        if (result.error) throw result.error;
        return res.json({ success: true });
    } catch (e) { reportOperationalError('native-push.unregister', e); return res.status(500).json({ error: 'Could not remove.' }); }
});

// One-click unsubscribe (token-signed, no login needed).
app.get('/api/unsubscribe', async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const u = req.query.u, t = req.query.t;
    const page = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MACPrep</title><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;"><div style="text-align:center;max-width:420px;padding:32px;"><div style="font-family:ui-monospace,monospace;font-size:24px;font-weight:800;">MAC<span style="color:#047857;">Prep</span></div><p style="font-size:16px;line-height:1.6;margin-top:18px;">${msg}</p><a href="${BASE_URL}/" style="color:#047857;">Back to MACPrep</a></div></body>`;
    if (!u || !t || !supabase || t !== unsubToken(u)) return res.status(400).send(page('This unsubscribe link is invalid or expired.'));
    try {
        const { error } = await supabase.from(PROFILE_TABLE).update({ nudge_opt_out: true }).eq('user_id', u);
        if (error) throw error;
        return res.send(page("You've been unsubscribed from study reminders. Email support@macprep.org if you'd like them back on."));
    } catch (error) {
        reportOperationalError('reminder.unsubscribe', error);
        return res.status(500).send(page('We could not update that preference. Please try the link again shortly.'));
    }
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
    } catch (error) {
        reportOperationalError('admin.run-nudges', error);
        return res.status(500).json({ error: 'Could not run reminders.' });
    }
});

// Record a successful purchase in the funnel exactly once per user. Webhook retries,
// checkout-return verification, and Store restore attempts must never double-count it.
async function recordPurchaseOnce(userId, via = 'stripe') {
    if (!userId || !supabase) return;
    try {
        const { error } = await supabase.from('analytics_events').insert({
            name: 'purchase',
            user_id: userId,
            meta: sanitizeAnalyticsMeta('upgrade_success', { via }),
        });
        if (error && error.code !== '23505') console.warn('[analytics] purchase event failed:', error.message);
    } catch (e) { /* analytics is never worth failing a payment path over */ }
}

// ACTUAL revenue from Stripe — succeeded charges minus refunds, grouped by calendar
// month (UTC). The old estimate multiplied purchase count by the CURRENT price
// constant, which rewrote history whenever the price changed (older sales showed
// as $100). Cached 10 min; on a Stripe hiccup we serve the last good snapshot.
let _revCache = { at: 0, data: null };
async function getStripeRevenue() {
    if (_revCache.data && Date.now() - _revCache.at < 10 * 60 * 1000) return _revCache.data;
    if (!stripe) return null;
    try {
        const byMonth = {};
        let all_time = 0, paid_count = 0;
        for await (const ch of stripe.charges.list({ limit: 100 })) {
            if (ch.status !== 'succeeded') continue;
            const net = ((ch.amount_captured ?? ch.amount ?? 0) - (ch.amount_refunded || 0)) / 100;
            if (net <= 0) continue; // fully refunded — not revenue
            const m = new Date(ch.created * 1000).toISOString().slice(0, 7);
            byMonth[m] = byMonth[m] || { month: m, amount: 0, count: 0 };
            byMonth[m].amount += net; byMonth[m].count += 1;
            all_time += net; paid_count += 1;
        }
        const data = { all_time, paid_count, monthly: Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)) };
        _revCache = { at: Date.now(), data };
        return data;
    } catch (e) { console.error('[metrics] stripe revenue fetch failed:', e.message); return _revCache.data; }
}

// Admin-only funnel/metrics for the founder dashboard (/metrics.html). All event
// aggregation happens in Postgres (founder_metrics function) — the old Node path
// fetched raw event rows in one request and hit PostgREST's ~1000-row cap, so only
// the OLDEST ~1000 events of the window survived and every recent day read as zero
// (the same bug /api/admin/analytics already fixed by paging). Revenue is actual
// Stripe charge amounts by month, and the funnel's Purchased row shares the same
// 30-day window as every other row.
app.get('/api/admin/metrics', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Forbidden' });
    if (!supabase) return res.status(500).json({ error: 'no db' });
    try {
        const windowDays = 30;
        const now = new Date();
        const usageSince = new Date(now.getTime() - windowDays * 86400000).toISOString();
        const [rollup, feedbackResult, rev, analyticsRows, itemQualityResult] = await Promise.all([
            supabase.rpc('founder_metrics', { p_window_days: windowDays, p_daily_days: 21, p_review_emails: [...REVIEW_EMAILS] }),
            supabase.from('user_suggestions').select('user_email, suggestion_text, created_at').order('created_at', { ascending: false }).limit(25),
            getStripeRevenue(),
            fetchAnalyticsEventsSince(usageSince).catch((error) => {
                console.error('[metrics] analytics usage fetch failed:', error.message);
                return [];
            }),
            supabase.rpc('macprep_item_quality_rollup', {
                p_min_sample: 10,
                p_excluded_emails: [...ADMIN_EMAILS, ...REVIEW_EMAILS],
            }),
        ]);
        if (rollup.error) throw new Error(rollup.error.message);
        if (feedbackResult.error) throw feedbackResult.error;
        if (itemQualityResult.error) {
            reportOperationalError('admin.metrics.item-quality', itemQualityResult.error);
        }
        const feedback = feedbackResult.data || [];
        const m = rollup.data;
        const thisMonth = new Date().toISOString().slice(0, 7);
        const cur = (rev && rev.monthly.find((x) => x.month === thisMonth)) || { amount: 0, count: 0 };
        res.json({
            generated_at: new Date().toISOString(),
            window_days: windowDays,
            // Client contract: totals.users (the SQL rollup names it users.total)
            totals: { users: m.users.total, premium: m.users.premium, free: m.users.free, with_exam_date: m.users.with_exam_date },
            credential_mix: m.credential_mix,
            lifecycle_mix: m.lifecycle_mix,
            program_mix: m.program_mix,
            program_unset: m.program_unset,
            revenue: {
                paid_conversions: rev ? rev.paid_count : m.purchases_all_time,
                all_time: rev ? rev.all_time : null,
                this_month: cur.amount,
                this_month_count: cur.count,
                monthly: rev ? rev.monthly : [],
                avg_price: rev && rev.paid_count ? rev.all_time / rev.paid_count : null,
            },
            funnel: [
                { key: 'visits', label: 'Landing views', n: m.funnel.visits },
                { key: 'signups', label: 'Signups', n: m.funnel.signups },
                { key: 'practiced', label: 'Started practicing', n: m.funnel.practiced },
                { key: 'paywall', label: 'Hit paywall', n: m.funnel.paywall },
                { key: 'checkout', label: 'Started checkout', n: m.funnel.checkout },
                { key: 'purchase', label: 'Purchased', n: m.funnel.purchased },
            ],
            event_counts: m.event_counts,
            product_usage: summarizeProductUsage(analyticsRows, now),
            item_quality: itemQualityResult.error ? {
                unavailable: true,
                summary: {},
                items: [],
            } : itemQualityResult.data,
            daily: m.daily,
            monthly_signups: m.signups_by_month || [],
            recent_signups: m.recent_signups,
            feedback_count: (feedback || []).length,
            recent_feedback: (feedback || []).map((f) => ({ email: f.user_email, text: f.suggestion_text, at: f.created_at })),
        });
    } catch (error) {
        reportOperationalError('admin.metrics', error);
        return res.status(500).json({ error: 'Could not load metrics.' });
    }
});

// Daily reminder scheduler (in-process; dormant without RESEND_API_KEY). Fires in
// a US-morning window; the per-user 20h throttle makes restarts safe.
function startReminderScheduler() {
    if (!(RESEND_API_KEY || PUSH_ENABLED || NATIVE_PUSH_ENABLED)) return;
    let _lastNudgeDay = null;
    setInterval(async () => {
        try {
            const now = new Date();
            const day = now.toISOString().slice(0, 10);
            const h = now.getUTCHours();
            if (h >= 13 && h < 15 && _lastNudgeDay !== day) {
                _lastNudgeDay = day;
                const { data: claimed, error: claimError } = await supabase.rpc('claim_macprep_daily_job', {
                    p_job_name: 'study-reminders',
                    p_run_day: day,
                });
                if (claimError) throw claimError;
                if (!claimed) return;
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
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : authCookie(req, ACCESS_COOKIE);
    if (!token || !supabaseAuth) return null;
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error) return null;
    return data.user || null;
}

// Helper: is this authenticated user premium? Keyed on user_id + account_tier.
async function isUserPremium(userId) {
    if (!supabase || !userId) {
        const error = new Error('Account access service is not configured.');
        error.status = 503;
        throw error;
    }
    const { data, error } = await supabase
        .from(PROFILE_TABLE)
        .select('account_tier')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) {
        error.status = 503;
        throw error;
    }
    return data?.account_tier === 'premium';
}

async function hasFullAccess(user) {
    if (!user) return false;
    if (isAdminUser(user) || isReviewUser(user)) return true;
    try {
        return await isUserPremium(user.id);
    } catch (error) {
        reportOperationalError('entitlement.lookup', error);
        return null;
    }
}

function accessLookupUnavailable(res) {
    return res.status(503).json({ error: 'Account access could not be verified. Please try again shortly.', retryable: true });
}

function inferLifecycleStage(profile) {
    const explicit = normalizeLifecycleStage(profile?.lifecycle_stage);
    if (explicit) return explicit;
    const credential = String(profile?.credential || '').trim().toUpperCase();
    if (credential.startsWith('SAA')) return 'student';
    if (credential.startsWith('CAA')) return 'practicing';
    return null;
}

function dateHasArrived(value) {
    return isValidProfileDate(value) && value <= new Date().toISOString().slice(0, 10);
}

async function advanceLifecycleDates(profile, userId) {
    let next = profile || null;
    let stage = inferLifecycleStage(next);
    if (!supabase || !userId) return { profile: next, stage };
    if (stage === 'incoming_student' && dateHasArrived(next?.matriculation_date)) {
        const now = new Date().toISOString();
        const { data, error } = await supabase.from(PROFILE_TABLE)
            .update({ lifecycle_stage: 'student', credential: 'SAA', lifecycle_updated_at: now, updated_at: now })
            .eq('user_id', userId)
            .eq('lifecycle_stage', 'incoming_student')
            .lte('matriculation_date', now.slice(0, 10))
            .select('lifecycle_stage, credential, matriculation_date, graduation_date')
            .maybeSingle();
        if (error) throw error;
        if (data) next = { ...next, ...data };
        stage = data ? 'student' : inferLifecycleStage(next);
    }
    if (stage === 'student' && dateHasArrived(next?.graduation_date)) {
        const now = new Date().toISOString();
        const { data, error } = await supabase.from(PROFILE_TABLE)
            .update({ lifecycle_stage: 'practicing', credential: 'CAA', lifecycle_updated_at: now, updated_at: now })
            .eq('user_id', userId)
            .eq('lifecycle_stage', 'student')
            .lte('graduation_date', now.slice(0, 10))
            .select('lifecycle_stage, credential, matriculation_date, graduation_date')
            .maybeSingle();
        if (error) throw error;
        if (data) next = { ...next, ...data };
        stage = data ? 'practicing' : inferLifecycleStage(next);
    }
    return { profile: next, stage };
}

async function advanceDueLifecycleProfiles() {
    if (!supabase) return { incoming: 0, graduates: 0 };
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const { data: incoming, error: incomingError } = await supabase.from(PROFILE_TABLE)
        .update({ lifecycle_stage: 'student', credential: 'SAA', lifecycle_updated_at: now, updated_at: now })
        .eq('lifecycle_stage', 'incoming_student')
        .lte('matriculation_date', today)
        .select('user_id');
    if (incomingError) throw incomingError;
    const { data: graduates, error: graduateError } = await supabase.from(PROFILE_TABLE)
        .update({ lifecycle_stage: 'practicing', credential: 'CAA', lifecycle_updated_at: now, updated_at: now })
        .eq('lifecycle_stage', 'student')
        .lte('graduation_date', today)
        .select('user_id');
    if (graduateError) throw graduateError;
    return { incoming: incoming?.length || 0, graduates: graduates?.length || 0 };
}

function startLifecycleScheduler() {
    if (!supabase) return;
    const run = async () => {
        try {
            const moved = await advanceDueLifecycleProfiles();
            if (moved.incoming || moved.graduates) console.log(`[lifecycle] advanced ${moved.incoming} incoming students and ${moved.graduates} graduates`);
        } catch (error) {
            reportOperationalError('lifecycle.scheduler', error);
        }
    };
    run();
    const timer = setInterval(run, 60 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
}

async function getUserLifecycle(user) {
    if (!user) return { stage: null, boardPrep: false };
    if (isAdminUser(user) || isReviewUser(user)) return { stage: 'practicing', boardPrep: true, elevated: true };
    if (!supabase) throw new Error('Lifecycle service is not configured.');
    const { data, error } = await supabase.from(PROFILE_TABLE)
        .select('lifecycle_stage, credential, matriculation_date, graduation_date')
        .eq('user_id', user.id)
        .maybeSingle();
    if (error) throw error;
    const resolved = await advanceLifecycleDates(data, user.id);
    return { ...resolved, boardPrep: BOARD_PREP_LIFECYCLE_STAGES.has(resolved.stage) };
}

async function requireBoardPrepLifecycle(user, res) {
    try {
        const lifecycle = await getUserLifecycle(user);
        if (lifecycle.boardPrep) return lifecycle;
        res.status(403).json({
            error: lifecycle.stage === 'incoming_student'
                ? 'Your student tools will open on your matriculation date.'
                : 'Board-prep tools are available once you begin AA school.',
            lifecycle_restricted: true,
            lifecycle_stage: lifecycle.stage,
        });
        return null;
    } catch (error) {
        reportOperationalError('lifecycle.lookup', error);
        res.status(503).json({ error: 'Your account stage could not be verified. Please try again shortly.', retryable: true });
        return null;
    }
}

async function grantEntitlement({
    userId,
    email,
    source,
    sourceReference,
    externalPaymentId = null,
    productId = null,
    amountTotal = null,
    currency = null,
    metadata = {},
    allowReactivate = false,
}) {
    if (!supabase || !userId) return false;
    const providerSource = ['stripe', 'apple', 'google_play'].includes(source);
    const args = {
        p_user: userId,
        p_email: email || null,
        p_source: source,
        p_source_reference: sourceReference,
        p_external_payment_id: externalPaymentId,
        p_product_id: productId,
        p_amount_total: Number.isSafeInteger(amountTotal) ? amountTotal : null,
        p_currency: currency || null,
        p_metadata: metadata && typeof metadata === 'object' ? metadata : {},
    };
    if (providerSource) {
        args.p_status = 'active';
        args.p_allow_reactivate = !!allowReactivate;
    }
    const { data, error } = await supabase.rpc(
        providerSource ? 'sync_macprep_provider_entitlement' : 'grant_macprep_entitlement',
        args
    );
    if (error) throw error;
    return !!data;
}

async function syncProviderEntitlement({ userId, email = null, source, sourceReference, externalPaymentId = null, productId = null, status, amountTotal = null, currency = null, metadata = {}, allowReactivate = false }) {
    if (!supabase || !userId) throw new Error('Entitlement storage is unavailable.');
    const { data, error } = await supabase.rpc('sync_macprep_provider_entitlement', {
        p_user: userId,
        p_email: email,
        p_source: source,
        p_source_reference: sourceReference,
        p_external_payment_id: externalPaymentId,
        p_product_id: productId,
        p_status: status,
        p_amount_total: Number.isSafeInteger(amountTotal) ? amountTotal : null,
        p_currency: currency || null,
        p_metadata: metadata && typeof metadata === 'object' ? metadata : {},
        p_allow_reactivate: !!allowReactivate,
    });
    if (error) throw error;
    return !!data;
}

async function setEntitlementStatus({ source, sourceReference = null, externalPaymentId = null, status }) {
    if (!supabase) return null;
    const { data, error } = await supabase.rpc('set_macprep_entitlement_status', {
        p_source: source,
        p_source_reference: sourceReference,
        p_external_payment_id: externalPaymentId,
        p_status: status,
    });
    if (error) throw error;
    return data || null;
}

async function verifyStripeCheckoutProduct(session) {
    const allowedPriceIds = new Set(configuredStripePriceIds());
    if (!stripe || !allowedPriceIds.size) throw new Error('Stripe price verification is not configured.');
    if (!session?.id || session.mode !== 'payment' || session.payment_status !== 'paid') {
        throw new Error('Stripe checkout is not a completed one-time payment.');
    }
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
    const rows = lineItems?.data || [];
    if (rows.length !== 1 || !allowedPriceIds.has(rows[0]?.price?.id) || rows[0]?.quantity !== 1) {
        throw new Error('Stripe checkout does not match the MACPrep full-access product.');
    }
    return rows[0];
}

async function profileUserIdForEmail(email) {
    const normalized = String(email || '').toLowerCase().trim();
    if (!normalized || !supabase) return null;
    const { data, error } = await supabase
        .from(PROFILE_TABLE)
        .select('user_id')
        .eq('email', normalized)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data?.user_id || null;
}

async function currentStripeEntitlementStatus(paymentIntentId) {
    if (!paymentIntentId) return 'active';
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    let charge = paymentIntent?.latest_charge || null;
    if (typeof charge === 'string') charge = await stripe.charges.retrieve(charge);
    if (charge?.refunded === true) return 'refunded';
    if (charge?.disputed === true) return 'disputed';
    return 'active';
}

async function resolveStripeEntitlementContext(paymentIntentId, fallbackEmail = '') {
    if (!stripe || !paymentIntentId) return null;
    const allowedPriceIds = new Set(configuredStripePriceIds());
    if (!allowedPriceIds.size) throw new Error('Stripe price verification is not configured.');

    const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 10 });
    for (const session of sessions?.data || []) {
        if (session.mode !== 'payment' || session.payment_status !== 'paid') continue;
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
        const rows = lineItems?.data || [];
        if (rows.length !== 1 || !allowedPriceIds.has(rows[0]?.price?.id) || rows[0]?.quantity !== 1) continue;
        const lineItem = rows[0];
        const email = (session.customer_details?.email || session.customer_email || fallbackEmail || '').toLowerCase().trim();
        let userId = session.client_reference_id || session.metadata?.user_id || null;
        if (!validUuid(userId)) userId = await profileUserIdForEmail(email);
        if (!validUuid(userId)) throw new Error('Verified MACPrep payment has no resolvable account.');
        return { userId, email, session, lineItem };
    }

    // New checkouts copy the account/product marker onto the PaymentIntent, which
    // gives refund recovery a second exact path if a Checkout listing is delayed.
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const metadataPriceId = paymentIntent?.metadata?.macprep_product_id;
    if (!allowedPriceIds.has(metadataPriceId)) return null;
    const userId = paymentIntent.metadata?.user_id;
    if (!validUuid(userId)) throw new Error('Verified MACPrep payment has no resolvable account.');
    return {
        userId,
        email: String(fallbackEmail || '').toLowerCase().trim(),
        session: { id: `payment_intent:${paymentIntentId}`, amount_total: paymentIntent.amount, currency: paymentIntent.currency },
        lineItem: { price: { id: metadataPriceId } },
    };
}

async function syncStripePaymentStatus({ paymentIntentId, status, fallbackEmail = '', eventId = null, allowReactivate = false }) {
    if (!paymentIntentId) return null;
    const existingUser = await setEntitlementStatus({
        source: 'stripe',
        externalPaymentId: paymentIntentId,
        status,
    });
    if (existingUser) return existingUser;

    const context = await resolveStripeEntitlementContext(paymentIntentId, fallbackEmail);
    if (!context) return null;
    await syncProviderEntitlement({
        userId: context.userId,
        email: context.email,
        source: 'stripe',
        sourceReference: context.session.id,
        externalPaymentId: paymentIntentId,
        productId: context.lineItem.price.id,
        status,
        amountTotal: context.session.amount_total,
        currency: context.session.currency,
        metadata: { recovered_from_provider_event: true, provider_event_id: eventId },
        allowReactivate,
    });
    return context.userId;
}

async function syncPaidStripeCheckout({ session, lineItem, userId, email, metadata = {} }) {
    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    const status = await currentStripeEntitlementStatus(paymentIntentId);
    const hasAccess = await syncProviderEntitlement({
        userId,
        email,
        source: 'stripe',
        sourceReference: session.id,
        externalPaymentId: paymentIntentId || null,
        productId: lineItem.price.id,
        status,
        amountTotal: session.amount_total,
        currency: session.currency,
        metadata,
    });
    return { hasAccess, paymentIntentId, status };
}

class MobilePurchaseError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export function normalizeMobileStore(store) {
    return store === 'apple' || store === 'google_play' ? store : null;
}

export function mobileAccountHash(userId) {
    return createHash('sha256').update(String(userId || '').toLowerCase()).digest('hex');
}

async function userIdFromMobileAccountHash(hash) {
    const normalized = String(hash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized) || !supabase) return null;
    const { data, error } = await supabase.rpc('macprep_user_id_from_mobile_hash', { p_hash: normalized });
    if (error) throw error;
    return validUuid(data) ? data : null;
}

function validUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function configuredMobileProductId() {
    return MOBILE_PREMIUM_PRODUCT_ID;
}

function assertMobilePurchase(condition, message) {
    if (!condition) throw new MobilePurchaseError(message);
}

// The decoded payload comes from Apple's SignedDataVerifier, never directly from
// the device. Keeping the semantic checks pure makes transaction rules testable.
export function validateAppleTransactionPayload(payload, { userId, transactionId, bundleId = MOBILE_APP_BUNDLE_ID, productId = configuredMobileProductId() }) {
    assertMobilePurchase(payload && typeof payload === 'object', 'Apple did not return a valid transaction.');
    assertMobilePurchase(validUuid(userId), 'A valid MACPrep account is required.');
    assertMobilePurchase(payload.bundleId === bundleId, 'This Apple transaction belongs to a different app.');
    assertMobilePurchase(payload.productId === productId, 'This Apple transaction is not MACPrep full access.');
    assertMobilePurchase(payload.type === AppleProductType.NON_CONSUMABLE, 'This Apple transaction is not a permanent entitlement.');
    assertMobilePurchase(String(payload.transactionId || '') === String(transactionId), 'Apple returned a mismatched transaction.');
    assertMobilePurchase(!payload.revocationDate, 'This Apple purchase has been revoked or refunded.');
    assertMobilePurchase(
        String(payload.appAccountToken || '').toLowerCase() === String(userId).toLowerCase(),
        'This Apple purchase belongs to a different MACPrep account.'
    );
    return {
        store: 'apple',
        transactionId: String(payload.originalTransactionId || payload.transactionId),
        originalTransactionId: String(payload.originalTransactionId || payload.transactionId),
        productId,
        purchasedAt: Number.isFinite(Number(payload.purchaseDate)) ? new Date(Number(payload.purchaseDate)).toISOString() : null,
        environment: String(payload.environment || ''),
    };
}

// Google returns this object from the authenticated Android Publisher API. The
// purchase token is verified by Google, while the account hash prevents a token
// from being attached to a different MACPrep account.
export function validateGooglePurchasePayload(payload, { userId, productId = configuredMobileProductId() }) {
    assertMobilePurchase(payload && typeof payload === 'object', 'Google Play did not return a valid purchase.');
    assertMobilePurchase(validUuid(userId), 'A valid MACPrep account is required.');
    assertMobilePurchase(payload.purchaseStateContext?.purchaseState === 'PURCHASED', 'This Google Play purchase is not complete.');
    assertMobilePurchase(
        Array.isArray(payload.productLineItem) && payload.productLineItem.some((item) => item?.productId === productId),
        'This Google Play purchase is not MACPrep full access.'
    );
    assertMobilePurchase(
        payload.obfuscatedExternalAccountId === mobileAccountHash(userId),
        'This Google Play purchase belongs to a different MACPrep account.'
    );
    return {
        store: 'google_play',
        productId,
        purchasedAt: payload.purchaseCompletionTime || null,
        environment: payload.testPurchaseContext ? 'test' : 'production',
    };
}

function appleCredentials() {
    const privateKey = String(process.env.APPLE_IAP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    const keyId = String(process.env.APPLE_IAP_KEY_ID || '').trim();
    const issuerId = String(process.env.APPLE_IAP_ISSUER_ID || '').trim();
    if (!privateKey || !keyId || !issuerId) {
        throw new MobilePurchaseError('Apple purchase verification is not configured yet.', 503);
    }
    return { privateKey, keyId, issuerId };
}

function appleRootCertificates() {
    const raw = String(process.env.APPLE_IAP_ROOT_CERTIFICATES_BASE64 || '').trim();
    if (!raw) throw new MobilePurchaseError('Apple purchase verification is not configured yet.', 503);
    try {
        const entries = JSON.parse(raw);
        const certs = Array.isArray(entries)
            ? entries.map((entry) => Buffer.from(String(entry), 'base64')).filter((cert) => cert.length > 0)
            : [];
        if (!certs.length) throw new Error('No certificates');
        return certs;
    } catch (e) {
        throw new MobilePurchaseError('Apple purchase verification is not configured yet.', 503);
    }
}

function appleVerifier(environment) {
    const appAppleId = environment === Environment.PRODUCTION ? Number(process.env.APPLE_IAP_APP_ID) : undefined;
    if (environment === Environment.PRODUCTION && (!Number.isSafeInteger(appAppleId) || appAppleId <= 0)) {
        throw new MobilePurchaseError('Apple purchase verification is not configured yet.', 503);
    }
    return new SignedDataVerifier(
        appleRootCertificates(),
        true,
        environment,
        MOBILE_APP_BUNDLE_ID,
        appAppleId
    );
}

async function verifyAppleNotification(signedPayload) {
    if (typeof signedPayload !== 'string' || signedPayload.length < 32 || signedPayload.length > 100000) {
        throw new MobilePurchaseError('Invalid Apple notification.', 400);
    }
    const productionAppId = Number(process.env.APPLE_IAP_APP_ID);
    const environments = Number.isSafeInteger(productionAppId) && productionAppId > 0
        ? [Environment.PRODUCTION, Environment.SANDBOX]
        : [Environment.SANDBOX];
    let lastError;
    for (const environment of environments) {
        try {
            const verifier = appleVerifier(environment);
            const notification = await verifier.verifyAndDecodeNotification(signedPayload);
            let transaction = null;
            if (notification?.data?.signedTransactionInfo) {
                transaction = await verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo);
            }
            return { notification, transaction };
        } catch (error) {
            lastError = error;
        }
    }
    console.warn('[mobile-purchase] Apple notification verification failed:', lastError?.message || 'unknown error');
    throw new MobilePurchaseError('Invalid Apple notification signature.', 400);
}

async function verifyApplePurchase(userId, transactionId) {
    assertMobilePurchase(/^\d{1,64}$/.test(String(transactionId || '')), 'Invalid Apple transaction.');
    const credentials = appleCredentials();
    let lastError = null;
    const productionAppId = Number(process.env.APPLE_IAP_APP_ID);
    const canVerifyProduction = Number.isSafeInteger(productionAppId) && productionAppId > 0;
    // TestFlight uses Apple's sandbox environment while production purchases use
    // production. The client never chooses the environment; the server safely tries both.
    const environments = canVerifyProduction
        ? [Environment.PRODUCTION, Environment.SANDBOX]
        : [Environment.SANDBOX];
    for (const environment of environments) {
        try {
            const client = new AppStoreServerAPIClient(
                credentials.privateKey,
                credentials.keyId,
                credentials.issuerId,
                MOBILE_APP_BUNDLE_ID,
                environment
            );
            const response = await client.getTransactionInfo(transactionId);
            const payload = await appleVerifier(environment).verifyAndDecodeTransaction(response.signedTransactionInfo);
            return validateAppleTransactionPayload(payload, { userId, transactionId });
        } catch (error) {
            if (error instanceof MobilePurchaseError && error.status === 503) throw error;
            lastError = error;
        }
    }
    if (!canVerifyProduction) {
        throw new MobilePurchaseError('Apple production purchase verification is not configured yet.', 503);
    }
    console.warn('[mobile-purchase] Apple transaction verification failed:', lastError?.message || 'unknown error');
    throw new MobilePurchaseError('We could not verify this Apple purchase.', 422);
}

function googlePublisherClient() {
    const raw = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) throw new MobilePurchaseError('Google Play purchase verification is not configured yet.', 503);
    let credentials;
    try {
        credentials = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
        if (!credentials.client_email || !credentials.private_key) throw new Error('Missing service account values');
        credentials.private_key = String(credentials.private_key).replace(/\\n/g, '\n');
    } catch (e) {
        throw new MobilePurchaseError('Google Play purchase verification is not configured yet.', 503);
    }
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    return google.androidpublisher({ version: 'v3', auth });
}

async function verifyGooglePlayPurchase(userId, purchaseToken) {
    assertMobilePurchase(/^[A-Za-z0-9._~-]{16,2048}$/.test(String(purchaseToken || '')), 'Invalid Google Play purchase.');
    const publisher = googlePublisherClient();
    let purchase;
    try {
        const response = await publisher.purchases.productsv2.getproductpurchasev2({
            packageName: MOBILE_APP_BUNDLE_ID,
            token: purchaseToken,
        });
        purchase = response.data;
    } catch (error) {
        console.warn('[mobile-purchase] Google Play purchase verification failed:', error?.message || 'unknown error');
        throw new MobilePurchaseError('We could not verify this Google Play purchase.', 422);
    }
    const entitlement = validateGooglePurchasePayload(purchase, { userId });
    return { ...entitlement, transactionId: String(purchaseToken), publisher, acknowledgementState: purchase.acknowledgementState };
}

async function verifyGooglePubSubRequest(req) {
    const audience = String(process.env.GOOGLE_PLAY_RTDN_AUDIENCE || '').trim();
    const expectedEmail = String(process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL || '').trim().toLowerCase();
    if (!audience || !expectedEmail) throw new MobilePurchaseError('Google Play notifications are not configured.', 503);
    const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!match) throw new MobilePurchaseError('Missing Google Pub/Sub identity.', 401);
    const client = new google.auth.OAuth2();
    let payload;
    try {
        const ticket = await client.verifyIdToken({ idToken: match[1], audience });
        payload = ticket.getPayload();
    } catch (error) {
        throw new MobilePurchaseError('Invalid Google Pub/Sub identity.', 401);
    }
    if (!payload?.email_verified || String(payload.email || '').toLowerCase() !== expectedEmail) {
        throw new MobilePurchaseError('Unexpected Google Pub/Sub identity.', 403);
    }
}

async function claimMobileEntitlement(userId, entitlement) {
    if (!supabase) throw new MobilePurchaseError('Purchases are temporarily unavailable.', 503);
    const row = {
        store: entitlement.store,
        store_transaction_id: entitlement.transactionId,
        original_transaction_id: entitlement.originalTransactionId || null,
        product_id: entitlement.productId,
        user_id: userId,
        environment: entitlement.environment || null,
        purchased_at: entitlement.purchasedAt || null,
        verified_at: new Date().toISOString(),
    };
    const { error } = await supabase.from(MOBILE_PURCHASE_TABLE).insert(row);
    if (!error) return { alreadyClaimed: false };
    if (error.code !== '23505') throw error;

    const { data: existing, error: lookupError } = await supabase
        .from(MOBILE_PURCHASE_TABLE)
        .select('user_id')
        .eq('store', entitlement.store)
        .eq('store_transaction_id', entitlement.transactionId)
        .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing || existing.user_id !== userId) {
        throw new MobilePurchaseError('This store purchase is already linked to another MACPrep account.', 409);
    }
    return { alreadyClaimed: true };
}

async function acknowledgeGooglePlayPurchase(publisher, purchaseToken, acknowledgementState) {
    if (acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') return true;
    try {
        await publisher.purchases.products.acknowledge({
            packageName: MOBILE_APP_BUNDLE_ID,
            productId: configuredMobileProductId(),
            token: purchaseToken,
            requestBody: {},
        });
        return true;
    } catch (error) {
        // The user already has the server-recorded entitlement. A later restore retries
        // acknowledgement, avoiding accidental loss of purchased access on a transient API error.
        console.error('[mobile-purchase] Google Play acknowledgement failed:', error?.message || 'unknown error');
        return false;
    }
}

// Returns the authenticated user only if their (verified) account email is on the
// admin allowlist — the site owner only. Not derived from any DB profile flag, so
// it can never be granted by accident when a customer is flagged is_program_director.
async function getAdminUser(req) {
    const user = await getUserFromToken(req);
    if (!user) return null;
    return isAdminUser(user) ? user : null;
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
export function resolveFacultyScope({ user, isAdmin = false, profile = null, requestedProgram = '' }) {
    if (!user || !hasVerifiedEmail(user)) return null;
    if (isAdmin) {
        const program = normalizeTrainingProgram(requestedProgram);
        return { user, program: program || null, role: 'admin', isAdmin: true };
    }
    const program = normalizeTrainingProgram(profile?.faculty_program);
    if (!(profile?.is_program_director || profile?.is_faculty) || !program) return null;
    return {
        user,
        program,
        role: profile.is_program_director ? 'program_director' : 'faculty',
        isAdmin: false,
    };
}

async function getFacultyUser(req, knownUser = null) {
    const user = knownUser || await getUserFromToken(req);
    if (!user || !supabase || !hasVerifiedEmail(user)) return null;
    if (isAdminUser(user)) {
        return resolveFacultyScope({ user, isAdmin: true, requestedProgram: req.query?.program });
    }
    const { data: p } = await supabase.from(PROFILE_TABLE)
        .select('is_program_director, is_faculty, faculty_program').eq('user_id', user.id).maybeSingle();
    return resolveFacultyScope({ user, profile: p });
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
// short TTL. Reused by: the student dashboard
// (you-vs-all-SAAs), per-question grading (SAA peer %), and the faculty cohort
// dashboard (cohort-vs-all-SAAs). The aggregation executes in Postgres so raw
// progress history never crosses the application boundary.
// ---------------------------------------------------------------------------
const SAA_BENCH_TTL = 10 * 60 * 1000;
let _saaBench = { at: 0, byDomain: {} };
const isSaaCred = (c) => String(c || '').trim().toUpperCase().startsWith('SAA');
async function getSaaBenchmark() {
    if (_saaBench.at && (Date.now() - _saaBench.at) < SAA_BENCH_TTL) return _saaBench;
    if (!supabase) return _saaBench;
    try {
        const { data, error } = await supabase.rpc('macprep_saa_benchmark', {
            p_served_statuses: SERVE_FILLER ? null : SERVED_STATUSES,
        });
        if (error) throw error;
        _saaBench = { at: Date.now(), byDomain: data || {} };
    } catch (e) { console.error('[saa-benchmark]', e.message); }
    return _saaBench;
}
// Per-domain SAA accuracy from each learner's latest answer per question. Require
// both enough answers and enough distinct active students before exposing a value.
function saaDomainBenchmark(bench, minResponses = 20, minLearners = 10) {
    const accuracy = {};
    const samples = {};
    Object.entries((bench && bench.byDomain) || {}).forEach(([domain, value]) => {
        const responses = Number(value?.a) || 0;
        const learners = Number(value?.u) || 0;
        if (responses >= minResponses && learners >= minLearners) {
            accuracy[domain] = Math.round(((Number(value?.c) || 0) / responses) * 100);
            samples[domain] = learners;
        }
    });
    return { accuracy, samples };
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
    const requestedLifecycle = normalizeLifecycleStage(req.body?.lifecycle_stage)
        || (req.body?.credential === 'SAA' ? 'student' : req.body?.credential === 'CAA' ? 'practicing' : null);
    const matriculationDate = isValidProfileDate(req.body?.matriculation_date) ? req.body.matriculation_date : null;
    const gradDate = isValidProfileDate(req.body?.graduation_date) ? req.body.graduation_date : null;
    const examDate = isValidProfileDate(req.body?.target_exam_date) ? req.body.target_exam_date : null;
    const trainingProgram = normalizeTrainingProgram(req.body?.training_program);

    if (!supabaseAuth) return res.status(500).json({ success: false, error: 'Auth not configured.' });
    if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password are required.' });

    try {
        if (action === 'register') {
            if (password.length < MIN_PASSWORD_LENGTH) {
                return res.status(400).json({ success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
            }
            const profileError = registrationProfileError({
                lifecycleStage: requestedLifecycle,
                matriculationDate,
                graduationDate: gradDate,
                trainingProgram,
            });
            if (profileError) return res.status(400).json({ success: false, error: profileError });
            if (examDate && gradDate && examDate < gradDate) {
                return res.status(400).json({ success: false, error: 'The target board date cannot be before graduation.' });
            }
            const signupLifecycle = resolveSignupLifecycleStage(requestedLifecycle, matriculationDate);
            const credential = lifecycleCredential(signupLifecycle);
            const { data, error } = await supabaseAuth.auth.signUp({
                email,
                password,
                options: { data: { name } },
            });
            if (error) return res.status(400).json({ success: false, error: error.message });

            // Create the profile row so the payment webhook has a target to match
            // by email, and so premium status has somewhere to live.
            if (supabase && data.user) {
                const applicant = signupLifecycle === 'applicant';
                const boardPrepSignup = signupLifecycle === 'student' || signupLifecycle === 'practicing';
                const { error: pErr } = await supabase
                    .from(PROFILE_TABLE)
                    .upsert({
                        user_id: data.user.id,
                        email,
                        account_tier: 'free',
                        full_name: (typeof name === 'string' && name.trim()) ? name.trim().replace(/\s+/g, ' ') : null,
                        lifecycle_stage: signupLifecycle,
                        lifecycle_updated_at: new Date().toISOString(),
                        credential,
                        training_program: applicant ? null : trainingProgram,
                        matriculation_date: requestedLifecycle === 'incoming_student' ? matriculationDate : null,
                        graduation_date: ['incoming_student', 'student'].includes(requestedLifecycle) ? gradDate : null,
                        target_exam_date: ['incoming_student', 'student'].includes(requestedLifecycle) ? examDate : null,
                        lifecycle_checkin_at: requestedLifecycle === 'incoming_student' ? new Date().toISOString() : null,
                        lifecycle_checkin_snoozed_until: null,
                        leaderboard_opt_in: boardPrepSignup,
                    }, { onConflict: 'user_id' });
                if (pErr) {
                    console.error(`Profile create failure: ${pErr.message}`);
                    await supabase.auth.admin.deleteUser(data.user.id).catch((cleanupError) => console.error(`Failed to remove incomplete signup: ${cleanupError.message}`));
                    return res.status(500).json({ success: false, error: 'Could not finish creating your account. Please try again.' });
                }
            }

            if (data.session) setAuthCookies(res, data.session);
            return res.json({
                success: true,
                needsConfirmation: !data.session, // true when email confirmation is on
                authenticated: !!data.session,
                profile: { email, premium_unlocked: false, lifecycle_stage: signupLifecycle },
            });
        }

        // Default action: login
        const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ success: false, error: error.message });

        const isPremium = await isUserPremium(data.user?.id);

        setAuthCookies(res, data.session);
        return res.json({
            success: true,
            authenticated: true,
            profile: { email, premium_unlocked: isPremium },
        });
    } catch (err) {
        reportOperationalError('auth.authenticate', err);
        const status = err?.status === 503 ? 503 : 500;
        return res.status(status).json({ success: false, error: status === 503 ? 'Account access is temporarily unavailable.' : 'Authentication failure.' });
    }
});

// Rotate the HttpOnly session cookies so a study session survives the one-hour
// access-token TTL without exposing either credential to browser JavaScript.
app.post('/api/auth/refresh', sessionLimiter, async (req, res) => {
    const refresh_token = req.body?.refresh_token || authCookie(req, REFRESH_COOKIE);
    if (!supabaseAuth || !refresh_token) return res.status(400).json({ error: 'Missing refresh token.' });
    try {
        const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });
        if (error || !data.session) return res.status(401).json({ error: 'Could not refresh session.' });
        setAuthCookies(res, data.session);
        return res.json({ authenticated: true });
    } catch (err) {
        return res.status(401).json({ error: 'Could not refresh session.' });
    }
});

app.post('/api/auth/logout', sessionLimiter, async (req, res) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : authCookie(req, ACCESS_COOKIE);
    clearAuthCookies(res);
    if (token && supabase) {
        try { await supabase.auth.admin.signOut(token, 'global'); } catch (e) { /* cookie clearing still succeeds */ }
    }
    return res.json({ success: true });
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
    if (!access_token || new_password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `A valid reset link and a ${MIN_PASSWORD_LENGTH}+ character password are required.` });
    }
    try {
        const { data, error } = await supabaseAuth.auth.getUser(access_token);
        if (error || !data.user) return res.status(401).json({ error: 'Reset link is invalid or expired.' });
        // Only honor tokens minted by the email-recovery flow — a normal login/OAuth
        // session token (amr=password/oauth) must not be usable to reset the password.
        const methods = tokenAuthMethods(access_token).map((m) => String(m).toLowerCase());
        if (!methods.includes('recovery')) {
            return res.status(403).json({ error: 'This action requires a password-reset link. Use the "Forgot password" option to get one.' });
        }
        // Use the authenticated user endpoint so the configured password-strength,
        // leaked-password, and recovery-session protections are enforced. An admin
        // update would bypass the normal user password-change policy.
        await updatePasswordWithAccessToken(access_token, new_password);
        clearAuthCookies(res);
        return res.json({ success: true });
    } catch (err) {
        if (err instanceof AuthPasswordUpdateError) return res.status(err.status).json({ error: err.message });
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
    if (new_password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    if (!current_password) return res.status(400).json({ error: 'Your current password is required.' });
    if (!supabase || !supabaseAuth) return res.status(500).json({ error: 'Not configured.' });
    try {
        // Re-authenticate with the current password before changing it, so a
        // leftover or stolen session token alone cannot lock the owner out.
        const { data: reauth, error: authErr } = await supabaseAuth.auth.signInWithPassword({ email: user.email, password: current_password });
        if (authErr || !reauth.session?.access_token) return res.status(403).json({ error: 'Current password is incorrect.' });
        await updatePasswordWithAccessToken(reauth.session.access_token, new_password, current_password);

        // Hosted Supabase invalidates active sessions after a password update. Start
        // a fresh session with the new password so a successful change does not leave
        // the user in a confusing half-signed-in state.
        const { data: nextSession, error: nextError } = await supabaseAuth.auth.signInWithPassword({ email: user.email, password: new_password });
        if (nextError || !nextSession.session) {
            clearAuthCookies(res);
            return res.json({ success: true, requires_login: true });
        }
        setAuthCookies(res, nextSession.session);
        return res.json({ success: true, requires_login: false });
    } catch (err) {
        if (err instanceof AuthPasswordUpdateError) return res.status(err.status).json({ error: err.message });
        return res.status(500).json({ error: 'Could not change password.' });
    }
});

// Delete the signed-in user's account and all associated data (GDPR/privacy).
app.post('/api/user/delete', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Account deletion is not configured.' });
    try {
        // The database function deletes the public records and auth identity in
        // one transaction. It is service-role-only and fails the request on any
        // error, instead of reporting success after partial cleanup.
        await deleteMacprepAccount(supabase, user.id);
        return res.json({ success: true });
    } catch (err) {
        reportOperationalError('account.delete', err);
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
    if (!(await requireBoardPrepLifecycle(user, res))) return;
    const allowed = await hasFullAccess(user);
    if (allowed === null) return accessLookupUnavailable(res);
    if (!allowed) return res.status(403).json({ error: 'Progress reset is available with full access.' });
    try {
        const { error } = await supabase.rpc('reset_macprep_progress', { p_user: user.id });
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        reportOperationalError('progress.reset', err);
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
    const debriefFilter = String(req.query.debrief || '');
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    try {
        let questionsQuery = supabase
            .from('questions')
            .select('id, category, domain_name, subtopic, difficulty, stem, choices, correct_answer, explanation, "references", status, teaching_debrief, debrief_reviewed_at')
            .eq('status', status)
            .order('id', { ascending: true })
            .limit(limit);
        if (debriefFilter === 'missing') questionsQuery = questionsQuery.is('debrief_reviewed_at', null);
        else if (debriefFilter === 'reviewed') questionsQuery = questionsQuery.not('debrief_reviewed_at', 'is', null);
        const { data, error } = await questionsQuery;
        if (error) throw error;
        const out = (data || []).map((q) => ({ ...q, choices: parseChoices(q.choices) }));
        // counts by status for the queue header
        const STATUSES = ['sme_review', 'published', 'rejected', 'draft', 'unreviewed'];
        const countResults = await Promise.all(STATUSES.map((st) =>
            supabase.from('questions').select('id', { count: 'exact', head: true }).eq('status', st)));
        const debriefCount = await supabase.from('questions')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'published')
            .is('debrief_reviewed_at', null);
        if (debriefCount.error) throw debriefCount.error;
        const counts = {};
        STATUSES.forEach((st, i) => { counts[st] = countResults[i].count || 0; });
        counts.debrief_missing = debriefCount.count || 0;
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
    'app_open', 'app_foreground', 'recommended_start', 'diagnostic_start',
    'specialty_quiz_start', 'mock_exam_start', 'flashcards_start', 'flashcards_done',
    'critical_events_open', 'arcade_start', 'arcade_over', 'boss_start',
    'progress_reset', 'upgrade_screen', 'applicant_progress_saved',
    'lifecycle_committed',
]);
const ANALYTICS_PLATFORM_KEYS = ['web', 'ios', 'android', 'untagged'];
const ANALYTICS_ARCADE_TYPES = new Set(['survival', 'suddendeath', 'timeattack', 'blitz']);
const ANALYTICS_MODES = new Set(['tutor', 'exam', 'recommended', 'diagnostic', 'mock', 'review', 'custom']);
const ANALYTICS_UPGRADE_SOURCES = new Set(['upgrade_screen']);
const ANALYTICS_UPGRADE_VIA = new Set(['web', 'ios', 'android', 'voucher', 'stripe', 'apple', 'google_play']);
const ANALYTICS_FEATURES = new Set(['generic', 'recommended', 'diagnostic', 'mock', 'flashcards', 'critical-events', 'arcade', 'boss', 'review', 'focused']);
const ANALYTICS_DOMAINS = new Set([
    'Principles of Anesthesia',
    'Physiology, Pathophysiology & Management',
    'Instrumentation, Monitoring & Anesthetic Delivery Systems',
    'Subspecialty Care',
    'Pharmacology',
    'Regional Anesthesia & Pain Management',
]);
const ANALYTICS_META_FIELDS = new Map([
    ['landing_view', new Set(['vid'])],
    ['demo_started', new Set(['vid'])],
    ['demo_completed', new Set(['vid'])],
    ['recommended_start', new Set(['size', 'adaptive'])],
    ['diagnostic_start', new Set(['size'])],
    ['mock_exam_start', new Set(['size'])],
    ['session_start', new Set(['size', 'mode'])],
    ['quiz_start', new Set(['size', 'mode'])],
    ['session_complete', new Set(['size', 'mode', 'answered'])],
    ['specialty_quiz_start', new Set(['count'])],
    ['boss_start', new Set(['domain'])],
    ['arcade_start', new Set(['type'])],
    ['arcade_over', new Set(['type', 'score', 'reason'])],
    ['paywall_hit', new Set(['feature', 'src'])],
    ['upgrade_screen', new Set(['feature'])],
    ['upgrade_success', new Set(['via'])],
    ['critical_events_open', new Set(['count'])],
    ['flashcards_start', new Set(['size'])],
    ['flashcards_done', new Set(['size', 'right'])],
]);
const FEATURE_EVENT_LABELS = new Map([
    ['recommended_start', 'Recommended set'],
    ['diagnostic_start', 'Diagnostic'],
    ['specialty_quiz_start', 'Focused quiz'],
    ['mock_exam_start', 'Mock Exam'],
    ['flashcards_start', 'Flashcards'],
    ['critical_events_open', 'Critical Events'],
    ['arcade_start', 'Arcade'],
    ['boss_start', 'Boss Fight'],
]);

export function analyticsPlatformFromMeta(meta) {
    const platform = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta.platform : null;
    return platform === 'web' || platform === 'ios' || platform === 'android' ? platform : 'untagged';
}

export function sanitizeAnalyticsMeta(name, rawMeta) {
    const raw = rawMeta && typeof rawMeta === 'object' && !Array.isArray(rawMeta) ? rawMeta : {};
    const clean = { platform: analyticsPlatformFromMeta(raw) };
    const allowed = ANALYTICS_META_FIELDS.get(name) || new Set();
    for (const key of allowed) {
        const value = raw[key];
        if (key === 'vid' && typeof value === 'string' && /^[a-z0-9-]{1,40}$/i.test(value)) clean.vid = value;
        else if (['size', 'count', 'answered', 'score', 'right'].includes(key) && Number.isInteger(Number(value))) {
            clean[key] = Math.max(0, Math.min(5000, Number(value)));
        } else if (key === 'adaptive' && typeof value === 'boolean') clean.adaptive = value;
        else if (key === 'mode' && ANALYTICS_MODES.has(value)) clean.mode = value;
        else if (key === 'type' && ANALYTICS_ARCADE_TYPES.has(value)) clean.type = value;
        else if (key === 'feature' && ANALYTICS_FEATURES.has(value)) clean.feature = value;
        else if (key === 'src' && ANALYTICS_UPGRADE_SOURCES.has(value)) clean.src = value;
        else if (key === 'via' && ANALYTICS_UPGRADE_VIA.has(value)) clean.via = value;
        else if (key === 'domain' && ANALYTICS_DOMAINS.has(value)) clean.domain = value;
        else if (key === 'reason' && typeof value === 'string' && /^[a-z0-9_-]{1,24}$/i.test(value)) clean.reason = value;
    }
    return clean;
}

async function fetchAnalyticsEventsSince(since) {
    const PAGE = 1000;
    let rows = [];
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from('analytics_events')
            .select('name, user_id, meta, created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .range(from, from + PAGE - 1);
        if (error) throw error;
        rows = rows.concat(data || []);
        if (!data || data.length < PAGE) return rows;
    }
}

export function summarizeProductUsage(rows, now = new Date()) {
    const buckets = Object.fromEntries(ANALYTICS_PLATFORM_KEYS.map((platform) => [platform, {
        active30: new Set(), active7: new Set(), entries: 0, sessions: 0, completed: 0,
    }]));
    const featureUsage = Object.fromEntries([...FEATURE_EVENT_LABELS.keys()].map((name) => [name, {
        total: 0,
        byPlatform: Object.fromEntries(ANALYTICS_PLATFORM_KEYS.map((platform) => [platform, 0])),
    }]));
    const weekAgo = now.getTime() - 7 * 86400000;

    for (const row of rows || []) {
        const platform = analyticsPlatformFromMeta(row?.meta);
        const bucket = buckets[platform];
        const createdAt = new Date(row?.created_at || 0).getTime();
        if (row?.user_id) {
            bucket.active30.add(row.user_id);
            if (createdAt >= weekAgo) bucket.active7.add(row.user_id);
        }
        if (row?.name === 'page_view' || row?.name === 'app_open' || row?.name === 'app_foreground') bucket.entries++;
        if (row?.name === 'session_start') bucket.sessions++;
        if (row?.name === 'session_complete') bucket.completed++;
        if (featureUsage[row?.name]) {
            featureUsage[row.name].total++;
            featureUsage[row.name].byPlatform[platform]++;
        }
    }

    return {
        platforms: ANALYTICS_PLATFORM_KEYS.map((platform) => ({
            platform,
            active_30d: buckets[platform].active30.size,
            active_7d: buckets[platform].active7.size,
            entries: buckets[platform].entries,
            sessions: buckets[platform].sessions,
            completed: buckets[platform].completed,
        })),
        feature_usage: [...FEATURE_EVENT_LABELS.entries()].map(([name, label]) => ({
            name,
            label,
            total: featureUsage[name].total,
            by_platform: featureUsage[name].byPlatform,
        })),
    };
}

app.post('/api/event', eventLimiter, async (req, res) => {
    if (!supabase) return res.json({ ok: true });
    const name = String(req.body?.name || '');
    if (!ANALYTICS_EVENTS.has(name)) return res.json({ ok: true }); // silently ignore unknown
    const user = await getUserFromToken(req);
    const meta = sanitizeAnalyticsMeta(name, req.body?.meta);
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
        // PostgREST caps a request at ~1000 rows, so use the shared paginated
        // reader and never quietly drop recent activity from the admin summary.
        const rows = await fetchAnalyticsEventsSince(since);
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
    const hasTeachingDebrief = Object.prototype.hasOwnProperty.call(b, 'teaching_debrief');
    if (hasTeachingDebrief) update.teaching_debrief = normalizeTeachingDebrief(b.teaching_debrief);
    if (Object.keys(update).length === 0 && !Object.prototype.hasOwnProperty.call(b, 'teaching_debrief_reviewed')) {
        return res.status(400).json({ error: 'Nothing to update.' });
    }
    try {
        const { data: current, error: readError } = await supabase
            .from('questions')
            .select('id, domain, domain_name, category, subtopic, stem, choices, correct_answer, explanation, "references", status, teaching_debrief, debrief_reviewed_at, debrief_reviewed_by')
            .eq('id', id)
            .maybeSingle();
        if (readError) throw readError;
        if (!current) return res.status(404).json({ error: 'Question not found.' });
        const candidate = {
            ...current,
            ...update,
            choices: parseChoices(update.choices ?? current.choices),
            references: (() => {
                const value = update.references ?? current.references;
                if (Array.isArray(value)) return value;
                if (typeof value === 'string') { try { return JSON.parse(value); } catch (error) { return []; } }
                return [];
            })(),
        };
        const debriefReviewRequested = b.teaching_debrief_reviewed === true;
        const reviewSensitiveContentSubmitted = hasTeachingDebrief
            || ['stem', 'explanation', 'correct_answer'].some((field) => Object.prototype.hasOwnProperty.call(b, field))
            || Object.prototype.hasOwnProperty.call(b, 'choices')
            || Object.prototype.hasOwnProperty.call(b, 'references');
        if (debriefReviewRequested) {
            const assessment = validateTeachingDebrief(
                candidate.teaching_debrief,
                candidate.choices,
                candidate.correct_answer
            );
            if (!assessment.valid) {
                return res.status(422).json({
                    error: 'Teach the Question is not ready for clinician sign-off.',
                    issues: assessment.errors,
                });
            }
            update.teaching_debrief = assessment.debrief;
            update.debrief_reviewed_at = new Date().toISOString();
            update.debrief_reviewed_by = admin.id;
        } else if (reviewSensitiveContentSubmitted || b.teaching_debrief_reviewed === false) {
            // Any clinical content, citation, or answer-layout submission invalidates
            // the prior sign-off until an admin explicitly reviews the complete layer.
            update.debrief_reviewed_at = null;
            update.debrief_reviewed_by = null;
        }
        if (candidate.status === 'published') {
            const assessment = validateQuestionForPublication(candidate);
            if (!assessment.valid) {
                return res.status(422).json({ error: 'This question does not meet the publication standard.', issues: assessment.errors });
            }
            update.reviewed_by = admin.id;
        }
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
            const { data: qs, error: questionError } = await supabase.from('questions').select('id, stem, category, subtopic, difficulty').in('id', ids);
            if (questionError) throw questionError;
            (qs || []).forEach((q) => { qmap[q.id] = q; });
        }
        const edits = (data || []).map((e) => ({ ...e, question: qmap[e.question_id] || null }));
        const STATUSES = ['pending', 'approved', 'rejected'];
        const cr = await Promise.all(STATUSES.map((s) => supabase.from('question_edits').select('id', { count: 'exact', head: true }).eq('status', s)));
        const countError = cr.find((result) => result.error)?.error;
        if (countError) throw countError;
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
            const { data: question, error: qErr } = await supabase
                .from('questions')
                .select('id, domain, domain_name, category, subtopic, stem, choices, correct_answer, explanation, "references", status')
                .eq('id', edit.question_id)
                .maybeSingle();
            if (qErr) throw qErr;
            if (!question) return res.status(404).json({ error: 'Question not found.' });
            if (question.status === 'published') {
                const assessment = validateQuestionForPublication({ ...question, choices: finalChoices });
                if (!assessment.valid) {
                    return res.status(422).json({ error: 'The proposed edit does not meet the publication standard.', issues: assessment.errors });
                }
            }
            const { data: applied, error: applyError } = await supabase.rpc('apply_macprep_question_edit', {
                p_edit_id: id,
                p_action: 'approve',
                p_choices: finalChoices,
            });
            if (applyError) throw applyError;
            return res.json({ success: true, already: !!applied?.already });
        } else {
            const { data: applied, error: applyError } = await supabase.rpc('apply_macprep_question_edit', {
                p_edit_id: id,
                p_action: 'reject',
                p_choices: null,
            });
            if (applyError) throw applyError;
            return res.json({ success: true, already: !!applied?.already });
        }
    } catch (err) {
        console.error('Edit action failure:', err.message);
        if (/edit_not_found/i.test(err.message || '')) return res.status(404).json({ error: 'Edit not found.' });
        if (/question_not_found/i.test(err.message || '')) return res.status(404).json({ error: 'Question not found.' });
        return res.status(500).json({ error: 'Could not apply edit.' });
    }
});

// ---------------------------------------------------------------------------
// Cohort vouchers — a program director generates codes and hands them to their
// students; each code grants one premium unlock when redeemed.
// ---------------------------------------------------------------------------
export function newVoucherCode() {
    return 'MACP-' + randomBytes(16).toString('hex').toUpperCase();
}

export function normalizeVoucherLabel(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

app.post('/api/admin/vouchers', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 0, 1), 200);
    const cleanLabel = normalizeVoucherLabel(req.body?.label);
    if (cleanLabel.length > 80) return res.status(400).json({ error: 'Cohort names must be 80 characters or fewer.' });
    const label = cleanLabel || null;
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

app.patch('/api/admin/vouchers/label', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    const hasCurrentLabel = Object.prototype.hasOwnProperty.call(req.body || {}, 'currentLabel');
    const currentLabel = req.body?.currentLabel;
    if (!hasCurrentLabel || (currentLabel !== null && typeof currentLabel !== 'string')) {
        return res.status(400).json({ error: 'Choose a cohort group to rename.' });
    }
    if (typeof currentLabel === 'string' && currentLabel.length > 80) {
        return res.status(400).json({ error: 'The current cohort name is invalid.' });
    }
    const label = normalizeVoucherLabel(req.body?.label);
    if (!label) return res.status(400).json({ error: 'Enter a cohort name.' });
    if (label.length > 80) return res.status(400).json({ error: 'Cohort names must be 80 characters or fewer.' });
    if (label === currentLabel) return res.json({ success: true, unchanged: true, label, updated: 0 });

    try {
        let collisionQuery = supabase.from('program_vouchers')
            .select('voucher_key')
            .eq('owner_director_id', admin.id)
            .ilike('label', label);
        if (currentLabel !== null) collisionQuery = collisionQuery.neq('label', currentLabel);
        const { data: collision, error: collisionError } = await collisionQuery.limit(1);
        if (collisionError) throw collisionError;
        if (collision?.length) {
            return res.status(409).json({ error: 'That cohort name is already in use. Choose a name that includes the school and class year.' });
        }

        let sourceQuery = supabase.from('program_vouchers')
            .select('voucher_key')
            .eq('owner_director_id', admin.id);
        sourceQuery = currentLabel === null ? sourceQuery.is('label', null) : sourceQuery.eq('label', currentLabel);
        const { data: source, error: sourceError } = await sourceQuery.limit(1);
        if (sourceError) throw sourceError;
        if (!source?.length) return res.status(404).json({ error: 'That cohort group was not found.' });

        let updateQuery = supabase.from('program_vouchers')
            .update({ label }, { count: 'exact' })
            .eq('owner_director_id', admin.id);
        updateQuery = currentLabel === null ? updateQuery.is('label', null) : updateQuery.eq('label', currentLabel);
        const { count, error: updateError } = await updateQuery;
        if (updateError) throw updateError;
        return res.json({ success: true, label, updated: Number.isFinite(count) ? count : null });
    } catch (err) {
        console.error('Voucher rename failure:', err.message);
        return res.status(500).json({ error: 'Could not rename that cohort group.' });
    }
});

app.get('/api/admin/vouchers', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    try {
        const { data, error } = await supabase.from('program_vouchers')
            .select('voucher_key, is_claimed, claimed_by_email, claimed_at, created_at, label')
            .eq('owner_director_id', admin.id).order('created_at', { ascending: false }).limit(500);
        if (error) throw error;
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
        const { error } = await supabase.rpc('claim_macprep_voucher', {
            p_user: user.id,
            p_email: (user.email || '').toLowerCase().trim(),
            p_code: code,
        });
        if (error) throw error;
        return res.json({ success: true });
    } catch (err) {
        if (/voucher_not_found/i.test(err.message || '')) return res.status(404).json({ error: 'That code was not found.' });
        if (/voucher_already_claimed/i.test(err.message || '')) return res.status(409).json({ error: 'That code has already been used.' });
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
        const { data: rows, error } = await supabase.from(PROFILE_TABLE)
            .select('email, full_name, credential, training_program, is_program_director, is_faculty, faculty_program');
        if (error) throw error;
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
        const { data: prof, error: profileError } = await supabase.from(PROFILE_TABLE).select('user_id, email').eq('email', email).maybeSingle();
        if (profileError) throw profileError;
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
    const authenticatedUser = await getUserFromToken(req);
    if (!authenticatedUser) return res.status(401).json({ error: 'Authentication required.' });
    const ctx = await getFacultyUser(req, authenticatedUser);
    if (!ctx) return res.status(403).json({ error: 'The cohort dashboard is for program directors and faculty.' });
    if (!supabase) return res.status(500).json({ error: 'no db' });
    try {
        // For admins: the full program list (with student counts) for the program-switcher
        // dropdown, attached to EVERY response so an admin can jump between programs without
        // leaving the page. Faculty/PD never get this — they only ever see their own program.
        let adminPrograms = null;
        if (ctx.isAdmin) {
            const { data: rows, error: pErr } = await supabase.rpc('macprep_program_counts');
            if (pErr) throw pErr;
            adminPrograms = Array.isArray(rows) ? rows : [];
        }
        // Admin without ?program= → prompt to pick one (faculty always have their own).
        if (!ctx.program) {
            return res.json({ role: ctx.role, is_admin: ctx.isAdmin, need_program: true, programs: adminPrograms || [] });
        }
        const program = ctx.program;
        const { data: rollup, error: rollupError } = await supabase.rpc('macprep_faculty_cohort_rollup', {
            p_program: program,
            p_served_statuses: SERVE_FILLER ? null : SERVED_STATUSES,
            p_excluded_emails: [...REVIEW_EMAILS],
        });
        if (rollupError) throw rollupError;
        return res.json({
            role: ctx.role,
            is_admin: ctx.isAdmin,
            programs: adminPrograms,
            program,
            ...(rollup || {}),
            generated_at: new Date().toISOString(),
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
    if (!(await requireBoardPrepLifecycle(user, res))) return;
    try {
        const weekStart = lbWeekStartUTC();
        const weekResetsAt = new Date(weekStart.getTime() + 7 * 86400000).toISOString();
        const { data: rollup, error: rollupError } = await supabase.rpc('macprep_leaderboard_rollup', {
            p_current_user: user.id,
            p_week_start: weekStart.toISOString(),
            p_since: new Date(Date.now() - 120 * 86400000).toISOString(),
        });
        if (rollupError) throw rollupError;
        const playerList = (Array.isArray(rollup?.players) ? rollup.players : []).filter((p) => lbShortName(p.full_name));
        const stat = (player) => {
            const attempts = Number(player?.weekly) || 0;
            const correct = Number(player?.correct) || 0;
            const days = new Set(Array.isArray(player?.study_days) ? player.study_days : []);
            return { weekly: attempts, correct, attempts, accuracy: attempts ? Math.round((correct / attempts) * 1000) / 10 : 0, streak: lbStreak(days) };
        };
        const enriched = playerList.map((p) => ({ user_id: p.user_id, name: lbShortName(p.full_name), title: p.selected_title || '', is_me: p.user_id === user.id, ...stat(p) }));
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
        const mine = rollup?.me || {};
        const myOptIn = mine.user_id ? !!mine.leaderboard_opt_in : true;
        const myName = lbShortName(mine.full_name) || null;
        const mv = stat(mine);
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
    if (!(await requireBoardPrepLifecycle(user, res))) return;
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
    const { data, error } = await supabase.from('questions').select('*')
        .eq('status', 'published').order('id').limit(DEMO_POOL_SIZE);
    if (error) throw error;
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
            answerRevision: Math.max(1, Number(q.answer_revision) || 1),
            choices: (q.choices || []).map((c) => ({
                id: answerChoiceId(q.id, c),
                label: c.label,
                text: c.text,
            })),
        }));
        res.json({ questions: picks });
    } catch (e) { res.status(500).json({ error: 'Demo temporarily unavailable.', questions: [] }); }
});

app.post('/api/demo/grade', demoLimiter, async (req, res) => {
    try {
        const id = req.body?.id;
        const q = (await getDemoPool()).find((x) => x.id === id);
        if (!q) return res.status(403).json({ error: 'That question is not part of the demo.' });
        const choices = q.choices || [];
        assertCurrentChoiceIdentity(q, req.body);
        const selectedIndex = resolveSubmittedChoiceIndex(q, req.body);
        const chosenLabel = choices[selectedIndex]?.label || null;
        res.json({
            correct: chosenLabel != null && chosenLabel === q.correct_answer,
            correct_answer: q.correct_answer,
            choices: choices.map((c) => ({
                id: answerChoiceId(q.id, c),
                label: c.label,
                text: c.text,
                correct: !!c.correct,
                rationale: c.rationale,
            })),
            explanation: q.explanation,
            references: q.references || [],
        });
    } catch (e) {
        res.status(e.status || 500).json({
            error: e.status ? e.message : 'Demo temporarily unavailable.',
            stale_question: e.code === 'stale_question',
        });
    }
});

// ---------------------------------------------------------------------------
// Question catalog and bounded study sessions. Answers/explanations are NEVER
// sent here; grading happens server-side via /api/grade. The browser no longer
// receives the full proprietary bank at sign-in.
// ---------------------------------------------------------------------------
app.get('/api/questions', async (req, res) => {
    try {
        const user = await getUserFromToken(req);
        if (!user) return res.status(401).json({ error: 'Authentication required.', questions: [] });
        if (!supabase) return res.json({ questions: [], catalog: { total: 0, categories: [] } });
        if (!(await requireBoardPrepLifecycle(user, res))) return;
        return res.json({ questions: [], catalog: await getQuestionCatalog() });
    } catch (err) {
        console.error('Questions route failure:', err.message);
        return res.status(500).json({ error: 'Database communication failure', questions: [], catalog: { total: 0, categories: [] } });
    }
});

app.post('/api/study-session', studySessionLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!(await requireBoardPrepLifecycle(user, res))) return;

    const requested = Math.min(Math.max(parseInt(req.body?.size, 10) || 10, 1), MAX_STUDY_SESSION_SIZE);
    const purpose = String(req.body?.purpose || 'custom');
    const category = typeof req.body?.category === 'string' ? req.body.category.slice(0, 160) : 'all';
    const difficulty = ['easy', 'medium', 'hard', 'all'].includes(req.body?.difficulty) ? req.body.difficulty : 'all';
    const poolMode = ['all', 'new'].includes(req.body?.pool_mode) ? req.body.pool_mode : 'all';
    const questionIds = Array.from(new Set((Array.isArray(req.body?.question_ids) ? req.body.question_ids : [])
        .map((id) => String(id).trim()).filter(Boolean))).slice(0, MAX_STUDY_SESSION_SIZE);
    try {
        const elevated = await hasFullAccess(user);
        if (elevated === null) return accessLookupUnavailable(res);
        let questions;
        if (!elevated) {
            // The signed-in trial is intentionally one bounded, recommended
            // 25-question session. Every other study mode is premium-only.
            if (!isFreeTrialSessionPurpose(purpose)) {
                return res.status(402).json({ error: 'Full study modes are available with full access.', paywall: true });
            }
            // A free account has a stable, bounded preview pool. This prevents
            // repeated session requests from becoming a content-harvesting API.
            questions = await fetchFixedFreePool(user.id, Math.min(requested, FREE_STUDY_POOL_SIZE));
        } else if (purpose === 'qotd') {
            // Ignore a caller-supplied id: every account receives the same 7 AM ET QotD.
            questions = await fetchQuestionOfTheDay();
        } else {
            questions = ['recommended', 'review'].includes(purpose)
                ? await fetchPrioritySessionQuestions(user.id, { size: requested, questionIds, purpose })
                : ['mock', 'diagnostic'].includes(purpose)
                    ? await fetchBalancedPremiumSessionQuestions(user.id, { size: requested, poolMode })
                : await fetchPremiumSessionQuestions(user.id, {
                    size: requested,
                    category,
                    difficulty,
                    questionIds,
                    poolMode,
                });
        }
        return res.json({ questions: questions.map(safeQuestionForClient), catalog: await getQuestionCatalog() });
    } catch (err) {
        reportOperationalError('study-session.build', err);
        return res.status(500).json({ error: 'Could not build a study session.' });
    }
});

app.get('/api/questions/search', studySessionLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.', questions: [] });
    if (!supabase) return res.json({ questions: [] });
    if (!(await requireBoardPrepLifecycle(user, res))) return;
    const elevated = await hasFullAccess(user);
    if (elevated === null) return accessLookupUnavailable(res);
    if (!elevated) return res.status(402).json({ error: 'Question search is available with full access.', paywall: true, questions: [] });
    const terms = String(req.query.q || '').trim().slice(0, 120);
    const words = terms.split(/\s+/).filter((word) => word.length >= 2).slice(0, 6);
    if (!words.length) return res.json({ questions: [] });
    try {
        let query = supabase
            .from('questions')
            .select('id, specialty, domain, domain_name, subtopic, category, difficulty, stem, choices, telemetry, status, answer_revision')
            .order('id', { ascending: true })
            .limit(40);
        words.forEach((word) => {
            query = query.ilike('stem', `%${word.replace(/[%_]/g, '\\$&')}%`);
        });
        query = applyServedFilter(query);
        const { data, error } = await query;
        if (error) throw error;
        return res.json({ questions: (data || []).map(safeQuestionForClient) });
    } catch (err) {
        console.error('Question search failure:', err.message);
        return res.status(500).json({ error: 'Could not search questions.', questions: [] });
    }
});

// Printable take-home exam (premium). Returns full questions WITH answers/explanations
// so the client can render a print-to-PDF page — gated to premium since it reveals keys.
app.get('/api/exam-export', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!(await requireBoardPrepLifecycle(user, res))) return;
    const fullAccess = await hasFullAccess(user);
    if (fullAccess === null) return accessLookupUnavailable(res);
    if (!fullAccess) {
        return res.status(402).json({ error: 'Printable exams are a premium feature.', paywall: true });
    }
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 25, 1), 200);
    const category = (req.query.category || 'all').toString();
    try {
        const pool = await fetchAllServedQuestionRows(
            'id, category, domain_name, stem, choices, correct_answer, explanation, "references"',
            { category }
        );
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
    if (!(await requireBoardPrepLifecycle(user, res))) return;
    const fullAccess = await hasFullAccess(user);
    if (fullAccess === null) return accessLookupUnavailable(res);
    if (!fullAccess) {
        return res.status(402).json({ error: 'Flashcard mode is a premium feature.', paywall: true });
    }
    const idsParam = (req.query.ids || '').toString().trim();
    const ids = idsParam ? idsParam.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200) : [];
    const count = ids.length ? ids.length : Math.min(Math.max(parseInt(req.query.count, 10) || 20, 1), 100);
    const category = (req.query.category || 'all').toString();
    try {
        const pool = await fetchAllServedQuestionRows(
            'id, category, domain_name, subtopic, stem, choices, correct_answer, explanation, "references"',
            { ids, category }
        );
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
    if (!(await requireBoardPrepLifecycle(user, res))) return;
    const fullAccess = await hasFullAccess(user);
    if (fullAccess === null) return accessLookupUnavailable(res);
    if (!fullAccess) {
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
    if (!(await requireBoardPrepLifecycle(user, res))) return;
    const b = req.body || {};
    try {
        const { data: cur, error: currentError } = await supabase.from(PROFILE_TABLE).select('bonus_xp, ach_claimed, daily_state').eq('user_id', user.id).maybeSingle();
        if (currentError) throw currentError;
        const ach_claimed = [...new Set([...(Array.isArray(cur?.ach_claimed) ? cur.ach_claimed : []), ...(Array.isArray(b.ach_claimed) ? b.ach_claimed : [])].filter((x) => typeof x === 'string'))].slice(0, 500);
        const mergeDaily = (A0, B0) => {
            const out = {}; const keys = new Set([...Object.keys(A0 || {}), ...Object.keys(B0 || {})]);
            for (const k of keys) { const A = (A0 && A0[k]) || {}, B2 = (B0 && B0[k]) || {};
                out[k] = { answered: Math.max(+A.answered || 0, +B2.answered || 0), correct: Math.max(+A.correct || 0, +B2.correct || 0), specs: [...new Set([...(A.specs || []), ...(B2.specs || [])])].slice(0, 12), rewarded: [...new Set([...(A.rewarded || []), ...(B2.rewarded || [])])].slice(0, 12), chest: !!(A.chest || B2.chest) }; }
            const trimmed = {}; Object.keys(out).sort().slice(-5).forEach((k) => { trimmed[k] = out[k]; }); return trimmed;
        };
        const daily_state = mergeDaily(cur?.daily_state, b.daily_state);
        const bonus_xp = Math.max(+(cur?.bonus_xp) || 0, +(b.bonus_xp) || 0);
        const { data: saved, error } = await supabase.from(PROFILE_TABLE)
            .update({ bonus_xp, ach_claimed, daily_state }).eq('user_id', user.id).select('user_id');
        if (error) throw error;
        if (!saved?.length) {
            const { error: insertError } = await supabase.from(PROFILE_TABLE).upsert({
                user_id: user.id,
                email: (user.email || '').toLowerCase().trim() || null,
                bonus_xp,
                ach_claimed,
                daily_state,
            }, { onConflict: 'user_id' });
            if (insertError) throw insertError;
        }
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
app.post('/api/grade', gradeLimiter, async (req, res) => {
    const { questionId, choiceIndex, choiceId } = req.body || {};
    if (!supabase) return res.status(500).json({ error: 'Database not configured.' });

    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!(await requireBoardPrepLifecycle(user, res))) return;

    if (!questionId || (choiceIndex === undefined && choiceId === undefined)) {
        return res.status(400).json({ error: 'questionId and an answer choice are required.' });
    }

    try {
        const fullAccess = await hasFullAccess(user);
        if (fullAccess === null) return accessLookupUnavailable(res);

        // Enforce the free ceiling on distinct questions already answered. Re-answering
        // a question the user has already seen is always allowed (doesn't add to the
        // distinct count), so this can't be gamed by replaying the same item.
        if (!fullAccess) {
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

        const { data: q, error } = await getServedQuestionQuery(supabase, questionId).maybeSingle();
        if (error) throw error;
        if (!q) return res.status(404).json({ error: 'Question not found.' });

        assertCurrentChoiceIdentity(q, req.body);
        const graded = normalizeGradeInput(q, req.body);
        const { selectedIndex: selIndex, correctIndex, isCorrect, confidence, timeMs, answerChanged, choices } = graded;

        // Record the attempt before revealing the answer. Unexpected persistence
        // failures must never be reported as a successfully graded question.
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
            throw pErr;
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
            // Peer comparison is scoped to ALL SAAs and aggregated in Postgres; raw
            // population-wide user ids and response rows never enter the app process.
            const { data: peer, error: peerError } = await supabase.rpc('macprep_saa_question_stats', {
                p_question: String(questionId),
            });
            if (peerError) throw peerError;
            const learnerCount = Number(peer?.learners) || 0;
            responseCount = learnerCount;
            if (learnerCount >= 10) {
                peerPct = Math.round(((Number(peer?.correct) || 0) / responseCount) * 100);
                const labels = peer?.labels && typeof peer.labels === 'object' ? peer.labels : {};
                choiceDistribution = choices.map((_, index) => Math.round(
                    ((Number(labels[String.fromCharCode(65 + index)]) || 0) / responseCount) * 100
                ));
            }
        } catch (e) { /* peer stats best-effort */ }

        return res.json({
            ...graded.result,
            peer_correct_pct: peerPct,
            peer_group: 'SAA',
            choice_distribution: choiceDistribution,
            response_count: responseCount,
        });
    } catch (err) {
        if (!err.status || err.status >= 500) reportOperationalError('grade.single', err);
        return res.status(err.status || 500).json({
            error: err.status ? err.message : 'Grading failure.',
            stale_question: err.code === 'stale_question',
        });
    }
});

// Exam mode submits once. The answer key is returned only after one atomic,
// idempotent progress write succeeds for the complete answered set.
app.post('/api/grade-batch', sessionLimiter, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: 'Database not configured.' });
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!(await requireBoardPrepLifecycle(user, res))) return;

    const submissionId = String(req.body?.submissionId || '');
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!validUuid(submissionId)) return res.status(400).json({ error: 'A valid exam submission id is required.' });
    if (!answers.length || answers.length > MAX_STUDY_SESSION_SIZE) {
        return res.status(400).json({ error: `Submit between 1 and ${MAX_STUDY_SESSION_SIZE} answered questions.` });
    }

    const questionIds = answers.map((answer) => String(answer?.questionId || '').trim());
    if (questionIds.some((id) => !id) || new Set(questionIds).size !== questionIds.length) {
        return res.status(400).json({ error: 'Every submitted question must be present exactly once.' });
    }

    try {
        const fullAccess = await hasFullAccess(user);
        if (fullAccess === null) return accessLookupUnavailable(res);
        const { data: existingSubmission, error: existingSubmissionError } = await supabase
            .from(PROGRESS_TABLE)
            .select('question_id')
            .eq('user_id', user.id)
            .eq('submission_id', submissionId);
        if (existingSubmissionError) throw existingSubmissionError;
        if (existingSubmission?.length) {
            const existingIds = new Set(existingSubmission.map((row) => String(row.question_id)));
            if (existingIds.size !== questionIds.length || questionIds.some((id) => !existingIds.has(id))) {
                return res.status(409).json({ error: 'This exam submission id was already used for a different question set.' });
            }
        }
        if (!fullAccess) {
            const ceiling = await getFreeTierCeiling();
            const { data: seenRows, error: seenErr } = await supabase
                .from(PROGRESS_TABLE)
                .select('question_id')
                .eq('user_id', user.id)
                .in('question_id', questionIds);
            if (seenErr) throw seenErr;
            const seen = new Set((seenRows || []).map((row) => String(row.question_id)));
            const { data: distinctCount, error: countErr } = await supabase.rpc('distinct_answered', { p_user: user.id });
            if (countErr) throw countErr;
            const newQuestions = questionIds.filter((id) => !seen.has(id)).length;
            if ((Number(distinctCount) || 0) + newQuestions > ceiling) {
                return res.status(402).json({ error: 'paywall', paywall: true, limit: ceiling });
            }
        }

        const query = applyServedFilter(
            supabase
                .from('questions')
                .select('id, specialty, category, correct_answer, choices, explanation, "references", answer_revision, teaching_debrief, debrief_reviewed_at')
                .in('id', questionIds)
        );
        const { data: questions, error: questionErr } = await query;
        if (questionErr) throw questionErr;
        const byId = new Map((questions || []).map((question) => [String(question.id), question]));
        if (byId.size !== questionIds.length) {
            return res.status(404).json({ error: 'One or more exam questions are no longer available.' });
        }

        const gradedAnswers = answers.map((answer) => {
            const questionId = String(answer.questionId);
            const question = byId.get(questionId);
            if (!existingSubmission?.length) assertCurrentChoiceIdentity(question, answer);
            const grade = normalizeGradeInput(question, answer);
            return { questionId, question, grade };
        });
        const progressRows = gradedAnswers.map(({ questionId, question, grade }) => ({
            user_id: user.id,
            question_id: questionId,
            submission_id: submissionId,
            specialty: question.specialty || null,
            category: question.category || null,
            selected_label: String.fromCharCode(65 + grade.selectedIndex),
            is_correct: grade.isCorrect,
            confidence: grade.confidence,
            time_ms: grade.timeMs,
            answer_changed: grade.answerChanged,
        }));

        const { data: inserted, error: progressErr } = await supabase
            .from(PROGRESS_TABLE)
            .upsert(progressRows, {
                onConflict: 'user_id,submission_id,question_id',
                ignoreDuplicates: true,
            })
            .select('question_id');
        if (progressErr) {
            if (/free_tier/i.test(progressErr.message || '') || progressErr.code === '23514') {
                return res.status(402).json({ error: 'paywall', paywall: true, limit: await getFreeTierCeiling() });
            }
            throw progressErr;
        }

        const insertedIds = new Set((inserted || []).map((row) => String(row.question_id)));
        await Promise.all(gradedAnswers.map(async ({ questionId, grade }) => {
            if (!insertedIds.has(questionId)) return;
            const quality = grade.isCorrect
                ? (grade.confidence === 'high' ? 5 : grade.confidence === 'medium' ? 4 : 3)
                : (grade.confidence === 'high' ? 0 : 2);
            const { error } = await supabase.rpc('sm2_review', {
                p_user: user.id,
                p_question: questionId,
                p_quality: quality,
            });
            if (error) reportOperationalError('grade-batch.sm2', error, { questionId });
        }));

        // A retry must return the answers that won the idempotent insert, not a
        // newly supplied body that the database correctly ignored.
        const { data: persisted, error: persistedError } = await supabase
            .from(PROGRESS_TABLE)
            .select('question_id, selected_label, is_correct')
            .eq('user_id', user.id)
            .eq('submission_id', submissionId);
        if (persistedError) throw persistedError;
        const persistedById = new Map((persisted || []).map((row) => [String(row.question_id), row]));
        if (persistedById.size !== questionIds.length || questionIds.some((id) => !persistedById.has(id))) {
            return res.status(409).json({ error: 'This exam submission id was already used for a different question set.' });
        }
        const persistedResults = questionIds.map((questionId) => {
            const selectedLabel = String(persistedById.get(questionId)?.selected_label || '').toUpperCase();
            const selectedIndex = selectedLabel.charCodeAt(0) - 65;
            const grade = normalizeGradeInput(byId.get(questionId), { choiceIndex: selectedIndex });
            return {
                questionId,
                ...grade.result,
                correct: persistedById.get(questionId)?.is_correct === true,
            };
        });

        return res.json({
            submissionId,
            results: persistedResults,
        });
    } catch (err) {
        if (!err.status || err.status >= 500) reportOperationalError('grade.batch', err);
        return res.status(err.status || 500).json({
            error: err.status ? err.message : 'The exam could not be graded. No answers were recorded.',
            stale_question: err.code === 'stale_question',
        });
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
    // title_auto: true = keep following the newest earned title; false = the user made an
    // explicit choice (a specific title or "No title") and it should stick.
    if ('auto' in b) upd.title_auto = !!b.auto;
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
app.get('/api/user/profile', profileLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.json({ profile: null });

    try {
        const { data: storedProfile, error } = await supabase
            .from(PROFILE_TABLE)
            .select('email, account_tier, premium_unlocked_at, created_at, is_program_director, is_faculty, faculty_program, full_name, lifecycle_stage, lifecycle_updated_at, credential, matriculation_date, graduation_date, training_program, target_exam_date, applicant_progress, lifecycle_checkin_at, lifecycle_checkin_snoozed_until, phone, study_goal, theme, font, leaderboard_handle, leaderboard_opt_in, selected_title, title_auto, bonus_xp, ach_claimed, daily_state, review_prompt_at')
            .eq('user_id', user.id)
            .maybeSingle();
        if (error) throw error;

        const advanced = await advanceLifecycleDates(storedProfile, user.id);
        const profile = advanced.profile;
        const adminUser = isAdminUser(user);
        const reviewUser = isReviewUser(user);
        const lifecycleStage = advanced.stage || (adminUser ? 'practicing' : reviewUser ? 'student' : null);
        const capabilities = resolveLifecycleCapabilities(lifecycleStage, {
            isAdmin: adminUser,
            isReview: reviewUser,
        });
        const boardPrepAllowed = capabilities.board_prep;

        const tzOffset = Math.max(-840, Math.min(840, Number(req.query.tz) || 0));
        const planNow = new Date();
        const planHorizon = new Date(planNow.getTime() + MAX_ADAPTIVE_PLAN_DAYS * 86400000).toISOString();
        let learningResult = { data: {}, error: null };
        let readinessResult = { data: {}, error: null };
        let flagsResult = { data: [], error: null };
        let cardsResult = { data: [], error: null };
        let dueResult = { data: [], error: null };
        let ceiling = 0;
        let benchmark = {};
        if (boardPrepAllowed) {
            [learningResult, readinessResult, flagsResult, cardsResult, dueResult, ceiling, benchmark] = await Promise.all([
                supabase.rpc('macprep_user_learning_rollup', {
                    p_user: user.id,
                    p_tz_offset: tzOffset,
                    p_served_statuses: SERVE_FILLER ? null : SERVED_STATUSES,
                }),
                supabase.rpc('macprep_user_practice_readiness', {
                    p_user: user.id,
                    p_served_statuses: SERVE_FILLER ? null : SERVED_STATUSES,
                }),
                supabase.from('user_flags').select('question_id').eq('user_id', user.id),
                supabase.from('user_flashcards').select('question_id').eq('user_id', user.id),
                fetchAllPostgrestRows((from, to) => supabase.from('review_state')
                    .select('question_id, due_at')
                    .eq('user_id', user.id)
                    .lte('due_at', planHorizon)
                    .order('due_at', { ascending: true })
                    .order('question_id', { ascending: true })
                    .range(from, to))
                    .then((data) => ({ data, error: null }), (error) => ({ data: [], error })),
                getFreeTierCeiling(),
                getSaaBenchmark(),
            ]);
        }
        for (const result of [learningResult, readinessResult, flagsResult, cardsResult, dueResult]) {
            if (result.error) throw result.error;
        }
        const learning = learningResult.data || {};
        const readinessBasis = readinessResult.data || {};
        const stats = learning.stats || { answered: 0, attempts: 0, correct: 0 };
        const flagged_ids = (flagsResult.data || []).map((row) => row.question_id);
        const flashcard_ids = (cardsResult.data || []).map((row) => row.question_id);
        const dueSchedule = dueResult.data || [];
        const due_ids = dueSchedule
            .filter((row) => !row.due_at || Date.parse(row.due_at) <= planNow.getTime())
            .map((row) => row.question_id);
        const rawCred = profile?.credential || null;
        const gradDate = profile?.graduation_date || null;
        let credCode = rawCred;
        if (rawCred) { const u = rawCred.trim().toUpperCase(); credCode = u.startsWith('SAA') ? 'SAA' : u.startsWith('CAA') ? 'CAA' : rawCred; }
        if (lifecycleStage === 'applicant' || lifecycleStage === 'incoming_student') credCode = null;
        const needsLifecycle = !adminUser && !reviewUser && !lifecycleStage;
        const needsCredential = !adminUser && !reviewUser && (
            needsLifecycle
            || (lifecycleStage === 'student' && (credCode !== 'SAA' || !gradDate))
            || (lifecycleStage === 'practicing' && credCode !== 'CAA')
        );
        const needsProgram = !adminUser && !reviewUser
            && ['incoming_student', 'student', 'practicing'].includes(lifecycleStage)
            && !normalizeTrainingProgram(profile?.training_program);
        // Peer benchmark: how this user's domains compare to ALL SAAs (anonymized aggregate;
        // students compare to the whole SAA population, never their own cohort).
        const saaBenchmark = saaDomainBenchmark(benchmark);
        const adaptivePlan = buildAdaptiveStudyPlan({
            now: planNow,
            timezoneOffset: tzOffset,
            targetExamDate: profile?.target_exam_date,
            totalQuestions: Number(readinessBasis.total) || 0,
            answeredQuestions: Number(stats.answered) || 0,
            answeredToday: Number(learning.answered_today) || 0,
            dueCount: due_ids.length,
            dueSchedule,
            missedCount: Array.isArray(learning.missed_ids) ? learning.missed_ids.length : 0,
            confidentMissedCount: Array.isArray(learning.confident_missed_ids) ? learning.confident_missed_ids.length : 0,
            byDomain: Array.isArray(learning.by_domain) ? learning.by_domain : [],
        });

        const accountCreatedMs = profile?.created_at ? Date.parse(profile.created_at) : NaN;
        const lifecycle_checkin_due = applicantCheckInDue({
            lifecycleStage,
            accountCreatedAt: profile?.created_at,
            lastCheckinAt: profile?.lifecycle_checkin_at,
            snoozedUntil: profile?.lifecycle_checkin_snoozed_until,
            now: planNow,
            isAdmin: adminUser,
            isReview: reviewUser,
        });
        // Review-ask nudge: once an account is a week old, ask for a review at the next
        // sign-in — unless they already left one (any status; one review per account) or
        // were asked within the last 30 days ("maybe later" → monthly cadence). The App
        // Store review account is never nagged. The reviews lookup only runs when the
        // cheap gates pass, so most profile fetches cost nothing extra.
        let review_prompt_due = false;
        try {
            const oldEnough = Number.isFinite(accountCreatedMs) && (Date.now() - accountCreatedMs) >= 7 * 86400000;
            const enoughExperience = Number(stats.answered) >= 10;
            const lastAsk = profile?.review_prompt_at ? Date.parse(profile.review_prompt_at) : 0;
            const windowOpen = !lastAsk || (Date.now() - lastAsk) >= 30 * 86400000;
            // Never nag the owner/admins (they own the product) or the App Store review account.
            if (boardPrepAllowed && !needsLifecycle && !lifecycle_checkin_due
                && oldEnough && enoughExperience && windowOpen && !isAdminUser(user) && !isReviewUser(user)) {
                const { count } = await supabase.from('reviews').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
                review_prompt_due = !count;
            }
        } catch (e) { /* the nudge is never worth failing a profile fetch over */ }

        return res.json({
            profile: {
                user_id: user.id,
                email: profile?.email || user.email || null,
                premium_unlocked: profile?.account_tier === 'premium' || adminUser || reviewUser,
                premium_unlocked_at: profile?.premium_unlocked_at || null,
                is_admin: adminUser,
                is_review: reviewUser,
                capabilities,
                is_program_director: !!profile?.is_program_director,
                is_faculty: !!profile?.is_faculty,
                faculty_program: profile?.faculty_program || null,
                // Drives the in-app "Cohort dashboard" nav item. Admin (owner) can view any
                // program; a faculty/PD only if they've been assigned one. Server re-checks on every call.
                can_view_cohort: isAdminUser(user) || (hasVerifiedEmail(user) && !!((profile?.is_program_director || profile?.is_faculty) && profile?.faculty_program)),
                full_name: profile?.full_name || '',
                lifecycle_stage: lifecycleStage || '',
                board_prep_enabled: boardPrepAllowed,
                needs_lifecycle: needsLifecycle,
                lifecycle_checkin_due,
                lifecycle_checkin_snoozed_until: profile?.lifecycle_checkin_snoozed_until || '',
                credential: credCode || '',
                matriculation_date: profile?.matriculation_date || '',
                graduation_date: gradDate || '',
                credential_effective: credCode || '',
                is_caa: lifecycleStage === 'practicing' && credCode === 'CAA',
                needs_credential: needsCredential,
                needs_program: needsProgram,
                review_prompt_due,
                training_program: profile?.training_program || '',
                target_exam_date: profile?.target_exam_date || '',
                applicant_progress: sanitizeApplicantProgress(profile?.applicant_progress),
                study_goal: profile?.study_goal || null,
                theme: profile?.theme || null,
                font: profile?.font || null,
                leaderboard_handle: profile?.leaderboard_handle || null,
                leaderboard_opt_in: !!profile?.leaderboard_opt_in,
                selected_title: profile?.selected_title || null,
                title_auto: profile?.title_auto !== false, // default true; false once they pick explicitly

                bonus_xp: Number(profile?.bonus_xp) || 0,
                ach_claimed: Array.isArray(profile?.ach_claimed) ? profile.ach_claimed : [],
                daily_state: (profile && profile.daily_state && typeof profile.daily_state === 'object') ? profile.daily_state : {},
                phone: profile?.phone || '',
                free_tier_limit: ceiling,
                stats,
                by_specialty: Array.isArray(learning.by_specialty) ? learning.by_specialty : [],
                calibration: Array.isArray(learning.calibration) ? learning.calibration : [],
                coverage: Array.isArray(learning.coverage) ? learning.coverage : [],
                by_domain: Array.isArray(learning.by_domain) ? learning.by_domain : [],
                saa_domain_benchmark: saaBenchmark.accuracy,
                saa_domain_benchmark_samples: saaBenchmark.samples,
                streak: Number(learning.streak) || 0,
                active_days: Array.isArray(learning.active_days) ? learning.active_days : [],
                trend: Array.isArray(learning.trend) ? learning.trend : [],
                readiness: Number(readinessBasis.score) || 0,
                readiness_basis: {
                    answered: Number(readinessBasis.answered) || 0,
                    correct: Number(readinessBasis.correct) || 0,
                    total: Number(readinessBasis.total) || 0,
                    latest_accuracy: readinessBasis.latest_accuracy == null ? null : Number(readinessBasis.latest_accuracy),
                },
                adaptive_plan: adaptivePlan,
                days_to_exam: adaptivePlan.days_to_exam,
                answered_today: Number(learning.answered_today) || 0,
                missed_ids: Array.isArray(learning.missed_ids) ? learning.missed_ids : [],
                confident_missed_ids: Array.isArray(learning.confident_missed_ids) ? learning.confident_missed_ids : [],
                due_ids,
                flagged_ids,
                flashcard_ids,
                answered_ids: Array.isArray(learning.answered_ids) ? learning.answered_ids : [],
            },
        });
    } catch (err) {
        reportOperationalError('profile.load', err);
        return res.status(500).json({ profile: null });
    }
});

// Update the authenticated user's personal profile fields. Premium status and
// admin flags are NOT writable here — only the user's own descriptive info.
app.post('/api/user/profile', profileLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Database not configured.' });

    const b = req.body || {};
    const update = {};
    if (Object.prototype.hasOwnProperty.call(b, 'lifecycle_stage')) {
        const stage = normalizeLifecycleStage(b.lifecycle_stage);
        if (!PROFILE_SELECTION_LIFECYCLE_STAGES.has(stage)) {
            return res.status(400).json({ error: 'Select applying, currently enrolled, or practicing CAA.' });
        }
        update.lifecycle_stage = stage;
        update.lifecycle_updated_at = new Date().toISOString();
    }
    if (Object.prototype.hasOwnProperty.call(b, 'full_name')) {
        if (typeof b.full_name !== 'string') return res.status(400).json({ error: 'Name must be text.' });
        update.full_name = b.full_name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 120);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'credential')) {
        if (!['SAA', 'CAA'].includes(b.credential)) return res.status(400).json({ error: 'Credential must be SAA or CAA.' });
        update.credential = b.credential;
    }
    if (Object.prototype.hasOwnProperty.call(b, 'phone')) {
        if (typeof b.phone !== 'string' || !/^[0-9+().\-\s]{0,32}$/.test(b.phone)) {
            return res.status(400).json({ error: 'Enter a valid phone number.' });
        }
        update.phone = b.phone.trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(b, 'training_program')) {
        const trainingProgram = normalizeTrainingProgram(b.training_program);
        if (!isReviewUser(user) && (!trainingProgram || trainingProgram.toLowerCase() === 'program not listed')) {
            return res.status(400).json({ error: 'Please select your AA program.' });
        }
        update.training_program = trainingProgram;
    }
    if (Object.prototype.hasOwnProperty.call(b, 'target_exam_date')) {
        if (b.target_exam_date === '' || b.target_exam_date === null) update.target_exam_date = null;
        else if (isValidProfileDate(b.target_exam_date)) update.target_exam_date = b.target_exam_date;
        else return res.status(400).json({ error: 'Enter a valid target exam date.' });
    }
    if (Object.prototype.hasOwnProperty.call(b, 'graduation_date')) {
        if (b.graduation_date === '' || b.graduation_date === null) update.graduation_date = null;
        else if (isValidProfileDate(b.graduation_date)) update.graduation_date = b.graduation_date;
        else return res.status(400).json({ error: 'Enter a valid graduation date.' });
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
        const { data: current, error: currentError } = await supabase
            .from(PROFILE_TABLE)
            .select('lifecycle_stage, credential, graduation_date, training_program')
            .eq('user_id', user.id)
            .maybeSingle();
        if (currentError) throw currentError;
        const currentStage = inferLifecycleStage(current);
        if (update.lifecycle_stage && currentStage && update.lifecycle_stage !== currentStage) {
            return res.status(409).json({ error: 'Use the lifecycle transition in your dashboard to change stages.' });
        }
        const effectiveStage = update.lifecycle_stage || currentStage;
        const effectiveGraduation = Object.prototype.hasOwnProperty.call(update, 'graduation_date')
            ? update.graduation_date : current?.graduation_date || null;
        const effectiveProgram = Object.prototype.hasOwnProperty.call(update, 'training_program')
            ? update.training_program : normalizeTrainingProgram(current?.training_program);
        if (effectiveStage === 'applicant') {
            update.credential = null;
            update.training_program = null;
            update.matriculation_date = null;
            update.graduation_date = null;
            update.target_exam_date = null;
            update.leaderboard_opt_in = false;
        } else if (effectiveStage === 'student') {
            if (!effectiveGraduation) return res.status(400).json({ error: 'Current AA students must add a valid expected graduation date.' });
            if (!isReviewUser(user) && !effectiveProgram) return res.status(400).json({ error: 'Please select your AA program.' });
            if (update.credential && update.credential !== 'SAA') {
                return res.status(409).json({ error: 'Student accounts use the SAA credential until their graduation date.' });
            }
            update.credential = 'SAA';
        } else if (effectiveStage === 'practicing') {
            if (!isReviewUser(user) && !effectiveProgram) return res.status(400).json({ error: 'Please select your AA program.' });
            if (update.credential && update.credential !== 'CAA') {
                return res.status(409).json({ error: 'Practicing CAA accounts keep the CAA credential.' });
            }
            update.credential = 'CAA';
        } else if (Object.prototype.hasOwnProperty.call(update, 'credential')) {
            return res.status(409).json({ error: 'Select where you are in your AA journey first.' });
        }
        const { data: savedProfile, error } = await supabase.from(PROFILE_TABLE)
            .update(update).eq('user_id', user.id).select('user_id');
        if (error) throw error;
        if (!savedProfile?.length) {
            const { error: insertError } = await supabase.from(PROFILE_TABLE).upsert({
                user_id: user.id,
                email: (user.email || '').toLowerCase().trim() || null,
                ...update,
            }, { onConflict: 'user_id' });
            if (insertError) throw insertError;
        }
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
            try { await supabase.from('analytics_events').insert({ name: 'program_not_listed', user_id: user.id, meta: { platform: 'untagged' } }); } catch (e) { /* non-fatal */ }
        }
        return res.json({ success: true });
    } catch (err) {
        reportOperationalError('profile.save', err);
        return res.status(500).json({ error: 'Could not save profile.' });
    }
});

app.post('/api/user/applicant-progress', profileLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Database not configured.' });
    try {
        const lifecycle = await getUserLifecycle(user);
        const adminUser = isAdminUser(user);
        if (!adminUser && !['applicant', 'incoming_student'].includes(lifecycle.stage)) {
            return res.status(403).json({ error: 'The application tracker is for applicant accounts.' });
        }
        const applicantProgress = sanitizeApplicantProgress(req.body?.progress);
        const now = new Date().toISOString();
        let updateQuery = supabase.from(PROFILE_TABLE)
            .update({ applicant_progress: applicantProgress, updated_at: now })
            .eq('user_id', user.id);
        if (!adminUser) updateQuery = updateQuery.in('lifecycle_stage', ['applicant', 'incoming_student']);
        const { data, error } = await updateQuery
            .select('user_id')
            .maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ error: 'Your account stage changed. Refresh and try again.' });
        try { await supabase.from('analytics_events').insert({ name: 'applicant_progress_saved', user_id: user.id, meta: { platform: 'untagged' } }); } catch (e) { /* best-effort */ }
        return res.json({ success: true, applicant_progress: applicantProgress });
    } catch (error) {
        reportOperationalError('applicant.progress', error);
        return res.status(500).json({ error: 'Could not save your application tracker.' });
    }
});

app.post('/api/user/lifecycle', profileLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Database not configured.' });
    const action = String(req.body?.action || '');
    try {
        const lifecycle = await getUserLifecycle(user);
        const now = new Date();
        const nowIso = now.toISOString();

        if (action === 'checkin_seen' || action === 'still_applying') {
            if (lifecycle.stage !== 'applicant') return res.status(409).json({ error: 'Your account is no longer in the applicant stage.' });
            const { error } = await supabase.from(PROFILE_TABLE).update({
                lifecycle_checkin_at: nowIso,
                lifecycle_checkin_snoozed_until: null,
                updated_at: nowIso,
            }).eq('user_id', user.id).eq('lifecycle_stage', 'applicant');
            if (error) throw error;
            return res.json({ success: true, lifecycle_stage: 'applicant' });
        }

        if (action === 'pause_cycle') {
            if (lifecycle.stage !== 'applicant') return res.status(409).json({ error: 'Your account is no longer in the applicant stage.' });
            const snoozeUntil = req.body?.snooze_until;
            if (!isValidProfileDate(snoozeUntil)) return res.status(400).json({ error: 'Choose a valid reminder date.' });
            const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
            const latest = new Date(now.getTime() + 730 * 86400000).toISOString().slice(0, 10);
            if (snoozeUntil < tomorrow || snoozeUntil > latest) {
                return res.status(400).json({ error: 'Choose a date within the next two years.' });
            }
            const { error } = await supabase.from(PROFILE_TABLE).update({
                lifecycle_checkin_at: nowIso,
                lifecycle_checkin_snoozed_until: snoozeUntil,
                updated_at: nowIso,
            }).eq('user_id', user.id).eq('lifecycle_stage', 'applicant');
            if (error) throw error;
            return res.json({ success: true, lifecycle_stage: 'applicant', snooze_until: snoozeUntil });
        }

        if (action === 'commit') {
            if (!['applicant', 'incoming_student'].includes(lifecycle.stage)) {
                return res.status(409).json({ error: 'This transition is only available before you begin AA school.' });
            }
            const trainingProgram = normalizeTrainingProgram(req.body?.training_program);
            const matriculationDate = req.body?.matriculation_date;
            const graduationDate = req.body?.graduation_date;
            const targetExamDate = req.body?.target_exam_date || null;
            if (!trainingProgram || trainingProgram.toLowerCase() === 'program not listed') {
                return res.status(400).json({ error: 'Select the program and campus where you committed.' });
            }
            if (!isValidProfileDate(matriculationDate)) return res.status(400).json({ error: 'Add a valid matriculation date.' });
            if (!isValidProfileDate(graduationDate)) return res.status(400).json({ error: 'Add a valid expected graduation date.' });
            if (graduationDate <= matriculationDate) return res.status(400).json({ error: 'Graduation must be after matriculation.' });
            if (targetExamDate && !isValidProfileDate(targetExamDate)) return res.status(400).json({ error: 'Add a valid target board date.' });
            if (targetExamDate && targetExamDate < graduationDate) return res.status(400).json({ error: 'The target board date cannot be before graduation.' });
            const nextStage = dateHasArrived(matriculationDate) ? 'student' : 'incoming_student';
            const update = {
                lifecycle_stage: nextStage,
                lifecycle_updated_at: nowIso,
                lifecycle_checkin_at: nowIso,
                lifecycle_checkin_snoozed_until: null,
                credential: nextStage === 'student' ? 'SAA' : null,
                training_program: trainingProgram,
                matriculation_date: matriculationDate,
                graduation_date: graduationDate,
                target_exam_date: targetExamDate,
                leaderboard_opt_in: false,
                updated_at: nowIso,
            };
            const { data, error } = await supabase.from(PROFILE_TABLE).update(update)
                .eq('user_id', user.id)
                .in('lifecycle_stage', ['applicant', 'incoming_student'])
                .select('user_id')
                .maybeSingle();
            if (error) throw error;
            if (!data) return res.status(409).json({ error: 'Your account stage changed. Refresh and try again.' });
            try { await supabase.from('analytics_events').insert({ name: 'lifecycle_committed', user_id: user.id, meta: { platform: 'untagged' } }); } catch (e) { /* best-effort */ }
            if (req.body?.program_unlisted) {
                const safeProgram = trainingProgram.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
                sendEmail({
                    to: Array.from(ADMIN_EMAILS),
                    subject: `MACPrep: new committed AA program - ${trainingProgram.slice(0, 80)}`,
                    html: `<p>An incoming student committed to a program that is not yet in MACPrep's list:</p><p><b>${safeProgram}</b></p>`,
                }).catch((error) => console.error('[program-alert] email failed:', error.message));
            }
            return res.json({ success: true, lifecycle_stage: nextStage });
        }

        return res.status(400).json({ error: 'Unknown lifecycle action.' });
    } catch (error) {
        reportOperationalError('lifecycle.update', error);
        return res.status(500).json({ error: 'Could not update your account stage.' });
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
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!await requireBoardPrepLifecycle(user, res)) return;
    const questionId = String(req.body?.questionId || '');
    const flagged = req.body?.flagged !== false;
    if (!questionId) return res.status(400).json({ error: 'questionId required.' });
    try {
        if (flagged) {
            const { error } = await supabase.from('user_flags').upsert({ user_id: user.id, question_id: questionId }, { onConflict: 'user_id,question_id' });
            if (error) throw error;
        } else {
            const { error } = await supabase.from('user_flags').delete().eq('user_id', user.id).eq('question_id', questionId);
            if (error) throw error;
        }
        return res.json({ success: true, flagged });
    } catch (err) {
        reportOperationalError('flag.save', err);
        return res.status(500).json({ error: 'Could not update flag.' });
    }
});

// Personal flashcard deck — add/remove a question the user wants to drill as a flashcard.
app.post('/api/user/flashcard', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!await requireBoardPrepLifecycle(user, res)) return;
    const questionId = String(req.body?.questionId || '');
    const saved = req.body?.saved !== false;
    if (!questionId) return res.status(400).json({ error: 'questionId required.' });
    try {
        if (saved) {
            const { error } = await supabase.from('user_flashcards').upsert({ user_id: user.id, question_id: questionId }, { onConflict: 'user_id,question_id' });
            if (error) throw error;
        } else {
            const { error } = await supabase.from('user_flashcards').delete().eq('user_id', user.id).eq('question_id', questionId);
            if (error) throw error;
        }
        return res.json({ success: true, saved });
    } catch (err) {
        reportOperationalError('flashcard.save', err);
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
        const { data, error } = await supabase.from(PROFILE_TABLE).select('full_name').eq('user_id', userId).maybeSingle();
        if (error) throw error;
        const n = data && data.full_name ? lbShortName(data.full_name) : '';
        return n || 'A classmate';
    } catch (e) { return 'A classmate'; }
}
app.post('/api/duel/create', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!await requireBoardPrepLifecycle(user, res)) return;
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 10, 5), 20);
    try {
        const pool = (await fetchAllServedQuestionRows('id')).map((r) => r.id);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const ids = pool.slice(0, count);
        if (ids.length < 3) return res.status(400).json({ error: 'Not enough questions available for a duel.' });
        const name = await duelName(user.id);
        let code = duelCode(), tries = 0, ok = false;
        while (tries < 6) {
            const { error } = await supabase.from('duels').insert({ code, creator_id: user.id, creator_name: name, question_ids: ids });
            if (!error) { ok = true; break; }
            if (error.code !== '23505') throw error;
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
    if (!await requireBoardPrepLifecycle(user, res)) return;
    const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 10, 5), 20);
    try {
        const name = await duelName(user.id);
        // 1) Try to claim an open random duel another student is waiting on (creator already played).
        const { data: open, error: openError } = await supabase.from('duels').select('code, question_ids, creator_name')
            .eq('is_random', true).is('opponent_id', null).neq('creator_id', user.id)
            .not('creator_score', 'is', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
        if (openError) throw openError;
        if (open) {
            const { data: claimed, error: claimError } = await supabase.from('duels')
                .update({ opponent_id: user.id, opponent_name: name })
                .eq('code', open.code).is('opponent_id', null).select('code').maybeSingle();
            if (claimError) throw claimError;
            if (claimed) return res.json({ success: true, matched: true, code: open.code, questionIds: open.question_ids || [], creatorName: open.creator_name, role: 'opponent', isRandom: true });
        }
        // 2) None open → create one and wait in the pool for the next random dueler.
        const pool = (await fetchAllServedQuestionRows('id')).map((r) => r.id);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const ids = pool.slice(0, count);
        if (ids.length < 3) return res.status(400).json({ error: 'Not enough questions available for a duel.' });
        let code = duelCode(), tries = 0, ok = false;
        while (tries < 6) {
            const { error } = await supabase.from('duels').insert({ code, creator_id: user.id, creator_name: name, question_ids: ids, is_random: true });
            if (!error) { ok = true; break; }
            if (error.code !== '23505') throw error;
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
    if (!await requireBoardPrepLifecycle(user, res)) return;
    try {
        const { data, error } = await supabase.from('duels').select('*')
            .or(`creator_id.eq.${user.id},opponent_id.eq.${user.id}`)
            .order('created_at', { ascending: false }).limit(8);
        if (error) throw error;
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
    if (!await requireBoardPrepLifecycle(user, res)) return;
    const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    try {
        const { data: d, error } = await supabase.from('duels').select('*').eq('code', code).maybeSingle();
        if (error) throw error;
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
    if (!await requireBoardPrepLifecycle(user, res)) return;
    const code = String(req.body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const score = Math.max(0, Math.min(parseInt(req.body?.score, 10) || 0, 200));
    const total = Math.max(1, Math.min(parseInt(req.body?.total, 10) || 1, 200));
    try {
        const { data: d, error: duelError } = await supabase.from('duels').select('*').eq('code', code).maybeSingle();
        if (duelError) throw duelError;
        if (!d) return res.status(404).json({ error: 'That duel code was not found.' });
        const name = await duelName(user.id);
        const upd = {};
        if (d.creator_id === user.id) { upd.creator_score = score; upd.creator_total = total; if (d.opponent_score != null) upd.completed_at = new Date().toISOString(); }
        else if (!d.opponent_id || d.opponent_id === user.id) { upd.opponent_id = user.id; upd.opponent_name = name; upd.opponent_score = score; upd.opponent_total = total; if (d.creator_score != null) upd.completed_at = new Date().toISOString(); }
        else { return res.status(409).json({ error: 'This duel already has two players.' }); }
        let updateQuery = supabase.from('duels').update(upd).eq('code', code);
        if (d.creator_id === user.id) updateQuery = updateQuery.eq('creator_id', user.id);
        else if (d.opponent_id === user.id) updateQuery = updateQuery.eq('opponent_id', user.id);
        else updateQuery = updateQuery.is('opponent_id', null);
        const { data: updated, error: updateError } = await updateQuery.select('*').maybeSingle();
        if (updateError) throw updateError;
        if (!updated) return res.status(409).json({ error: 'Another player joined this duel first.' });
        const m = updated;
        return res.json({ success: true, code, creatorName: m.creator_name, creatorScore: m.creator_score, creatorTotal: m.creator_total, opponentName: m.opponent_name, opponentScore: m.opponent_score, opponentTotal: m.opponent_total, isRandom: m.is_random });
    } catch (err) { return res.status(500).json({ error: 'Could not save your duel score.' }); }
});

// Per-question personal notes.
app.get('/api/user/note', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!await requireBoardPrepLifecycle(user, res)) return;
    const questionId = String(req.query.questionId || '');
    if (!questionId) return res.status(400).json({ error: 'questionId required.' });
    try {
        const { data, error } = await supabase.from('user_notes').select('note').eq('user_id', user.id).eq('question_id', questionId).maybeSingle();
        if (error) throw error;
        return res.json({ note: data?.note || '' });
    } catch (error) {
        reportOperationalError('note.load', error);
        return res.status(500).json({ error: 'Could not load note.' });
    }
});

app.post('/api/user/note', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    if (!await requireBoardPrepLifecycle(user, res)) return;
    const questionId = String(req.body?.questionId || '');
    const note = (req.body?.note || '').toString().slice(0, 5000);
    if (!questionId) return res.status(400).json({ error: 'questionId required.' });
    try {
        if (note.trim() === '') {
            const { error } = await supabase.from('user_notes').delete().eq('user_id', user.id).eq('question_id', questionId);
            if (error) throw error;
        } else {
            const { error } = await supabase.from('user_notes').upsert({ user_id: user.id, question_id: questionId, note, updated_at: new Date().toISOString() }, { onConflict: 'user_id,question_id' });
            if (error) throw error;
        }
        return res.json({ success: true });
    } catch (err) {
        reportOperationalError('note.save', err);
        return res.status(500).json({ error: 'Could not save note.' });
    }
});

// My Notebook: all of the user's notes + flagged questions, with question context.
app.get('/api/user/notebook', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.json({ notes: [], flagged: [] });
    if (!await requireBoardPrepLifecycle(user, res)) return;
    try {
        const { data: notes, error: notesError } = await supabase.from('user_notes').select('question_id, note, updated_at').eq('user_id', user.id);
        if (notesError) throw notesError;
        const { data: flags, error: flagsError } = await supabase.from('user_flags').select('question_id').eq('user_id', user.id);
        if (flagsError) throw flagsError;
        const ids = Array.from(new Set([...(notes || []).map((n) => n.question_id), ...(flags || []).map((f) => f.question_id)]));
        const qmap = {};
        if (ids.length) {
            const { data: qs, error: questionError } = await supabase.from('questions').select('id, category, domain_name, stem').in('id', ids);
            if (questionError) throw questionError;
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
// Every review enters the moderation queue before public display. Language checks
// still prioritize risky submissions for the founder's notification, but no user
// supplied testimonial can publish directly to a public marketing surface.
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
        // One review per account: re-submitting updates the existing review and sends
        // the new text back through moderation.
        const held = reviewNeedsModeration(body) || reviewNeedsModeration(author_name) || reviewNeedsModeration(credential);
        const status = 'pending';
        const { error } = await supabase.from('reviews').upsert(
            { user_id: user.id, author_name, credential, rating, body, status },
            { onConflict: 'user_id' }
        );
        if (error) throw error;
        // They reviewed — quiet the review-ask nudge for good (belt-and-suspenders; the
        // due-check also sees the review row itself). Fire-and-forget.
        supabase.from(PROFILE_TABLE).update({ review_prompt_at: new Date().toISOString() }).eq('user_id', user.id).then(() => {}, () => {});
        sendEmail({
            to: 'support@macprep.org',
            subject: held ? `Review flagged for moderation — ${author_name}` : `New MACPrep review awaiting approval — ${author_name}`,
            html: `<p style="font-family:sans-serif;font-size:15px;"><strong>${escHtml(author_name)}</strong> ${escHtml(credential || '')} · ${rating}★</p><p style="font-family:sans-serif;font-size:15px;background:#f6f7f9;border:1px solid #e5e7eb;border-radius:8px;padding:14px;">${escHtml(body)}</p>` + (held
                ? `<p style="font-size:13px;color:#b45309;"><strong>⚠ Auto-held (flagged language).</strong> It is NOT on the public page. Approve or remove it in the admin Content review queue.</p>`
                : `<p style="font-size:12px;color:#6b7280;">This is not public yet. Approve or remove it in the admin Content review queue.</p>`),
        }).then(() => {}, () => {});
        // Always report success — never signal to the submitter that a review was held.
        return res.json({ success: true });
    } catch (err) {
        console.error('Review submit failure:', err.message);
        return res.status(500).json({ error: 'Could not submit your review.' });
    }
});

// "Maybe later" on the in-app review ask — stamps the clock so the prompt waits a
// month before asking again (and keeps asking monthly until they leave a review).
app.post('/api/user/review-prompt-seen', async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!supabase) return res.status(500).json({ error: 'Not configured.' });
    try {
        const { error } = await supabase.from(PROFILE_TABLE).update({ review_prompt_at: new Date().toISOString() }).eq('user_id', user.id);
        if (error) throw error;
        return res.json({ ok: true });
    } catch (error) {
        reportOperationalError('review.prompt-seen', error);
        return res.status(500).json({ error: 'Could not update the review reminder.' });
    }
});

app.get('/api/admin/reviews', async (req, res) => {
    const admin = await getAdminUser(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required.' });
    try {
        // Show every non-rejected review so pending submissions and approved public
        // testimonials can be managed in the same queue.
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
// Native one-time purchases. The device only supplies a store transaction token;
// entitlement is granted after server-to-server verification, never by trusting a
// client-side premium flag. Both stores resolve to the same account_tier contract
// already used by Stripe, vouchers, and program grants.
// ---------------------------------------------------------------------------
app.post('/api/mobile-purchases/apple-notifications', async (req, res) => {
    try {
        const { notification, transaction } = await verifyAppleNotification(req.body?.signedPayload);
        const type = notification?.notificationType;
        if (type === NotificationTypeV2.TEST) return res.status(200).end();
        if (!transaction) return res.status(200).end();
        if (transaction.bundleId !== MOBILE_APP_BUNDLE_ID
            || transaction.productId !== MOBILE_PREMIUM_PRODUCT_ID
            || transaction.type !== AppleProductType.NON_CONSUMABLE) {
            return res.status(400).json({ error: 'Notification is not for MACPrep full access.' });
        }
        const sourceReference = String(transaction.originalTransactionId || transaction.transactionId || '');
        if (!sourceReference) return res.status(400).json({ error: 'Notification has no transaction reference.' });

        if (type === NotificationTypeV2.REFUND_REVERSED) {
            // Notification delivery is unordered. Re-fetch the transaction from
            // Apple before reactivating so a stale reversal cannot override a
            // newer refund or revocation.
            if (!validUuid(transaction.appAccountToken)) {
                reportOperationalError('apple.entitlement.unmatched', new Error('An Apple refund reversal did not match an account.'), { notificationType: type });
                return res.status(200).end();
            }
            const entitlement = await verifyApplePurchase(
                transaction.appAccountToken,
                String(transaction.transactionId || '')
            );
            await syncProviderEntitlement({
                userId: transaction.appAccountToken,
                source: 'apple',
                sourceReference: entitlement.transactionId,
                productId: entitlement.productId,
                status: 'active',
                metadata: { notification_uuid: notification.notificationUUID || null },
                allowReactivate: true,
            });
        } else if ([NotificationTypeV2.REFUND, NotificationTypeV2.REVOKE].includes(type)) {
            const status = type === NotificationTypeV2.REFUND ? 'refunded' : 'revoked';
            const matched = await setEntitlementStatus({ source: 'apple', sourceReference, status });
            if (!matched && validUuid(transaction.appAccountToken)) {
                await syncProviderEntitlement({
                    userId: transaction.appAccountToken,
                    source: 'apple',
                    sourceReference,
                    productId: transaction.productId,
                    status,
                    metadata: { notification_uuid: notification.notificationUUID || null },
                });
            } else if (!matched) {
                reportOperationalError('apple.entitlement.unmatched', new Error('An Apple status event did not match an account.'), { notificationType: type });
            }
        } else if (type === NotificationTypeV2.ONE_TIME_CHARGE && validUuid(transaction.appAccountToken)) {
            const entitlement = validateAppleTransactionPayload(transaction, {
                userId: transaction.appAccountToken,
                transactionId: transaction.transactionId,
            });
            await claimMobileEntitlement(transaction.appAccountToken, entitlement);
            await grantEntitlement({
                userId: transaction.appAccountToken,
                source: 'apple',
                sourceReference: entitlement.transactionId,
                productId: entitlement.productId,
                metadata: { notification_uuid: notification.notificationUUID || null },
            });
        }
        return res.status(200).end();
    } catch (error) {
        if (error instanceof MobilePurchaseError) return res.status(error.status).json({ error: error.message });
        reportOperationalError('apple.notification', error);
        return res.status(500).json({ error: 'Could not process Apple notification.' });
    }
});

app.post('/api/mobile-purchases/google-notifications', async (req, res) => {
    try {
        await verifyGooglePubSubRequest(req);
        const encoded = req.body?.message?.data;
        if (typeof encoded !== 'string' || encoded.length > 150000) return res.status(400).json({ error: 'Invalid Pub/Sub message.' });
        let notification;
        try { notification = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
        catch (error) { return res.status(400).json({ error: 'Invalid Google Play notification.' }); }
        if (notification.packageName !== MOBILE_APP_BUNDLE_ID) return res.status(400).json({ error: 'Notification is for another app.' });

        const oneTime = notification.oneTimeProductNotification;
        const voided = notification.voidedPurchaseNotification;
        if (oneTime) {
            if (oneTime.sku !== MOBILE_PREMIUM_PRODUCT_ID) return res.status(200).end();
            const token = String(oneTime.purchaseToken || '');
            if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(token)) return res.status(400).json({ error: 'Invalid purchase token.' });
            const publisher = googlePublisherClient();
            const response = await publisher.purchases.productsv2.getproductpurchasev2({
                packageName: MOBILE_APP_BUNDLE_ID,
                token,
            });
            const purchase = response.data;
            const purchased = purchase?.purchaseStateContext?.purchaseState === 'PURCHASED';
            if (Number(oneTime.notificationType) === 1 && !purchased) {
                throw new MobilePurchaseError('Google Play purchase state has not settled yet.', 503);
            }
            const productMatches = Array.isArray(purchase?.productLineItem)
                && purchase.productLineItem.some((item) => item?.productId === MOBILE_PREMIUM_PRODUCT_ID);
            if (!productMatches) return res.status(200).end();
            if (!purchased) {
                // A canceled pending purchase never granted access. Revoke only an
                // existing record; do not replace an unrelated legacy entitlement.
                await setEntitlementStatus({ source: 'google_play', sourceReference: token, status: 'revoked' });
                return res.status(200).end();
            }
            const userId = await userIdFromMobileAccountHash(purchase.obfuscatedExternalAccountId);
            if (!userId) {
                reportOperationalError('google-play.entitlement.unmatched', new Error('A Google Play purchase event did not match an account.'), { notificationType: oneTime.notificationType });
                return res.status(200).end();
            }
            const verified = validateGooglePurchasePayload(purchase, { userId });
            const entitlement = { ...verified, transactionId: token };
            await claimMobileEntitlement(userId, entitlement);
            await grantEntitlement({
                userId,
                source: 'google_play',
                sourceReference: token,
                productId: entitlement.productId,
                metadata: { pubsub_message_id: req.body?.message?.messageId || null },
            });
            await acknowledgeGooglePlayPurchase(publisher, token, purchase.acknowledgementState);
        } else if (voided?.purchaseToken && Number(voided.productType) === 2) {
            const token = String(voided.purchaseToken);
            if (!/^[A-Za-z0-9._~-]{16,2048}$/.test(token)) return res.status(400).json({ error: 'Invalid purchase token.' });
            const matched = await setEntitlementStatus({
                source: 'google_play',
                sourceReference: token,
                status: 'revoked',
            });
            if (!matched) {
                const publisher = googlePublisherClient();
                const response = await publisher.purchases.productsv2.getproductpurchasev2({
                    packageName: MOBILE_APP_BUNDLE_ID,
                    token,
                });
                const purchase = response.data;
                const productMatches = Array.isArray(purchase?.productLineItem)
                    && purchase.productLineItem.some((item) => item?.productId === MOBILE_PREMIUM_PRODUCT_ID);
                const userId = productMatches
                    ? await userIdFromMobileAccountHash(purchase.obfuscatedExternalAccountId)
                    : null;
                if (userId) {
                    await syncProviderEntitlement({
                        userId,
                        source: 'google_play',
                        sourceReference: token,
                        productId: MOBILE_PREMIUM_PRODUCT_ID,
                        status: 'revoked',
                        metadata: { pubsub_message_id: req.body?.message?.messageId || null },
                    });
                } else {
                    reportOperationalError('google-play.voided.unmatched', new Error('A voided Google Play purchase did not match an account.'));
                }
            }
        }
        return res.status(200).end();
    } catch (error) {
        if (error instanceof MobilePurchaseError) return res.status(error.status).json({ error: error.message });
        reportOperationalError('google-play.notification', error);
        return res.status(500).json({ error: 'Could not process Google Play notification.' });
    }
});

app.post('/api/mobile-purchases/verify', mobilePurchaseLimiter, async (req, res) => {
    const user = await getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    const store = normalizeMobileStore(req.body?.store);
    if (!store) return res.status(400).json({ error: 'Unsupported mobile store.' });

    try {
        let entitlement;
        if (store === 'apple') {
            entitlement = await verifyApplePurchase(user.id, String(req.body?.transaction_id || '').trim());
        } else {
            entitlement = await verifyGooglePlayPurchase(user.id, String(req.body?.purchase_token || '').trim());
        }

        await claimMobileEntitlement(user.id, entitlement);
        const premiumUnlocked = await grantEntitlement({
            userId: user.id,
            email: (user.email || '').toLowerCase().trim(),
            source: entitlement.store,
            sourceReference: entitlement.transactionId,
            productId: entitlement.productId,
            metadata: {
                original_transaction_id: entitlement.originalTransactionId || null,
                environment: entitlement.environment || null,
                purchased_at: entitlement.purchasedAt || null,
            },
            // This path just performed a fresh provider lookup and may safely
            // restore a purchase after a reversed refund or resolved dispute.
            allowReactivate: true,
        });
        if (!premiumUnlocked) {
            throw new MobilePurchaseError('This store purchase has been refunded or revoked.', 422);
        }
        recordPurchaseOnce(user.id, store);

        let acknowledged = true;
        if (store === 'google_play') {
            acknowledged = await acknowledgeGooglePlayPurchase(
                entitlement.publisher,
                entitlement.transactionId,
                entitlement.acknowledgementState
            );
        }
        return res.json({ premium_unlocked: true, store, acknowledged });
    } catch (error) {
        if (error instanceof MobilePurchaseError) return res.status(error.status).json({ error: error.message });
        reportOperationalError('mobile-purchase.verify', error, { store });
        return res.status(500).json({ error: 'Could not verify this purchase.' });
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
        const fullAccess = await hasFullAccess(user);
        if (fullAccess === null) return accessLookupUnavailable(res);
        if (fullAccess) return res.status(409).json({ error: 'This account already has full access.', premium_unlocked: true });
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
            payment_intent_data: {
                metadata: {
                    user_id: user.id,
                    macprep_product_id: priceId,
                },
            },
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
        }, {
            idempotencyKey: stripeCheckoutIdempotencyKey(user.id, priceId),
        });

        res.json({ url: session.url });
    } catch (err) {
        reportOperationalError('stripe.checkout-create', err);
        res.status(500).json({ error: 'Could not start checkout. Please try again.' });
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
            const already = await hasFullAccess(user);
            if (already === null) return accessLookupUnavailable(res);
            return res.json({ premium_unlocked: already });
        }
        const lineItem = await verifyStripeCheckoutProduct(session);
        const entitlement = await syncPaidStripeCheckout({
            session,
            lineItem,
            userId: user.id,
            email: (session.customer_details?.email || user.email || '').toLowerCase().trim(),
            metadata: { verified_on_return: true },
        });
        // The webhook normally records the purchase; when this fallback path is what
        // unlocked the account (webhook missed/delayed), record it here — deduped, so
        // whichever path runs second is a no-op and the sale is counted exactly once.
        recordPurchaseOnce(user.id);
        return res.json({ premium_unlocked: entitlement.hasAccess });
    } catch (err) {
        reportOperationalError('stripe.checkout-verify', err);
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
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.too.large' || err?.status === 413) {
        return res.status(413).json({ error: 'Request body is too large.' });
    }
    console.error('Unhandled route error:', err && err.stack ? err.stack : err);
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
// Start server (all routes are declared above this line). Keeping startup out of
// module evaluation lets the local node:test suite import and exercise helpers
// without opening a listener or requiring live Supabase/Stripe credentials.
// ---------------------------------------------------------------------------
let backgroundJobsStarted = false;
function startBackgroundJobs() {
    if (backgroundJobsStarted) return;
    backgroundJobsStarted = true;
    startReferralCodeScheduler();
    startReminderScheduler();
    startLifecycleScheduler();
}

export function startServer(port = process.env.PORT || 3000) {
    startBackgroundJobs();
    return app.listen(port, () => {
        console.log(`MACPrep server running on port ${port}`);
        console.log(`Supabase: ${supabase ? 'CONNECTED (service role)' : 'OFFLINE'} | Auth: ${supabaseAuth ? 'ready' : 'OFFLINE'}`);
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) startServer();

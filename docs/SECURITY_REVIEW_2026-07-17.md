# MACPrep Security Review - 2026-07-17

## Scope and outcome

This review covered the Express API, browser client and service worker, Capacitor
shells, Supabase schema/RLS/functions, Stripe paths, dependency graph, Git
history, and the production HTTP edge. It is an evidence-based point-in-time
assessment, not a guarantee that no future vulnerability exists.

## Remediated

- `20260717203000_revoke_legacy_public_data_access.sql` revokes `anon` and
  `authenticated` access to the deprecated question table, which contained
  answer keys, the legacy review table, which contained reviewer email addresses,
  and direct profile-table access.
- `20260717203100_harden_auth_trigger_search_path.sql` pins the auth provisioning
  trigger to an empty search path.
- `20260717212400_drop_legacy_profile_policies.sql` removes stale direct-profile
  RLS policies rather than leaving them to become active after a future grant.
- Production verification confirmed those roles cannot read the legacy questions
  or reviews and cannot update profiles. The only remaining `user_profiles`
  policy is service-role-only.
- The server now uses no-store API responses, removes Express fingerprinting,
  rejects bodies above 64 KB, enforces HTTPS-only redirect origins, constrains
  clean URL file resolution, returns non-sensitive payment/webhook errors, and
  adds focused rate limits.
- Password resets accept only Supabase `recovery` tokens. Admin, reviewer, and
  faculty elevation require a confirmed email; application-managed passwords
  require at least 12 characters.
- Browser and server Sentry configuration removes request bodies, cookies,
  authorization headers, and user context. Operational logs no longer include
  account email addresses or identifiers in the checkout/push paths.
- Native Android backups are disabled. The service worker only persists
  same-origin assets and will not open an off-origin push target.

## Required owner actions

1. In Supabase Auth, enable leaked-password protection and configure the
   production password policy. The Supabase security advisor still reports this
   as disabled.
2. Rotate the historical Stripe test secret and webhook signing secret that were
   committed in old Git history. Do this before any optional coordinated history
   rewrite; never rewrite a shared branch before rotation.
3. Confirm whether the one-row `macprep_profiles_deprecated` table can be
   destroyed. It has an obsolete column named `password`; do not inspect its
   contents. After confirmation, drop the table (or at minimum the column) in a
   reviewed migration.
4. Put the Render origin behind Cloudflare-only origin controls and add Cloudflare
   rate-limit/WAF rules. The process-local limiter is useful but does not share
   state across restarts or multiple instances.
5. Plan a migration from localStorage bearer/refresh tokens and CSP
   `script-src 'unsafe-inline'` to server-managed `HttpOnly`, `Secure`,
   `SameSite` cookies plus a nonce/hash-based CSP. This is the largest remaining
   browser compromise-risk reduction and needs a staged native-webview test plan.
6. Test iOS App-Bound Domains in TestFlight before enabling them. The setting can
   block top-level navigation to domains not listed in `WKAppBoundDomains`.

## Verification evidence

- `npm audit --omit=dev --json`: no known production dependency vulnerabilities.
- `npm test`: 9 passing tests after the hardening work.
- `node --check src/server.mjs`, `src/app.js`, `src/instrument.mjs`, and `sw.js`:
  passed.
- Local HTTP smoke test: API responses are non-cacheable, `X-Powered-By` is
  absent, CSP includes `form-action 'self'`, and oversized JSON returns `413`.
- `npx cap sync android`: passed. A debug APK build was not attempted to
  completion because the local machine does not have a Java runtime.

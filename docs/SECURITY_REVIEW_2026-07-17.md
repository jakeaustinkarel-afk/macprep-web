# MACPrep Security Review - 2026-07-17 (status refreshed 2026-07-18)

## Scope and outcome

This review covered the Express API, browser client and service worker, Capacitor
shells, Supabase schema/RLS/functions, Stripe paths, dependency graph, Git
history, and the production HTTP edge. It is an evidence-based point-in-time
assessment, not a guarantee that no future vulnerability exists.

## Remediated

- `20260717211946_revoke_legacy_public_data_access.sql` revokes `anon` and
  `authenticated` access to the deprecated question table, which contained
  answer keys, the legacy review table, which contained reviewer email addresses,
  and direct profile-table access.
- `20260717212003_harden_auth_trigger_search_path.sql` pins the auth provisioning
  trigger to an empty search path.
- `20260717212119_drop_legacy_profile_policies.sql` removes stale direct-profile
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
- Browser authentication now uses server-managed `HttpOnly`, `Secure`,
  `SameSite=Lax` cookies. Cookie-authenticated mutations reject untrusted origins,
  and browser code no longer reads or sends bearer/refresh credentials.
- Supabase Auth now requires 12-character passwords, blocks known leaked
  passwords, requires the current password for password changes, and protects
  password changes with recent-login checks. The security advisor has no warning
  findings after the change.
- Sensitive auth, feedback, checkout, voucher, and native-purchase routes now use
  an atomic database-backed rate limiter in addition to bounded instance-local
  limits. Only hashed rate-limit identities are stored.
- Store and Stripe grants now reconcile through a server-only entitlement ledger;
  refund/revocation notifications remove access only when no active grant remains.

## Required owner actions

1. Rotate the historical Stripe test secret and webhook signing secret that were
   committed in old Git history. Do this before any optional coordinated history
   rewrite; never rewrite a shared branch before rotation.
2. Confirm whether the one-row `macprep_profiles_deprecated` table can be
   destroyed. It has an obsolete column named `password`; do not inspect its
   contents. After confirmation, drop the table (or at minimum the column) in a
   reviewed migration.
3. Put the Render origin behind Cloudflare-only origin controls and add Cloudflare
   WAF rules as an additional edge layer. The application now has shared database
   limits, but origin isolation remains useful defense in depth.
4. Remove legacy inline handlers and styles so CSP can drop
   `script-src 'unsafe-inline'` and adopt nonces or hashes. Credentials are no
   longer JavaScript-readable, but this remains the largest browser-side hardening
   task.
5. Test iOS App-Bound Domains in TestFlight before enabling them. The setting can
   block top-level navigation to domains not listed in `WKAppBoundDomains`.
6. Build a protected staging environment with seeded Supabase data and signed
   Stripe/App Store webhook fixtures before the next payment-provider change.

## Verification evidence

- `npm audit --omit=dev --json`: no known production dependency vulnerabilities.
- `npm test`: 29 passing tests after the July 18 hardening work, including HTTP
  surface, CSRF, entitlement, migration, faculty-scope, analytics, and native
  bridge checks.
- `node --check src/server.mjs`, `src/app.js`, `src/instrument.mjs`, and `sw.js`:
  passed.
- Local HTTP smoke test: API responses are non-cacheable, `X-Powered-By` is
  absent, CSP includes `form-action 'self'`, and oversized JSON returns `413`.
- `npx cap sync`: passed for iOS and Android. An iOS simulator build, including
  the local StoreKit bridge, passed. Android Gradle reached dependency resolution
  with Java 21 but could not compile because the Android SDK is not installed on
  this Mac.
- Supabase migration history and security advisors were rechecked after the four
  July 18 migrations and Auth configuration changes. The only remaining advisor
  notices are informational RLS-with-no-policy entries for deliberate server-only
  tables.

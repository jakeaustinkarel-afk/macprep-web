# MACPrep Security Review - 2026-07-23

## Scope and limits

This point-in-time review covered the Express API, browser and service-worker
code, Capacitor purchase bridges, Supabase tables, RLS, grants and functions,
Stripe and native purchase flows, repository history, dependencies, CI,
production HTTP behavior, and operational configuration visible from the
repository and connected services.

It is not a guarantee that MACPrep has no vulnerabilities. App Store, Stripe,
Cloudflare, Render, and Supabase account settings that are not exposed to the
repository still require owner verification.

## Remediated in this release

### High

- Direct authenticated access to `program_vouchers` could let an ordinary
  account create a voucher and redeem premium access. Production now has no
  client policies or grants on the table, and the repository contains the same
  service-role-only baseline. Aggregate review found no non-owner voucher
  creation or claim evidence.
- A deprecated profile table held one non-empty value in a plaintext `password`
  column. The column was removed without reading the value, and production now
  has no remaining public-table column named `password`.
- Canonical questions and legacy learning functions are now explicitly
  service-role-only in both production and migration history. Answer keys remain
  behind server-side grading.

### Medium

- New cohort vouchers use 128 random bits instead of 32.
- Historical Stripe full-access Price IDs can be allowlisted through
  `STRIPE_FULL_ACCESS_PRICE_IDS`, allowing refunds for older prices to resolve to
  the correct entitlement.
- A delayed dispute win or refund reversal must now be confirmed against fresh
  provider state before access can reactivate.
- Stripe Checkout retries from the same account and product share a bounded
  idempotency key, reducing duplicate one-time charge races.
- Native purchase controls now remain unavailable when the corresponding server
  verifier is not configured. The next iOS bridge also leaves StoreKit
  transactions unfinished until MACPrep records the entitlement successfully.
- Account deletion now requires the current password in addition to an active
  session, and is protected by the shared authentication attempt ceiling.
- User-controlled specialty labels and server-provided card content no longer
  flow through the identified string-to-HTML print paths. Search wildcard
  escaping now also handles literal backslashes.
- Stripe, Apple, and Google provider webhooks now have a local resource ceiling
  in addition to their mandatory signature or identity verification.
- Weekly dependency audits, Dependabot updates, and CodeQL analysis are now
  versioned with CI. Third-party GitHub Actions are pinned to commit hashes.
- Local ignored credential files were changed from group/world-readable mode to
  owner-only mode.

## Unresolved findings

### High

1. `main` has no branch protection or repository ruleset even though production
   deploys from it. Require a pull request, passing CI and CodeQL, blocked force
   pushes, and restricted direct pushes before treating the deployment path as
   protected.
2. Older paid accounts were imported as `legacy` entitlements. Add every
   historical Stripe full-access Price ID to
   `STRIPE_FULL_ACCESS_PRICE_IDS`, backfill provider identifiers where possible,
   and reconcile those accounts against Stripe. The code fix cannot infer which
   legacy grants represent paid purchases.
3. The direct Render hostname is publicly reachable while Express trusts all
   forwarded proxy identities. This can bypass Cloudflare edge controls and
   weaken IP rate limits. Restrict the origin to Cloudflare and configure a known
   proxy topology before relying on forwarded IPs as an abuse boundary.
4. Production currently reports Apple and Google purchase verification as
   unconfigured. The new safety gate prevents an unverified charge attempt, but
   Apple purchase and restore controls will remain unavailable until the App
   Store verifier credentials and trust roots are configured in Render. Resolve
   this before App Review.

### Medium

5. Admin and faculty authorization does not require MFA/AAL2. Enroll every
   privileged account first, then enforce AAL2 and recent step-up authentication
   on privileged reads and mutations.
6. Existing unclaimed eight-hex-character voucher codes remain shorter than the
   new format. Do not invalidate distributed codes blindly; inventory each
   cohort, replace undistributed codes, and expire old codes after a communicated
   transition.
7. Approximately 1,180 dependency files remain tracked under `node_modules`.
   Remove that tree from Git in a dedicated change after preserving any genuine
   local edits, then make CI reject tracked dependency directories.
8. Historical repository contents included a Supabase privileged key and Stripe
   test key. The exposed key values now return unauthorized, but the historical
   Stripe webhook secret cannot be tested remotely. Confirm it was rotated, then
   purge the secrets from all public refs.
9. The migration directory still begins from historical production objects
   rather than a complete clean-database baseline. The critical question,
   voucher, entitlement, and learning boundaries reviewed here are now
   versioned, but a protected staging restore must prove the entire schema can be
   reconstructed before disaster recovery is considered tested.

### Low / defense in depth

10. The CSP still permits inline scripts. The CodeQL-identified stored-content
   and print-document paths were removed, and authentication cookies are not
   JavaScript-readable, but moving inline handlers into modules is required
   before removing `script-src 'unsafe-inline'`.
11. Static marketing pages inside the native WebView can still mention Stripe
    web terms. Open those pages externally or make their payment copy
    native-aware before Android submission.

## Verification evidence

- Root and mobile dependency audits: zero known vulnerabilities at all
  severities.
- Gitleaks worktree and full-history scans completed. Current tracked source has
  no live credential files; ignored local credentials and historical findings
  were classified separately.
- Supabase security advisor: no warning or error findings. Remaining notices are
  informational `rls_enabled_no_policy` entries for deliberate deny-by-default
  server tables:
  <https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy>
- Production checks confirmed security headers, non-cacheable API responses,
  blocked cross-origin cookie mutations, protected admin/user routes, and `404`
  responses for `.env`, `package.json`, server source, migrations, and private
  data paths.
- Production database checks confirmed no anonymous/authenticated access to
  questions, vouchers, or legacy learning functions; the service role retains
  required access.
- JavaScript syntax checks, all 74 Node tests, Capacitor sync, and the iOS
  simulator build passed. Android compilation could not run because this Mac has
  no Java runtime; the unchanged Android purchase bridge remains covered by
  source tests and the mobile dependency audit, but a Gradle build is still a
  residual verification gap.
- Post-deploy production probes confirmed the new build marker and release notes.
  Native purchase verification intentionally reports unavailable until the
  corresponding Store verifier credentials are configured in production.

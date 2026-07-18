# MACPrep Backlog

Last reviewed: 2026-07-18.

## Ready To Execute

- [x] Applied the 2026-07-17 rollup and account-deletion migration series to the linked Supabase project, deployed matching server build `session-rollups-20260717.1`, and ran database advisors plus production smoke checks.
- [ ] Pull the reviewed historical Supabase baseline into version control with `supabase db pull`. The live schema predates this repo's migration history; do not fabricate it from code.
- [ ] Add a protected staging environment with a Stripe test webhook secret and seeded Supabase data, then add an end-to-end signed webhook test.
- [x] Captured `EXPLAIN (ANALYZE, BUFFERS)` for benchmark, cohort, leaderboard, and bounded served-question selection on 2026-07-17.
- [x] Applied atomic mock-exam, entitlement-ledger, transactional review/learning, and distributed-rate-limit migrations to the linked Supabase project on 2026-07-18.
- [x] Moved browser authentication to HttpOnly cookies, enabled 12-character and leaked-password protections in Supabase Auth, and added CSRF/static-surface regression coverage.
- [x] Added CI, browser/native capability handshakes, idempotent purchase reconciliation, and latest-response practice/peer metrics with minimum sample thresholds.

## Next Engineering Slice

- [ ] Split `src/server.mjs` by responsibility: auth/billing, question delivery/grading, profile/learning analytics, faculty reporting, and notifications.
- [ ] Split `src/app.js` into feature modules after validating the session-delivery API on staging. Preserve its no-full-bank-in-browser rule.
- [ ] Move the server-side proportional mock sampler into a database function once live query plans justify it, while preserving the no-full-bank-in-browser rule.

## Maintenance

- [ ] Deploy the Firebase Admin major upgrade and validate Android push in staging before promoting to production.
- [ ] Review Capacitor patch releases and run `npx cap sync` plus native build checks before store submission.
- [ ] Re-run `npm audit --omit=dev` after every dependency update and keep lockfiles committed.
- [ ] Revisit `node_modules/.package-lock.json` only when installing dependencies; it is generated state, not a source artifact.

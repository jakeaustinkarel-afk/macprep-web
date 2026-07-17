# MACPrep

MACPrep is a board-review application for anesthesiologist assistants. It provides cited, clinician-reviewed question sessions, server-side grading, progress analytics, spaced repetition, mock exams, cohort reporting, and a Capacitor shell for iOS and Android.

## Architecture

- `src/server.mjs`: Express API, Supabase/Auth integration, Stripe web checkout, grading, admin/faculty endpoints, and static-file policy.
- `src/app.js`: browser application controller. It holds only the active study set; it does not download the full question bank.
- `supabase/migrations/`: versioned database changes. Apply the migration before deploying a server that calls its RPCs.
- `mobile/`: Capacitor native shell that loads `https://www.macprep.org`.
- `docs/codex/PROJECT_CONTEXT.md`: durable product, operational, and safety context migrated from Claude.

Read [AGENTS.md](AGENTS.md) and [docs/codex/PROJECT_CONTEXT.md](docs/codex/PROJECT_CONTEXT.md) before changing behavior that touches clinical content, billing, question access, or native purchase flows.

## Local Development

```bash
npm install
npm start
```

The server starts at `http://localhost:3000`. Copy `.env.example` to `.env` and supply only development credentials. Never commit `.env`, Supabase service-role keys, Stripe secrets, APNs keys, or Firebase credentials.

## Checks

```bash
npm test
node --check src/server.mjs
node --check src/app.js
npm run build
```

The test suite is local and does not start a listener, call Stripe, or require a Supabase project. It covers the served-content grading gate, paginated PostgREST reads, account-deletion failure propagation, and the required database rollup contract.

## Database Deployment

The server now depends on the 2026-07-17 rollup migration series in `supabase/migrations/`: `20260717200046_database_contract_and_rollups.sql` plus the two `fix_account_deletion_*` follow-ups. Together they add the indexes and service-role-only database functions used for SAA benchmarks, faculty cohort analytics, leaderboard rollups, and transactional account deletion.

Deploy in this order:

1. Review and apply the migration to the linked Supabase project.
2. Run `supabase db advisors` and inspect the suggested security/performance fixes.
3. Deploy the matching server build.
4. Verify `/api/health`, a grade request for a published question, profile metrics for an account with more than 1,000 attempts, and faculty/leaderboard views.

For a greenfield Supabase project, first obtain a reviewed schema snapshot from the existing project with `supabase db pull`; the historical live schema predates this repository's migration history. The versioned migration above is additive and deliberately does not guess at unverified production columns or clinical question data.

## Product Rules

- Serve only published questions in production (`SERVE_PUBLISHED_ONLY=true`, `SERVE_FILLER=false`).
- Never expose answer correctness before `/api/grade` has graded a submission.
- Native apps must not open Stripe checkout or display external purchase flows.
- Clinical content remains cited and clinician-reviewed before publication.
- Program director/faculty access is not site-admin access.

## Mobile

```bash
cd mobile
npm install
npx cap sync
npx cap open ios
npx cap open android
```

See [mobile/README.md](mobile/README.md) and [STORE-SUBMISSION.md](STORE-SUBMISSION.md) for store-specific steps.

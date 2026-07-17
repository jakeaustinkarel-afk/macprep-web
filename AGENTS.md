# MACPrep Codex Context

Jake is the owner/founder. Treat MACPrep as the active project when working in this repository.

## Product

MACPrep is a board-review product for Certified Anesthesiologist Assistants (CAAs) and student anesthesiologist assistants (SAAs) preparing for NCCAA certification and recertification. The public site is `https://www.macprep.org`.

Core positioning:
- Built for CAAs/SAAs, not recycled nurse-anesthesia content.
- Every published question should be clinician-reviewed, blueprint-tagged, and cited.
- The strongest differentiation is verifiable sourcing, per-choice rationales, and transparent CAA review.
- The exam-prep product is currently positioned as a one-time $100 lifetime purchase. Web uses Stripe; native apps use the approved one-time Store product with server-side verification. Both grant the same account entitlement. Do not add Stripe purchase paths inside native apps.

## Stack

- Backend: Express in `src/server.mjs`.
- Frontend: vanilla HTML/CSS/JS, mainly `index.html`, `styles.css`, and `src/app.js`.
- Database/auth: Supabase Auth and Postgres.
- Payments: Stripe Checkout plus a single webhook route at `POST /api/webhooks/stripe`; verified native Store purchases use `POST /api/mobile-purchases/verify`.
- Hosting: Render for the web server.
- Mobile: Capacitor app in `mobile/` that loads `https://www.macprep.org`.
- Monitoring: Sentry if `SENTRY_DSN` and `SENTRY_BROWSER_DSN` are configured.
- Notifications: Web Push via VAPID; native push via APNs for iOS and FCM for Android.

## Canonical Docs

Read these before substantial product or architecture work:
- `docs/codex/PROJECT_CONTEXT.md` - Codex-ready project context.
- `docs/codex/CLAUDE_TO_CODEX_MIGRATION.md` - how to import Claude context safely.
- `BLUEPRINT.md` - question-bank blueprint and authoring quality standard.
- `AUDIT.md` - technical/product audit and fix history.
- `PUSH-SETUP.md` - web/native push setup.
- `STORE-SUBMISSION.md` - App Store and Play Store submission kit.
- `brand/BRAND.md` - brand mark, color, and usage rules.
- `mobile/README.md` - Capacitor mobile shell notes.

## Important Tables And Content Gates

The canonical profile table is `user_profiles`, keyed to Supabase auth by `user_id`.

Question-serving rules in `src/server.mjs`:
- `SERVE_PUBLISHED_ONLY=true` means public users only see `status='published'`.
- `SERVE_PUBLISHED_ONLY=false` allows `sme_review` and `published` for private preview.
- `SERVE_FILLER=false` keeps legacy unreviewed filler out of served content.

Do not bypass the server to expose answer keys. The client should never receive correctness flags before grading.

## Secrets

Never commit `.env`, service-role keys, Stripe secrets, Firebase service accounts, APNs `.p8` files, or raw Claude exports. Raw Claude exports belong in the ignored `local/claude-export/` folder and should be distilled into committed docs only after redaction.

## Development Commands

- Install web dependencies: `npm install`
- Run web server: `npm start`
- Syntax check backend: `node --check src/server.mjs`
- Syntax check frontend controller: `node --check src/app.js`
- Install mobile dependencies: `cd mobile && npm install`
- Sync native projects: `cd mobile && npx cap sync`

## Working Style

- Jake is a practicing CAA and MACPrep's founder. Treat his clinical judgment as product credibility, but do not assume that a clinical-adjacent expansion is automatically the right business move.
- Be truth-first: distinguish confirmed facts, inferences, and recommendations. Say when the evidence is insufficient, and give candid pushback rather than automatic agreement.
- Do not take external action, including sending, posting, scheduling, or changing third-party accounts, without Jake's explicit approval.
- Preserve clinical credibility. Do not mass-publish generated medical questions without SME review.
- Preserve App Store compliance. Web purchases are fine; native apps must not route users to Stripe or external digital-purchase links.
- Keep MACPrep focused on the AA professional lifecycle. Do not default to generic test prep, a broad AI question bank, or CRNA/SRNA expansion; see `docs/codex/PROJECT_CONTEXT.md` for the current strategic boundaries.
- Prefer small, verifiable changes. Run syntax checks after touching JS.
- Existing uncommitted work may be Jake's or imported from Claude. Do not overwrite or revert it unless Jake explicitly asks.

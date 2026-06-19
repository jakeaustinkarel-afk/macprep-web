# MACPrep — Technical & Product Audit

_Prepared June 19, 2026. Based on a full read of the codebase in `macprep-web` and read-only introspection of the live Supabase database._

This document is the master list of what's broken and how to fix it, ranked by severity. Items marked **[VERIFIED]** were confirmed directly against the live database or by reading the executing code path, not inferred.

---

## TL;DR

The stack (Express + Supabase + Stripe on Render) is a reasonable foundation, but the app is **not currently functional or safe to charge money on**. Three things are simultaneously true:

1. **Users cannot log in** — the login endpoint the frontend calls doesn't exist.
2. **Paying customers receive nothing** — the payment webhook writes premium status to a database table (`profiles`) that does not exist.
3. **The premium product is free and exposed** — the question API returns the entire bank, including correct answers, to anyone, with no authentication.

On top of that, the question content itself is mass-generated boilerplate with no real clinical substance, which is the deepest problem because it's the actual product.

---

## Severity 1 — Critical (product-breaking / revenue-losing / legal exposure)

### 1.1 Paying customers are never upgraded — webhook writes to a non-existent table **[VERIFIED]**
`src/server.mjs` reads and writes a table called `profiles` (webhook handler and both profile endpoints). The live database has **no `profiles` table** — the equivalent table is `user_profiles`. Result: when Stripe fires `checkout.session.completed`, the `UPDATE/INSERT ... profiles` call errors, the handler returns HTTP 500, and the user's `is_premium` flag is never set. **A customer can pay $50 and get nothing.** This is both a revenue bug and a chargeback/consumer-protection risk.
**Fix:** point all profile reads/writes at `user_profiles`, key them on the Supabase Auth user id (not email), and add a reconciliation path so a paid-but-not-upgraded user can be repaired.

### 1.2 Login is impossible — the endpoint doesn't exist **[VERIFIED]**
`src/app.js` `executeLoginSubmission()` POSTs to `/api/auth/login`. **No such route exists** in `server.mjs`. The only auth route, `/api/auth/register`, just `res.redirect('/index.html?registered=true')` — it never creates a user, stores a password, or starts a session. There is no authentication system at all: no password hashing, no Supabase Auth calls, no sessions/JWT.
**Fix:** implement real authentication via Supabase Auth (`signUp` / `signInWithPassword`), with the session token used to authorize subsequent API calls.

### 1.3 The entire premium bank is free and the answers leak **[VERIFIED]**
`GET /api/questions` runs `supabase.from('questions').select('*')` and returns every row — **3,514 questions** including the `correct_answer` column — to any unauthenticated visitor. The "free tier limit" of 100 lives only in browser JavaScript (`FREE_TIER_CEILING` in `app.js`). Anyone can open dev tools, call `/api/questions` directly, and get the whole paid product with answers attached.
**Fix:** never send `correct_answer` (or `choices[].correct`) to the client. Grade server-side. Enforce the free/premium boundary on the server based on the authenticated user's `is_premium` flag.

### 1.4 The quiz never grades answers or shows explanations **[VERIFIED]**
`handleSelectionEvent()` increments a counter and advances. It never checks correctness, never marks right/wrong, never shows the explanation (which the data contains), and never records performance. It also reads `currentQuestion.correct_answer || currentQuestion.answer`, but in the data correctness lives in `choices[].correct` and the DB column `correct_answer`. The core study loop does nothing.
**Fix:** grade the selection, show correct/incorrect state, reveal the explanation, and persist progress to `user_profiles`.

### 1.5 Question content is templated filler, not real medicine **[VERIFIED]**
Representative live answer choices: _"Administer rapid first-line pharmacological treatment protocols"_, _"A sudden decrease in core tympanic temperature profile metrics"_, with rationales like _"This choice perfectly updates standard algorithms... documented in peer literature."_ Distractors describe themselves as _"a psychometric trap."_ None of it contains decision-relevant clinical content. CAAs/SAAs are trained clinicians and will recognize this immediately; shipping it would destroy credibility and invite refund demands.
**Fix:** treat the current bank as scaffolding only. Author real, sourced questions against a defined blueprint (see §5). This requires subject-matter expertise and cannot be safely auto-generated at scale.

---

## Severity 2 — High (security)

### 2.1 Profile endpoints have zero authentication **[VERIFIED]**
`GET /api/user/profile?email=` and `POST /api/user/profile` accept an email in the query/body and read or upsert that profile with no auth check. Anyone can read or overwrite any user's profile (including flipping fields) by supplying an email. Identity must come from a verified session token, never from a client-supplied parameter.

### 2.2 Duplicate, broken Stripe webhook handlers **[VERIFIED]**
Two handlers exist: `/api/webhooks/stripe` (line ~28, correct — registered before `express.json()` with `express.raw`) and `/api/webhook/stripe` (line ~220, registered **after** `express.json()`). Express will have already consumed/parsed the body, so the second handler's signature verification (`constructEvent`) will fail on real traffic. Two endpoints also means two URLs that could be configured in the Stripe dashboard, only one of which works.
**Fix:** keep exactly one webhook route, registered before the JSON body parser, and make sure the Stripe dashboard points at it.

---

## Severity 3 — Medium (correctness, consistency, maintainability)

### 3.1 Table-name and schema chaos **[VERIFIED]**
The code references four different tables inconsistently:
- `profiles` — used by `server.mjs`; **does not exist**.
- `user_profiles` — the real profile table (used by `seed_mock_cohort.mjs`).
- `questions` — 3,514 rows; what the live server actually serves.
- `macprep_questions` — 2,501 rows, a separate, richer schema ("premium blueprint").

There are effectively **two question tables** and the seed scripts disagree on which is canonical. Pick one source of truth for questions and one profile table, and delete/rename the rest.

### 3.2 Two conflicting payment paths **[VERIFIED]**
The paywall button in `app.js` hardcodes a Stripe Payment Link (`buy.stripe.com/...$50`), while `server.mjs` also exposes `POST /api/create-checkout-session` using `STRIPE_PRODUCTION_PRICE_ID` — an env var that isn't documented in `.env.example`. Decide on one checkout method so price changes and webhooks stay consistent.

### 3.3 Routes defined after `app.listen()` **[VERIFIED]**
`/api/create-checkout-session`, the second webhook, and `/api/auth/register` are declared after the server starts listening (line ~180). It works in Express but is disorganized and error-prone. Define all routes before `listen()`.

### 3.4 Unlabeled question metadata **[VERIFIED]**
In the 2,500-row source payload, ~1,500 questions have `specialty: "?"`. Questions can't be filtered or blueprinted by specialty until this is fixed.

---

## Severity 4 — Low (hygiene)

- **Dead scaffolding:** `App.tsx` and `.expo/` are leftover React Native/Expo files; the real app is vanilla HTML/JS served by Express. Remove to avoid confusion. **[VERIFIED]**
- **Junk files:** several `.rtf` duplicates (`styles.css.rtf`, `src/app.js.rtf`, `data/data:questions.json.rtf`, etc.) and a `data:questions.json.rtf` with an illegal `:` in the name. Delete. **[VERIFIED]**
- **7 MB `questions.json` committed** even though the database is the source of truth. Keep one canonical copy or move to a `seeds/` folder excluded from the served static root. **[VERIFIED]**
- **Commit history shows churn:** messages like "nuked and paved", "aggressively bound", "hardwired" indicate repeated band-aid fixes rather than root-cause fixes — consistent with the structural problems above. **[VERIFIED]**
- **Verbose cosmetic naming** ("Hardened Cluster", "high-clearance", "matrix") adds no function and obscures intent.

---

## Severity 5 — Product / content strategy

The question bank is the product. A credible board-prep bank for SAAs/CAAs needs, per item: a realistic clinical stem, plausible distractors that map to genuine misconceptions, a teaching explanation, and a citation to a defensible source (textbook/guideline). None of that exists yet.

**Recommended structure (a blueprint to author against):**
- **Tracks:** Initial Certification (NCCAA) vs. Continued Demonstration of Qualifications (recert).
- **Content domains** (align to the official content outline): anatomy & physiology, pharmacology, anesthesia equipment & physics, monitoring, general/regional/neuraxial techniques, subspecialties (cardiac, neuro, OB, pediatric, regional, ambulatory, pain), patient safety/crisis management, and professional issues.
- **Per-question record:** `domain`, `subtopic`, `difficulty`, `stem`, `choices[]` (4–5), `correct`, `explanation`, `source` (citation), `references[]`.

**Honest constraint:** I can build the blueprint, schema, authoring template, relabel derivable specialties, and write a few genuinely substantive example questions to set the quality bar — but authoring thousands of medically accurate, citable questions requires clinical SME review. I won't fabricate medical facts at scale.

---

## Recommended order of operations

1. **Stop charging until 1.1–1.3 are fixed** — right now someone can pay and get nothing while someone else gets everything free.
2. Fix grading + explanations (1.4) — makes the app actually usable.
3. Move the paywall and answer-stripping server-side (1.3) + secure profile endpoints (2.1).
4. Implement real auth (1.2).
5. Consolidate webhooks and checkout (2.2, 3.2) and fix the table-name mess (3.1).
6. Clean up hygiene (§4).
7. Begin the real content build against the blueprint (§5) — the longest-running track; start in parallel.

---

## Notes on testing & deployment

- The local `.env` contains only `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The `SUPABASE_SERVICE_ROLE_KEY` and Stripe keys live only on Render, so payment/admin flows can't be fully tested from a local checkout.
- No code in this audit has been deployed. Changes should be reviewed and tested in a staging context before pushing to GitHub/Render.

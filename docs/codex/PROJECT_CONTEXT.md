# MACPrep Project Context

Last updated by Codex: 2026-07-17.

This file is the durable Codex handoff for MACPrep. It summarizes the repository, product stance, operational constraints, and the project context that used to live mostly in Claude conversations.

## One-Line Product

MACPrep is an NCCAA board-review app for CAAs and SAAs: cited questions, per-choice rationales, mock exams, spaced repetition, flashcards, Critical Events, progress analytics, and cohort/program support.

## Product Positioning

Primary audience:
- Student anesthesiologist assistants preparing for initial NCCAA certification.
- Practicing CAAs maintaining readiness and, later, recertification/CME.
- Program directors who can buy or sponsor cohort access.

Core promise:
- Board prep built for CAAs, not adapted from CRNA material.
- Questions are mapped to the NCCAA content blueprint.
- Published questions should be clinician-reviewed, cited, and written with rationales for every answer choice.

Defensible wedge:
- Verifiable source transparency.
- Per-choice teaching rationales.
- Practicing CAA review and ownership.
- Low-friction pricing compared with subscription competitors.

Current price stance:
- Exam-prep access is a one-time $50 lifetime web purchase.
- There is a rotating 20 percent referral/promo code path in the server.
- Native apps should reflect already-paid account status and must not send users to external Stripe checkout.
- Do not introduce a subscription by default. Jake prefers a one-time purchase; testing a higher lifetime price, such as $100, is a future business decision rather than a current pricing change.

Support/contact:
- Support email used throughout docs and app copy: `support@macprep.org`.
- Public domain: `https://www.macprep.org`.

## Architecture

Web app:
- Express server: `src/server.mjs`.
- Browser controller: `src/app.js`.
- Static pages: root `*.html`.
- Styles: `styles.css`.
- Service worker/offline shell: `sw.js`, `offline.html`.

Backend services:
- Supabase Auth for account signup/signin/session refresh.
- Supabase Postgres for profiles, questions, progress, review state, vouchers, feedback, analytics, notifications, and related product state.
- Stripe Checkout for web purchases.
- Stripe webhook: `POST /api/webhooks/stripe`, registered before JSON parsing.
- Render hosts the production server.
- Sentry is optional and controlled by env vars.
- Resend email nudges are dormant unless `RESEND_API_KEY` is configured.
- Web Push is dormant unless VAPID keys are configured.
- Native Push is dormant unless APNs and/or Firebase credentials are configured.

Mobile:
- Capacitor project in `mobile/`.
- Bundle/app ID: `org.macprep.app`.
- Native shell loads `https://www.macprep.org`, so most web/content changes ship without store review.
- Native changes such as plugins, capabilities, icons, permissions, or splash screens require a new App Store / Play Store build.

## Key Runtime Rules

Profiles:
- Canonical table: `user_profiles`.
- It links to Supabase Auth by `user_id`.
- Premium status uses `account_tier='premium'` plus `premium_unlocked_at`.

Question gates:
- Public production should run with `SERVE_PUBLISHED_ONLY=true`.
- `SERVE_PUBLISHED_ONLY=false` is for private preview of `sme_review` questions.
- `SERVE_FILLER=false` keeps unreviewed legacy filler out of served content.
- Client responses must not expose `correct_answer` or `choices[].correct`.
- Grading is server-side through `/api/grade`.

Static file safety:
- `src/server.mjs` blocks direct static serving of source, data, seeds, docs, envs, SQL, CSV, PDFs, and similar sensitive/internal assets.

Admin:
- Site admin is email-allowlisted by `ADMIN_EMAILS`.
- Program director/faculty permissions should not imply site-admin permissions.
- App review/demo accounts are controlled by `REVIEW_EMAILS`.

## Environment Variables

Required in production:
- `NODE_ENV=production`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRODUCTION_PRICE_ID`

Important optional/config vars:
- `STRIPE_AUTOMATIC_TAX`
- `STRIPE_REFERRAL_COUPON_ID`
- `ALLOWED_HOSTS`
- `PUBLIC_BASE_URL`
- `ADMIN_EMAILS`
- `REVIEW_EMAILS`
- `SERVE_PUBLISHED_ONLY`
- `SERVE_FILLER`
- `SENTRY_DSN`
- `SENTRY_BROWSER_DSN`
- `RESEND_API_KEY`
- `RESEND_FROM`
- `MAILING_ADDRESS`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`
- `FIREBASE_SERVICE_ACCOUNT`
- `APNS_KEY_P8`
- `APNS_KEY_ID`
- `APPLE_TEAM_ID`
- `APNS_BUNDLE_ID`
- `APNS_PRODUCTION`

Never commit secrets. `.env`, native push credentials, Firebase service accounts, APNs keys, and private legal/tax documents are ignored.

## Canonical Product Docs

- `BLUEPRINT.md`: NCCAA question-bank blueprint, domain weights, authoring schema, quality rubric, serving gates, and authored batch status.
- `AUDIT.md`: product/technical audit with prior critical issues and resolution log.
- `STORE-SUBMISSION.md`: App Store and Play Store listing copy, review notes, privacy answers, screenshots, and submission runbook.
- `PUSH-SETUP.md`: web push and native push architecture and credential checklist.
- `mobile/README.md`: native shell setup, mobile commands, and store/build implications.
- `brand/BRAND.md`: pulse-tile brand mark, color tokens, typography, and usage rules.
- `brand/IMPLEMENTATION.md`: website and Stripe brand rollout details.
- `marketing/competitive-vigilant-iq.md`: primary competitor brief.
- `marketing/program-outreach/README.md`: program-director cohort-license campaign.
- `marketing/partnerships/state-academies/README.md`: state-academy member-benefit campaign.
- `marketing/cme-compliance-checklist.md`: CME governance standard.
- `marketing/cme-opportunity.md`: CME market/opportunity analysis and pricing stance.

## Content Strategy

The question bank is the product. Legacy filler exists as scaffolding only and should not be treated as publishable clinical content.

Publishing standard:
- Plausible clinical stem.
- One defensibly correct answer.
- Distractors map to real misconceptions.
- Explanation teaches the concept and addresses distractors.
- At least one defensible citation.
- Blueprint domain and subtopic tags.
- SME/clinician review before `published`.

Domain blueprint from `BLUEPRINT.md`:
- Principles of Anesthesia: about 9 percent.
- Physiology, Pathophysiology and Management: about 19 percent.
- Instrumentation, Monitoring and Anesthetic Delivery Systems: about 15 percent.
- Subspecialty Care: about 31 percent.
- Pharmacology: about 15 percent.
- Regional Anesthesia and Pain Management: about 8 percent.

## Growth And Business Context

Strategic boundaries:
- Do not dilute MACPrep into a generic AI question bank or standardized-test-prep product. The defensible value is AA-specific clinical judgment, trusted source trails, and question quality.
- Do not default to CRNA/SRNA expansion. Jake has identified CAA/CRNA political friction as a reason not to pursue that direction.
- The broader expansion concept is the AA professional lifecycle: aspiring-AA preparation and interview/readiness resources, SAA board prep, then practicing-CAA recertification resources, CME, and eventual job-resource referrals. This is an explored direction, not an approved build roadmap.
- A CAA CME collaboration with Patrick Flaherty is being explored. Confirm scope, commercial terms, accredited-provider requirements, and compliance before making public claims or implementing related flows.
- A later jobs-resource referral to BagMask has been discussed; it is not a commitment to build a job board.

Program outreach:
- Program directors are the highest leverage exam-prep sales channel.
- Start with verified contacts, warm introductions, Georgia/home-turf programs, and high-volume programs.
- Lead with pass-rate support, teaching value, free pilots, and credibility.

State academy partnerships:
- Offer academy-specific member benefit codes.
- The economic wedge is a low one-time lifetime price compared with recurring subscriptions.
- Do not bash competitors; win on value and transparency.

CME:
- Long-term opportunity for CAA recertification education. Do not presume a subscription model.
- MACPrep is not an accredited CME provider; use joint providership with an ACCME-accredited provider.
- CME content must be independent education, not product promotion.
- Do not launch CME without partner compliance signoff, disclosures, records, post-test, evaluation, certificate, and NCCAA Category I - Anesthesia fit.

Competitor:
- Vigilant IQ is the primary direct competitor.
- They also have CAA founder credibility, spaced repetition, analytics, mock exams, and CME, so do not position features alone as the wedge.
- Position MACPrep around transparency, sourcing, per-choice rationales, quality, and price clarity.

## App Store And Play Store Constraints

Native app purchase rule:
- Hide upgrade/pricing CTAs in native apps.
- Do not open Stripe from the native app.
- Free users can use the free tier; locked premium features should not include external purchase paths in native.

Submission needs:
- Demo account with premium unlocked.
- Screenshots from a clean account with some activity.
- Support URL selected and working.
- Privacy answers match actual data collection.
- `APNS_PRODUCTION=true` for TestFlight/App Store production push tokens.

## Common Commands

```bash
npm install
npm start
node --check src/server.mjs
node --check src/app.js
```

Mobile:

```bash
cd mobile
npm install
npx cap sync
npx cap open ios
npx cap open android
```

## Open Migration Items

Use `docs/codex/CLAUDE_TO_CODEX_MIGRATION.md` to bring in any Claude-only context that is not already represented here.

High-value Claude imports to look for:
- Current unfinished task list.
- Last deployed commit/build and deploy status.
- Store-submission status and exact blockers.
- Supabase schema notes not captured in migrations/docs.
- Stripe product/price/webhook setup notes.
- Any current Claude plans around mobile native push, IAP compliance, or app review.
- Marketing calendars, outreach replies, and partnership commitments.
- Raw business decisions that are only in chat.

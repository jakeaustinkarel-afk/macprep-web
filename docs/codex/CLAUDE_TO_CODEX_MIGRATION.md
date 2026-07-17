# Claude To Codex Migration Runbook

Use this to move MACPrep context from Claude into Codex without losing decisions or leaking secrets.

## Goal

Codex should be able to continue MACPrep work from this repository alone:
- Product and technical context live in committed docs.
- Raw Claude exports stay local and ignored.
- Secrets remain in secret stores, not in chat transcripts or git.
- Outstanding tasks are converted into explicit files/issues rather than scattered conversation history.

## What Is Already In This Repo

Codex-readable context now exists in:
- `AGENTS.md`
- `docs/codex/PROJECT_CONTEXT.md`
- `BLUEPRINT.md`
- `AUDIT.md`
- `PUSH-SETUP.md`
- `STORE-SUBMISSION.md`
- `brand/`
- `mobile/README.md`
- `marketing/`

Claude-local config exists in:
- `.claude/settings.local.json`
- `.claude/launch.json`

The `.claude/` files are useful for reconstructing prior permissions and launch helpers, but they are not the actual product brain.

## Safe Raw Export Location

Put raw Claude exports here:

```text
local/claude-export/
```

That folder is ignored by git. It can contain conversation exports, project instructions, copied chat snippets, screenshots, and temporary notes.

Suggested filenames:
- `project-instructions.md`
- `open-tasks.md`
- `recent-conversations.md`
- `deployment-notes.md`
- `supabase-notes.md`
- `stripe-notes.md`
- `mobile-store-notes.md`
- `marketing-decisions.md`

## Export Checklist From Claude

Bring over these categories:

1. Project instructions
   - Claude Project custom instructions.
   - Any style rules, product rules, or "always remember" notes.
   - Tool assumptions or environment notes.

2. Current task state
   - Active task list.
   - Last thing Claude was doing.
   - Anything half-implemented or pending review.
   - Any deployment or app-store blocker.

3. Product decisions
   - Pricing.
   - Positioning.
   - Product promises and non-negotiables.
   - Competitor positioning.
   - CME partnership stance.

4. Technical decisions
   - Supabase schema decisions.
   - Stripe checkout/webhook decisions.
   - Render env var choices.
   - Auth, paywall, grading, and content-serving gates.
   - Mobile/native push decisions.

5. Operations
   - App Store / Play Store status.
   - Render deploy status.
   - Stripe account/product/price status.
   - Supabase migration status.
   - Sentry/Resend/push status.

6. Marketing and business
   - Outreach status.
   - Contacts and replies.
   - Partnership commitments.
   - Social calendar and post status.
   - Any promises already made to programs, academies, or partners.

## Redaction Checklist

Before anything is committed or pasted into a long-lived doc, remove:
- Supabase service-role keys.
- Stripe secret keys, webhook secrets, restricted keys, and session IDs.
- APNs `.p8` private key contents.
- Firebase service-account JSON.
- Render secret values.
- Private customer/user data.
- Private contact details unless they already belong in intentional outreach CSVs.
- Legal, tax, banking, and identity documents.
- Claude or browser cookies/tokens.

Secrets should live in Render, Supabase, Stripe, Firebase, Apple, Google, or a password manager - not in repo docs.

## Distillation Process

For each Claude export:

1. Save the raw export in `local/claude-export/`.
2. Skim for decisions, tasks, credentials, and user/private data.
3. Redact secrets in any distilled summary.
4. Move durable project facts into `docs/codex/PROJECT_CONTEXT.md`.
5. Move tactical tasks into a dated file under `docs/codex/`, or into an issue tracker if one is introduced.
6. Delete or archive raw exports only after their useful content is captured.

Use this format for distilled notes:

```markdown
## Topic

Source: Claude export filename, date if known.

Decision:
- ...

Rationale:
- ...

Follow-up:
- ...
```

## Suggested First Import Pass

Start with the highest-risk areas:

1. Store submission and mobile app review state.
2. Payment, Stripe, and webhook setup.
3. Supabase schema/migration state.
4. Current content bank status and review gates.
5. Outreach commitments or replies.
6. Any current Claude task list.

## Claude Subscription Cancellation

Do this only after exports are saved and distilled.

Official Anthropic/Claude references checked 2026-07-17:
- Data export: `https://support.claude.com/en/articles/9450526-export-your-claude-data`
- Memory export: `https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude`
- Pro/Max cancellation: `https://support.claude.com/en/articles/8325617-cancel-your-pro-or-max-subscription`
- Team cancellation: `https://support.claude.com/en/articles/9267323-cancel-your-organization-s-team-plan-subscription`
- Refunds: `https://support.claude.com/en/articles/12386328-requesting-a-refund-for-a-paid-claude-plan`

Export first:

1. Claude web or Claude Desktop: initials/name in lower left -> Settings -> Privacy -> Export data.
2. Wait for the export email and download the file while the link is still valid.
3. If Claude memory is enabled, export memory too:
   - New memory experience: Settings -> Memory.
   - Legacy memory experience: Settings -> Capabilities -> Memory -> View and edit your memory.
   - You can also ask Claude to write out its memories verbatim and save the output locally.
4. Save exports under `local/claude-export/`.
5. Distill the useful, redacted parts into committed docs.

Cancel after export:

1. If you bought Pro/Max on Claude web or Claude Desktop: initials/name in lower left -> Settings -> Billing -> Cancel.
2. If you subscribed through iOS: Claude iOS -> initials in top right -> Billing -> Manage subscription, or cancel through Apple subscriptions.
3. If you subscribed through Android: Claude Android -> initials in top right -> Billing -> Manage subscription, or cancel through Google Play subscriptions.
4. If this is a Team plan: an Owner or Primary Owner cancels from Organization settings -> Billing.
5. Cancel at least 24 hours before the next billing date to avoid another renewal.
6. If requesting a refund, use Claude support: Get help -> Send us a message -> Claude Refund Request. Refund eligibility depends on plan, region, platform, and terms.

Do not cancel before confirming that any needed team/workspace data has been exported or copied.

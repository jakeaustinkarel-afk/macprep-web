# Database Contract

MACPrep uses Supabase Auth plus Postgres. The Express server uses a service-role client, so authorization must be enforced in application code before cross-user data is read or changed.

## Source Of Truth

The historical production schema was created before database migrations were committed to this repository. The additive 2026-07-17 migration series in `supabase/migrations/` is the current versioned performance and safety contract; apply every pending migration, including the `fix_account_deletion_*` follow-ups.

Before treating a fresh environment as reproducible, pull and review the existing schema with the Supabase CLI. Do not invent a greenfield baseline from product code or copy production data into source control.

```bash
supabase db pull macprep_baseline --linked --yes
supabase db advisors
supabase migration list --linked
```

Running those commands against the live project is an external operation and requires Jake's approval.

## Required Tables

| Area | Tables |
| --- | --- |
| Identity and access | `user_profiles`, `program_vouchers` |
| Question delivery and learning | `questions`, `user_progress`, `review_state`, `user_flags`, `user_flashcards`, `user_notes` |
| Cohort and social | `duels`, `reviews` |
| Product operations | `analytics_events`, `user_suggestions`, `question_edits` |
| Notifications | `push_subscriptions`, `native_device_tokens` |

The primary keys and foreign keys should be confirmed in the pulled baseline. At minimum, indexes must support `user_progress(user_id, created_at)` and the served-question filters in the migration.

## Required Functions

Existing application functions:

- `distinct_answered(p_user uuid)`: enforces the free-tier distinct-question count.
- `sm2_review(p_user uuid, p_question text, p_quality integer)`: persists spaced-repetition state.
- `founder_metrics(...)`: returns founder/admin metrics without client-side aggregation.

Functions added in the current migration:

- `macprep_saa_benchmark(text[])`: anonymized SAA domain benchmark.
- `macprep_faculty_cohort_rollup(text, text[], text[])`: a bounded cohort response for an already-authorized program.
- `macprep_program_counts()`: admin program switcher counts.
- `macprep_leaderboard_rollup(uuid, timestamptz, timestamptz)`: leaderboard event aggregates.
- `delete_macprep_account(uuid)`: transactional public-data and Auth deletion.

All added functions revoke access from `public`, `anon`, and `authenticated`, and grant execution only to `service_role`.

## Change Rules

- Add a migration for every schema, index, trigger, or database-function change.
- Prefer `security invoker` functions. Any `security definer` function must use an empty `search_path`, explicitly schema-qualify relations, and revoke default public execution.
- Enable RLS on exposed tables. Tables intended only for the server should use RLS with no public policy.
- Run `supabase db advisors` and an `EXPLAIN (ANALYZE, BUFFERS)` check for new high-volume access paths before release.

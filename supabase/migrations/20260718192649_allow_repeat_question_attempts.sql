-- A learner may legitimately answer the same question again in Review,
-- Recommended, Tutor, Arcade, or a later mock exam. The legacy uniqueness
-- constraint treated the second attempt as a database error. Keep every
-- attempt so spaced repetition and ability tracking can learn from it; the
-- newer submission-scoped unique index still makes mock-exam retries safe.

alter table public.user_progress
    drop constraint if exists unique_user_question;

-- Some older environments may have created the same rule as a standalone
-- unique index rather than a table constraint.
drop index if exists public.unique_user_question;

create index if not exists idx_user_progress_user_question
    on public.user_progress (user_id, question_id);

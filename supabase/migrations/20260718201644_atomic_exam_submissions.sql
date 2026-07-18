-- Give every exam submission a stable id so a network retry cannot duplicate
-- progress rows. A multi-row PostgREST upsert is one PostgreSQL statement: if a
-- free-tier trigger or any other constraint rejects one row, the whole exam
-- submission rolls back and no answer key is returned by the server.

alter table public.user_progress
    add column if not exists submission_id uuid;

create unique index if not exists idx_user_progress_submission_question
    on public.user_progress (user_id, submission_id, question_id);

comment on column public.user_progress.submission_id is
    'Idempotency key for an exam submission. Null for individually graded tutor attempts.';

-- Tie learner reports to the exact clinical revision they describe. Historical
-- free-form reports remain visible to admins but no longer flag newer revisions.

alter table public.user_suggestions
    add column if not exists kind text,
    add column if not exists question_id text,
    add column if not exists answer_revision integer,
    add column if not exists status text,
    add column if not exists resolved_at timestamptz;

update public.user_suggestions
set kind = coalesce(
        kind,
        nullif(substring(suggestion_text from '^\[([a-z_]+)\]'), ''),
        'suggestion'
    ),
    question_id = coalesce(
        question_id,
        nullif(substring(suggestion_text from 'Question[[:space:]]+([^[:space:]\[]+)'), '')
    ),
    status = coalesce(status, 'legacy')
where kind is null
   or status is null
   or (question_id is null and suggestion_text like '[question_report]%');

update public.user_suggestions
set kind = 'suggestion'
where kind not in ('suggestion', 'bug', 'question_report');

-- The old rollup parsed this prefix and treated every report as permanently
-- current. Keep the text for history while removing it from that legacy parser.
update public.user_suggestions
set suggestion_text = regexp_replace(
        suggestion_text,
        '^\[question_report\]',
        '[legacy_question_report]'
    )
where status = 'legacy'
  and suggestion_text like '[question_report]%';

alter table public.user_suggestions
    alter column kind set default 'suggestion',
    alter column kind set not null,
    alter column status set default 'pending',
    alter column status set not null;

alter table public.user_suggestions
    drop constraint if exists user_suggestions_kind_check,
    add constraint user_suggestions_kind_check
        check (kind in ('suggestion', 'bug', 'question_report')),
    drop constraint if exists user_suggestions_status_check,
    add constraint user_suggestions_status_check
        check (status in ('pending', 'resolved', 'legacy')),
    drop constraint if exists user_suggestions_question_revision_check,
    add constraint user_suggestions_question_revision_check
        check (
            kind <> 'question_report'
            or status = 'legacy'
            or (
                question_id is not null
                and answer_revision is not null
                and answer_revision > 0
            )
        );

create index if not exists idx_user_suggestions_current_question_reports
    on public.user_suggestions (question_id, answer_revision, created_at desc)
    where kind = 'question_report' and status = 'pending';

create or replace function public.resolve_macprep_superseded_question_reports()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.answer_revision is distinct from old.answer_revision then
        update public.user_suggestions
        set status = 'resolved',
            resolved_at = now(),
            suggestion_text = regexp_replace(
                suggestion_text,
                '^\[question_report\]',
                '[resolved_question_report]'
            )
        where kind = 'question_report'
          and status = 'pending'
          and question_id = new.id::text
          and answer_revision < new.answer_revision;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_resolve_macprep_superseded_question_reports
    on public.questions;
create trigger trg_resolve_macprep_superseded_question_reports
after update of answer_revision on public.questions
for each row execute function public.resolve_macprep_superseded_question_reports();

revoke all on function public.resolve_macprep_superseded_question_reports()
    from public, anon, authenticated;
grant execute on function public.resolve_macprep_superseded_question_reports()
    to service_role;

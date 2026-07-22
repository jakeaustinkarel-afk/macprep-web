-- Keep historical answer labels aligned when a question's choice order changes.
-- The July 19 answer-position rebalance changed labels for rounds 37-49; this
-- migration repairs every historical attempt whose original key is provable and
-- excludes the small ambiguous remainder from per-choice peer comparisons.

alter table public.questions
    add column if not exists answer_revision integer;

update public.questions
set answer_revision = 1
where answer_revision is null;

alter table public.questions
    alter column answer_revision set default 1,
    alter column answer_revision set not null;

alter table public.user_progress
    add column if not exists answer_revision integer;

update public.user_progress
set answer_revision = 1
where answer_revision is null;

alter table public.user_progress
    alter column answer_revision set default 1,
    alter column answer_revision set not null;

comment on column public.questions.answer_revision is
    'Increments whenever answer choices or the answer key changes.';
comment on column public.user_progress.answer_revision is
    'Question answer revision shown when this attempt was recorded.';

-- The preceding rebalance migration was committed at 2026-07-20 00:42:53 UTC.
-- No affected attempts were recorded between that change and this repair.
with affected as (
    select q.id::text as question_id
    from public.questions q
    where q.status = 'published'
      and regexp_replace(q.id::text, '-[0-9]+$', '') in (
        'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
        'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
        'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
        'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
        'authored-batch-r49'
      )
)
update public.questions q
set answer_revision = greatest(q.answer_revision, 2)
from affected a
where q.id::text = a.question_id;

-- A correct historical response proves the old correct label. The rebalance was
-- a single swap between that old label and the new key, so the same permutation
-- safely remaps every response for that question.
with affected as (
    select q.id::text as question_id,
           upper(q.correct_answer) as current_key,
           q.answer_revision
    from public.questions q
    where q.status = 'published'
      and regexp_replace(q.id::text, '-[0-9]+$', '') in (
        'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
        'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
        'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
        'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
        'authored-batch-r49'
      )
), inferred_old_keys as (
    select up.question_id::text as question_id,
           min(upper(up.selected_label)) filter (
               where up.is_correct and upper(coalesce(up.selected_label, '')) ~ '^[A-E]$'
           ) as old_key
    from public.user_progress up
    join affected a on a.question_id = up.question_id::text
    where up.created_at < timestamptz '2026-07-20 00:42:53+00'
    group by up.question_id
    having count(distinct upper(up.selected_label)) filter (
        where up.is_correct and upper(coalesce(up.selected_label, '')) ~ '^[A-E]$'
    ) = 1
)
update public.user_progress up
set selected_label = case
        when upper(up.selected_label) = inferred.old_key then affected.current_key
        when upper(up.selected_label) = affected.current_key then inferred.old_key
        else up.selected_label
    end,
    answer_revision = affected.answer_revision
from affected
join inferred_old_keys inferred using (question_id)
where up.question_id::text = affected.question_id
  and up.created_at < timestamptz '2026-07-20 00:42:53+00'
  and up.answer_revision = 1;

-- Any attempt made after the rebalance already used the current labels.
with affected as (
    select q.id::text as question_id, q.answer_revision
    from public.questions q
    where q.status = 'published'
      and regexp_replace(q.id::text, '-[0-9]+$', '') in (
        'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
        'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
        'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
        'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
        'authored-batch-r49'
      )
)
update public.user_progress up
set answer_revision = affected.answer_revision
from affected
where up.question_id::text = affected.question_id
  and up.created_at >= timestamptz '2026-07-20 00:42:53+00'
  and up.answer_revision is distinct from affected.answer_revision;

create or replace function public.bump_macprep_question_answer_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.choices is distinct from old.choices
       or upper(coalesce(new.correct_answer, '')) is distinct from upper(coalesce(old.correct_answer, '')) then
        if new.answer_revision <= old.answer_revision then
            new.answer_revision := old.answer_revision + 1;
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_macprep_question_answer_revision on public.questions;
create trigger trg_macprep_question_answer_revision
before update of choices, correct_answer on public.questions
for each row execute function public.bump_macprep_question_answer_revision();

create or replace function public.stamp_macprep_progress_answer_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    select q.answer_revision into new.answer_revision
    from public.questions q
    where q.id::text = new.question_id::text;

    if not found then
        raise exception 'question_not_found';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_macprep_progress_answer_revision on public.user_progress;
create trigger trg_macprep_progress_answer_revision
before insert on public.user_progress
for each row execute function public.stamp_macprep_progress_answer_revision();

revoke all on function public.bump_macprep_question_answer_revision() from public, anon, authenticated;
revoke all on function public.stamp_macprep_progress_answer_revision() from public, anon, authenticated;

create index if not exists idx_user_progress_question_revision_latest
    on public.user_progress (question_id, answer_revision, user_id, created_at desc, id desc);

-- Choice distributions compare only responses from the currently displayed
-- answer layout. Older ambiguous labels stay stored for auditability but cannot
-- distort the chart.
create or replace function public.macprep_saa_question_stats(p_question text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    with responses as (
        select distinct on (up.user_id)
            up.user_id,
            up.is_correct,
            upper(coalesce(up.selected_label, '')) as selected_label
        from public.user_progress up
        join public.questions q
          on q.id::text = up.question_id::text
         and q.answer_revision = up.answer_revision
        join public.user_profiles p on p.user_id = up.user_id
        where up.question_id::text = p_question
          and upper(coalesce(p.credential, '')) like 'SAA%'
          and (p.graduation_date is null or p.graduation_date > current_date)
        order by up.user_id, up.created_at desc, up.id desc
    ), labels as (
        select selected_label, count(*)::integer as responses
        from responses
        where selected_label ~ '^[A-E]$'
        group by selected_label
    )
    select jsonb_build_object(
        'responses', (select count(*)::integer from responses),
        'learners', (select count(distinct user_id)::integer from responses),
        'correct', (select count(*) filter (where is_correct)::integer from responses),
        'labels', coalesce(
            (select jsonb_object_agg(selected_label, responses) from labels),
            '{}'::jsonb
        )
    );
$$;

revoke all on function public.macprep_saa_question_stats(text) from public, anon, authenticated;
grant execute on function public.macprep_saa_question_stats(text) to service_role;

-- Evaluate auth helpers once per statement rather than once per row.
alter policy "Program directors can inspect owned vouchers."
on public.program_vouchers
using ((select auth.uid()) = owner_director_id);

alter policy "Program directors can insert voucher records."
on public.program_vouchers
with check ((select auth.uid()) = owner_director_id);

alter policy "Restrict suggestion viewing to Admin Master"
on public.user_suggestions
using (((select auth.jwt()) ->> 'email') = 'jakeaustin.karel@gmail.com');

alter policy "Users can read their own progress"
on public.user_progress
using ((select auth.uid()) = user_id);

alter policy "Users read own flags"
on public.user_flags
using ((select auth.uid()) = user_id);

alter policy "Users manage own notes"
on public.user_notes
using ((select auth.uid()) = user_id);

do $postflight$
declare
    conflicting_keys integer;
    unmigrated_provable integer;
    mismatched_current_answers integer;
begin
    with affected as (
        select q.id::text as question_id
        from public.questions q
        where q.status = 'published'
          and regexp_replace(q.id::text, '-[0-9]+$', '') in (
            'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
            'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
            'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
            'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
            'authored-batch-r49'
          )
    ), inferred as (
        select up.question_id::text as question_id
        from public.user_progress up
        join affected a on a.question_id = up.question_id::text
        where up.created_at < timestamptz '2026-07-20 00:42:53+00'
          and up.is_correct
          and upper(coalesce(up.selected_label, '')) ~ '^[A-E]$'
        group by up.question_id
        having count(distinct upper(up.selected_label)) > 1
    )
    select count(*)::integer into conflicting_keys from inferred;

    with affected as (
        select q.id::text as question_id, q.answer_revision
        from public.questions q
        where q.status = 'published'
          and regexp_replace(q.id::text, '-[0-9]+$', '') in (
            'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
            'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
            'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
            'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
            'authored-batch-r49'
          )
    )
    select count(*)::integer into unmigrated_provable
    from public.user_progress up
    join affected a on a.question_id = up.question_id::text
    where up.created_at < timestamptz '2026-07-20 00:42:53+00'
      and up.answer_revision is distinct from a.answer_revision
      and exists (
          select 1
          from public.user_progress witness
          where witness.question_id::text = up.question_id::text
            and witness.created_at < timestamptz '2026-07-20 00:42:53+00'
            and witness.is_correct
            and upper(coalesce(witness.selected_label, '')) ~ '^[A-E]$'
      );

    with affected as (
        select q.id::text as question_id,
               q.answer_revision,
               upper(q.correct_answer) as current_key
        from public.questions q
        where q.status = 'published'
          and regexp_replace(q.id::text, '-[0-9]+$', '') in (
            'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
            'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
            'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
            'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
            'authored-batch-r49'
          )
    )
    select count(*)::integer into mismatched_current_answers
    from public.user_progress up
    join affected a
      on a.question_id = up.question_id::text
     and a.answer_revision = up.answer_revision
    where up.is_correct is distinct from (upper(coalesce(up.selected_label, '')) = a.current_key);

    if conflicting_keys > 0 or unmigrated_provable > 0 or mismatched_current_answers > 0 then
        raise exception
            'Answer revision repair failed: % conflicting key(s), % unmigrated provable attempt(s), % current mismatch(es).',
            conflicting_keys, unmigrated_provable, mismatched_current_answers;
    end if;
end;
$postflight$;

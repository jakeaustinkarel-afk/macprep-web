-- Repair the five false misses reported after the July 19 answer-position
-- rebalance. Each report maps to exactly one incorrect A attempt in the 15
-- minutes before it; abort instead of guessing if production data drifts.

create temporary table macprep_reported_attempt_repairs
on commit drop
as
with report_windows(question_id, report_at) as (
    values
        ('authored-batch-r38-016'::text, timestamptz '2026-07-20 02:08:17.784063+00'),
        ('authored-batch-r45-012'::text, timestamptz '2026-07-21 03:35:24.394736+00'),
        ('authored-batch-r37-012'::text, timestamptz '2026-07-21 03:42:02.740096+00'),
        ('authored-batch-r49-004'::text, timestamptz '2026-07-22 00:11:08.046222+00'),
        ('authored-batch-r49-005'::text, timestamptz '2026-07-22 00:12:59.635003+00')
)
select
    up.id as progress_id,
    up.user_id,
    up.question_id,
    q.correct_answer,
    q.answer_revision
from report_windows report
join public.questions q
  on q.id::text = report.question_id
 and q.answer_revision = 2
 and upper(q.correct_answer) <> 'A'
join public.user_progress up
  on up.question_id::text = report.question_id
 and up.created_at between report.report_at - interval '15 minutes' and report.report_at
 and upper(coalesce(up.selected_label, '')) = 'A'
 and not up.is_correct;

do $preflight$
declare
    repair_count integer;
    question_count integer;
begin
    select count(*)::integer, count(distinct question_id)::integer
    into repair_count, question_count
    from macprep_reported_attempt_repairs;

    if repair_count <> 5 or question_count <> 5 then
        raise exception 'Expected exactly one stale-layout attempt for each of five reports; found % rows across % questions.',
            repair_count, question_count;
    end if;
end;
$preflight$;

update public.user_progress up
set selected_label = upper(repair.correct_answer),
    is_correct = true,
    answer_revision = repair.answer_revision
from macprep_reported_attempt_repairs repair
where up.id = repair.progress_id;

-- Rebuild the affected question schedules from their complete attempt history.
-- This removes the false miss without erasing legitimate later practice.
do $rebuild_review_state$
declare
    target record;
    attempt record;
    quality integer;
    repetitions integer;
    ease_factor real;
    interval_days integer;
    last_reviewed_at timestamptz;
begin
    for target in
        select distinct user_id, question_id
        from macprep_reported_attempt_repairs
    loop
        repetitions := 0;
        ease_factor := 2.5;
        interval_days := 0;
        last_reviewed_at := null;

        for attempt in
            select is_correct, confidence, created_at
            from public.user_progress
            where user_id = target.user_id
              and question_id::text = target.question_id::text
            order by created_at, id
        loop
            quality := case
                when attempt.is_correct and attempt.confidence = 'high' then 5
                when attempt.is_correct and attempt.confidence = 'medium' then 4
                when attempt.is_correct then 3
                when attempt.confidence = 'high' then 0
                else 2
            end;

            ease_factor := ease_factor
                + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
            ease_factor := greatest(1.3, ease_factor);

            if quality < 3 then
                repetitions := 0;
                interval_days := 1;
            else
                repetitions := repetitions + 1;
                interval_days := case repetitions
                    when 1 then 1
                    when 2 then 3
                    when 3 then 7
                    else greatest(1, round((interval_days * ease_factor)::numeric)::integer)
                end;
            end if;
            last_reviewed_at := attempt.created_at;
        end loop;

        if last_reviewed_at is not null then
            insert into public.review_state (
                user_id, question_id, repetitions, ease_factor, interval_days,
                due_at, last_reviewed_at
            ) values (
                target.user_id, target.question_id, repetitions, ease_factor,
                interval_days, last_reviewed_at + make_interval(days => interval_days),
                last_reviewed_at
            )
            on conflict (user_id, question_id) do update
            set repetitions = excluded.repetitions,
                ease_factor = excluded.ease_factor,
                interval_days = excluded.interval_days,
                due_at = excluded.due_at,
                last_reviewed_at = excluded.last_reviewed_at;
        end if;
    end loop;
end;
$rebuild_review_state$;

-- The adaptive domain score is insert-triggered, so replay each affected
-- learner/domain after correcting the historical outcome.
do $rebuild_domain_ability$
declare
    target record;
    attempt record;
    ability numeric;
    expected_score numeric;
    attempts integer;
    correct integer;
begin
    for target in
        select distinct
            repair.user_id,
            coalesce(q.domain_name, 'General') as domain
        from macprep_reported_attempt_repairs repair
        join public.questions q on q.id::text = repair.question_id::text
    loop
        ability := 1100;
        attempts := 0;
        correct := 0;

        for attempt in
            select
                up.is_correct,
                case lower(coalesce(q.difficulty, 'medium'))
                    when 'easy' then 900
                    when 'hard' then 1300
                    else 1100
                end as question_rating
            from public.user_progress up
            join public.questions q on q.id::text = up.question_id::text
            where up.user_id = target.user_id
              and coalesce(q.domain_name, 'General') = target.domain
            order by up.created_at, up.id
        loop
            expected_score := 1.0 / (
                1.0 + power(10.0, (attempt.question_rating - ability) / 400.0)
            );
            ability := greatest(700, least(1500,
                ability + 24.0 * ((case when attempt.is_correct then 1 else 0 end) - expected_score)
            ));
            attempts := attempts + 1;
            correct := correct + case when attempt.is_correct then 1 else 0 end;
        end loop;

        insert into public.user_domain_ability (
            user_id, domain, ability, attempts, correct, updated_at
        ) values (
            target.user_id, target.domain, ability, attempts, correct, now()
        )
        on conflict (user_id, domain) do update
        set ability = excluded.ability,
            attempts = excluded.attempts,
            correct = excluded.correct,
            updated_at = excluded.updated_at;
    end loop;
end;
$rebuild_domain_ability$;

-- Clarify the only open report whose current wording still left room for a
-- different management choice. OAA/DAS calls for a contextual wake-versus-
-- proceed decision after oxygenation is restored; the stem now states the
-- persistent category-1 urgency that makes proceeding the best answer.
do $clarify_obstetric_item$
declare
    changed integer;
begin
    update public.questions
    set stem = 'A 28-year-old parturient requires category-1 cesarean delivery for persistent fetal bradycardia. After rapid sequence induction, two optimized laryngoscopy attempts fail. Facemask ventilation remains adequate with oxygen saturation at 96%, and the obstetrician confirms that delivery cannot safely be delayed. Following OAA/DAS obstetric failed-intubation guidance, which action is most appropriate?',
        choices = jsonb_set(
            choices,
            '{4}',
            jsonb_build_object(
                'label', 'E',
                'text', 'Declare failed intubation, place a second-generation supraglottic airway, confirm effective ventilation, and proceed while the category-1 urgency persists',
                'correct', true,
                'rationale', 'Correct. After limited optimized attempts, declare failed intubation and prioritize oxygenation. In this stated category-1 emergency, effective ventilation through a second-generation supraglottic airway plus the obstetric determination that delay is unsafe supports proceeding, with continuous reassessment. Waking is favored when urgency and airway or surgical factors do not justify continuing.'
            )
        ),
        explanation = 'After two optimized failed laryngoscopy attempts, the OAA/DAS obstetric algorithm prioritizes declaring failed intubation and maintaining oxygenation, usually with a second-generation supraglottic airway. The subsequent decision to wake or proceed is contextual rather than automatic. Here, persistent fetal bradycardia, the obstetric determination that delivery cannot safely be delayed, and confirmed effective ventilation support proceeding while continuously reassessing oxygenation and airway-device performance. If effective ventilation were not maintained, the pathway would escalate; if the urgency did not justify continuing, waking the patient would be favored.',
        "references" = jsonb_build_array(jsonb_build_object(
            'source', 'OAA/DAS guidelines for difficult and failed tracheal intubation in obstetrics (2015)',
            'url', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4606761/'
        ))
    where id::text = 'authored-batch-06-004'
      and status = 'published'
      and answer_revision = 1
      and upper(correct_answer) = 'E';

    get diagnostics changed = row_count;
    if changed <> 1 then
        raise exception 'Expected to clarify exactly one obstetric question; changed %.', changed;
    end if;
end;
$clarify_obstetric_item$;

do $postflight$
declare
    repaired integer;
    obstetric_revision integer;
    obstetric_correct_choices integer;
begin
    select count(*)::integer into repaired
    from macprep_reported_attempt_repairs repair
    join public.user_progress up on up.id = repair.progress_id
    where up.is_correct
      and upper(up.selected_label) = upper(repair.correct_answer)
      and up.answer_revision = repair.answer_revision;

    if repaired <> 5 then
        raise exception 'Expected five corrected report attempts; verified %.', repaired;
    end if;

    select q.answer_revision,
           (select count(*)::integer
            from jsonb_array_elements(q.choices) choice
            where coalesce((choice->>'correct')::boolean, false))
    into obstetric_revision, obstetric_correct_choices
    from public.questions q
    where q.id::text = 'authored-batch-06-004';

    if obstetric_revision <> 2 or obstetric_correct_choices <> 1 then
        raise exception 'Obstetric clarification failed validation (revision %, correct choices %).',
            obstetric_revision, obstetric_correct_choices;
    end if;
end;
$postflight$;

drop table macprep_reported_attempt_repairs;

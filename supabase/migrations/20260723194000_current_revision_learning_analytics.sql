begin;

-- Rebuild one learner's adaptive Elo state from only active answer revisions.
-- Historical attempts remain immutable in user_progress for auditability.
create or replace function public.rebuild_macprep_user_domain_ability(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    attempt record;
    current_ability numeric;
    question_rating numeric;
    expected_score numeric;
begin
    delete from public.user_domain_ability where user_id = p_user;

    for attempt in
        select
            coalesce(q.domain_name, 'General') as domain,
            lower(coalesce(q.difficulty, 'medium')) as difficulty,
            up.is_correct
        from public.user_progress up
        join public.questions q
          on q.id::text = up.question_id::text
         and q.answer_revision = up.answer_revision
        where up.user_id = p_user
          and q.status in ('published', 'sme_review')
        order by up.created_at, up.id
    loop
        question_rating := case attempt.difficulty
            when 'easy' then 900
            when 'hard' then 1300
            else 1100
        end;
        insert into public.user_domain_ability (user_id, domain)
        values (p_user, attempt.domain)
        on conflict (user_id, domain) do nothing;

        select ability into current_ability
        from public.user_domain_ability
        where user_id = p_user and domain = attempt.domain
        for update;

        expected_score := 1.0 / (1.0 + power(10.0, (question_rating - current_ability) / 400.0));
        update public.user_domain_ability
        set ability = greatest(700, least(1500,
                current_ability + 24.0 * ((case when attempt.is_correct then 1 else 0 end) - expected_score)
            )),
            attempts = attempts + 1,
            correct = correct + case when attempt.is_correct then 1 else 0 end,
            updated_at = now()
        where user_id = p_user and domain = attempt.domain;
    end loop;
end;
$$;

create or replace function public.update_macprep_domain_ability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    question_domain text;
    question_rating numeric;
    current_revision integer;
    current_ability numeric;
    expected_score numeric;
begin
    select
        coalesce(domain_name, 'General'),
        case lower(coalesce(difficulty, 'medium'))
            when 'easy' then 900
            when 'hard' then 1300
            else 1100
        end,
        answer_revision
    into question_domain, question_rating, current_revision
    from public.questions
    where id::text = new.question_id::text
      and status in ('published', 'sme_review');

    if question_domain is null or new.answer_revision <> current_revision then
        return new;
    end if;

    insert into public.user_domain_ability (user_id, domain)
    values (new.user_id, question_domain)
    on conflict (user_id, domain) do nothing;

    select ability into current_ability
    from public.user_domain_ability
    where user_id = new.user_id and domain = question_domain
    for update;

    expected_score := 1.0 / (1.0 + power(10.0, (question_rating - current_ability) / 400.0));
    update public.user_domain_ability
    set ability = greatest(700, least(1500,
            current_ability + 24.0 * ((case when new.is_correct then 1 else 0 end) - expected_score)
        )),
        attempts = attempts + 1,
        correct = correct + case when new.is_correct then 1 else 0 end,
        updated_at = now()
    where user_id = new.user_id and domain = question_domain;
    return new;
end;
$$;

create or replace function public.rebuild_macprep_ability_after_question_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    learner record;
begin
    if new.answer_revision is distinct from old.answer_revision
       or new.status is distinct from old.status then
        for learner in
            select distinct up.user_id
            from public.user_progress up
            where up.question_id::text = new.id::text
        loop
            perform public.rebuild_macprep_user_domain_ability(learner.user_id);
        end loop;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_macprep_rebuild_ability_after_question_change on public.questions;
create trigger trg_macprep_rebuild_ability_after_question_change
after update of answer_revision, status on public.questions
for each row execute function public.rebuild_macprep_ability_after_question_change();

do $$
declare
    learner record;
begin
    for learner in select distinct user_id from public.user_progress loop
        perform public.rebuild_macprep_user_domain_ability(learner.user_id);
    end loop;
end;
$$;

create or replace function public.macprep_saa_benchmark(
    p_served_statuses text[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    with latest as (
        select distinct on (up.user_id, up.question_id)
            up.user_id,
            coalesce(q.domain_name, 'General') as domain,
            up.is_correct
        from public.user_progress up
        join public.user_profiles p on p.user_id = up.user_id
        join public.questions q
          on q.id::text = up.question_id::text
         and q.answer_revision = up.answer_revision
        where upper(coalesce(p.credential, '')) like 'SAA%'
          and (p.graduation_date is null or p.graduation_date > current_date)
          and (p_served_statuses is null or q.status = any(p_served_statuses))
        order by up.user_id, up.question_id, up.created_at desc, up.id desc
    ), stats as (
        select domain,
               count(*)::integer as responses,
               count(*) filter (where is_correct)::integer as correct,
               count(distinct user_id)::integer as learners
        from latest
        group by domain
    )
    select coalesce(jsonb_object_agg(
        domain,
        jsonb_build_object('a', responses, 'c', correct, 'u', learners)
    ), '{}'::jsonb)
    from stats;
$$;

create or replace function public.macprep_user_practice_readiness(
    p_user uuid,
    p_served_statuses text[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    with served as (
        select q.id, q.answer_revision
        from public.questions q
        where p_served_statuses is null or q.status = any(p_served_statuses)
    ), latest as (
        select distinct on (up.question_id)
            up.question_id, up.is_correct
        from public.user_progress up
        join served s
          on s.id::text = up.question_id::text
         and s.answer_revision = up.answer_revision
        where up.user_id = p_user
        order by up.question_id, up.created_at desc, up.id desc
    ), basis as (
        select
            (select count(*)::integer from latest) as answered,
            (select count(*) filter (where is_correct)::integer from latest) as correct,
            (select count(*)::integer from served) as total
    )
    select jsonb_build_object(
        'score', case when answered = 0 or total = 0 then 0 else round(
            (correct::numeric / answered) * 100.0
            * (0.5 + 0.5 * least(1.0, answered::numeric / total))
        )::integer end,
        'answered', answered,
        'correct', correct,
        'total', total,
        'latest_accuracy', case when answered = 0 then null
            else round(100.0 * correct / answered)::integer end
    )
    from basis;
$$;

create or replace function public.macprep_user_learning_rollup(
    p_user uuid,
    p_tz_offset integer default 0,
    p_served_statuses text[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    with served_questions as (
        select id, answer_revision, coalesce(category, 'Uncategorized') as category,
               coalesce(domain_name, 'General') as domain
        from public.questions
        where p_served_statuses is null or status = any(p_served_statuses)
    ), progress as (
        select up.id, up.question_id, up.is_correct, sq.category,
               up.created_at, up.confidence
        from public.user_progress up
        join served_questions sq
          on sq.id::text = up.question_id::text
         and sq.answer_revision = up.answer_revision
        where up.user_id = p_user
    ), base_stats as (
        select count(*)::integer as attempts,
               count(*) filter (where is_correct)::integer as correct,
               count(distinct question_id)::integer as answered
        from progress
    ), per_question as (
        select distinct on (question_id) question_id, is_correct, confidence
        from progress
        order by question_id, created_at desc, id desc
    ), specialty_stats as (
        select category, count(*)::integer as attempts,
               count(*) filter (where is_correct)::integer as correct
        from progress
        group by category
    ), calibration_stats as (
        select category, count(*)::integer as attempts,
               count(*) filter (where is_correct)::integer as correct
        from progress
        where confidence = 'high'
        group by category
        having count(*) >= 3
    ), bank_category as (
        select category, count(*)::integer as total
        from served_questions
        group by category
    ), answered_category as (
        select sq.category, count(distinct p.question_id)::integer as answered
        from progress p
        join served_questions sq on sq.id::text = p.question_id::text
        group by sq.category
    ), bank_domain as (
        select domain, count(*)::integer as total
        from served_questions
        group by domain
    ), answered_domain as (
        select sq.domain, count(distinct p.question_id)::integer as answered
        from progress p
        join served_questions sq on sq.id::text = p.question_id::text
        group by sq.domain
    ), local_context as (
        select (now() - make_interval(mins => greatest(-840, least(840, p_tz_offset))))::date as today
    ), study_days as (
        select distinct (created_at - make_interval(mins => greatest(-840, least(840, p_tz_offset))))::date as day
        from progress
    ), streak_anchor as (
        select case when exists (select 1 from study_days where day = lc.today)
            then lc.today else lc.today - 1 end as day
        from local_context lc
    ), streak_value as (
        select coalesce(min(gap), 365)::integer as streak
        from generate_series(0, 364) as gap
        cross join streak_anchor a
        where not exists (select 1 from study_days d where d.day = a.day - gap)
    ), daily_stats as (
        select
            (created_at - make_interval(mins => greatest(-840, least(840, p_tz_offset))))::date as day,
            count(*)::integer as attempts,
            count(*) filter (where is_correct)::integer as correct
        from progress
        group by 1
    ), recent_days as (
        select * from daily_stats order by day desc limit 7
    ), domain_rows as (
        select
            b.domain,
            coalesce(a.attempts, 0) as attempts,
            coalesce(a.correct, 0) as correct,
            coalesce(ad.answered, 0) as answered,
            b.total,
            round(coalesce(a.ability, 1100))::integer as ability
        from bank_domain b
        left join public.user_domain_ability a
          on a.user_id = p_user and a.domain = b.domain
        left join answered_domain ad on ad.domain = b.domain
    ), served_total as (
        select count(*)::integer as total from served_questions
    )
    select jsonb_build_object(
        'stats', jsonb_build_object(
            'attempts', bs.attempts,
            'correct', bs.correct,
            'answered', bs.answered
        ),
        'answered_ids', coalesce((
            select jsonb_agg(question_id order by question_id) from per_question
        ), '[]'::jsonb),
        'missed_ids', coalesce((
            select jsonb_agg(question_id order by question_id)
            from per_question where not is_correct
        ), '[]'::jsonb),
        'confident_missed_ids', coalesce((
            select jsonb_agg(question_id order by question_id)
            from per_question where not is_correct and confidence = 'high'
        ), '[]'::jsonb),
        'by_specialty', coalesce((
            select jsonb_agg(jsonb_build_object(
                'category', category,
                'attempts', attempts,
                'correct', correct,
                'accuracy', round(100.0 * correct / attempts)::integer
            ) order by attempts desc, category)
            from specialty_stats
        ), '[]'::jsonb),
        'calibration', coalesce((
            select jsonb_agg(jsonb_build_object(
                'category', category,
                'attempts', attempts,
                'accuracy', round(100.0 * correct / attempts)::integer
            ) order by round(100.0 * correct / attempts), category)
            from calibration_stats
        ), '[]'::jsonb),
        'coverage', coalesce((
            select jsonb_agg(jsonb_build_object(
                'category', b.category,
                'total', b.total,
                'answered', coalesce(a.answered, 0)
            ) order by b.total desc, b.category)
            from bank_category b
            left join answered_category a on a.category = b.category
        ), '[]'::jsonb),
        'by_domain', coalesce((
            select jsonb_agg(jsonb_build_object(
                'domain', domain,
                'attempts', attempts,
                'correct', correct,
                'accuracy', case when attempts > 0 then round(100.0 * correct / attempts)::integer else null end,
                'answered', answered,
                'total', total,
                'ability', ability,
                'target', ability + 40,
                'target_tier', case when ability + 40 >= 1200 then 'hard' when ability + 40 >= 1000 then 'medium' else 'easy' end,
                'mastery', case when attempts >= 5 then greatest(0, least(100, round((ability - 800) / 6.0)::integer)) else null end
            ) order by case domain
                when 'Principles of Anesthesia' then 1
                when 'Physiology, Pathophysiology & Management' then 2
                when 'Instrumentation, Monitoring & Anesthetic Delivery Systems' then 3
                when 'Subspecialty Care' then 4
                when 'Pharmacology' then 5
                when 'Regional Anesthesia & Pain Management' then 6
                else 99 end, domain)
            from domain_rows
        ), '[]'::jsonb),
        'active_days', coalesce((
            select jsonb_agg(to_char(day, 'YYYY-MM-DD') order by day) from study_days
        ), '[]'::jsonb),
        'streak', (select streak from streak_value),
        'trend', coalesce((
            select jsonb_agg(jsonb_build_object(
                'day', to_char(day, 'YYYY-MM-DD'),
                'accuracy', round(100.0 * correct / attempts)::integer,
                'attempts', attempts
            ) order by day)
            from recent_days
        ), '[]'::jsonb),
        'answered_today', (
            select count(*)::integer
            from progress p cross join local_context lc
            where (p.created_at - make_interval(mins => greatest(-840, least(840, p_tz_offset))))::date = lc.today
        ),
        'readiness', case when bs.attempts = 0 or st.total = 0 then 0 else round(
            (bs.correct::numeric / bs.attempts) * 100.0
            * (0.5 + 0.5 * least(1.0, bs.answered::numeric / st.total))
        )::integer end
    )
    from base_stats bs cross join served_total st;
$$;

revoke all on function public.rebuild_macprep_user_domain_ability(uuid)
    from public, anon, authenticated;
revoke all on function public.update_macprep_domain_ability()
    from public, anon, authenticated;
revoke all on function public.rebuild_macprep_ability_after_question_change()
    from public, anon, authenticated;
revoke all on function public.macprep_saa_benchmark(text[])
    from public, anon, authenticated;
revoke all on function public.macprep_user_practice_readiness(uuid, text[])
    from public, anon, authenticated;
revoke all on function public.macprep_user_learning_rollup(uuid, integer, text[])
    from public, anon, authenticated;

grant execute on function public.rebuild_macprep_user_domain_ability(uuid) to service_role;
grant execute on function public.macprep_saa_benchmark(text[]) to service_role;
grant execute on function public.macprep_user_practice_readiness(uuid, text[]) to service_role;
grant execute on function public.macprep_user_learning_rollup(uuid, integer, text[]) to service_role;

commit;

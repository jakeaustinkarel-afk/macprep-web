-- Transactional admin review actions and bounded learning analytics.
-- All functions cross user/question boundaries and are therefore service-role only.

-- Webhook retries and checkout-return verification can arrive concurrently. Keep one
-- canonical purchase funnel event per account at the database boundary.
with ranked_purchase_events as (
    select ctid, row_number() over (
        partition by user_id
        order by created_at asc, id asc
    ) as duplicate_number
    from public.analytics_events
    where name = 'purchase' and user_id is not null
)
delete from public.analytics_events
where ctid in (
    select ctid from ranked_purchase_events where duplicate_number > 1
);

create unique index if not exists idx_analytics_events_one_purchase_per_user
    on public.analytics_events (user_id)
    where name = 'purchase' and user_id is not null;

-- Applying a proposed choice rewrite and closing its queue item must be one
-- transaction. A concurrent reviewer receives the already-closed result instead of
-- applying a stale second edit.
create or replace function public.apply_macprep_question_edit(
    p_edit_id bigint,
    p_action text,
    p_choices jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_edit public.question_edits%rowtype;
begin
    if p_action not in ('approve', 'reject') then
        raise exception 'Unsupported review action.';
    end if;

    select * into target_edit
    from public.question_edits
    where id = p_edit_id
    for update;

    if not found then
        raise exception 'edit_not_found';
    end if;
    if target_edit.status <> 'pending' then
        return jsonb_build_object('status', target_edit.status, 'already', true);
    end if;

    if p_action = 'approve' then
        if p_choices is null or jsonb_typeof(p_choices) <> 'array' then
            raise exception 'Approved choices must be a JSON array.';
        end if;
        update public.questions
        set choices = p_choices
        where id = target_edit.question_id;
        if not found then
            raise exception 'question_not_found';
        end if;

        update public.question_edits
        set status = 'approved', proposed_choices = p_choices, reviewed_at = now()
        where id = target_edit.id;
        return jsonb_build_object('status', 'approved', 'already', false);
    end if;

    update public.question_edits
    set status = 'rejected', reviewed_at = now()
    where id = target_edit.id;
    return jsonb_build_object('status', 'rejected', 'already', false);
end;
$$;

-- Persist the adaptive engine's per-domain state. New attempts update one small row
-- instead of replaying a learner's full history on every dashboard visit.
create table if not exists public.user_domain_ability (
    user_id uuid not null references auth.users(id) on delete cascade,
    domain text not null,
    ability numeric not null default 1100,
    attempts integer not null default 0,
    correct integer not null default 0,
    updated_at timestamptz not null default now(),
    primary key (user_id, domain)
);

alter table public.user_domain_ability enable row level security;
revoke all on table public.user_domain_ability from public, anon, authenticated;
grant all on table public.user_domain_ability to service_role;

create table if not exists public.scheduled_job_runs (
    job_name text not null,
    run_day date not null,
    started_at timestamptz not null default now(),
    primary key (job_name, run_day)
);

alter table public.scheduled_job_runs enable row level security;
revoke all on table public.scheduled_job_runs from public, anon, authenticated;
grant all on table public.scheduled_job_runs to service_role;

create or replace function public.claim_macprep_daily_job(p_job_name text, p_run_day date)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    inserted_count integer := 0;
begin
    if p_job_name is null or btrim(p_job_name) = '' or length(p_job_name) > 80 then
        raise exception 'A valid scheduled job name is required.';
    end if;
    insert into public.scheduled_job_runs (job_name, run_day)
    values (btrim(p_job_name), p_run_day)
    on conflict (job_name, run_day) do update
        set started_at = now()
        where public.scheduled_job_runs.started_at < now() - interval '2 hours';
    get diagnostics inserted_count = row_count;
    delete from public.scheduled_job_runs where run_day < current_date - 90;
    return inserted_count = 1;
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
    current_ability numeric;
    expected_score numeric;
begin
    select
        coalesce(domain_name, 'General'),
        case lower(coalesce(difficulty, 'medium'))
            when 'easy' then 900
            when 'hard' then 1300
            else 1100
        end
    into question_domain, question_rating
    from public.questions
    where id = new.question_id;

    if question_domain is null then
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

drop trigger if exists trg_macprep_domain_ability on public.user_progress;
create trigger trg_macprep_domain_ability
after insert on public.user_progress
for each row execute function public.update_macprep_domain_ability();

-- Rebuild exact Elo state for existing history in chronological order. This is a
-- one-time migration operation; subsequent attempts use the trigger above.
truncate table public.user_domain_ability;
with recursive ordered_attempts as (
    select
        up.user_id,
        coalesce(q.domain_name, 'General') as domain,
        up.is_correct,
        case lower(coalesce(q.difficulty, 'medium'))
            when 'easy' then 900::numeric
            when 'hard' then 1300::numeric
            else 1100::numeric
        end as question_rating,
        row_number() over (
            partition by up.user_id, coalesce(q.domain_name, 'General')
            order by up.created_at, up.id
        ) as attempt_number
    from public.user_progress up
    join public.questions q on q.id = up.question_id
), elo as (
    select
        user_id,
        domain,
        attempt_number,
        greatest(700::numeric, least(1500::numeric,
            1100::numeric + 24::numeric * (
                (case when is_correct then 1 else 0 end)::numeric
                - 1::numeric / (1::numeric + power(10::numeric, (question_rating - 1100::numeric) / 400::numeric))
            )
        )) as ability,
        1 as attempts,
        case when is_correct then 1 else 0 end as correct
    from ordered_attempts
    where attempt_number = 1

    union all

    select
        a.user_id,
        a.domain,
        a.attempt_number,
        greatest(700::numeric, least(1500::numeric,
            e.ability + 24::numeric * (
                (case when a.is_correct then 1 else 0 end)::numeric
                - 1::numeric / (1::numeric + power(10::numeric, (a.question_rating - e.ability) / 400::numeric))
            )
        )) as ability,
        e.attempts + 1,
        e.correct + case when a.is_correct then 1 else 0 end
    from elo e
    join ordered_attempts a
      on a.user_id = e.user_id
     and a.domain = e.domain
     and a.attempt_number = e.attempt_number + 1
), final_elo as (
    select distinct on (user_id, domain)
        user_id, domain, ability, attempts, correct
    from elo
    order by user_id, domain, attempt_number desc
)
insert into public.user_domain_ability (user_id, domain, ability, attempts, correct)
select user_id, domain, ability, attempts, correct
from final_elo;

-- One bounded JSON document replaces a full progress-history download plus a full
-- question-bank download on every profile request.
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
    with progress as (
        select question_id, is_correct, coalesce(category, 'Uncategorized') as category,
               created_at, confidence
        from public.user_progress
        where user_id = p_user
    ), served_questions as (
        select id, coalesce(category, 'Uncategorized') as category,
               coalesce(domain_name, 'General') as domain
        from public.questions
        where p_served_statuses is null or status = any(p_served_statuses)
    ), base_stats as (
        select count(*)::integer as attempts,
               count(*) filter (where is_correct)::integer as correct,
               count(distinct question_id)::integer as answered
        from progress
    ), per_question as (
        select question_id,
               bool_or(is_correct) as ever_correct,
               bool_or(not is_correct) as ever_incorrect,
               bool_or(not is_correct and confidence = 'high') as confident_incorrect
        from progress
        group by question_id
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
        join served_questions sq on sq.id = p.question_id
        group by sq.category
    ), bank_domain as (
        select domain, count(*)::integer as total
        from served_questions
        group by domain
    ), answered_domain as (
        select sq.domain, count(distinct p.question_id)::integer as answered
        from progress p
        join served_questions sq on sq.id = p.question_id
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
            from per_question where ever_incorrect and not ever_correct
        ), '[]'::jsonb),
        'confident_missed_ids', coalesce((
            select jsonb_agg(question_id order by question_id)
            from per_question where confident_incorrect and not ever_correct
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

-- Per-question peer distributions are calculated in Postgres and never ship a
-- population-wide user-id list to the application process.
create or replace function public.macprep_saa_question_stats(p_question text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    with responses as (
        select up.is_correct, upper(coalesce(up.selected_label, '')) as selected_label
        from public.user_progress up
        join public.user_profiles p on p.user_id = up.user_id
        where up.question_id::text = p_question
          and upper(coalesce(p.credential, '')) like 'SAA%'
    ), labels as (
        select selected_label, count(*)::integer as responses
        from responses
        where selected_label ~ '^[A-Z]$'
        group by selected_label
    )
    select jsonb_build_object(
        'responses', (select count(*)::integer from responses),
        'correct', (select count(*) filter (where is_correct)::integer from responses),
        'labels', coalesce((select jsonb_object_agg(selected_label, responses) from labels), '{}'::jsonb)
    );
$$;

-- Reset all state derived from answered questions in the same transaction. Notes,
-- flags, and the account entitlement intentionally remain untouched.
create or replace function public.reset_macprep_progress(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    delete from public.review_state where user_id = p_user;
    delete from public.user_domain_ability where user_id = p_user;
    delete from public.user_progress where user_id = p_user;
end;
$$;

revoke all on function public.apply_macprep_question_edit(bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.update_macprep_domain_ability() from public, anon, authenticated;
revoke all on function public.macprep_user_learning_rollup(uuid, integer, text[]) from public, anon, authenticated;
revoke all on function public.macprep_saa_question_stats(text) from public, anon, authenticated;
revoke all on function public.reset_macprep_progress(uuid) from public, anon, authenticated;
revoke all on function public.claim_macprep_daily_job(text, date) from public, anon, authenticated;
grant execute on function public.apply_macprep_question_edit(bigint, text, jsonb) to service_role;
grant execute on function public.update_macprep_domain_ability() to service_role;
grant execute on function public.macprep_user_learning_rollup(uuid, integer, text[]) to service_role;
grant execute on function public.macprep_saa_question_stats(text) to service_role;
grant execute on function public.reset_macprep_progress(uuid) to service_role;
grant execute on function public.claim_macprep_daily_job(text, date) to service_role;

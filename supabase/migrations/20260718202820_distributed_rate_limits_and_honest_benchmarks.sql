-- Shared abuse controls and statistically safer learner comparisons.
-- All objects are service-role-only; no browser role can read population data
-- or consume/reset a rate-limit bucket directly.

create table if not exists public.rate_limit_windows (
    bucket text not null,
    identity_hash text not null,
    window_started_at timestamptz not null,
    expires_at timestamptz not null,
    hit_count integer not null check (hit_count > 0),
    primary key (bucket, identity_hash)
);

create index if not exists idx_rate_limit_windows_expires_at
    on public.rate_limit_windows (expires_at);

alter table public.rate_limit_windows enable row level security;
revoke all on table public.rate_limit_windows from public, anon, authenticated;
grant select, insert, update, delete on table public.rate_limit_windows to service_role;

create or replace function public.consume_macprep_rate_limit(
    p_bucket text,
    p_identity_hash text,
    p_window_seconds integer,
    p_max_hits integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_hits integer;
    v_expires timestamptz;
begin
    if p_bucket !~ '^[a-z0-9_-]{1,48}$'
       or p_identity_hash !~ '^[a-f0-9]{64}$'
       or p_window_seconds < 1 or p_window_seconds > 86400
       or p_max_hits < 1 or p_max_hits > 10000 then
        raise exception 'invalid rate limit parameters';
    end if;

    -- Amortized cleanup keeps one-off address/account hashes from accumulating.
    if left(p_identity_hash, 2) = '00' then
        delete from public.rate_limit_windows
        where expires_at < v_now - interval '1 day';
    end if;

    insert into public.rate_limit_windows (
        bucket, identity_hash, window_started_at, expires_at, hit_count
    ) values (
        p_bucket, p_identity_hash, v_now,
        v_now + make_interval(secs => p_window_seconds), 1
    )
    on conflict (bucket, identity_hash) do update
    set hit_count = case
            when public.rate_limit_windows.expires_at <= v_now then 1
            else public.rate_limit_windows.hit_count + 1
        end,
        window_started_at = case
            when public.rate_limit_windows.expires_at <= v_now then v_now
            else public.rate_limit_windows.window_started_at
        end,
        expires_at = case
            when public.rate_limit_windows.expires_at <= v_now
                then v_now + make_interval(secs => p_window_seconds)
            else public.rate_limit_windows.expires_at
        end
    returning hit_count, expires_at into v_hits, v_expires;

    return jsonb_build_object(
        'allowed', v_hits <= p_max_hits,
        'count', v_hits,
        'retry_after', greatest(1, ceil(extract(epoch from (v_expires - v_now)))::integer)
    );
end;
$$;

revoke all on function public.consume_macprep_rate_limit(text, text, integer, integer)
    from public, anon, authenticated;
grant execute on function public.consume_macprep_rate_limit(text, text, integer, integer)
    to service_role;

-- Each learner contributes at most one response per question: their latest one.
-- This prevents frequent users and repeated retries from dominating the cohort.
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
        join public.questions q on q.id = up.question_id
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
        join public.user_profiles p on p.user_id = up.user_id
        where up.question_id::text = p_question
          and upper(coalesce(p.credential, '')) like 'SAA%'
          and (p.graduation_date is null or p.graduation_date > current_date)
        order by up.user_id, up.created_at desc, up.id desc
    ), labels as (
        select selected_label, count(*)::integer as responses
        from responses
        where selected_label ~ '^[A-Z]$'
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

-- A bounded readiness basis that scores the latest result for each served item,
-- not every retry. The result is an in-product practice estimate, never an exam
-- pass prediction.
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
        select q.id
        from public.questions q
        where p_served_statuses is null or q.status = any(p_served_statuses)
    ), latest as (
        select distinct on (up.question_id)
            up.question_id, up.is_correct
        from public.user_progress up
        join served s on s.id = up.question_id
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

revoke all on function public.macprep_saa_benchmark(text[]) from public, anon, authenticated;
revoke all on function public.macprep_saa_question_stats(text) from public, anon, authenticated;
revoke all on function public.macprep_user_practice_readiness(uuid, text[]) from public, anon, authenticated;
grant execute on function public.macprep_saa_benchmark(text[]) to service_role;
grant execute on function public.macprep_saa_question_stats(text) to service_role;
grant execute on function public.macprep_user_practice_readiness(uuid, text[]) to service_role;

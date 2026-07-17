-- MACPrep database contract and scalable rollups.
--
-- This migration is additive for the existing production schema. It records the
-- tables and RPCs that src/server.mjs depends on, adds the indexes that support
-- the access patterns below, and moves cohort/leaderboard calculations into
-- Postgres so the application never scans raw progress history in Node.
--
-- Apply this migration before deploying the matching server change. The RPCs are
-- intentionally service_role-only because they aggregate data across accounts.

create index if not exists idx_user_progress_user_created_at
    on public.user_progress (user_id, created_at desc);

create index if not exists idx_user_progress_question_user
    on public.user_progress (question_id, user_id);

create index if not exists idx_questions_status_domain
    on public.questions (status, domain_name, id);

create index if not exists idx_user_profiles_training_program
    on public.user_profiles (training_program, credential, graduation_date);

create index if not exists idx_user_profiles_leaderboard
    on public.user_profiles (leaderboard_opt_in, user_id)
    where leaderboard_opt_in is true;

-- All-SAA accuracy benchmark by served NCCAA domain. Returning one JSON value
-- avoids PostgREST response caps while the join stays inside the database.
create or replace function public.macprep_saa_benchmark(
    p_served_statuses text[] default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select coalesce(
        jsonb_object_agg(
            stats.domain,
            jsonb_build_object('a', stats.attempts, 'c', stats.correct)
        ),
        '{}'::jsonb
    )
    from (
        select
            coalesce(q.domain_name, 'General') as domain,
            count(*)::integer as attempts,
            count(*) filter (where up.is_correct)::integer as correct
        from public.user_progress up
        join public.user_profiles p on p.user_id = up.user_id
        join public.questions q on q.id = up.question_id
        where upper(coalesce(p.credential, '')) like 'SAA%'
          and (p_served_statuses is null or q.status = any(p_served_statuses))
        group by coalesce(q.domain_name, 'General')
    ) as stats;
$$;

-- Cohort dashboard response. Access control remains in Express; this function
-- only accepts the program resolved from the verified faculty/admin identity.
create or replace function public.macprep_faculty_cohort_rollup(
    p_program text,
    p_served_statuses text[] default null,
    p_excluded_emails text[] default '{}'::text[]
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    with nccaa(domain, position) as (
        values
            ('Principles of Anesthesia'::text, 1),
            ('Physiology, Pathophysiology & Management'::text, 2),
            ('Instrumentation, Monitoring & Anesthetic Delivery Systems'::text, 3),
            ('Subspecialty Care'::text, 4),
            ('Pharmacology'::text, 5),
            ('Regional Anesthesia & Pain Management'::text, 6)
    ),
    cohort as (
        select p.user_id, p.email, p.full_name, p.credential
        from public.user_profiles p
        where p.training_program = p_program
          and coalesce(p.is_program_director, false) is false
          and coalesce(p.is_faculty, false) is false
          and upper(coalesce(p.credential, '')) like 'SAA%'
          and (p.graduation_date is null or p.graduation_date > current_date)
          and lower(coalesce(p.email, '')) <> all(p_excluded_emails)
    ),
    attempts as (
        select
            up.user_id,
            up.question_id,
            up.is_correct,
            up.created_at,
            up.time_ms,
            up.answer_changed,
            coalesce(q.domain_name, 'General') as domain,
            q.stem,
            q.question_type
        from public.user_progress up
        join cohort c on c.user_id = up.user_id
        join public.questions q on q.id = up.question_id
        where p_served_statuses is null or q.status = any(p_served_statuses)
    ),
    domain_stats as (
        select domain, count(*)::integer as attempts,
               count(*) filter (where is_correct)::integer as correct
        from attempts
        group by domain
    ),
    saa_domain_stats as (
        select
            coalesce(q.domain_name, 'General') as domain,
            count(*)::integer as attempts,
            count(*) filter (where up.is_correct)::integer as correct
        from public.user_progress up
        join public.user_profiles p on p.user_id = up.user_id
        join public.questions q on q.id = up.question_id
        where upper(coalesce(p.credential, '')) like 'SAA%'
          and (p_served_statuses is null or q.status = any(p_served_statuses))
        group by coalesce(q.domain_name, 'General')
    ),
    roster as (
        select
            c.full_name as name,
            c.email,
            c.credential,
            count(a.question_id)::integer as attempts,
            count(distinct a.question_id)::integer as answered,
            case when count(a.question_id) > 0
                then round(100.0 * count(*) filter (where a.is_correct) / count(a.question_id))::integer
                else null end as accuracy,
            max(a.created_at) as last_active
        from cohort c
        left join attempts a on a.user_id = c.user_id
        group by c.user_id, c.full_name, c.email, c.credential
    ),
    question_stats as (
        select
            question_id,
            min(stem) as stem,
            min(domain) as domain,
            min(question_type) as question_type,
            count(*)::integer as attempts,
            round(100.0 * count(*) filter (where is_correct) / count(*))::integer as pct_correct,
            round(avg(time_ms) filter (where time_ms > 0))::integer as avg_time_ms,
            round(100.0 * count(*) filter (where answer_changed is true)
                / nullif(count(*) filter (where answer_changed is not null), 0))::integer as change_rate
        from attempts
        group by question_id
        having count(*) >= 3
    ),
    hardest as (
        select *
        from question_stats
        order by pct_correct asc, attempts desc, question_id
        limit 15
    )
    select jsonb_build_object(
        'cohort_size', (select count(*)::integer from cohort),
        'summary', jsonb_build_object(
            'attempts', (select count(*)::integer from attempts),
            'answered', (select count(distinct question_id)::integer from attempts),
            'accuracy', (
                select case when count(*) > 0
                    then round(100.0 * count(*) filter (where is_correct) / count(*))::integer
                    else null end
                from attempts
            ),
            'active_7d', (
                select count(*)::integer from roster
                where last_active >= now() - interval '7 days'
            )
        ),
        'by_domain', coalesce((
            select jsonb_agg(jsonb_build_object(
                'domain', n.domain,
                'attempts', coalesce(d.attempts, 0),
                'correct', coalesce(d.correct, 0),
                'accuracy', case when coalesce(d.attempts, 0) > 0
                    then round(100.0 * d.correct / d.attempts)::integer else null end,
                'saa_accuracy', case when coalesce(s.attempts, 0) >= 20
                    then round(100.0 * s.correct / s.attempts)::integer else null end
            ) order by n.position)
            from nccaa n
            left join domain_stats d on d.domain = n.domain
            left join saa_domain_stats s on s.domain = n.domain
        ), '[]'::jsonb),
        'roster', coalesce((
            select jsonb_agg(jsonb_build_object(
                'name', r.name,
                'email', r.email,
                'credential', r.credential,
                'attempts', r.attempts,
                'answered', r.answered,
                'accuracy', r.accuracy,
                'last_active', r.last_active
            ) order by r.attempts desc, r.email)
            from roster r
        ), '[]'::jsonb),
        'hardest_items', coalesce((
            select jsonb_agg(jsonb_build_object(
                'question_id', h.question_id,
                'stem', case when length(regexp_replace(coalesce(h.stem, ''), '\\s+', ' ', 'g')) > 160
                    then left(regexp_replace(coalesce(h.stem, ''), '\\s+', ' ', 'g'), 157) || '...'
                    else regexp_replace(coalesce(h.stem, ''), '\\s+', ' ', 'g') end,
                'domain', h.domain,
                'question_type', h.question_type,
                'attempts', h.attempts,
                'pct_correct', h.pct_correct,
                'avg_time_ms', h.avg_time_ms,
                'change_rate', h.change_rate
            ) order by h.pct_correct, h.attempts desc, h.question_id)
            from hardest h
        ), '[]'::jsonb)
    );
$$;

create or replace function public.macprep_program_counts()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    select coalesce(jsonb_agg(jsonb_build_object('program', program, 'students', students) order by program), '[]'::jsonb)
    from (
        select trim(training_program) as program, count(*)::integer as students
        from public.user_profiles
        where trim(coalesce(training_program, '')) <> ''
        group by trim(training_program)
    ) as programs;
$$;

-- Leaderboard history is reduced to one JSON document instead of shipping every
-- attempt to Node. The client-facing name formatting/ranking remains in Express.
create or replace function public.macprep_leaderboard_rollup(
    p_current_user uuid,
    p_week_start timestamptz,
    p_since timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
    with selected_players as (
        select p.user_id, p.full_name, p.selected_title, coalesce(p.leaderboard_opt_in, false) as leaderboard_opt_in
        from public.user_profiles p
        where (p.leaderboard_opt_in is true and p.full_name is not null)
           or p.user_id = p_current_user
    ),
    stats as (
        select
            p.user_id,
            p.full_name,
            p.selected_title,
            p.leaderboard_opt_in,
            count(up.question_id) filter (where up.created_at >= p_week_start)::integer as weekly,
            count(up.question_id) filter (where up.created_at >= p_week_start and up.is_correct)::integer as correct,
            coalesce(jsonb_agg(distinct to_char(up.created_at at time zone 'America/New_York', 'YYYY-MM-DD'))
                filter (where up.created_at is not null), '[]'::jsonb) as study_days
        from selected_players p
        left join public.user_progress up
          on up.user_id = p.user_id
         and up.created_at >= p_since
        group by p.user_id, p.full_name, p.selected_title, p.leaderboard_opt_in
    )
    select jsonb_build_object(
        'players', coalesce((
            select jsonb_agg(jsonb_build_object(
                'user_id', user_id,
                'full_name', full_name,
                'selected_title', selected_title,
                'leaderboard_opt_in', leaderboard_opt_in,
                'weekly', weekly,
                'correct', correct,
                'study_days', study_days
            ))
            from stats
            where leaderboard_opt_in and full_name is not null
        ), '[]'::jsonb),
        'me', coalesce((
            select jsonb_build_object(
                'user_id', user_id,
                'full_name', full_name,
                'leaderboard_opt_in', leaderboard_opt_in,
                'weekly', weekly,
                'correct', correct,
                'study_days', study_days
            )
            from stats
            where user_id = p_current_user
        ), '{}'::jsonb)
    );
$$;

-- Account deletion spans application data and Supabase Auth. Keeping the deletes
-- inside one SECURITY DEFINER transaction prevents partial, falsely-successful
-- cleanup. Only the server's service_role may execute it.
create or replace function public.delete_macprep_account(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_user is null then
        raise exception 'A user id is required.';
    end if;

    delete from public.user_progress where user_id = p_user;
    delete from public.review_state where user_id = p_user;
    delete from public.user_flags where user_id = p_user;
    delete from public.user_flashcards where user_id = p_user;
    delete from public.user_notes where user_id = p_user;
    delete from public.push_subscriptions where user_id = p_user;
    delete from public.native_device_tokens where user_id = p_user;
    delete from public.analytics_events where user_id = p_user;
    delete from public.user_suggestions where user_id = p_user;
    delete from public.reviews where user_id = p_user;
    delete from public.program_vouchers where owner_director_id = p_user or claimed_by_id = p_user;
    delete from public.duels where creator_id = p_user or opponent_id = p_user;
    delete from public.user_profiles where user_id = p_user;
    delete from auth.users where id = p_user;

    if not found then
        raise exception 'Account not found.';
    end if;
end;
$$;

revoke all on function public.macprep_saa_benchmark(text[]) from public, anon, authenticated;
revoke all on function public.macprep_faculty_cohort_rollup(text, text[], text[]) from public, anon, authenticated;
revoke all on function public.macprep_program_counts() from public, anon, authenticated;
revoke all on function public.macprep_leaderboard_rollup(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.delete_macprep_account(uuid) from public, anon, authenticated;

grant execute on function public.macprep_saa_benchmark(text[]) to service_role;
grant execute on function public.macprep_faculty_cohort_rollup(text, text[], text[]) to service_role;
grant execute on function public.macprep_program_counts() to service_role;
grant execute on function public.macprep_leaderboard_rollup(uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.delete_macprep_account(uuid) to service_role;

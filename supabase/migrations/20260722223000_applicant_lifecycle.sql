-- Applicant-to-CAA lifecycle model. Premium entitlement remains independent.

alter table public.user_profiles
    add column if not exists lifecycle_stage text,
    add column if not exists matriculation_date date,
    add column if not exists applicant_progress jsonb not null default '{}'::jsonb,
    add column if not exists lifecycle_checkin_at timestamptz,
    add column if not exists lifecycle_checkin_snoozed_until date,
    add column if not exists certification_checkin_at timestamptz,
    add column if not exists certification_confirmed_at timestamptz,
    add column if not exists lifecycle_updated_at timestamptz;

-- Existing professional labels are enough to place current accounts. Unclassified
-- legacy accounts remain null so the application can ask instead of guessing.
update public.user_profiles
set lifecycle_stage = case
        when upper(trim(coalesce(credential, ''))) like 'CAA%' then 'practicing'
        when upper(trim(coalesce(credential, ''))) like 'SAA%' then 'student'
        else lifecycle_stage
    end,
    lifecycle_updated_at = coalesce(lifecycle_updated_at, updated_at, created_at)
where lifecycle_stage is null
  and upper(trim(coalesce(credential, ''))) like any (array['CAA%', 'SAA%']);

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'user_profiles_lifecycle_stage_check'
          and conrelid = 'public.user_profiles'::regclass
    ) then
        alter table public.user_profiles
            add constraint user_profiles_lifecycle_stage_check
            check (lifecycle_stage is null or lifecycle_stage in (
                'applicant', 'incoming_student', 'student', 'practicing'
            ));
    end if;

    if not exists (
        select 1 from pg_constraint
        where conname = 'user_profiles_applicant_progress_object_check'
          and conrelid = 'public.user_profiles'::regclass
    ) then
        alter table public.user_profiles
            add constraint user_profiles_applicant_progress_object_check
            check (jsonb_typeof(applicant_progress) = 'object'
                and pg_column_size(applicant_progress) <= 65536);
    end if;
end
$$;

create index if not exists idx_user_profiles_lifecycle_stage
    on public.user_profiles (lifecycle_stage, user_id);

create index if not exists idx_user_profiles_incoming_matriculation
    on public.user_profiles (matriculation_date, user_id)
    where lifecycle_stage = 'incoming_student';

-- Applicants and incoming students must never enter SAA peer benchmarks.
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
        where p.lifecycle_stage = 'student'
          and upper(coalesce(p.credential, '')) like 'SAA%'
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
        join public.questions q
          on q.id::text = up.question_id::text
         and q.answer_revision = up.answer_revision
        join public.user_profiles p on p.user_id = up.user_id
        where up.question_id::text = p_question
          and p.lifecycle_stage = 'student'
          and upper(coalesce(p.credential, '')) like 'SAA%'
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

create or replace function public.macprep_faculty_cohort_rollup(
    p_program text,
    p_served_statuses text[] default null,
    p_excluded_emails text[] default '{}'::text[]
)
returns jsonb
language sql
stable
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
    ), cohort as (
        select p.user_id, p.email, p.full_name, p.credential
        from public.user_profiles p
        where p.training_program = p_program
          and coalesce(p.is_program_director, false) is false
          and coalesce(p.is_faculty, false) is false
          and p.lifecycle_stage = 'student'
          and upper(coalesce(p.credential, '')) like 'SAA%'
          and lower(coalesce(p.email, '')) <> all(p_excluded_emails)
    ), attempts as (
        select up.user_id, up.question_id, up.is_correct, up.created_at,
               up.time_ms, up.answer_changed,
               coalesce(q.domain_name, 'General') as domain,
               q.stem, q.question_type
        from public.user_progress up
        join cohort c on c.user_id = up.user_id
        join public.questions q on q.id = up.question_id
        where p_served_statuses is null or q.status = any(p_served_statuses)
    ), domain_stats as (
        select domain, count(*)::integer as attempts,
               count(*) filter (where is_correct)::integer as correct
        from attempts
        group by domain
    ), saa_domain_stats as (
        select coalesce(q.domain_name, 'General') as domain,
               count(*)::integer as attempts,
               count(*) filter (where up.is_correct)::integer as correct
        from public.user_progress up
        join public.user_profiles p on p.user_id = up.user_id
        join public.questions q on q.id = up.question_id
        where p.lifecycle_stage = 'student'
          and upper(coalesce(p.credential, '')) like 'SAA%'
          and (p_served_statuses is null or q.status = any(p_served_statuses))
        group by coalesce(q.domain_name, 'General')
    ), roster as (
        select c.full_name as name, c.email, c.credential,
               count(a.question_id)::integer as attempts,
               count(distinct a.question_id)::integer as answered,
               case when count(a.question_id) > 0
                   then round(100.0 * count(*) filter (where a.is_correct) / count(a.question_id))::integer
                   else null end as accuracy,
               max(a.created_at) as last_active
        from cohort c
        left join attempts a on a.user_id = c.user_id
        group by c.user_id, c.full_name, c.email, c.credential
    ), question_stats as (
        select question_id, min(stem) as stem, min(domain) as domain,
               min(question_type) as question_type,
               count(*)::integer as attempts,
               round(100.0 * count(*) filter (where is_correct) / count(*))::integer as pct_correct,
               round(avg(time_ms) filter (where time_ms > 0))::integer as avg_time_ms,
               round(100.0 * count(*) filter (where answer_changed is true)
                   / nullif(count(*) filter (where answer_changed is not null), 0))::integer as change_rate
        from attempts
        group by question_id
        having count(*) >= 3
    ), hardest as (
        select * from question_stats
        order by pct_correct asc, attempts desc, question_id
        limit 15
    )
    select jsonb_build_object(
        'cohort_size', (select count(*)::integer from cohort),
        'summary', jsonb_build_object(
            'attempts', (select count(*)::integer from attempts),
            'answered', (select count(distinct question_id)::integer from attempts),
            'accuracy', (select case when count(*) > 0
                then round(100.0 * count(*) filter (where is_correct) / count(*))::integer
                else null end from attempts),
            'active_7d', (select count(*)::integer from roster
                where last_active >= now() - interval '7 days')
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
                'name', r.name, 'email', r.email, 'credential', r.credential,
                'attempts', r.attempts, 'answered', r.answered,
                'accuracy', r.accuracy, 'last_active', r.last_active
            ) order by r.attempts desc, r.email)
            from roster r
        ), '[]'::jsonb),
        'hardest_items', coalesce((
            select jsonb_agg(jsonb_build_object(
                'question_id', h.question_id,
                'stem', case when length(regexp_replace(coalesce(h.stem, ''), '\\s+', ' ', 'g')) > 160
                    then left(regexp_replace(coalesce(h.stem, ''), '\\s+', ' ', 'g'), 157) || '...'
                    else regexp_replace(coalesce(h.stem, ''), '\\s+', ' ', 'g') end,
                'domain', h.domain, 'question_type', h.question_type,
                'attempts', h.attempts, 'pct_correct', h.pct_correct,
                'avg_time_ms', h.avg_time_ms, 'change_rate', h.change_rate
            ) order by h.pct_correct, h.attempts desc, h.question_id)
            from hardest h
        ), '[]'::jsonb)
    );
$$;

create or replace function public.macprep_leaderboard_rollup(
    p_current_user uuid,
    p_week_start timestamptz,
    p_since timestamptz
)
returns jsonb
language sql
stable
set search_path = ''
as $$
    with selected_players as (
        select p.user_id, p.full_name, p.selected_title,
               coalesce(p.leaderboard_opt_in, false) as leaderboard_opt_in
        from public.user_profiles p
        where p.lifecycle_stage in ('student', 'practicing')
          and ((p.leaderboard_opt_in is true and p.full_name is not null)
               or p.user_id = p_current_user)
    ), latest_weekly as (
        select distinct on (up.user_id, up.question_id)
               up.user_id, up.question_id, up.is_correct
        from public.user_progress up
        join selected_players p on p.user_id = up.user_id
        where up.created_at >= p_week_start
        order by up.user_id, up.question_id, up.created_at desc, up.id desc
    ), weekly_stats as (
        select user_id, count(*)::integer as weekly,
               count(*) filter (where is_correct)::integer as correct
        from latest_weekly
        group by user_id
    ), day_stats as (
        select up.user_id,
               jsonb_agg(distinct to_char(up.created_at at time zone 'America/New_York', 'YYYY-MM-DD')) as study_days
        from public.user_progress up
        join selected_players p on p.user_id = up.user_id
        where up.created_at >= p_since
        group by up.user_id
    ), stats as (
        select p.user_id, p.full_name, p.selected_title, p.leaderboard_opt_in,
               coalesce(w.weekly, 0) as weekly,
               coalesce(w.correct, 0) as correct,
               coalesce(d.study_days, '[]'::jsonb) as study_days
        from selected_players p
        left join weekly_stats w on w.user_id = p.user_id
        left join day_stats d on d.user_id = p.user_id
    )
    select jsonb_build_object(
        'players', coalesce((
            select jsonb_agg(jsonb_build_object(
                'user_id', user_id, 'full_name', full_name,
                'selected_title', selected_title,
                'leaderboard_opt_in', leaderboard_opt_in,
                'weekly', weekly, 'correct', correct, 'study_days', study_days
            ))
            from stats
            where leaderboard_opt_in and full_name is not null
        ), '[]'::jsonb),
        'me', coalesce((
            select jsonb_build_object(
                'user_id', user_id, 'full_name', full_name,
                'leaderboard_opt_in', leaderboard_opt_in,
                'weekly', weekly, 'correct', correct, 'study_days', study_days
            )
            from stats
            where user_id = p_current_user
        ), '{}'::jsonb)
    );
$$;

create or replace function public.founder_metrics(
    p_window_days integer default 30,
    p_daily_days integer default 21,
    p_review_emails text[] default '{}'::text[]
)
returns jsonb
language sql
stable
set search_path = 'public'
as $$
with ev as (
  select name, created_at, user_id, meta
  from analytics_events
  where created_at >= now() - make_interval(days => p_window_days)
), days as (
  select generate_series((now() - make_interval(days => p_daily_days - 1))::date, now()::date, interval '1 day')::date as d
)
select jsonb_build_object(
  'users', (select jsonb_build_object(
      'total', count(*),
      'premium', count(*) filter (where account_tier = 'premium'),
      'free', count(*) filter (where account_tier is distinct from 'premium'),
      'with_exam_date', count(*) filter (where target_exam_date is not null)
    ) from user_profiles),
  'credential_mix', (select jsonb_build_object(
      'saa', count(*) filter (where upper(trim(credential)) like 'SAA%'),
      'caa', count(*) filter (where upper(trim(credential)) like 'CAA%'),
      'other', count(*) filter (where credential is not null and trim(credential) <> ''
          and upper(trim(credential)) not like 'SAA%' and upper(trim(credential)) not like 'CAA%'),
      'unset', count(*) filter (where credential is null or trim(credential) = '')
    ) from user_profiles),
  'lifecycle_mix', (select jsonb_build_object(
      'applicant', count(*) filter (where lifecycle_stage = 'applicant'),
      'incoming_student', count(*) filter (where lifecycle_stage = 'incoming_student'),
      'student', count(*) filter (where lifecycle_stage = 'student'),
      'practicing', count(*) filter (where lifecycle_stage = 'practicing'),
      'unset', count(*) filter (where lifecycle_stage is null)
    ) from user_profiles),
  'program_mix', (select coalesce(jsonb_agg(jsonb_build_object('program', program, 'n', n) order by n desc, program), '[]'::jsonb)
    from (
      select case when lower(trim(email)) = any(p_review_emails) then 'REVIEW'
                  else nullif(trim(training_program), '') end as program,
             count(*) as n
      from user_profiles
      where lifecycle_stage in ('incoming_student', 'student', 'practicing')
         or lower(trim(email)) = any(p_review_emails)
      group by 1
    ) p where program is not null),
  'program_unset', (select count(*) from user_profiles
      where lifecycle_stage in ('incoming_student', 'student', 'practicing')
        and not (lower(trim(email)) = any(p_review_emails))
        and (training_program is null or trim(training_program) = '')),
  'recent_signups', (select coalesce(jsonb_agg(r.j order by r.created_at desc), '[]'::jsonb) from (
      select created_at, jsonb_build_object(
        'email', email, 'tier', account_tier, 'lifecycle_stage', lifecycle_stage,
        'credential', case when upper(trim(credential)) like 'SAA%' then 'SAA'
                           when upper(trim(credential)) like 'CAA%' then 'CAA'
                           when credential is null or trim(credential) = '' then null else 'other' end,
        'joined', created_at, 'exam_date', target_exam_date,
        'grad_date', graduation_date, 'matriculation_date', matriculation_date,
        'program', case when lower(trim(email)) = any(p_review_emails) then 'REVIEW'
                        else nullif(trim(training_program), '') end
      ) as j
      from user_profiles order by created_at desc nulls last limit 12
    ) r),
  'signups_by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', m, 'n', n) order by m desc), '[]'::jsonb) from (
      select to_char(date_trunc('month', created_at), 'YYYY-MM') as m, count(*) as n
      from user_profiles
      where created_at >= date_trunc('month', now()) - interval '11 months'
      group by 1
    ) t),
  'event_counts', (select coalesce(jsonb_object_agg(name, n), '{}'::jsonb)
    from (select name, count(*) as n from ev group by name) t),
  'funnel', jsonb_build_object(
      'visits', (select count(distinct coalesce(meta->>'vid', created_at::text)) from ev where name = 'landing_view'),
      'signups', (select count(*) from user_profiles where created_at >= now() - make_interval(days => p_window_days)),
      'practiced', (select count(distinct user_id) from ev where name in ('session_start', 'quiz_start', 'session_complete') and user_id is not null),
      'paywall', (select count(distinct user_id) from ev where name = 'paywall_hit' and user_id is not null),
      'checkout', (select count(distinct user_id) from ev where name in ('checkout_started', 'upgrade_click') and user_id is not null),
      'purchased', (select count(*) from ev where name = 'purchase')
    ),
  'purchases_all_time', (select count(*) from analytics_events where name = 'purchase'),
  'daily', (select coalesce(jsonb_agg(jsonb_build_object(
        'date', to_char(days.d, 'YYYY-MM-DD'),
        'visits', coalesce(v.n, 0), 'signups', coalesce(s.n, 0),
        'sessions', coalesce(se.n, 0), 'purchases', coalesce(pu.n, 0)
      ) order by days.d), '[]'::jsonb)
    from days
    left join (select created_at::date dd, count(distinct coalesce(meta->>'vid', created_at::text)) n from ev where name = 'landing_view' group by 1) v on v.dd = days.d
    left join (select created_at::date dd, count(*) n from user_profiles group by 1) s on s.dd = days.d
    left join (select created_at::date dd, count(*) n from ev where name = 'session_start' group by 1) se on se.dd = days.d
    left join (select created_at::date dd, count(*) n from ev where name = 'purchase' group by 1) pu on pu.dd = days.d)
);
$$;

revoke all on function public.macprep_saa_benchmark(text[]) from public, anon, authenticated;
revoke all on function public.macprep_saa_question_stats(text) from public, anon, authenticated;
revoke all on function public.macprep_faculty_cohort_rollup(text, text[], text[]) from public, anon, authenticated;
revoke all on function public.macprep_leaderboard_rollup(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.founder_metrics(integer, integer, text[]) from public, anon, authenticated;

grant execute on function public.macprep_saa_benchmark(text[]) to service_role;
grant execute on function public.macprep_saa_question_stats(text) to service_role;
grant execute on function public.macprep_faculty_cohort_rollup(text, text[], text[]) to service_role;
grant execute on function public.macprep_leaderboard_rollup(uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.founder_metrics(integer, integer, text[]) to service_role;

comment on column public.user_profiles.lifecycle_stage is
    'AA journey stage, separate from credential and premium entitlement.';
comment on column public.user_profiles.applicant_progress is
    'Sanitized applicant checklist, prerequisite, shadowing, and program-tracker state.';

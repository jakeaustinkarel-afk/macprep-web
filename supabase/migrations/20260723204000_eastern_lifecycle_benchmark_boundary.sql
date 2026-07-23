begin;

-- Keep SAA peer membership aligned with the same Eastern calendar date used by
-- lifecycle transitions in the application. PostgreSQL current_date follows
-- the database session timezone and can otherwise remove an SAA several hours
-- before their account actually advances to the practicing stage.
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
          and (
              p.graduation_date is null
              or p.graduation_date > (now() at time zone 'America/New_York')::date
          )
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

revoke all on function public.macprep_saa_benchmark(text[])
    from public, anon, authenticated;
grant execute on function public.macprep_saa_benchmark(text[])
    to service_role;

commit;

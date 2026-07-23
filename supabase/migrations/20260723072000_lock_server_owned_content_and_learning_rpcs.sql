begin;

-- Questions, answer keys, and grading metadata are served only through Express.
-- Record the live deny-by-default posture so staging and disaster recovery do
-- not accidentally expose the canonical question table through PostgREST.
alter table public.questions enable row level security;

do $$
declare
    policy_row record;
begin
    for policy_row in
        select policyname
        from pg_policies
        where schemaname = 'public'
          and tablename = 'questions'
    loop
        execute format(
            'drop policy if exists %I on public.questions',
            policy_row.policyname
        );
    end loop;
end;
$$;

revoke all on table public.questions from public, anon, authenticated;
grant all on table public.questions to service_role;

-- These learning helpers predate the migration history. Keep their definitions
-- reproducible and callable only by the server's service-role client.
create or replace function public.distinct_answered(p_user uuid)
returns integer
language sql
stable
set search_path = pg_catalog, public
as $$
    select count(distinct question_id)::integer
    from user_progress
    where user_id = p_user;
$$;

create or replace function public.sm2_review(
    p_user uuid,
    p_question text,
    p_quality integer
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
    v_rep integer;
    v_ef real;
    v_int integer;
begin
    select repetitions, ease_factor, interval_days
    into v_rep, v_ef, v_int
    from review_state
    where user_id = p_user
      and question_id = p_question;

    if not found then
        v_rep := 0;
        v_ef := 2.5;
        v_int := 0;
    end if;

    v_ef := v_ef + (0.1 - (5 - p_quality) * (0.08 + (5 - p_quality) * 0.02));
    if v_ef < 1.3 then v_ef := 1.3; end if;

    if p_quality < 3 then
        v_rep := 0;
        v_int := 1;
    else
        v_rep := v_rep + 1;
        if v_rep = 1 then v_int := 1;
        elsif v_rep = 2 then v_int := 3;
        elsif v_rep = 3 then v_int := 7;
        else v_int := greatest(1, round(v_int * v_ef)::integer);
        end if;
    end if;

    insert into review_state (
        user_id,
        question_id,
        repetitions,
        ease_factor,
        interval_days,
        due_at,
        last_reviewed_at
    )
    values (
        p_user,
        p_question,
        v_rep,
        v_ef,
        v_int,
        now() + make_interval(days => v_int),
        now()
    )
    on conflict (user_id, question_id) do update
    set repetitions = excluded.repetitions,
        ease_factor = excluded.ease_factor,
        interval_days = excluded.interval_days,
        due_at = excluded.due_at,
        last_reviewed_at = excluded.last_reviewed_at;
end;
$$;

create or replace function public.enforce_free_tier_ceiling()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
    v_is_premium boolean;
    v_ceiling integer := 25;
    v_distinct integer;
begin
    perform pg_advisory_xact_lock(hashtext(new.user_id::text));

    select account_tier = 'premium'
    into v_is_premium
    from user_profiles
    where user_id = new.user_id;

    if v_is_premium is true then return new; end if;

    if exists (
        select 1
        from user_progress
        where user_id = new.user_id
          and question_id = new.question_id
    ) then
        return new;
    end if;

    select count(distinct question_id)
    into v_distinct
    from user_progress
    where user_id = new.user_id;

    if v_distinct >= v_ceiling then
        raise exception 'free_tier_limit_reached'
            using errcode = 'check_violation';
    end if;

    return new;
end;
$$;

revoke all on function public.distinct_answered(uuid)
    from public, anon, authenticated;
revoke all on function public.sm2_review(uuid, text, integer)
    from public, anon, authenticated;
revoke all on function public.enforce_free_tier_ceiling()
    from public, anon, authenticated;

grant execute on function public.distinct_answered(uuid) to service_role;
grant execute on function public.sm2_review(uuid, text, integer) to service_role;
grant execute on function public.enforce_free_tier_ceiling() to service_role;

commit;

-- Keep repeat practice, provider entitlements, and native purchase recovery
-- consistent after the July 18 account/progress migrations.

create or replace function public.grant_macprep_entitlement(
    p_user uuid,
    p_email text,
    p_source text,
    p_source_reference text,
    p_external_payment_id text default null,
    p_product_id text default null,
    p_amount_total bigint default null,
    p_currency text default null,
    p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    existing_user uuid;
    has_access boolean;
begin
    if p_user is null or p_source_reference is null or btrim(p_source_reference) = '' then
        raise exception 'A user and source reference are required.';
    end if;
    if p_source not in ('stripe', 'apple', 'google_play', 'voucher', 'program', 'admin', 'legacy') then
        raise exception 'Unsupported entitlement source.';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_source || ':' || p_source_reference, 0));
    select user_id into existing_user
    from public.account_entitlements
    where source = p_source and source_reference = p_source_reference
    for update;
    if existing_user is not null and existing_user <> p_user then
        raise exception 'This entitlement is already linked to another account.';
    end if;

    insert into public.account_entitlements (
        user_id, source, source_reference, external_payment_id, product_id,
        status, amount_total, currency, metadata, status_updated_at
    ) values (
        p_user, p_source, p_source_reference, p_external_payment_id, p_product_id,
        'active', p_amount_total, lower(p_currency), coalesce(p_metadata, '{}'::jsonb), now()
    )
    on conflict (source, source_reference) do update set
        external_payment_id = coalesce(excluded.external_payment_id, public.account_entitlements.external_payment_id),
        product_id = coalesce(excluded.product_id, public.account_entitlements.product_id),
        amount_total = coalesce(excluded.amount_total, public.account_entitlements.amount_total),
        currency = coalesce(excluded.currency, public.account_entitlements.currency),
        metadata = public.account_entitlements.metadata || excluded.metadata,
        -- A delayed completion/restore must not undo a refund, revocation, or dispute.
        status = case
            when public.account_entitlements.status in ('refunded', 'revoked', 'disputed')
                then public.account_entitlements.status
            else 'active'
        end,
        status_updated_at = case
            when public.account_entitlements.status in ('refunded', 'revoked', 'disputed')
                then public.account_entitlements.status_updated_at
            else now()
        end;

    if p_source <> 'legacy' then
        update public.account_entitlements
        set status = 'superseded', status_updated_at = now()
        where user_id = p_user and source = 'legacy' and status = 'active';
    end if;

    insert into public.user_profiles (user_id, email)
    values (p_user, nullif(lower(btrim(p_email)), ''))
    on conflict (user_id) do update set
        email = coalesce(public.user_profiles.email, excluded.email);

    select public.recompute_macprep_entitlement(p_user) into has_access;
    return has_access;
end;
$$;

create or replace function public.sync_macprep_provider_entitlement(
    p_user uuid,
    p_email text,
    p_source text,
    p_source_reference text,
    p_external_payment_id text default null,
    p_product_id text default null,
    p_status text default 'active',
    p_amount_total bigint default null,
    p_currency text default null,
    p_metadata jsonb default '{}'::jsonb,
    p_allow_reactivate boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    existing_id uuid;
    existing_user uuid;
    existing_status text;
    effective_status text;
    has_access boolean;
begin
    if p_user is null or p_source_reference is null or btrim(p_source_reference) = '' then
        raise exception 'A user and source reference are required.';
    end if;
    if p_source not in ('stripe', 'apple', 'google_play') then
        raise exception 'Unsupported provider entitlement source.';
    end if;
    if p_status not in ('active', 'refunded', 'revoked', 'disputed') then
        raise exception 'Unsupported provider entitlement status.';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
        p_source || ':' || coalesce(nullif(p_external_payment_id, ''), p_source_reference), 0
    ));

    select id, user_id, status
    into existing_id, existing_user, existing_status
    from public.account_entitlements
    where source = p_source
      and (
        source_reference = p_source_reference
        or (p_external_payment_id is not null and external_payment_id = p_external_payment_id)
      )
    order by (source_reference = p_source_reference) desc
    limit 1
    for update;

    if existing_user is not null and existing_user <> p_user then
        raise exception 'This entitlement is already linked to another account.';
    end if;

    effective_status := p_status;
    if existing_id is not null
       and p_status = 'active'
       and existing_status in ('refunded', 'revoked', 'disputed')
       and not p_allow_reactivate then
        effective_status := existing_status;
    end if;

    if existing_id is null then
        insert into public.account_entitlements (
            user_id, source, source_reference, external_payment_id, product_id,
            status, amount_total, currency, metadata, status_updated_at
        ) values (
            p_user, p_source, p_source_reference, p_external_payment_id, p_product_id,
            effective_status, p_amount_total, lower(p_currency), coalesce(p_metadata, '{}'::jsonb), now()
        );
    else
        update public.account_entitlements
        set external_payment_id = coalesce(p_external_payment_id, external_payment_id),
            product_id = coalesce(p_product_id, product_id),
            amount_total = coalesce(p_amount_total, amount_total),
            currency = coalesce(lower(p_currency), currency),
            metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
            status = effective_status,
            status_updated_at = case when status = effective_status then status_updated_at else now() end
        where id = existing_id;
    end if;

    update public.account_entitlements
    set status = 'superseded', status_updated_at = now()
    where user_id = p_user and source = 'legacy' and status = 'active';

    insert into public.user_profiles (user_id, email)
    values (p_user, nullif(lower(btrim(p_email)), ''))
    on conflict (user_id) do update set
        email = coalesce(public.user_profiles.email, excluded.email);

    select public.recompute_macprep_entitlement(p_user) into has_access;
    return has_access;
end;
$$;

create or replace function public.set_macprep_entitlement_status(
    p_source text,
    p_source_reference text,
    p_external_payment_id text,
    p_status text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    target_id uuid;
    target_user uuid;
begin
    if p_status not in ('active', 'refunded', 'revoked', 'disputed', 'superseded') then
        raise exception 'Unsupported entitlement status.';
    end if;

    select id, user_id into target_id, target_user
    from public.account_entitlements
    where source = p_source
      and (
        (p_source_reference is not null and source_reference = p_source_reference)
        or (p_external_payment_id is not null and external_payment_id = p_external_payment_id)
      )
    order by (p_source_reference is not null and source_reference = p_source_reference) desc
    limit 1
    for update;

    if target_id is not null then
        update public.account_entitlements
        set status = p_status, status_updated_at = now()
        where id = target_id;
        perform public.recompute_macprep_entitlement(target_user);
    end if;
    return target_user;
end;
$$;

-- Google Pub/Sub only supplies the account hash stored with the purchase. Resolve
-- it server-side without exposing the user roster to browser roles.
create or replace function public.macprep_user_id_from_mobile_hash(p_hash text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
    select u.id
    from auth.users u
    where p_hash ~ '^[0-9a-f]{64}$'
      and encode(extensions.digest(lower(u.id::text), 'sha256'), 'hex') = p_hash
    limit 1;
$$;

-- Repeat practice should count as another attempt, but never as several distinct
-- leaderboard questions. Accuracy uses the latest answer to each question that week.
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
        select p.user_id, p.full_name, p.selected_title,
               coalesce(p.leaderboard_opt_in, false) as leaderboard_opt_in
        from public.user_profiles p
        where (p.leaderboard_opt_in is true and p.full_name is not null)
           or p.user_id = p_current_user
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

-- The Missed set follows the latest attempt. A later miss should return to review,
-- and a later correct response should clear it.
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
        select id, question_id, is_correct, coalesce(category, 'Uncategorized') as category,
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

revoke all on function public.grant_macprep_entitlement(uuid, text, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.set_macprep_entitlement_status(text, text, text, text) from public, anon, authenticated;
revoke all on function public.sync_macprep_provider_entitlement(uuid, text, text, text, text, text, text, bigint, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.macprep_user_id_from_mobile_hash(text) from public, anon, authenticated;
revoke all on function public.macprep_leaderboard_rollup(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.macprep_user_learning_rollup(uuid, integer, text[]) from public, anon, authenticated;
grant execute on function public.grant_macprep_entitlement(uuid, text, text, text, text, text, bigint, text, jsonb) to service_role;
grant execute on function public.set_macprep_entitlement_status(text, text, text, text) to service_role;
grant execute on function public.sync_macprep_provider_entitlement(uuid, text, text, text, text, text, text, bigint, text, jsonb, boolean) to service_role;
grant execute on function public.macprep_user_id_from_mobile_hash(text) to service_role;
grant execute on function public.macprep_leaderboard_rollup(uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.macprep_user_learning_rollup(uuid, integer, text[]) to service_role;

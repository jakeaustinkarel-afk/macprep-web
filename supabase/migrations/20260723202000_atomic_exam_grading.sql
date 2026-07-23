begin;

create or replace function public.grade_macprep_exam_attempts(
    p_user uuid,
    p_submission uuid,
    p_attempts jsonb
)
returns table (
    question_id text,
    selected_label text,
    is_correct boolean,
    answer_revision integer,
    inserted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt jsonb;
    v_expected integer;
    v_existing integer;
    v_current_revision integer;
    v_question text;
begin
    if p_submission is null then
        raise exception 'submission_id_required';
    end if;
    if jsonb_typeof(p_attempts) <> 'array' then
        raise exception 'attempts_array_required';
    end if;

    v_expected := jsonb_array_length(p_attempts);
    if v_expected < 1 or v_expected > 200 then
        raise exception 'invalid_attempt_count';
    end if;
    if (
        select count(*) <> count(distinct attempt->>'question_id')
        from jsonb_array_elements(p_attempts) attempt
    ) then
        raise exception 'duplicate_question';
    end if;

    perform pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_submission::text));

    select count(*)
    into v_existing
    from public.user_progress up
    where up.user_id = p_user
      and up.submission_id = p_submission;

    if v_existing > 0 then
        if v_existing <> v_expected
           or exists (
                select 1
                from public.user_progress up
                where up.user_id = p_user
                  and up.submission_id = p_submission
                  and not exists (
                      select 1
                      from jsonb_array_elements(p_attempts) attempt
                      where attempt->>'question_id' = up.question_id::text
                  )
           ) then
            raise exception 'submission_conflict';
        end if;

        if exists (
            select 1
            from public.user_progress up
            left join public.questions q on q.id::text = up.question_id::text
            where up.user_id = p_user
              and up.submission_id = p_submission
              and (q.id is null or up.answer_revision <> q.answer_revision)
        ) then
            raise exception 'stale_question';
        end if;

        return query
        select up.question_id::text, up.selected_label, up.is_correct,
               up.answer_revision, false
        from public.user_progress up
        where up.user_id = p_user
          and up.submission_id = p_submission
        order by up.question_id;
        return;
    end if;

    -- Validate every row before the first write. A failure anywhere rolls back
    -- both the answer batch and every associated SM-2 review update.
    for v_attempt in select value from jsonb_array_elements(p_attempts)
    loop
        v_question := trim(coalesce(v_attempt->>'question_id', ''));
        if v_question = ''
           or coalesce(v_attempt->>'selected_label', '') !~ '^[A-E]$' then
            raise exception 'invalid_attempt';
        end if;

        select q.answer_revision
        into v_current_revision
        from public.questions q
        where q.id::text = v_question
        for share;

        if not found then
            raise exception 'question_not_found';
        end if;
        if coalesce((v_attempt->>'answer_revision')::integer, 0) <> v_current_revision then
            raise exception 'stale_question';
        end if;
    end loop;

    for v_attempt in select value from jsonb_array_elements(p_attempts)
    loop
        v_question := trim(v_attempt->>'question_id');

        insert into public.user_progress (
            user_id, question_id, submission_id, answer_revision, specialty,
            category, selected_label, is_correct, confidence, time_ms,
            answer_changed
        )
        values (
            p_user,
            v_question,
            p_submission,
            (v_attempt->>'answer_revision')::integer,
            nullif(v_attempt->>'specialty', ''),
            nullif(v_attempt->>'category', ''),
            v_attempt->>'selected_label',
            (v_attempt->>'is_correct')::boolean,
            nullif(v_attempt->>'confidence', ''),
            greatest(0, least(3600000, coalesce((v_attempt->>'time_ms')::integer, 0))),
            coalesce((v_attempt->>'answer_changed')::boolean, false)
        );

        perform public.sm2_review(
            p_user,
            v_question,
            greatest(0, least(5, coalesce((v_attempt->>'quality')::integer, 0)))
        );
    end loop;

    return query
    select up.question_id::text, up.selected_label, up.is_correct,
           up.answer_revision, true
    from public.user_progress up
    where up.user_id = p_user
      and up.submission_id = p_submission
    order by up.question_id;
end;
$$;

revoke all on function public.grade_macprep_exam_attempts(uuid, uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.grade_macprep_exam_attempts(uuid, uuid, jsonb)
    to service_role;

commit;

begin;

-- A clean database must enforce the free-question ceiling even if a request
-- reaches Postgres through a path other than the normal Express pre-check.
drop trigger if exists trg_enforce_free_tier on public.user_progress;
create trigger trg_enforce_free_tier
before insert on public.user_progress
for each row execute function public.enforce_free_tier_ceiling();

-- Preserve the answer layout the learner actually saw. A concurrent editorial
-- update must reject the attempt rather than silently stamping the new revision.
create or replace function public.stamp_macprep_progress_answer_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_current_revision integer;
begin
    select q.answer_revision
    into v_current_revision
    from public.questions q
    where q.id::text = new.question_id::text;

    if not found then
        raise exception 'question_not_found';
    end if;
    if new.answer_revision is not null
       and new.answer_revision <> v_current_revision then
        raise exception 'stale_question';
    end if;

    new.answer_revision := v_current_revision;
    return new;
end;
$$;

-- Serialize SM-2 updates for the same learner/question so simultaneous device
-- requests cannot overwrite a newer review interval with stale values.
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
    perform pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_question));

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
        user_id, question_id, repetitions, ease_factor, interval_days,
        due_at, last_reviewed_at
    )
    values (
        p_user, p_question, v_rep, v_ef, v_int,
        now() + make_interval(days => v_int), now()
    )
    on conflict (user_id, question_id) do update
    set repetitions = excluded.repetitions,
        ease_factor = excluded.ease_factor,
        interval_days = excluded.interval_days,
        due_at = excluded.due_at,
        last_reviewed_at = excluded.last_reviewed_at;
end;
$$;

create or replace function public.grade_macprep_tutor_attempt(
    p_user uuid,
    p_question text,
    p_submission uuid,
    p_answer_revision integer,
    p_specialty text,
    p_category text,
    p_selected_label text,
    p_is_correct boolean,
    p_confidence text,
    p_time_ms integer,
    p_answer_changed boolean,
    p_quality integer
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
    v_current_revision integer;
    v_existing_question text;
begin
    if p_submission is null then
        raise exception 'submission_id_required';
    end if;

    perform pg_advisory_xact_lock(hashtext(p_user::text || ':' || p_submission::text));

    select q.answer_revision
    into v_current_revision
    from public.questions q
    where q.id::text = p_question
    for share;

    if not found then
        raise exception 'question_not_found';
    end if;
    if p_answer_revision is null or p_answer_revision <> v_current_revision then
        raise exception 'stale_question';
    end if;

    select up.question_id::text
    into v_existing_question
    from public.user_progress up
    where up.user_id = p_user
      and up.submission_id = p_submission
    limit 1;

    if found then
        if v_existing_question <> p_question then
            raise exception 'submission_conflict';
        end if;
        return query
        select up.question_id::text, up.selected_label, up.is_correct,
               up.answer_revision, false
        from public.user_progress up
        where up.user_id = p_user
          and up.submission_id = p_submission
          and up.question_id::text = p_question
        limit 1;
        return;
    end if;

    insert into public.user_progress (
        user_id, question_id, submission_id, answer_revision, specialty,
        category, selected_label, is_correct, confidence, time_ms,
        answer_changed
    )
    values (
        p_user, p_question, p_submission, p_answer_revision, p_specialty,
        p_category, p_selected_label, p_is_correct, p_confidence, p_time_ms,
        p_answer_changed
    );

    perform public.sm2_review(p_user, p_question, greatest(0, least(5, p_quality)));

    return query
    select up.question_id::text, up.selected_label, up.is_correct,
           up.answer_revision, true
    from public.user_progress up
    where up.user_id = p_user
      and up.submission_id = p_submission
      and up.question_id::text = p_question
    limit 1;
end;
$$;

revoke all on function public.stamp_macprep_progress_answer_revision()
    from public, anon, authenticated;
revoke all on function public.sm2_review(uuid, text, integer)
    from public, anon, authenticated;
revoke all on function public.grade_macprep_tutor_attempt(
    uuid, text, uuid, integer, text, text, text, boolean, text, integer, boolean, integer
) from public, anon, authenticated;

grant execute on function public.sm2_review(uuid, text, integer) to service_role;
grant execute on function public.grade_macprep_tutor_attempt(
    uuid, text, uuid, integer, text, text, text, boolean, text, integer, boolean, integer
) to service_role;

commit;

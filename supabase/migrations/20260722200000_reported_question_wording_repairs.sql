-- Repair the reported obstetric answer wording and verify the published bank
-- for the same high-confidence structural and mechanical text defects.

do $repair$
declare
    repaired_rows integer;
begin
    update public.questions
    set choices = jsonb_set(
            choices,
            '{0,text}',
            to_jsonb('Reduced functional residual capacity with higher oxygen consumption causing rapid desaturation, plus decreased lower esophageal sphincter tone and a vascular, edematous airway.'::text),
            false
        ),
        teaching_debrief = '{}'::jsonb,
        debrief_reviewed_at = null,
        debrief_reviewed_by = null
    where id::text = 'authored-batch-r6-026'
      and status = 'published'
      and upper(correct_answer) = 'A'
      and choices #>> '{0,label}' = 'A'
      and (choices #>> '{0,correct}')::boolean is true
      and choices #>> '{0,text}' = 'Reduced functional residual capacity with higher oxygen consumption causing rapid desaturation, plus lower esophageal sphincter tone and a vascular, edematous airway.';

    get diagnostics repaired_rows = row_count;
    if repaired_rows <> 1 then
        raise exception 'Expected exactly one authored-batch-r6-026 wording repair, updated % rows', repaired_rows;
    end if;
end;
$repair$;

do $postflight$
declare
    integrity_issues integer;
    wording_issues integer;
    polarity_issues integer;
begin
    with per_question as (
        select q.id,
               jsonb_typeof(q.choices) as choices_type,
               case when jsonb_typeof(q.choices) = 'array' then jsonb_array_length(q.choices) else 0 end as choice_count,
               upper(coalesce(q.correct_answer, '')) as correct_answer,
               count(*) filter (where coalesce((c.choice ->> 'correct')::boolean, false)) as correct_flags,
               count(*) filter (
                   where coalesce((c.choice ->> 'correct')::boolean, false)
                     and upper(coalesce(c.choice ->> 'label', '')) = upper(coalesce(q.correct_answer, ''))
               ) as aligned_correct_flags,
               count(distinct upper(coalesce(c.choice ->> 'label', ''))) as distinct_labels,
               count(*) filter (where btrim(coalesce(c.choice ->> 'text', '')) = '') as blank_choices,
               count(*) filter (where btrim(coalesce(c.choice ->> 'rationale', '')) = '') as blank_rationales
        from public.questions q
        left join lateral jsonb_array_elements(
            case when jsonb_typeof(q.choices) = 'array' then q.choices else '[]'::jsonb end
        ) c(choice) on true
        where q.status = 'published'
        group by q.id, q.choices, q.correct_answer
    )
    select count(*)::integer into integrity_issues
    from per_question
    where choices_type is distinct from 'array'
       or choice_count not between 4 and 5
       or correct_answer !~ '^[A-E]$'
       or correct_flags <> 1
       or aligned_correct_flags <> 1
       or distinct_labels <> choice_count
       or blank_choices > 0
       or blank_rationales > 0;

    with text_fields as (
        select q.id::text as question_id, 'stem'::text as field, q.stem as value
        from public.questions q where q.status = 'published'
        union all
        select q.id::text, 'explanation', q.explanation
        from public.questions q where q.status = 'published'
        union all
        select q.id::text, 'choice_' || coalesce(c.choice ->> 'label', '?'), c.choice ->> 'text'
        from public.questions q
        cross join lateral jsonb_array_elements(q.choices) c(choice)
        where q.status = 'published'
        union all
        select q.id::text, 'rationale_' || coalesce(c.choice ->> 'label', '?'), c.choice ->> 'rationale'
        from public.questions q
        cross join lateral jsonb_array_elements(q.choices) c(choice)
        where q.status = 'published'
    )
    select count(*)::integer into wording_issues
    from text_fields
    where btrim(coalesce(value, '')) = ''
       or value ~* '\m([a-z][a-z]+)[[:space:]]+\1\M'
       or value like '%  %'
       or value ~ '[[:space:]][,;.!?]'
       or (length(value) - length(replace(value, '(', ''))) <> (length(value) - length(replace(value, ')', '')))
       or (length(value) - length(replace(value, '[', ''))) <> (length(value) - length(replace(value, ']', '')))
       or value ~* '\mplus[[:space:]]+lower[[:space:]]+esophageal[[:space:]]+sphincter[[:space:]]+tone\M';

    select count(*)::integer into polarity_issues
    from public.questions q
    cross join lateral jsonb_array_elements(q.choices) c(choice)
    where q.status = 'published'
      and (
          (
              upper(coalesce(c.choice ->> 'label', '')) = upper(q.correct_answer)
              and ltrim(coalesce(c.choice ->> 'rationale', '')) ~* '^(incorrect|wrong|this is false|not correct)([.:]|$)'
          )
          or (
              upper(coalesce(c.choice ->> 'label', '')) <> upper(q.correct_answer)
              and ltrim(coalesce(c.choice ->> 'rationale', '')) ~* '^(correct|this is correct|yes)([.:]|$)'
          )
      );

    if integrity_issues <> 0 or wording_issues <> 0 or polarity_issues <> 0 then
        raise exception 'Published question audit failed: integrity %, wording %, rationale polarity %',
            integrity_issues, wording_issues, polarity_issues;
    end if;

    if not exists (
        select 1
        from public.questions q
        where q.id::text = 'authored-batch-r6-026'
          and upper(q.correct_answer) = 'A'
          and q.choices #>> '{0,text}' = 'Reduced functional residual capacity with higher oxygen consumption causing rapid desaturation, plus decreased lower esophageal sphincter tone and a vascular, edematous airway.'
          and q.debrief_reviewed_at is null
          and q.debrief_reviewed_by is null
    ) then
        raise exception 'authored-batch-r6-026 wording repair did not pass postflight verification';
    end if;
end;
$postflight$;

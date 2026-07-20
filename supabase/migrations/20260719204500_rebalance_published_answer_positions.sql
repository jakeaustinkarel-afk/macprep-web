-- Rounds 37-49 were imported with the clinically correct choice concentrated in
-- position A. Reorder choices deterministically while preserving every choice,
-- rationale, correctness flag, citation, and question status.

do $preflight$
declare
    invalid_rows integer;
begin
    select count(*)::integer into invalid_rows
    from public.questions q
    where q.status = 'published'
      and regexp_replace(q.id, '-[0-9]+$', '') in (
        'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
        'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
        'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
        'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
        'authored-batch-r49'
      )
      and (
        jsonb_typeof(q.choices) <> 'array'
        or case when jsonb_typeof(q.choices) = 'array' then jsonb_array_length(q.choices) else 0 end <> 5
        or coalesce(upper(q.correct_answer), '') not in ('A', 'B', 'C', 'D', 'E')
        or case when jsonb_typeof(q.choices) = 'array' then (
          select count(*)
          from jsonb_array_elements(q.choices) choice
          where coalesce((choice->>'correct')::boolean, false)
        ) else 0 end <> 1
        or case when jsonb_typeof(q.choices) = 'array' then (
          select choice->>'label'
          from jsonb_array_elements(q.choices) choice
          where coalesce((choice->>'correct')::boolean, false)
          limit 1
        ) else null end is distinct from upper(q.correct_answer)
      );

    if invalid_rows > 0 then
        raise exception 'Answer-position repair stopped: % affected question(s) failed structural validation.', invalid_rows;
    end if;
end;
$preflight$;

with ranked as (
    select
        q.id,
        q.choices,
        upper(q.correct_answer) as correct_answer,
        regexp_replace(q.id, '-[0-9]+$', '') as batch,
        substring(regexp_replace(q.id, '-[0-9]+$', '') from 'r([0-9]+)$')::integer as round_number,
        row_number() over (
            partition by regexp_replace(q.id, '-[0-9]+$', '')
            order by md5(q.id)
        ) as batch_position
    from public.questions q
    where q.status = 'published'
      and regexp_replace(q.id, '-[0-9]+$', '') in (
        'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
        'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
        'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
        'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
        'authored-batch-r49'
      )
), positioned as (
    select
        ranked.*,
        (((round_number + batch_position - 1) % 5) + 1)::integer as target_index,
        ascii(correct_answer) - 64 as correct_index
    from ranked
), expanded as (
    select
        positioned.id,
        positioned.target_index,
        item.choice,
        case
            when item.old_index::integer = positioned.correct_index then positioned.target_index
            when item.old_index::integer = positioned.target_index then positioned.correct_index
            else item.old_index::integer
        end as new_index
    from positioned
    cross join lateral jsonb_array_elements(positioned.choices)
        with ordinality as item(choice, old_index)
), rebuilt as (
    select
        id,
        target_index,
        jsonb_agg(
            jsonb_set(choice, '{label}', to_jsonb(chr(64 + new_index)), true)
            order by new_index
        ) as choices
    from expanded
    group by id, target_index
)
update public.questions q
set choices = rebuilt.choices,
    correct_answer = chr(64 + rebuilt.target_index)
from rebuilt
where q.id = rebuilt.id;

do $postflight$
declare
    invalid_rows integer;
    unbalanced_batches integer;
begin
    select count(*)::integer into invalid_rows
    from public.questions q
    where q.status = 'published'
      and regexp_replace(q.id, '-[0-9]+$', '') in (
        'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
        'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
        'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
        'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
        'authored-batch-r49'
      )
      and (
        (select count(*) from jsonb_array_elements(q.choices) choice
         where coalesce((choice->>'correct')::boolean, false)) <> 1
        or (select choice->>'label' from jsonb_array_elements(q.choices) choice
            where coalesce((choice->>'correct')::boolean, false) limit 1)
            is distinct from upper(q.correct_answer)
        or (select string_agg(choice->>'label', '' order by ordinality)
            from jsonb_array_elements(q.choices) with ordinality item(choice, ordinality)) <> 'ABCDE'
      );

    with affected as (
        select regexp_replace(q.id, '-[0-9]+$', '') as batch, upper(q.correct_answer) as answer
        from public.questions q
        where q.status = 'published'
          and regexp_replace(q.id, '-[0-9]+$', '') in (
            'authored-batch-r37', 'authored-batch-r38', 'authored-batch-r39',
            'authored-batch-r40', 'authored-batch-r41', 'authored-batch-r42',
            'authored-batch-r43', 'authored-batch-r44', 'authored-batch-r45',
            'authored-batch-r46', 'authored-batch-r47', 'authored-batch-r48',
            'authored-batch-r49'
          )
    ), labels(answer) as (values ('A'), ('B'), ('C'), ('D'), ('E')),
    batches as (select distinct batch from affected),
    counts as (
        select batches.batch, labels.answer, count(affected.answer)::integer as n
        from batches cross join labels
        left join affected using (batch, answer)
        group by batches.batch, labels.answer
    )
    select count(*)::integer into unbalanced_batches
    from (select batch from counts group by batch having max(n) - min(n) > 1) skewed;

    if invalid_rows > 0 or unbalanced_batches > 0 then
        raise exception 'Answer-position repair failed postflight: % invalid row(s), % unbalanced batch(es).', invalid_rows, unbalanced_batches;
    end if;
end;
$postflight$;

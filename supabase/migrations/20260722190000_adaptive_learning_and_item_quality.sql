-- Adaptive-learning release: reviewed teaching debriefs plus privacy-safe,
-- service-role-only item quality signals. The learner plan itself is computed
-- from existing progress and review-state data, so it needs no new user table.

alter table public.questions
    add column if not exists teaching_debrief jsonb not null default '{}'::jsonb,
    add column if not exists debrief_reviewed_at timestamptz,
    add column if not exists debrief_reviewed_by uuid;

comment on column public.questions.teaching_debrief is
    'Structured Teach the Question content; not served until debrief_reviewed_at is set.';
comment on column public.questions.debrief_reviewed_at is
    'CAA review timestamp for the current teaching_debrief content.';
comment on column public.questions.debrief_reviewed_by is
    'Admin auth user who reviewed the current teaching_debrief content.';

create index if not exists idx_user_progress_current_item_first
    on public.user_progress (question_id, answer_revision, user_id, created_at, id);

create or replace function public.macprep_item_quality_rollup(
    p_min_sample integer default 10,
    p_excluded_emails text[] default '{}'::text[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    with settings as (
        select greatest(5, least(coalesce(p_min_sample, 10), 100))::integer as min_sample
    ), published as (
        select
            q.id::text as question_id,
            coalesce(q.category, q.domain_name, q.domain::text, 'General') as category,
            coalesce(q.subtopic, '') as subtopic,
            upper(coalesce(q.correct_answer, '')) as correct_answer,
            q.answer_revision,
            case when jsonb_typeof(q.choices) = 'array' then jsonb_array_length(q.choices) else 0 end as choice_count,
            q.debrief_reviewed_at is not null as debrief_reviewed
        from public.questions q
        where q.status = 'published'
    ), eligible_attempts as (
        select
            up.id,
            up.user_id,
            up.question_id::text as question_id,
            up.is_correct,
            upper(coalesce(up.selected_label, '')) as selected_label,
            up.confidence,
            up.time_ms,
            up.answer_changed,
            up.created_at,
            row_number() over (
                partition by up.user_id, up.question_id
                order by up.created_at asc, up.id asc
            ) as attempt_number
        from public.user_progress up
        join published q
          on q.question_id = up.question_id::text
         and q.answer_revision = up.answer_revision
        left join public.user_profiles profile on profile.user_id = up.user_id
        where not (
            lower(coalesce(profile.email, '')) = any(
                coalesce((select array_agg(lower(email)) from unnest(coalesce(p_excluded_emails, '{}'::text[])) email), '{}'::text[])
            )
        )
    ), first_attempts as (
        select * from eligible_attempts where attempt_number = 1
    ), learner_totals as (
        select
            user_id,
            count(*)::integer as answered,
            count(*) filter (where is_correct)::integer as correct
        from first_attempts
        group by user_id
    ), scored as (
        select
            attempts.*,
            totals.answered,
            case when totals.answered > 1
                then (totals.correct - case when attempts.is_correct then 1 else 0 end)::double precision
                    / (totals.answered - 1)::double precision
                else null
            end as rest_score
        from first_attempts attempts
        join learner_totals totals using (user_id)
    ), item_stats as (
        select
            question_id,
            count(*)::integer as learners,
            count(*) filter (where is_correct)::integer as correct,
            round(100.0 * avg(case when is_correct then 1 else 0 end))::integer as percent_correct,
            corr(
                (case when is_correct then 1 else 0 end)::double precision,
                rest_score
            ) filter (where answered >= 5 and rest_score is not null) as discrimination,
            percentile_cont(0.5) within group (order by time_ms)
                filter (where time_ms between 2000 and 900000) / 1000.0 as median_seconds,
            round(100.0 * count(*) filter (where answer_changed is true)
                / nullif(count(*) filter (where answer_changed is not null), 0))::integer as answer_change_pct,
            round(100.0 * count(*) filter (where confidence = 'high' and not is_correct)
                / nullif(count(*), 0))::integer as high_confidence_miss_pct
        from scored
        group by question_id
    ), label_counts as (
        select question_id, selected_label, count(*)::integer as responses
        from first_attempts
        where selected_label ~ '^[A-E]$'
        group by question_id, selected_label
    ), choice_labels as (
        select
            q.question_id,
            chr(64 + positions.position) as label,
            q.correct_answer,
            coalesce(counts.responses, 0)::integer as responses
        from published q
        cross join lateral generate_series(1, greatest(0, least(q.choice_count, 5))) positions(position)
        left join label_counts counts
          on counts.question_id = q.question_id
         and counts.selected_label = chr(64 + positions.position)
    ), choice_rollup as (
        select
            labels.question_id,
            jsonb_object_agg(labels.label, labels.responses order by labels.label) as choice_counts,
            coalesce(jsonb_agg(labels.label order by labels.label) filter (
                where labels.label <> labels.correct_answer
                  and stats.learners >= (select min_sample from settings)
                  and labels.responses::numeric / nullif(stats.learners, 0) < 0.05
            ), '[]'::jsonb) as nonfunctional_distractors
        from choice_labels labels
        left join item_stats stats using (question_id)
        group by labels.question_id
    ), report_counts as (
        select report.question_id, count(*)::integer as reports
        from (
            select substring(suggestion_text from 'Question[[:space:]]+([^[:space:]\[]+)') as question_id
            from public.user_suggestions
            where suggestion_text like '[question_report]%'
        ) report
        where report.question_id is not null
        group by report.question_id
    ), combined as (
        select
            q.question_id,
            q.category,
            q.subtopic,
            coalesce(stats.learners, 0)::integer as learners,
            stats.percent_correct,
            case when stats.discrimination is null then null else round(stats.discrimination::numeric, 3) end as discrimination,
            case when stats.median_seconds is null then null else round(stats.median_seconds::numeric, 1) end as median_seconds,
            stats.answer_change_pct,
            stats.high_confidence_miss_pct,
            coalesce(choices.choice_counts, '{}'::jsonb) as choice_counts,
            coalesce(choices.nonfunctional_distractors, '[]'::jsonb) as nonfunctional_distractors,
            coalesce(reports.reports, 0)::integer as reports,
            q.debrief_reviewed,
            case
                when coalesce(stats.learners, 0) < (select min_sample from settings) then 'too_small'
                when stats.learners < 30 then 'early'
                else 'stable'
            end as sample_band
        from published q
        left join item_stats stats using (question_id)
        left join choice_rollup choices using (question_id)
        left join report_counts reports using (question_id)
    ), flagged as (
        select
            combined.*,
            to_jsonb(array_remove(array[
                case when learners >= (select min_sample from settings) and percent_correct <= 25 then 'very_difficult' end,
                case when learners >= (select min_sample from settings) and percent_correct >= 95 then 'very_easy' end,
                case when learners >= (select min_sample from settings) and discrimination < 0 then 'negative_discrimination' end,
                case when learners >= (select min_sample from settings) and discrimination >= 0 and discrimination < 0.10 then 'weak_discrimination' end,
                case when learners >= (select min_sample from settings) and jsonb_array_length(nonfunctional_distractors) > 0 then 'unused_distractor' end,
                case when learners >= (select min_sample from settings) and high_confidence_miss_pct >= 15 then 'high_confidence_misses' end,
                case when reports > 0 then 'learner_report' end
            ]::text[], null)) as flags
        from combined
    ), ranked as (
        select
            flagged.*,
            (
                jsonb_array_length(flags) * 100
                + least(reports, 10) * 20
                + case when sample_band = 'stable' then 20 when sample_band = 'early' then 10 else 0 end
                + least(learners, 100)
            )::integer as attention_score
        from flagged
    )
    select jsonb_build_object(
        'method', jsonb_build_object(
            'attempt_basis', 'first attempt per learner on the current answer revision',
            'minimum_sample', (select min_sample from settings),
            'stable_sample', 30,
            'time_window_seconds', jsonb_build_array(2, 900)
        ),
        'summary', jsonb_build_object(
            'total_items', count(*)::integer,
            'items_with_attempts', count(*) filter (where learners > 0)::integer,
            'early_items', count(*) filter (where sample_band = 'early')::integer,
            'stable_items', count(*) filter (where sample_band = 'stable')::integer,
            'flagged_items', count(*) filter (where jsonb_array_length(flags) > 0)::integer,
            'max_sample', coalesce(max(learners), 0)::integer,
            'debrief_reviewed', count(*) filter (where debrief_reviewed)::integer,
            'debrief_coverage_pct', case when count(*) = 0 then 0
                else round(100.0 * count(*) filter (where debrief_reviewed) / count(*))::integer end
        ),
        'items', coalesce((
            select jsonb_agg(to_jsonb(items) order by items.attention_score desc, items.reports desc, items.learners desc, items.question_id)
            from (select * from ranked order by attention_score desc, reports desc, learners desc, question_id limit 300) items
        ), '[]'::jsonb)
    )
    from ranked;
$$;

revoke all on function public.macprep_item_quality_rollup(integer, text[])
    from public, anon, authenticated;
grant execute on function public.macprep_item_quality_rollup(integer, text[])
    to service_role;

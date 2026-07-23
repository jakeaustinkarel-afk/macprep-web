import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildAdaptiveStudyPlan } from '../src/lib/study-plan.mjs';
import { normalizeTeachingDebrief, validateTeachingDebrief } from '../src/lib/teaching-debrief.mjs';

const DOMAINS = [
    { domain: 'Principles of Anesthesia', mastery: 72, attempts: 40 },
    { domain: 'Pharmacology', mastery: 41, attempts: 18 },
    { domain: 'Subspecialty Care', mastery: 58, attempts: 25 },
];

test('adaptive plans prioritize due work and the weakest measured domain', () => {
    const plan = buildAdaptiveStudyPlan({
        now: new Date('2026-07-22T14:00:00Z'),
        timezoneOffset: 240,
        targetExamDate: '2026-09-10',
        totalQuestions: 1509,
        answeredQuestions: 900,
        answeredToday: 4,
        dueCount: 8,
        dueSchedule: [
            { question_id: 'q-1', due_at: '2026-07-22T12:00:00Z' },
            { question_id: 'q-2', due_at: '2026-07-22T13:00:00Z' },
        ],
        missedCount: 12,
        confidentMissedCount: 3,
        byDomain: DOMAINS,
    });

    assert.equal(plan.phase, 'build');
    assert.equal(plan.days.length, 50);
    assert.equal(plan.plan_end_date, '2026-09-09');
    assert.equal(plan.weakest_domains[0].domain, 'Pharmacology');
    assert.equal(plan.days[0].completed, 4);
    assert.equal(plan.days[0].tasks[0].kind, 'due');
    assert.deepEqual(plan.days[0].tasks[0].question_ids, ['q-1', 'q-2']);
    assert.ok(plan.days[0].tasks.some((task) => task.kind === 'focused' && task.domain === 'Pharmacology'));
});

test('adaptive plans use the learner local date for the due schedule', () => {
    const plan = buildAdaptiveStudyPlan({
        now: new Date('2026-07-22T03:30:00Z'),
        timezoneOffset: 240,
        totalQuestions: 100,
        answeredQuestions: 10,
        dueCount: 1,
        dueSchedule: [{ question_id: 'local-tuesday', due_at: '2026-07-22T02:30:00Z' }],
        byDomain: DOMAINS,
    });

    assert.equal(plan.days[0].date, '2026-07-21');
    assert.equal(plan.days[0].tasks[0].kind, 'due');
    assert.deepEqual(plan.days[0].tasks[0].question_ids, ['local-tuesday']);
});

test('an impossible exam pace is capped and described honestly', () => {
    const plan = buildAdaptiveStudyPlan({
        now: new Date('2026-07-22T14:00:00Z'),
        timezoneOffset: 240,
        targetExamDate: '2026-07-30',
        totalQuestions: 1509,
        answeredQuestions: 0,
        byDomain: DOMAINS,
    });

    assert.equal(plan.phase, 'final');
    assert.equal(plan.daily_target, 50);
    assert.ok(plan.raw_coverage_pace > plan.daily_target);
    assert.match(plan.summary, /instead of assigning an unrealistic/);
    assert.equal(plan.days.length, 8);
    assert.equal(plan.plan_end_date, '2026-07-29');
});

test('exam-dated plans span the full four-to-six-month preparation window', () => {
    const plan = buildAdaptiveStudyPlan({
        now: new Date('2026-07-22T14:00:00Z'),
        timezoneOffset: 240,
        targetExamDate: '2026-12-15',
        totalQuestions: 1509,
        answeredQuestions: 100,
        byDomain: DOMAINS,
    });

    assert.equal(plan.days.length, 146);
    assert.equal(plan.window_label, '5-month roadmap');
    assert.equal(plan.plan_end_date, '2026-12-14');
    assert.equal(plan.continues_to_exam, false);
    assert.deepEqual(plan.roadmap.map((stage) => stage.phase), ['foundation', 'build', 'final', 'taper']);
    assert.deepEqual(plan.roadmap.map((stage) => stage.start_index), [0, 56, 116, 139]);
    assert.match(plan.summary, /5-month roadmap/);
});

test('farther exam dates receive a rolling six-month adaptive window', () => {
    const plan = buildAdaptiveStudyPlan({
        now: new Date('2026-07-22T14:00:00Z'),
        timezoneOffset: 240,
        targetExamDate: '2027-03-01',
        totalQuestions: 1509,
        answeredQuestions: 100,
        byDomain: DOMAINS,
    });

    assert.equal(plan.days.length, 183);
    assert.equal(plan.window_label, '6-month roadmap');
    assert.equal(plan.continues_to_exam, true);
    assert.match(plan.summary, /six-month adaptive window/);
});

test('plans without an exam date use a sustainable rolling four-month horizon', () => {
    const plan = buildAdaptiveStudyPlan({
        now: new Date('2026-07-22T14:00:00Z'),
        timezoneOffset: 240,
        totalQuestions: 1509,
        answeredQuestions: 0,
        byDomain: DOMAINS,
    });

    assert.equal(plan.days.length, 120);
    assert.equal(plan.window_label, '4-month roadmap');
    assert.equal(plan.daily_target, 20);
    assert.match(plan.summary, /Add your exam date/);
});

test('checkpoint targets include reviews scheduled for the same day', () => {
    const plan = buildAdaptiveStudyPlan({
        now: new Date('2026-07-22T14:00:00Z'),
        timezoneOffset: 240,
        totalQuestions: 1509,
        answeredQuestions: 500,
        dueCount: 5,
        dueSchedule: Array.from({ length: 5 }, (_, index) => ({
            question_id: `checkpoint-due-${index}`,
            due_at: '2026-08-04T14:00:00Z',
        })),
        byDomain: DOMAINS,
    });

    const checkpoint = plan.days[13];
    assert.deepEqual(checkpoint.tasks.map((task) => task.kind), ['due', 'diagnostic']);
    assert.equal(checkpoint.target, checkpoint.tasks.reduce((sum, task) => sum + task.count, 0));
});

test('the profile endpoint paginates review inputs across the six-month horizon', async () => {
    const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
    const start = server.indexOf("app.get('/api/user/profile'");
    const end = server.indexOf("app.post('/api/user/profile'", start);
    const profileRoute = server.slice(start, end);

    assert.match(server, /buildAdaptiveStudyPlan, MAX_ADAPTIVE_PLAN_DAYS/);
    assert.match(profileRoute, /MAX_ADAPTIVE_PLAN_DAYS \* 86400000/);
    assert.match(profileRoute, /fetchAllPostgrestRows\([\s\S]*from\('review_state'\)[\s\S]*\.range\(from, to\)/);
});

test('teaching debriefs normalize allowed fields and require every distractor pivot', () => {
    const normalized = normalizeTeachingDebrief({
        key_takeaway: '  Match the intervention\n to the mechanism.  ',
        correct_principle: 'The keyed response treats the mechanism while preserving perfusion.',
        distractor_corrections: {
            A: 'Choice A would become correct if the patient were stable and observation were appropriate.',
            C: 'Choice C would become correct if the stem described inadequate anesthetic depth.',
            D: 'Choice D would become correct if the condition were nonurgent and the result changed management.',
            Z: 'This key must be discarded.',
        },
        source_verification: 'Confirm the mechanism and first-line response in the cited guideline section.',
        unexpected: 'discard me',
    });
    assert.equal(normalized.key_takeaway, 'Match the intervention to the mechanism.');
    assert.equal(Object.hasOwn(normalized.distractor_corrections, 'Z'), false);

    const choices = [{}, {}, {}, {}];
    const assessment = validateTeachingDebrief(normalized, choices, 'B');
    assert.equal(assessment.valid, true);

    const incomplete = validateTeachingDebrief({ ...normalized, distractor_corrections: { A: normalized.distractor_corrections.A } }, choices, 'B');
    assert.equal(incomplete.valid, false);
    assert.match(incomplete.errors.join(' '), /Choice C/);
    assert.match(incomplete.errors.join(' '), /Choice D/);
});

test('item-quality migration is revision-aware, first-attempt based, and service-role only', async () => {
    const sql = await readFile(new URL('../supabase/migrations/20260722190000_adaptive_learning_and_item_quality.sql', import.meta.url), 'utf8');
    assert.match(sql, /q\.answer_revision = up\.answer_revision/);
    assert.match(sql, /row_number\(\) over[\s\S]*order by up\.created_at asc, up\.id asc/);
    assert.match(sql, /security definer/);
    assert.match(sql, /revoke all on function public\.macprep_item_quality_rollup\(integer, text\[\]\)[\s\S]*from public, anon, authenticated/);
    assert.match(sql, /grant execute on function public\.macprep_item_quality_rollup\(integer, text\[\]\)[\s\S]*to service_role/);
});

test('clinical question edits revoke an older teaching-debrief sign-off', async () => {
    const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');
    assert.match(server, /reviewSensitiveContentSubmitted[\s\S]*'stem', 'explanation', 'correct_answer'/);
    assert.match(server, /reviewSensitiveContentSubmitted[\s\S]*hasOwnProperty\.call\(b, 'references'\)/);
    assert.match(server, /else if \(reviewSensitiveContentSubmitted \|\| b\.teaching_debrief_reviewed === false\)[\s\S]*debrief_reviewed_at = null/);
});

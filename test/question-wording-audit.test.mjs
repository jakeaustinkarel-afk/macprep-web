import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { auditQuestionTextQuality } from '../src/lib/question-validation.mjs';

function question(overrides = {}) {
    return {
        id: 'question-1',
        stem: 'A complete clinical vignette asks for the single best physiologic explanation.',
        explanation: 'The explanation connects the relevant physiologic change to the clinical consequence.',
        correct_answer: 'A',
        choices: [
            { label: 'A', correct: true, text: 'The supported physiologic change', rationale: 'Correct: this matches the mechanism described in the stem.' },
            { label: 'B', correct: false, text: 'A plausible but unsupported alternative', rationale: 'This reverses the mechanism described in the stem.' },
            { label: 'C', correct: false, text: 'A second plausible alternative', rationale: 'This applies to a different clinical setting.' },
            { label: 'D', correct: false, text: 'A third plausible alternative', rationale: 'This does not address the underlying mechanism.' },
        ],
        ...overrides,
    };
}

test('question wording audit accepts aligned, mechanically clean content', () => {
    const result = auditQuestionTextQuality([question()]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
});

test('question wording audit catches omitted modifiers, mechanical slips, and rationale polarity', () => {
    const candidate = question({
        stem: 'A complete complete vignette contains a repeated word.',
        choices: [
            {
                label: 'A',
                correct: true,
                text: 'Reduced FRC plus lower esophageal sphincter tone.',
                rationale: 'Incorrect: this rationale conflicts with the keyed answer.',
            },
            {
                label: 'B',
                correct: false,
                text: 'A plausible alternative',
                rationale: 'Correct: this rationale conflicts with an unkeyed answer.',
            },
            { label: 'C', correct: false, text: 'A second alternative', rationale: 'This applies elsewhere.' },
            { label: 'D', correct: false, text: 'A third alternative', rationale: 'This applies elsewhere.' },
        ],
    });
    const result = auditQuestionTextQuality([candidate]);
    const types = result.issues.map((issue) => issue.type);
    assert.equal(result.valid, false);
    assert.ok(types.includes('repeated_word'));
    assert.ok(types.includes('missing_directional_modifier'));
    assert.ok(types.includes('correct_choice_marked_incorrect'));
    assert.ok(types.includes('incorrect_choice_marked_correct'));
});

test('reported obstetric wording repair is guarded and preserved in canonical content', async () => {
    const [migration, seedText] = await Promise.all([
        readFile(new URL('../supabase/migrations/20260722200000_reported_question_wording_repairs.sql', import.meta.url), 'utf8'),
        readFile(new URL('../seeds/authored_round6_live.json', import.meta.url), 'utf8'),
    ]);
    const seed = JSON.parse(seedText);
    const sourceQuestion = seed[25];
    const sourceAnswer = sourceQuestion.choices[sourceQuestion.correct_index].text;

    assert.match(sourceAnswer, /decreased lower esophageal sphincter tone/);
    assert.doesNotMatch(sourceAnswer, /plus lower esophageal sphincter tone/);
    assert.match(migration, /where id::text = 'authored-batch-r6-026'/);
    assert.match(migration, /Expected exactly one authored-batch-r6-026 wording repair/);
    assert.match(migration, /debrief_reviewed_at = null/);
    assert.match(migration, /debrief_reviewed_by = null/);
    assert.match(migration, /Published question audit failed/);
    assert.match(migration, /plus\[\[:space:\]\]\+lower/);
});

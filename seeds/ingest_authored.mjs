// Validated, review-gated ingestion for authored question batches.
//
// Dry run (default):
//   node seeds/ingest_authored.mjs seeds/authored_batch_01.json
// Apply after reviewing the report:
//   node seeds/ingest_authored.mjs seeds/authored_batch_01.json --apply
//
// Every row lands in `sme_review`; this tool cannot publish questions.
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { validateQuestionForPublication } from '../src/lib/question-validation.mjs';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
const apply = args.includes('--apply');
if (!file) {
    console.error('Usage: node seeds/ingest_authored.mjs <batch.json> [--apply]');
    process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const batch = String(doc?._meta?.batch || path.basename(file, '.json')).trim();
const rows = (doc.questions || []).map((question, index) => ({
    id: `${batch}-${String(index + 1).padStart(3, '0')}`,
    specialty: question.subtopic || question.domain_name || null,
    domain: question.domain ?? null,
    domain_name: question.domain_name ?? null,
    subtopic: question.subtopic ?? null,
    difficulty: question.difficulty ?? null,
    stem: question.stem,
    choices: question.choices,
    correct_answer: question.correct_answer ?? null,
    explanation: question.explanation ?? null,
    references: question.references ?? [],
    status: 'sme_review',
}));

if (!rows.length) {
    console.error('Validation failed: the batch contains no questions.');
    process.exit(1);
}

const failures = rows.flatMap((row) => {
    const assessment = validateQuestionForPublication(row);
    return assessment.errors.map((error) => `${row.id}: ${error}`);
});
if (failures.length) {
    console.error(`Validation failed with ${failures.length} issue(s):`);
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
}

console.log(`Validated ${rows.length} question(s) from ${batch}. Destination status: sme_review.`);
if (!apply) {
    console.log('Dry run only. Re-run with --apply after reviewing this report.');
    process.exit(0);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --apply.');
    process.exit(1);
}

const supabase = createClient(url.replace(/\/$/, ''), key);
const { data, error } = await supabase.from('questions').upsert(rows, { onConflict: 'id' }).select('id');
if (error) {
    console.error('Ingestion failed:', error.message);
    process.exit(1);
}
console.log(`Upserted ${data.length} question(s) into the SME review queue.`);

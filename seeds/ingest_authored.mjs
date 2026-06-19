// Idempotent ingestion for authored question batches.
//
//   node seeds/ingest_authored.mjs seeds/authored_batch_01.json
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
// Rows are upserted on a stable text id ("<batch>-NNN") so re-running updates
// in place instead of duplicating. Everything lands with status='sme_review';
// nothing is promoted to 'published' here — that requires a credentialed
// reviewer to sign off and set reviewed_by (BLUEPRINT.md §4).
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const file = process.argv[2];
if (!file) { console.error('Usage: node seeds/ingest_authored.mjs <batch.json>'); process.exit(1); }

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1); }

const supabase = createClient(url.replace(/\/$/, ''), key);
const doc = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const batch = doc?._meta?.batch || path.basename(file, '.json');
const status = doc?._meta?.status || 'sme_review';

const rows = (doc.questions || []).map((q, i) => {
    const id = `${batch}-${String(i + 1).padStart(3, '0')}`;
    return {
        id,
        specialty: q.subtopic || q.domain_name || null,
        domain: q.domain ?? null,
        domain_name: q.domain_name ?? null,
        subtopic: q.subtopic ?? null,
        difficulty: q.difficulty ?? null,
        stem: q.stem,
        // Store choices as a native JSONB array (label/text/correct/rationale).
        // The server strips correctness before sending to clients.
        choices: q.choices,
        correct_answer: q.correct_answer ?? null,
        explanation: q.explanation ?? null,
        references: q.references ?? [],
        status,
    };
});

const { data, error } = await supabase
    .from('questions')
    .upsert(rows, { onConflict: 'id' })
    .select('id');

if (error) { console.error('Ingestion failed:', error.message); process.exit(1); }
console.log(`Upserted ${data.length} questions from ${batch} (status=${status}).`);

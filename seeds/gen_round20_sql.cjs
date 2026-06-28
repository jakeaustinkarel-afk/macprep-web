const fs = require('fs');

const SRC = 'seeds/authored_round20_live.json';
const OUT = 'seeds/round20_insert.sql';

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (data.length !== 48) throw new Error('expected 48, got ' + data.length);

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

// Target correct-answer letter per question (array order 0..47).
// Required totals: A=10, B=9, C=9, D=10, E=10.
// Spread across categories so no letter clusters in one specialty.
// Categories by index group:
//  0-2 Trauma; 3-5 Thoracic; 6-8 Pharm; 9-11 Airway; 12-14 Endocrine;
//  15-17 Ophthalmic; 18-20 Pediatric; 21-22 Principles; 23-25 Neuro;
//  26-28 Obstetric; 29-31 Ambulatory; 32-34 Ortho; 35-36 Regional;
//  37-38 Cardiac; 39-41 Monitoring; 42-44 Geriatric; 45 Principles; 46 Regional; 47 Cardiac
const TARGET = [
  // Trauma (0-2)
  'A', 'B', 'C',
  // Thoracic (3-5)
  'D', 'E', 'A',
  // Pharmacology (6-8)
  'B', 'C', 'D',
  // Airway (9-11)
  'E', 'A', 'B',
  // Endocrine (12-14)
  'C', 'D', 'E',
  // Ophthalmic (15-17)
  'A', 'B', 'C',
  // Pediatric (18-20)
  'D', 'E', 'A',
  // Principles (21-22)
  'B', 'C',
  // Neuro (23-25)
  'D', 'E', 'A',
  // Obstetric (26-28)
  'B', 'C', 'D',
  // Ambulatory (29-31)
  'E', 'A', 'B',
  // Ortho (32-34)
  'C', 'D', 'E',
  // Regional (35-36)
  'A', 'B',
  // Cardiac (37-38)
  'C', 'D',
  // Monitoring (39-41)
  'E', 'A', 'B',
  // Geriatric (42-44)
  'C', 'D', 'E',
  // Principles (45)
  'D',
  // Regional (46)
  'E',
  // Cardiac (47)
  'A',
];

if (TARGET.length !== 48) throw new Error('TARGET length ' + TARGET.length);

// validate totals
const counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
TARGET.forEach(t => counts[t]++);
const want = { A: 10, B: 9, C: 9, D: 10, E: 10 };
for (const L of LETTERS) {
  if (counts[L] !== want[L]) {
    throw new Error(`letter ${L}: have ${counts[L]} want ${want[L]}`);
  }
}

// validate spread: no letter appears more than once within a 3-item category group
// (groups are contiguous; quick check that within any contiguous run of same category, letters are distinct)
const groups = {};
data.forEach((q, i) => {
  (groups[q.category] = groups[q.category] || []).push(i);
});
for (const [cat, idxs] of Object.entries(groups)) {
  const seen = {};
  for (const i of idxs) {
    const L = TARGET[i];
    if (seen[L]) {
      console.warn(`WARN: letter ${L} repeats in category "${cat}" (idx ${seen[L]} & ${i})`);
    }
    seen[L] = i;
  }
}

function sqlStr(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}
function jsonbLit(obj) {
  // JSON.stringify then escape single quotes for SQL literal
  return "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";
}

const rows = [];
data.forEach((q, i) => {
  const n = String(i + 1).padStart(3, '0');
  const id = `authored-batch-r20-${n}`;
  const targetLetter = TARGET[i];
  const targetIdx = LETTERS.indexOf(targetLetter);

  if (!Array.isArray(q.choices) || q.choices.length !== 5) {
    throw new Error(`q${i} choices != 5`);
  }
  if (q.correct_index < 0 || q.correct_index > 4) {
    throw new Error(`q${i} bad correct_index`);
  }

  // 1. pull correct choice; others keep original relative order
  const correctChoice = q.choices[q.correct_index];
  const others = q.choices.filter((_, idx) => idx !== q.correct_index);

  // 2. insert correct choice at targetIdx among the others
  const ordered = others.slice();
  ordered.splice(targetIdx, 0, correctChoice);
  if (ordered.length !== 5) throw new Error(`q${i} reorder len ${ordered.length}`);

  // 3. relabel A..E, set correct only on target
  const choicesOut = ordered.map((c, idx) => ({
    text: c.text,
    label: LETTERS[idx],
    correct: idx === targetIdx,
    rationale: c.rationale,
  }));

  // sanity: exactly one correct, and it's the right text
  const corrCount = choicesOut.filter(c => c.correct).length;
  if (corrCount !== 1) throw new Error(`q${i} corrCount ${corrCount}`);
  if (choicesOut[targetIdx].text !== correctChoice.text) {
    throw new Error(`q${i} target text mismatch`);
  }

  const references = [{ url: q.reference_url, source: q.reference_title }];

  const cols = [
    sqlStr(id),                        // id
    sqlStr(q.category),                // specialty
    sqlStr(q.stem),                    // stem
    jsonbLit(choicesOut),              // choices
    sqlStr(targetLetter),              // correct_answer
    sqlStr(q.explanation),             // explanation
    "'{}'::jsonb",                     // telemetry
    "'Subspecialty Care'",             // domain_name
    sqlStr(q.subtopic ?? null),        // subtopic
    sqlStr(q.difficulty ?? null),      // difficulty
    jsonbLit(references),              // references
    "'sme_review'",                    // status
    sqlStr(q.category),                // category
  ];
  rows.push('(' + cols.join(', ') + ')');
});

const HEADER =
  'INSERT INTO questions\n' +
  '  (id, specialty, stem, choices, correct_answer, explanation, telemetry, domain_name, subtopic, difficulty, "references", status, category)\n' +
  'VALUES\n';

const sql = HEADER + rows.join(',\n') + ';\n';
fs.writeFileSync(OUT, sql);
console.log('Wrote ' + OUT + ' with ' + rows.length + ' rows.');

// Also emit batches of 6 rows each -> 8 files, each small enough to read.
const BATCH = 6;
let bi = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  bi++;
  const chunk = rows.slice(i, i + BATCH);
  const bsql = HEADER + chunk.join(',\n') + ';\n';
  const fname = `seeds/round20_batch_${String(bi).padStart(2, '0')}.sql`;
  fs.writeFileSync(fname, bsql);
  console.log(`  ${fname}: ${chunk.length} rows, ${bsql.length} chars`);
}
console.log('Letter totals:', JSON.stringify(counts));

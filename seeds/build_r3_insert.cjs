const fs = require('fs');
const path = '/Users/jakekarel/Desktop/macprep-web/seeds/authored_round3_live.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

// Target slot (0=A..4=E) per question index. Designed so:
//  - totals are A=9,B=9,C=9,D=9,E=9
//  - within any single category, no slot repeats (spread across categories)
// Index : category (grouping)
// 0,1,2     Trauma
// 3,4,5     Thoracic
// 6,7,8     Pharmacology
// 9,10,11   Airway
// 12,13,14  Endocrine
// 15,16     Ophthalmic
// 17,18,19  Pediatric
// 20,21     Principles
// 22,23,24  Neuro
// 25,26     Obstetric
// 27,28,29  Ambulatory
// 30,31,32  Ortho
// 33,34,35  Regional
// 36,37,38  Cardiac
// 39,40,41  Monitoring
// 42,43,44  Geriatric
const targetSlot = {
  0: 0, 1: 1, 2: 2,        // Trauma     A B C
  3: 3, 4: 4, 5: 0,        // Thoracic   D E A
  6: 1, 7: 2, 8: 3,        // Pharma     B C D
  9: 4, 10: 0, 11: 1,      // Airway     E A B
  12: 2, 13: 3, 14: 4,     // Endocrine  C D E
  15: 0, 16: 1,            // Ophthalmic A B
  17: 2, 18: 3, 19: 4,     // Pediatric  C D E
  20: 0, 21: 1,            // Principles A B
  22: 2, 23: 3, 24: 4,     // Neuro      C D E
  25: 0, 26: 1,            // Obstetric  A B
  27: 2, 28: 3, 29: 4,     // Ambulatory C D E
  30: 0, 31: 1, 32: 2,     // Ortho      A B C
  33: 3, 34: 4, 35: 0,     // Regional   D E A
  36: 1, 37: 2, 38: 3,     // Cardiac    B C D
  39: 4, 40: 0, 41: 1,     // Monitoring E A B
  42: 2, 43: 3, 44: 4,     // Geriatric  C D E
};

// Sanity: totals and per-category no-repeat
const counts = [0, 0, 0, 0, 0];
const perCat = {};
data.forEach((q, i) => {
  const s = targetSlot[i];
  counts[s]++;
  const c = q.category;
  perCat[c] = perCat[c] || [];
  if (perCat[c].includes(s)) {
    throw new Error(`Slot ${s} repeats in category ${c} at index ${i}`);
  }
  perCat[c].push(s);
});
console.error('Slot totals A-E:', counts.join(','));
if (counts.join(',') !== '9,9,9,9,9') throw new Error('Slot totals not 9 each');

function sqlStr(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}
function jsonbLit(obj) {
  // JSON.stringify produces valid JSON; escape single quotes for SQL literal.
  return "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";
}

const rows = data.map((q, i) => {
  if (!Array.isArray(q.choices) || q.choices.length !== 5) {
    throw new Error(`Question ${i} does not have exactly 5 choices`);
  }
  const ci = q.correct_index;
  if (ci < 0 || ci > 4) throw new Error(`Bad correct_index at ${i}`);
  const target = targetSlot[i];

  const correctChoice = q.choices[ci];
  const others = q.choices.filter((_, idx) => idx !== ci); // keep original order

  // Build new order: insert correct choice at `target` among the 4 others.
  const ordered = others.slice();
  ordered.splice(target, 0, correctChoice);
  if (ordered.length !== 5) throw new Error(`Reorder produced ${ordered.length} choices at ${i}`);

  const choices = ordered.map((ch, pos) => ({
    text: ch.text,
    label: LETTERS[pos],
    correct: pos === target,
    rationale: ch.rationale,
  }));

  // verify exactly one correct and it sits at target
  const correctPositions = choices.map((c, p) => (c.correct ? p : -1)).filter((p) => p >= 0);
  if (correctPositions.length !== 1 || correctPositions[0] !== target) {
    throw new Error(`Correct flag mismatch at ${i}`);
  }
  if (choices[target].text !== correctChoice.text) {
    throw new Error(`Correct text mismatch at ${i}`);
  }

  const id = `authored-batch-r3-${String(i + 1).padStart(3, '0')}`;
  const correctLetter = LETTERS[target];
  const references = [{ url: q.reference_url, source: q.reference_title }];

  const vals = [
    sqlStr(id),
    sqlStr(q.category),            // specialty
    sqlStr(q.category),            // category
    sqlStr('Subspecialty Care'),  // domain_name
    sqlStr(q.subtopic || null),   // subtopic
    sqlStr(q.difficulty || null), // difficulty
    sqlStr(q.stem),               // stem
    jsonbLit(choices),            // choices
    sqlStr(correctLetter),        // correct_answer
    sqlStr(q.explanation),        // explanation
    jsonbLit(references),         // references
    sqlStr('sme_review'),         // status
    "'{}'::jsonb",                // telemetry
  ];
  return '(' + vals.join(', ') + ')';
});

const header =
  'INSERT INTO questions (id, specialty, category, domain_name, subtopic, difficulty, stem, choices, correct_answer, explanation, "references", status, telemetry) VALUES\n';

const sql = header + rows.join(',\n') + ';\n';
fs.writeFileSync('/Users/jakekarel/Desktop/macprep-web/seeds/r3_insert.sql', sql);
console.error('Wrote SQL with', rows.length, 'rows,', sql.length, 'bytes');

// Also write chunked files of 15 rows each for easier tool execution
for (let c = 0; c < 3; c++) {
  const chunk = rows.slice(c * 15, c * 15 + 15);
  const csql = header + chunk.join(',\n') + ';\n';
  fs.writeFileSync(`/Users/jakekarel/Desktop/macprep-web/seeds/r3_insert_part${c + 1}.sql`, csql);
  console.error(`Wrote part${c + 1} with`, chunk.length, 'rows,', csql.length, 'bytes');
}

// Emit per-question summary for audit
data.forEach((q, i) => {
  console.error(`${String(i + 1).padStart(2, '0')}\t${LETTERS[targetSlot[i]]}\t${q.category}`);
});

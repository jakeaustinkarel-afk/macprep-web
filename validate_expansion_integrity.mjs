import fs from "node:fs/promises";
import path from "node:path";

const DATA_PATH = path.join(process.cwd(), "data", "questions.json");

async function verifyIntegrity() {
  const raw = await fs.readFile(DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  const questions = data.questions || [];
  
  console.log(`🔍 Auditing ${questions.length} total questions inside repository...`);
  
  let errors = 0;
  questions.forEach((q, idx) => {
    if (!q.id) { console.log(`❌ Error: Question index ${idx} is missing an ID field.`); errors++; }
    if (!q.choices || q.choices.length !== 5) { console.log(`❌ Error: Item ${q.id || idx} does not have exactly 5 options.`); errors++; }
    const correctCount = q.choices?.filter(c => c.correct === true).length || 0;
    if (correctCount !== 1) { console.log(`❌ Error: Item ${q.id || idx} must have exactly ONE true correct answer flag (Found: ${correctCount}).`); errors++; }
    if (!q.doi) { console.log(`⚠️ Warning: Item ${q.id || idx} is missing a peer-reviewed DOI tracking number.`); }
  });

  if (errors === 0) {
    console.log("🚀 Integrity check PASSED! Local data format is completely robust for cloud synchronization.");
  } else {
    console.log(`❌ Integrity check FAILED with ${errors} structural errors.`);
  }
}
verifyIntegrity().catch(console.error);

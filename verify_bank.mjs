import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BANK_PATH = path.join(__dirname, "data", "questions.json");

const EXPECTED_TOTAL = 1000;
const EXPECTED_FREE = 100;
const VALID_TRACKS = ["initial_certification", "advanced_recertification"];
const LETTERS = ["A", "B", "C", "D", "E"];

const trackCounts = { initial_certification: 0, advanced_recertification: 0 };
const freeStatusCounts = { true: 0, false: 0 };
const distributionLetterCounts = Object.fromEntries(LETTERS.map(l => [l, 0]));
const structuralErrors = [];
const complianceErrors = [];
const lowSignalErrors = [];
const distractorAuditMap = new Map();

const complianceViolationPattern = /\b(official nccaa|approved by nccaa|actual exam item|for clinical use|patient-specific directive|treatment protocol)\b/i;
const clinicalVignettePattern = /\b(\d+\s*(year-old|y\/o|month-old)|presents with|history of|undergoing|scheduled for|intubated|anesthetized|vitals|preoperative|postoperative|intraoperative|hemodynamic|induction|extubation)\b/i;

async function runAudit() {
  try {
    const rawData = await fs.readFile(BANK_PATH, "utf8");
    const questions = JSON.parse(rawData).questions || [];

    for (const q of questions) {
      const id = q.id || `Index_${questions.indexOf(q)}`;
      
      if (VALID_TRACKS.includes(q.track)) trackCounts[q.track]++;
      else structuralErrors.push(`${id}: Invalid track token layout [${q.track}]`);
      
      if (typeof q.is_free === "boolean") freeStatusCounts[String(q.is_free)]++;
      
      if (!q.stem || !Array.isArray(q.choices) || q.choices.length !== 5) {
        structuralErrors.push(`${id}: Question failed basic 5-choice board matrix validation rules.`);
        continue;
      }

      const correctPool = q.choices.filter(c => c.correct === true);
      if (correctPool.length !== 1) structuralErrors.push(`${id}: Verification anomaly. Detected answer counts: ${correctPool.length}`);
      else distributionLetterCounts[correctPool[0].label]++;

      if (complianceViolationPattern.test(q.stem) || complianceViolationPattern.test(q.explanation)) {
        complianceErrors.push(`${id}: Trademark affiliation or prescriptive phrasing identified.`);
      }

      if (!clinicalVignettePattern.test(q.stem)) lowSignalErrors.push(id);

      for (const choice of q.choices) {
        if (!choice.correct && choice.text) {
          const norm = choice.text.toLowerCase().trim().replace(/[^a-z0-9]+/g, " ");
          if (!distractorAuditMap.has(norm)) distractorAuditMap.set(norm, []);
          distractorAuditMap.get(norm).push(id);
        }
      }
    }

    const hardFailures = [];
    if (structuralErrors.length) hardFailures.push(`Structural configuration breaks identified: ${structuralErrors.length}`);
    if (complianceErrors.length) hardFailures.push(`Legal liability exceptions thrown: ${complianceErrors.length}`);

    console.log("\n📊 --- MACPREP DATA INTEGRITY REPORT ---");
    console.log("Total Asset Count Weight:", questions.length);
    console.log("Track Balance:", trackCounts);
    console.log("Gating Allocations:", freeStatusCounts);
    console.log("Letter Selection Entropy Balance:", distributionLetterCounts);
    console.log("Low Signal Vignette Identification Review IDs:", lowSignalErrors.slice(0, 5));
    console.log("-----------------------------------------");

    if (hardFailures.length) {
      console.error("❌ Build Gating Rules Breached:\n", hardFailures.join("\n"));
      process.exitCode = 1;
    } else {
      console.log("✅ Verification metrics passed. Workspace records production-ready status.");
    }
  } catch (err) {
    console.error("❌ Core system file execution trap:", err.message);
    process.exitCode = 1;
  }
}
runAudit();

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BANK_PATH = path.join(__dirname, "data", "questions.json");

async function runQualityGate() {
  try {
    const rawData = await fs.readFile(BANK_PATH, "utf8");
    const payload = JSON.parse(rawData);
    const questions = payload.questions || [];

    console.log("=== MACPrep Curriculum Bank Quality Gate ===");
    console.log(`Auditing ${questions.length} active clinical cases for board conformity...\n`);

    let issuesCount = 0;
    const deprecatedPhrases = ["quiz", "game", "vigilance iq", "anepath", "matricora"];

    for (const q of questions) {
      const logPrefix = `[Item ${q.id || "MISSING_ID"}]`;

      if (!q.id) {
        console.error("❌ Critical: Question element encountered without a valid unique alphanumeric ID.");
        issuesCount++;
        continue;
      }

      if (q.track !== "initial_certification" && q.track !== "advanced_recertification") {
        console.error(`${logPrefix} ❌ Error: Track must read 'initial_certification' or 'advanced_recertification'. Found: '${q.track}'`);
        issuesCount++;
      }

      if (!q.specialty || !q.sub_specialty) {
        console.error(`${logPrefix} ❌ Error: Missing mandatory specialty or sub_specialty clinical taxonomy tags.`);
        issuesCount++;
      }

      if (q.telemetry) {
        const heartRate = parseInt(q.telemetry.hr);
        if (isNaN(heartRate) || heartRate < 20 || heartRate > 250) {
          console.error(`${logPrefix} ⚠️ Warning: Telemetry HR baseline parameters sit outside expected physiological limits (20-250 bpm). Found: ${q.telemetry.hr}`);
          issuesCount++;
        }
        if (q.telemetry.spo2 && !q.telemetry.spo2.includes("%")) {
          console.error(`${logPrefix} ⚠️ Warning: Telemetry SpO2 string lacks canonical percentage symbol suffix.`);
          issuesCount++;
        }
      }

      if (q.choices) {
        const hasCorrectAnswer = q.choices.some(choice => choice.correct === true);
        if (!hasCorrectAnswer) {
          console.error(`${logPrefix} ❌ Error: Question lacks a flagged correct baseline option row.`);
          issuesCount++;
        }
      } else {
        console.error(`${logPrefix} ❌ Error: Choices option collection is completely missing.`);
        issuesCount++;
      }

      if (q.differential_diagnosis && !q.differential_diagnosis.includes("<table")) {
        console.error(`${logPrefix} ⚠️ Warning: Differential grid layout fails to expose structural HTML table layout parameters.`);
        issuesCount++;
      }

      if (!q.source || !q.source.doi || q.source.doi.includes("replace_with_")) {
        console.error(`${logPrefix} ❌ Error: Missing or placeholder NLM peer-reviewed bibliographic literature DOI signature.`);
        issuesCount++;
      }

      const textualBodyPayload = `${q.stem} ${q.explanation} ${q.choices ? q.choices.map(c => c.text + " " + c.rationale).join(" ") : ""}`.toLowerCase();
      for (const phrase of deprecatedPhrases) {
        if (textualBodyPayload.includes(phrase)) {
          console.error(`${logPrefix} ❌ Error: Deprecated system phrase or non-scholarly branding detected: "${phrase}"`);
          issuesCount++;
        }
      }
    }

    console.log("=========================================");
    if (issuesCount === 0) {
      console.log("✅ Validation Passed: 100% of curriculum entries conform to premium clinical standards.");
      process.exit(0);
    } else {
      console.error(`❌ Validation Failed: Encountered ${issuesCount} conformity or regulatory schema faults.`);
      process.exit(1);
    }
  } catch (executionError) {
    console.error(`💥 Runtime Exception Intercepted: ${executionError.message}`);
    process.exit(1);
  }
}

runQualityGate();

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function runLiveQualityAudit() {
  console.log("🏁 Initializing Full-Range Live Database Quality Verification Sweep...");
  
  try {
    let allQuestions = [];
    let page = 0;
    const pageSize = 1000;
    let keepFetching = true;

    while (keepFetching) {
      console.log(`📡 Extracting row offset lane: ${page * pageSize} to ${(page + 1) * pageSize}...`);
      const { data, error } = await supabase
        .from('questions')
        .select('*')
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) throw error;

      if (data.length === 0) {
        keepFetching = false;
      } else {
        allQuestions = allQuestions.concat(data);
        if (data.length < pageSize) {
          keepFetching = false;
        }
        page++;
      }
    }

    console.log(`\n📦 Total Real Records Discovered across all indices: ${allQuestions.length}\n`);

    let malformedCount = 0;
    let missingExplanationCount = 0;
    let badgeCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    let specialtyMap = {};

    allQuestions.forEach((q) => {
      const spec = q.specialty || "UNASSIGNED";
      specialtyMap[spec] = (specialtyMap[spec] || 0) + 1;

      if (!q.explanation || q.explanation.trim().length < 10) {
        missingExplanationCount++;
      }

      try {
        const parsed = typeof q.choices === 'string' ? JSON.parse(q.choices) : q.choices;
      } catch (err) {
        malformedCount++;
      }

      const answerKey = q.correct_answer || q.correctAnswer;
      if (answerKey && badgeCounts[answerKey] !== undefined) {
        badgeCounts[answerKey]++;
      }
    });

    console.log("==========================================================================");
    console.log("📊 REAL UN-CAPPED PRODUCTION HEALTH STATUS REPORT");
    console.log(`✅ Total Live Verified Records: ${allQuestions.length - malformedCount}`);
    console.log(`❌ Malformed JSON Rows:        ${malformedCount}`);
    console.log(`⚠️ Warning: Missing Rationales: ${missingExplanationCount}`);
    console.log("--------------------------------------------------------------------------");
    console.log("🔠 OPTION BADGE BALANCE DISTRIBUTION AUDIT:");
    console.table(badgeCounts);
    console.log("\n%🩺 CORE BLUEPRINT SPECIALTY COVERAGE VOLUMES:");
    console.table(specialtyMap);
    console.log("==========================================================================");

  } catch (err) {
    console.error("❌ Critical Ingestion Intercept Failure:", err.message);
  }
}

runLiveQualityAudit();

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { auditAnswerPositionBalance, auditQuestionTextQuality } from './src/lib/question-validation.mjs';

dotenv.config();

const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, serviceRoleKey);

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
        .eq('status', 'published')
        .order('id', { ascending: true })
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

    console.log(`\n📦 Total published records discovered: ${allQuestions.length}\n`);

    let malformedCount = 0;
    let missingExplanationCount = 0;
    let answerAlignmentCount = 0;
    let badgeCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    let specialtyMap = {};

    const published = allQuestions.filter((question) => question.status === 'published');
    published.forEach((q) => {
      const spec = q.specialty || "UNASSIGNED";
      specialtyMap[spec] = (specialtyMap[spec] || 0) + 1;

      if (!q.explanation || q.explanation.trim().length < 10) {
        missingExplanationCount++;
      }

      try {
        const parsed = typeof q.choices === 'string' ? JSON.parse(q.choices) : q.choices;
        const markedCorrect = Array.isArray(parsed) ? parsed.filter((choice) => choice?.correct === true) : [];
        if (markedCorrect.length !== 1 || markedCorrect[0]?.label !== (q.correct_answer || q.correctAnswer)) {
          answerAlignmentCount++;
        }
      } catch (err) {
        malformedCount++;
      }

      const answerKey = q.correct_answer || q.correctAnswer;
      if (answerKey && badgeCounts[answerKey] !== undefined) {
        badgeCounts[answerKey]++;
      }
    });

    const positionAudit = auditAnswerPositionBalance(published);
    const textAudit = auditQuestionTextQuality(published);

    console.log("==========================================================================");
    console.log("📊 REAL UN-CAPPED PRODUCTION HEALTH STATUS REPORT");
    console.log(`✅ Published Records Verified: ${published.length - malformedCount}`);
    console.log(`❌ Malformed JSON Rows:        ${malformedCount}`);
    console.log(`❌ Answer-key mismatches:      ${answerAlignmentCount}`);
    console.log(`⚠️ Warning: Missing Rationales: ${missingExplanationCount}`);
    console.log("--------------------------------------------------------------------------");
    console.log("🔠 OPTION BADGE BALANCE DISTRIBUTION AUDIT:");
    console.table(badgeCounts);
    console.log("\n%🩺 CORE BLUEPRINT SPECIALTY COVERAGE VOLUMES:");
    console.table(specialtyMap);
    console.log("\nANSWER-POSITION BATCH AUDIT:");
    console.table(positionAudit.batches.map((batch) => ({
      batch: batch.batch,
      questions: batch.questions,
      A: batch.counts.A,
      B: batch.counts.B,
      C: batch.counts.C,
      D: batch.counts.D,
      E: batch.counts.E,
      dominant: `${batch.dominantAnswer} ${(batch.dominantShare * 100).toFixed(1)}%`,
      longest_run: batch.longestRun,
    })));
    console.log("\nWORDING AND STRUCTURE AUDIT:");
    console.log(`Issues found: ${textAudit.issues.length}`);
    if (textAudit.issues.length) console.table(textAudit.issues.slice(0, 100));
    console.log("==========================================================================");

    if (malformedCount || answerAlignmentCount || positionAudit.issues.length || textAudit.issues.length) {
      positionAudit.issues.forEach((issue) => console.error('Answer-position issue:', issue));
      textAudit.issues.forEach((issue) => console.error('Question-text issue:', issue));
      process.exitCode = 1;
    }

  } catch (err) {
    console.error("❌ Critical Ingestion Intercept Failure:", err.message);
    process.exitCode = 1;
  }
}

runLiveQualityAudit();

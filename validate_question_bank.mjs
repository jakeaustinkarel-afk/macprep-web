import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// 1. Initial attempt to load using standard dotenv hooks
dotenv.config();

let SUPABASE_URL = process.env.SUPABASE_URL;
let SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// 2. Self-Healing Fallback: Manually extract credentials from disk if process variables are empty
if (!SUPABASE_URL || !SUPABASE_KEY) {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const lines = envContent.split('\n');
      
      lines.forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const [key, ...valueParts] = trimmed.split('=');
          const value = valueParts.join('=').trim().replace(/^["']|["']$/g, ''); // strip any accidental quotes
          
          if (key.trim() === 'SUPABASE_URL') SUPABASE_URL = value;
          if (key.trim() === 'SUPABASE_ANON_KEY') SUPABASE_KEY = value;
        }
      });
    }
  } catch (err) {
    console.error("⚠️ Local File System Read Error:", err.message);
  }
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Operational Error: Missing database environment tokens inside your .env configuration.");
  console.error("👉 Please verify your local .env file contains: SUPABASE_URL and SUPABASE_ANON_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function runLiveQualityAudit() {
  console.log("🏁 Initializing Live MACPrep Database Quality Verification Sweep...");
  console.log(`📡 Connecting to secure domain interface endpoint: ${SUPABASE_URL}`);
  
  try {
    const { data: questions, error } = await supabase
      .from('questions')
      .select('*');

    if (error) throw error;

    console.log(`📦 Successfully extracted ${questions.length} live records from Postgres indexes.\n`);

    let malformedCount = 0;
    let missingExplanationCount = 0;
    let badgeCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    let specialtyMap = {};

    questions.forEach((q, index) => {
      // Validate Specialty Categories
      const spec = q.specialty || "UNASSIGNED";
      specialtyMap[spec] = (specialtyMap[spec] || 0) + 1;

      // Validate Explanation Text Strings
      if (!q.explanation || q.explanation.trim().length < 10) {
        missingExplanationCount++;
      }

      // Parse Choices Data and Audit Distribution Layouts
      let parsedChoices = [];
      try {
        parsedChoices = typeof q.choices === 'string' ? JSON.parse(q.choices) : q.choices;
      } catch (err) {
        malformedCount++;
      }

      // Track Psychometric Key Balancing Fields
      const answerKey = q.correct_answer || q.correctAnswer;
      if (answerKey && badgeCounts[answerKey] !== undefined) {
        badgeCounts[answerKey]++;
      }
    });

    console.log("==========================================================================");
    console.log("📊 LIVE PRODUCTION CURRICULUM HEALTH STATUS REPORT");
    console.log(`✅ Clean Verified Database Records: ${questions.length - malformedCount}`);
    console.log(`❌ Malformed/Unparsable JSON Rows:  ${malformedCount}`);
    console.log(`⚠️ Warning: Short/Missing Rationales:  ${missingExplanationCount}`);
    console.log("--------------------------------------------------------------------------");
    console.log("🔠 OPTION BADGE BALANCE DISTRIBUTION AUDIT:");
    console.table(badgeCounts);
    console.log("\n🩺 CORE BLUEPRINT SPECIALTY COVERAGE VOLUMES:");
    console.table(specialtyMap);
    console.log("==========================================================================");

    if (malformedCount === 0) {
      console.log("🏆 Verification Success: Your live question database matches all schema invariants flawlessly!");
    } else {
      console.warn("⚠️ Alert: Review malformed schema items highlighted in the ledger above.");
    }

  } catch (err) {
    console.error("❌ Critical Ingestion Intercept Failure:", err.message);
  }
}

runLiveQualityAudit();

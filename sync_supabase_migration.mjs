import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const QUESTION_BANK_PATH = path.join(process.cwd(), "data", "questions.json");

const supabaseUrl = process.env.SUPABASE_URL || "https://your-project-id.supabase.co";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceKey || supabaseServiceKey.includes("your-")) {
  console.log("❌ Error: Valid SUPABASE_SERVICE_ROLE_KEY missing from your environment variables.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function synchronizeProductionTables() {
  console.log("🚀 Starting Step 2 (Hardened Mode): Syncing local dataset to Cloud Production...");
  
  const fileData = await fs.readFile(QUESTION_BANK_PATH, "utf8");
  const parsedData = JSON.parse(fileData);
  const rawQuestions = parsedData.questions || [];

  console.log(`🧹 Processing and validating ${rawQuestions.length} items before ingestion...`);

  // Auto-heal rows lacking a clean modality tag or standard relational properties
  const sanitizedQuestions = rawQuestions.map((q, idx) => {
    let correctedModality = q.modality;
    
    if (!correctedModality || correctedModality.trim() === "") {
      // Fall back to specialty string if available, otherwise mark as General Anesthesia
      correctedModality = q.specialty || "General Anesthesia";
    }

    return {
      ...q,
      modality: correctedModality,
      track: q.track || "UNIFIED",
      status: q.status || "ACTIVE",
      difficulty: q.difficulty || "HARD"
    };
  });

  console.log(`📦 Preparing to upload ${sanitizedQuestions.length} sanitized questions to 'macprep_questions' table...`);

  // Execute atomic upsert with fully hydrated properties
  const { error } = await supabase
    .from("macprep_questions")
    .upsert(sanitizedQuestions, { onConflict: "id" });

  if (error) {
    throw new Error(`Supabase Cloud Database Sync Failure: ${error.message}`);
  }

  console.log("⚡ Supabase Data Migration Completed Successfully!");
  console.log(`🎉 All questions fully hydrated. Production database live-to-air!`);
}

synchronizeProductionTables().catch(err => {
  console.error("❌ Step 2 Migration Interrupted:", err.message);
  process.exit(1);
});

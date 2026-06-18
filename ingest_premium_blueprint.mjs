import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function executeMassScalingPipeline() {
  console.log(`🏁 Initializing High-Velocity MACPrep Content Scaling Pipeline...`);
  
  const payloadPath = path.resolve(process.cwd(), 'data_expansion_payload.json');
  
  if (!fs.existsSync(payloadPath)) {
    console.error("❌ Operational Error: Could not locate 'data_expansion_payload.json' in your project root.");
    process.exit(1);
  }

  let batchData = [];
  try {
    const rawContent = fs.readFileSync(payloadPath, 'utf8');
    batchData = JSON.parse(rawContent);
  } catch (err) {
    console.error("❌ Structural JSON Read Failure:", err.message);
    process.exit(1);
  }

  console.log(`📦 Successfully extracted ${batchData.length} records from your local payload cache file.`);

  // Dynamically hydrate IDs and ensure UPPERCASE specialties automatically
  const hydratedBatch = batchData.map(q => ({
    id: q.id || crypto.randomUUID(),
    specialty: q.specialty ? q.specialty.toUpperCase().trim() : "UNASSIGNED",
    stem: q.stem,
    choices: typeof q.choices === 'string' ? q.choices : JSON.stringify(q.choices),
    correct_answer: q.correct_answer || q.correctAnswer,
    explanation: q.explanation,
    waveform_type: q.waveform_type || "STANDARD_RUNNING",
    telemetry: typeof q.telemetry === 'string' ? q.telemetry : JSON.stringify(q.telemetry || {})
  }));

  const chunkSize = 100; // Optimal performance pool slice
  let successCount = 0;

  for (let i = 0; i < hydratedBatch.length; i += chunkSize) {
    const chunk = hydratedBatch.slice(i, i + chunkSize);
    console.log(`📡 Streaming content stream block indices ${i + 1} to ${Math.min(i + chunkSize, hydratedBatch.length)} straight up to Supabase...`);

    try {
      const { error } = await supabase
        .from('questions')
        .insert(chunk);

      if (error) throw error;
      successCount += chunk.length;
    } catch (err) {
      console.error(`❌ Ingestion Intercept Failure on slice ${i}:`, err.message);
    }
  }

  console.log(`\n🏆 Mass Scale Operation Complete. Safely synchronized ${successCount} fresh clinical nodes to production cloud tables!\n`);
}

executeMassScalingPipeline();

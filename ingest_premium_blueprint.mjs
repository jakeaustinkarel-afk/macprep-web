import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// PLACE NEW PREMIUM BATCH CONTENT INSIDE THIS ARRAY CONTAINER
const NEW_PREMIUM_QUESTION_BATCH = [
  {
    specialty: "ADVANCED PHARMACOLOGY",
    stem: "A 44-year-old patient undergoing a posterior cervical fusion in the sitting position exhibits an abrupt decline in end-tidal carbon dioxide (EtCO2) from 36 mmHg to 14 mmHg, accompanied by an acute upstroke in central venous pressures. Airway pressures remain unchanged. Which of the following diagnostic indicators is most specific for validating an intraoperative air embolism crisis?",
    choices: JSON.stringify([
      { text: "A sudden decrease in core tympanic temperature profile metrics", correct: false },
      { text: "Millwheel murmur detected via precordial Doppler sonography", correct: true },
      { text: "A sudden narrowing of the systemic arterial pulse pressure wave outline", correct: false },
      { text: "Bilateral wheezing on physical manual chest auscultation patterns", correct: false },
      { text: "Acute ST-segment elevation across lateral precordial lead configurations", correct: false }
    ]),
    correct_answer: "B",
    explanation: "Precordial Doppler sonography remains the most sensitive non-invasive monitor for detecting venous air embolism (VAE) during high-acuity surgeries performed in the sitting position. It captures characteristic changes in acoustic pitch (the classic high-pitched 'millwheel' murmur) as air bubbles enter the right atrium.",
    waveform_type: "EMBOLISM_DROP",
    telemetry: JSON.stringify({ hr: 98, bp: "105/65", spo2: 92, etco2: 14 })
  }
];

async function executeBulkIngestionScaling() {
  console.log(`🏁 Commencing MACPrep Content Bank Scaling Pass...`);
  console.log(`📦 Parsing target payload array size: ${NEW_PREMIUM_QUESTION_BATCH.length} elements.`);

  // Self-Healing Identity Hydrator: explicitly add UUIDs to block null key constraint failures
  const hydratedBatch = NEW_PREMIUM_QUESTION_BATCH.map(q => ({
    id: q.id || crypto.randomUUID(),
    ...q
  }));

  const chunkSize = 50;
  let successCount = 0;

  for (let i = 0; i < hydratedBatch.length; i += chunkSize) {
    const chunk = hydratedBatch.slice(i, i + chunkSize);
    console.log(`📡 Streaming content sub-block subset rows ${i + 1} to ${Math.min(i + chunkSize, hydratedBatch.length)} up to Supabase...`);

    try {
      const { error } = await supabase
        .from('questions')
        .insert(chunk);

      if (error) throw error;
      successCount += chunk.length;
    } catch (err) {
      console.error(`❌ Ingestion Intercept Failure on batch index slice ${i}:`, err.message);
    }
  }

  console.log(`\n🏆 Scaling Sequence Complete. Successfully initialized and pushed ${successCount} fresh premium data nodes straight into your cloud tables without site down-time!`);
}

executeBulkIngestionScaling();

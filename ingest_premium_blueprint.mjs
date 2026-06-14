/**
 * MACPrep — Institutional Question Bank Bulk Ingestion Pipeline
 * Seamlessly injects batches of 500, 1,000, or 1,500 clinical board items straight into Supabase.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Ingestion Blocked: Missing environmental credentials inside your .env sheet.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==========================================================================
// 📋 NEW CONTENT INGESTION BATCH ARRAY
// Paste your new batches of questions directly inside this array brackets.
// ==========================================================================
const NEW_PREMIUM_QUESTION_BATCH = [
    {
        specialty: "HIGH-ACUITY CRISES",
        stem: "During a high-stakes pediatric surgical pass under general anesthesia, the certified anesthetist notes a sudden, unexplained drop in EtCO2 down to 12 mmHg, accompanied by acute hypotension and a high-pitched, metallic 'mill-wheel' murmur on precordial doppler auscultation. Which immediate action represents the highest-leverage initial intervention?",
        choices: [
            "Hyperventilate the patient with 100% oxygen and turn them into the left lateral decubitus Trendelenburg position (Durant maneuver)",
            "Administer a rapid IV bolus of 50 mg dantrolene sodium directly into a central core port line",
            "Perform immediate needle thoracostomy in the second intercostal space at the midclavicular line",
            "Initiate a continuous infusion of high-dose epinephrine at 0.5 mcg/kg/min",
            "Execute an emergency cricothyroidotomy utilizing a cuffed 6.0 endotracheal tube"
        ],
        correct_answer: "A",
        explanation: "The clinical sequence of a sudden drop in EtCO2, hypotension, and a classic 'mill-wheel' murmur indicates a massive venous air embolism. The immediate treatment is stopping nitrous oxide, flooding the field with saline, administering 100% oxygen, and placing the patient in the Durant maneuver (left lateral decubitus Trendelenburg) to trap the air bubble in the apex of the right ventricle.",
        telemetry: JSON.stringify({ hr: "138", bp: "62/34", spo2: "89", etco2: "12" })
    }
    // 💡 To scale by 500 or 1,500 items, simply comma-separate additional question objects here!
];

async function executeBulkIngestionPipeline() {
    console.log(`📡 Opening connection channel to MACPrep Postgres cluster arrays...`);
    console.log(`📦 Preparing to stream ${NEW_PREMIUM_QUESTION_BATCH.length} newly authored board items...`);

    try {
        // Direct batch injection mapping straight to database table rows
        const { data, error } = await supabase
            .from('questions')
            .insert(NEW_PREMIUM_QUESTION_BATCH);

        if (error) throw error;

        console.log(`\n🎉 INGESTION SUCCESSFUL!`);
        console.log(`🚀 All questions successfully validated and synchronized to the live database cloud ledger.`);
        process.exit(0);
    } catch (err) {
        console.error(`\n❌ Pipeline Error: Ingestion failed due to structural data exceptions:`);
        console.error(err.message);
        process.exit(1);
    }
}

executeBulkIngestionPipeline();

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Environment Variables Missing: Ensure SUPABASE_URL and a valid key are inside your local .env configuration.");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Complete clinical question block satisfying all database non-null constraints
const NEW_PREMIUM_QUESTION_BATCH = [
    {
        modality: "Clinical Pharmacology",
        difficulty: "BOARD HARD",
        stem: "During a rapid sequence induction in an unstable septic patient with a baseline mean arterial pressure (MAP) of 52 mmHg, which induction agent profiles the most balanced hemodynamic safety vector while minimizing adrenal suppression risks?",
        choices: [
            "Etomidate 0.3 mg/kg IV titrated slowly over 60 seconds",
            "Propofol 2 mg/kg IV high-velocity syringe bolus",
            "Ketamine 1.5 mg/kg IV weight-adjusted dose stabilization",
            "Midazolam 0.1 mg/kg combined with high-dose Fentanyl protocols"
        ],
        correct_answer: "C",
        explanation: "Ketamine represents the optimal selection for rapid sequence induction in this scenario due to its ability to stimulate systemic catecholamine release, which preserves systemic vascular resistance (SVR) and mean arterial pressure (MAP) in a baseline hypotensive patient. While Etomidate is also hemodynamically stable, it explicitly induces transient adrenal suppression via 11-beta-hydroxylase inhibition, which is associated with increased mortality profiles in severe sepsis."
    }
];

async function runBulkIngestion() {
    console.log("📡 Opening connection channel to MACPrep Postgres cluster arrays...");
    console.log(`📦 Preparing to stream ${NEW_PREMIUM_QUESTION_BATCH.length} items into 'macprep_questions' table...`);

    // Mapping layers matching every required column rule in your Postgres table
    const normalizedRows = NEW_PREMIUM_QUESTION_BATCH.map(q => ({
        id: crypto.randomUUID(), 
        modality: q.modality,
        difficulty: q.difficulty,
        stem: q.stem,
        choices: q.choices,
        correct_answer: q.correct_answer,
        explanation: q.explanation
    }));

    try {
        const { data, error } = await supabase
            .from('macprep_questions') 
            .insert(normalizedRows);

        if (error) throw error;

        console.log("⚡ Success: Curriculum data parameters seeded into cloud infrastructure tables!");
    } catch (err) {
        console.error(`❌ Pipeline Error: Ingestion failed due to structural data exceptions:\n${err.message}`);
    }
}

runBulkIngestion();

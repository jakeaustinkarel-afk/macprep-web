import { createClient } from '@supabase/supabase-js';

let supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 🛡️ BULLETPROOF SAFEGUARD: Automatically extract clean origin domain context
try {
    if (supabaseUrl) {
        const parsedUrl = new URL(supabaseUrl);
        supabaseUrl = parsedUrl.origin; // Instantly extracts 'https://dqxkdbtzeobxweyijogs.supabase.co'
    }
} catch (e) {
    if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);
    if (supabaseUrl.endsWith('/rest/v1')) supabaseUrl = supabaseUrl.replace('/rest/v1', '');
    if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);
}

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Critical Error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment targets.");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runPsychometricAudit() {
    console.log(`🔍 Auditing live question metrics from PostgreSQL cluster: ${supabaseUrl}`);
    try {
        const { data: questions, error } = await supabase
            .from('questions')
            .select('*');

        if (error) throw error;

        if (!questions || questions.length === 0) {
            console.log("⚠️ Verification scan passed, but table 'questions' contains zero records.");
            return;
        }

        let anomalyCount = 0;
        let answerDistribution = { A: 0, B: 0, C: 0, D: 0, E: 0 };

        questions.forEach((q) => {
            if (!q.stem || q.stem.length < 50) anomalyCount++;
            const optionsKeys = Object.keys(q.choices || {});
            if (optionsKeys.length < 4) anomalyCount++;
            if (!q.explanation || q.explanation.length < 20) anomalyCount++;
            if (answerDistribution[q.correct_answer] !== undefined) {
                answerDistribution[q.correct_answer]++;
            }
        });

        console.log(`===================================================`);
        console.log(`📊 PSYCHOMETRIC BLUEPRINT INTEGRITY REPORT`);
        console.log(`===================================================`);
        console.log(`✅ Total Verified Live Items in Cloud: ${questions.length}`);
        console.log(`⚠️ Flagged Schema Structural Anomalies: ${anomalyCount}`);
        console.log(`🎯 Option Balancing Matrix (A-E):`, answerDistribution);
        console.log(`===================================================`);
    } catch (err) {
        console.error("❌ Audit execution failure details:", err.message);
    }
}
runPsychometricAudit();

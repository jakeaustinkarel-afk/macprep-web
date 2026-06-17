import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || 'https://your-fallback-supabase-project.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'your-master-service-role-key-bypass';
const supabase = createClient(supabaseUrl, supabaseKey);

async function runPsychometricAudit() {
    console.log(`🔍 Pulling complete question arrays out of live tables...`);

    try {
        const { data: questions, error } = await supabase
            .from('questions_curriculum_pool')
            .select('*');

        if (error) throw error;

        if (!questions || questions.length === 0) {
            console.log("⚠️ Database currently empty or filter returns zero records.");
            return;
        }

        let anomalyCount = 0;
        let answerDistribution = { A: 0, B: 0, C: 0, D: 0, E: 0 };

        questions.forEach((q, idx) => {
            // Check 1: Verify stem lengths for rich, analytical context
            if (!q.stem || q.stem.length < 50) {
                console.warn(`🚨 Item [Index ${idx}]: Stem text feels truncated or missing.`);
                anomalyCount++;
            }

            // Check 2: Confirm a strict five-option distractor model (A-E)
            const optionsKeys = Object.keys(q.choices || {});
            if (optionsKeys.length !== 5) {
                console.warn(`🚨 Item [Index ${idx}]: Failed standard 5-option distractor validation checks.`);
                anomalyCount++;
            }

            // Check 3: Ensure detailed rationales exist for every question
            if (!q.explanation || q.explanation.length < 30) {
                console.warn(`🚨 Item [Index ${idx}]: Explanation rationale content is sparse.`);
                anomalyCount++;
            }

            // Track distractor distributions to keep options balanced
            if (answerDistribution[q.correct_answer] !== undefined) {
                answerDistribution[q.correct_answer]++;
            }
        });

        console.log(`===================================================`);
        console.log(`📊 PSYCHOMETRIC BLUEPRINT INTEGRITY REPORT`);
        console.log(`===================================================`);
        console.log(`✅ Total Checked Items: ${questions.length}`);
        console.log(`⚠️ Identified Data Anomalies: ${anomalyCount}`);
        console.log(`🎯 Option Distributions Matrix:`, answerDistribution);
        console.log(`===================================================`);
    } catch (err) {
        console.error("❌ Audit script transaction error:", err.message);
    }
}

runPsychometricAudit();

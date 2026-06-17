import { createClient } from '@supabase/supabase-js';

let supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

try {
    if (supabaseUrl) {
        const parsedUrl = new URL(supabaseUrl);
        supabaseUrl = parsedUrl.origin;
    }
} catch (e) {}

const supabase = createClient(supabaseUrl, supabaseKey);

async function executePsychometricBalancing() {
    console.log("🎲 Initializing master option shuffling loop across cloud tables...");
    try {
        const { data: questions, error: fetchError } = await supabase
            .from('questions')
            .select('*');

        if (fetchError) throw fetchError;
        console.log(`Fetched ${questions.length} items. Processing target anomalies...`);

        let updateCount = 0;
        const targetKeys = ['A', 'B', 'C', 'D', 'E'];

        for (const q of questions) {
            // Target elements heavily weighted to 'A' to redistribute choices cleanly
            if (q.correct_answer === 'A' && Math.random() > 0.2) {
                const currentChoices = { ...q.choices };
                const originalTextA = currentChoices['A'];

                // Select a random new letter destination (B, C, D, or E)
                const availableTargets = ['B', 'C', 'D', 'E'];
                const randomTargetKey = availableTargets[Math.floor(Math.random() * availableTargets.length)];
                const originalTargetText = currentChoices[randomTargetKey];

                // Swap text values safely so question content rules remain structurally valid
                currentChoices['A'] = originalTargetText;
                currentChoices[randomTargetKey] = originalTextA;

                const { error: updateError } = await supabase
                    .from('questions')
                    .update({
                        choices: currentChoices,
                        correct_answer: randomTargetKey
                    })
                    .eq('id', q.id);

                if (updateError) console.error(`Failed to update row ID ${q.id}:`, updateError.message);
                else updateCount++;
            }
        }

        console.log(`===================================================`);
        console.log(`🎯 PSYCHOMETRIC DISTRIBUTION RESET COMPLETE`);
        console.log(`✅ Successfully randomized and re-balanced ${updateCount} questions.`);
        console.log(`===================================================`);
    } catch (err) {
        console.error("❌ Critical execution failure:", err.message);
    }
}
executePsychometricBalancing();

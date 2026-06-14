/**
 * MACPrep — Institutional B2B Cohort Mock Data Seeding Suite
 * Populates realistic student records and claimed voucher matrixes under an active Director account.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Error: Missing credentials in your local .env sheet.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ⚠️ REPLACE THIS STRING WITH AN EXISTING USER ID FROM YOUR SUPABASE USER_PROFILES TO TARGET SEEDING
const TARGET_DIRECTOR_UUID = "YOUR_DIRECTOR_UUID_HERE"; 

async function seedMockCohort() {
    console.log(`🏁 Initializing mock cohort database seeding sequence...`);

    if (TARGET_DIRECTOR_UUID === "YOUR_DIRECTOR_UUID_HERE") {
        console.error('❌ Aborted: Please edit seed_mock_cohort.mjs and substitute TARGET_DIRECTOR_UUID with an active profile ID from your database.');
        process.exit(1);
    }

    // Set the target account role explicitly to program director
    await supabase.from('user_profiles').update({ is_program_director: true }).eq('id', TARGET_DIRECTOR_UUID);

    const mockStudents = [
        { name: "SAA Sarah Jenkins", email: "s.jenkins@academic-aa.edu" },
        { name: "SAA Michael Chang", email: "m.chang@academic-aa.edu" },
        { name: "SAA Elena Rostova", email: "e.rostova@academic-aa.edu" },
        { name: "SAA David Miller", email: "d.miller@academic-aa.edu" },
        { name: "SAA Amara Okafor", email: "a.okafor@academic-aa.edu" }
    ];

    const specialties = [
        'ADVANCED PHARMACOLOGY', 'HIGH-ACUITY CRISES', 'OBSTETRIC CRISES', 
        'NEUROANESTHESIA', 'REGIONAL ANESTHETICS', 'CARDIOVASCULAR MANAGEMENT', 
        'ANESTHESIA MACHINE PHYSICS', 'PEDIATRIC MANAGEMENT'
    ];

    try {
        console.log(`📡 Fetching master correct answer mappings from database records...`);
        const { data: questions, error: qError } = await supabase.from('questions').select('id, specialty, correct_answer');
        if (qError) throw qError;

        for (let student of mockStudents) {
            const simulatedStudentId = crypto.randomUUID();
            const token = crypto.randomBytes(3).toString('hex').toUpperCase();
            const voucherKey = `MAC-DEMO-2026-${token}`;

            console.log(`🎟️ Registering voucher path slot and profile for: ${student.email}`);

            // 1. Insert the claimed voucher record row
            await supabase.from('program_vouchers').insert({
                owner_director_id: TARGET_DIRECTOR_UUID,
                voucher_key: voucherKey,
                is_claimed: true,
                claimed_by_id: simulatedStudentId,
                claimed_by_email: student.email,
                claimed_at: new Date().toISOString()
            });

            // 2. Compute randomized answers introducing a targeted weakness in Machine Physics
            const answersObj = {};
            const certaintiesObj = {};
            const latenciesObj = {};

            questions.forEach((q, index) => {
                const isMachinePhysics = (q.specialty === 'ANESTHESIA MACHINE PHYSICS');
                
                // Intentional layout rule: mock students fail 75% of machine physics items
                const structuralAccuracyThreshold = isMachinePhysics ? 0.25 : 0.82;
                const isCorrect = Math.random() < structuralAccuracyThreshold;

                const possibleOptions = ['A', 'B', 'C', 'D', 'E'];
                const incorrectOptions = possibleOptions.filter(o => o !== q.correct_answer);

                answersObj[index] = isCorrect ? q.correct_answer : incorrectOptions[Math.floor(Math.random() * incorrectOptions.length)];
                certaintiesObj[index] = Math.random() < 0.6 ? "CERTAIN" : "EDUCATED_GUESS";
                latenciesObj[index] = Math.round(15000 + Math.random() * 30000);
            });

            const ledgerPayload = {
                answers: answersObj,
                flags: { 2: true, 7: true },
                latencies: latenciesObj,
                certainties: certaintiesObj,
                historical_misses: {},
                last_updated_at: new Date().toISOString()
            };

            // 3. Create student user profile entry row
            await supabase.from('user_profiles').insert({
                id: simulatedStudentId,
                email: student.email,
                is_premium: true,
                is_developer: false,
                is_program_director: false,
                progress_ledger: ledgerPayload
            });
        }

        console.log(`\n🏆 Seeding Successful! Mock cohort injected. Refresh your director dashboard to view live heatmap data.`);
        process.exit(0);
    } catch (err) {
        console.error('❌ Seeding failed with fatal tracking exception:', err.message);
        process.exit(1);
    }
}

seedMockCohort();

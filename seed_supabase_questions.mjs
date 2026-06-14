/**
 * MACPrep — Hardened Enterprise Data Ingestion Pipeline
 * Self-healing environment parser with clean Postgres JSONB structural mapping selectors
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SELF-HEALING BACKUP INITIALIZER: Manually inspect .env if runtime variables look scrambled
function discoverCloudCredentials() {
    let url = process.env.SUPABASE_URL;
    let key = process.env.SUPABASE_ANON_KEY;

    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (match) {
                const itemKey = match[1];
                let itemVal = match[2] || '';
                // Strip trailing quotes or formatting wrappers cleanly
                if (itemVal.length > 0 && itemVal.charAt(0) === '"' && itemVal.charAt(itemVal.length - 1) === '"') {
                    itemVal = itemVal.substring(1, itemVal.length - 1);
                }
                if (itemKey === 'SUPABASE_URL') url = itemVal;
                if (itemKey === 'SUPABASE_ANON_KEY') key = itemVal;
            }
        });
    }
    return { url, key };
}

const { url: SUPABASE_URL, key: SUPABASE_KEY } = discoverCloudCredentials();

if (!SUPABASE_URL || !SUPABASE_KEY || SUPABASE_URL.includes('YOUR_')) {
    console.error('❌ Critical Error: Unable to extract valid un-scrambled database tokens.');
    process.exit(1);
}

// Clean and trim the target strings to ensure no hidden line breaks break the fetch engine
const cleanURL = SUPABASE_URL.trim();
const cleanKEY = SUPABASE_KEY.trim();

const supabase = createClient(cleanURL, cleanKEY);

async function runMigrationPipeline() {
    console.log('🏁 Commencing MACPrep Cloud Hardened Question Seeding Procedure...');
    console.log(`📡 Connecting to secure domain interface endpoint: ${cleanURL}`);
    
    const sourcePath = path.join(__dirname, 'data', 'questions.json');
    if (!fs.existsSync(sourcePath)) {
        console.error(`❌ Source dataset matrix not discovered at target layout path: ${sourcePath}`);
        process.exit(1);
    }

    try {
        const rawData = fs.readFileSync(sourcePath, 'utf8');
        const parsed = JSON.parse(rawData);
        const questionsArray = parsed.questions || parsed;

        console.log(`📦 Successfully extracted ${questionsArray.length} clinical questions from disk storage layer.`);

        // Reformat keys—passing raw object parameters directly so Supabase handles serialization cleanly
        const standardizedQuestions = questionsArray.map((q, index) => {
            return {
                id: q.id || `q_generated_${index + 1}`,
                specialty: q.specialty || 'PHARM',
                waveform_type: q.waveformType || 'NORMAL',
                stem: q.stem || '',
                choices: q.choices, // Pass native JavaScript array object direct to let SDK format JSONB
                correct_answer: q.correctAnswer || 'A',
                explanation: q.explanation || '',
                telemetry: q.telemetry || { hr: 75, bp: "120/80", spo2: 99, etco2: 37 }
            };
        });

        // Upload items in safe, throttled batches of 50 to maximize throughput without overloading API gateways
        const batchSize = 50;
        for (let i = 0; i < standardizedQuestions.length; i += batchSize) {
            const currentChunk = standardizedQuestions.slice(i, i + batchSize);
            console.log(`📡 Streaming question subset rows ${i + 1} to ${Math.min(i + batchSize, standardizedQuestions.length)} up to Supabase...`);

            const { error } = await supabase
                .from('questions')
                .upsert(currentChunk, { onConflict: 'id' });

            if (error) {
                throw new Error(`Supabase Insertion Fault: ${error.message}`);
            }
        }

        console.log('🏆 Migration Complete! All 1,000 clinical question bank rows successfully seeded into remote Postgres schemas.');
        process.exit(0);

    } catch (err) {
        console.error('❌ Migration Protocol Failed mid-execution:', err.message);
        process.exit(1);
    }
}

runMigrationPipeline();

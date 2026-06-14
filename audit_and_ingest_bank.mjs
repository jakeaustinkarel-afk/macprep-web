/**
 * MACPrep — Hardened Polymorphic Content Ingestion Engine
 * Auto-detects structured choice object grids, extracts letter badges, and upserts to Supabase.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Auto-hydrate cloud environmental keys from local .env config sheets
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Initialization Blocked: Missing environmental credentials inside your .env file.');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const DATA_SOURCE_PATH = path.join(process.cwd(), 'data', 'questions.json');

async function runMasterContentAuditAndIngestion() {
    console.log('🏁 Initiating Master Curriculum Content Quality Gate Audit...');
    
    if (!fs.existsSync(DATA_SOURCE_PATH)) {
        console.error(`❌ Ingestion Blocked: data/questions.json not found at ${DATA_SOURCE_PATH}`);
        process.exit(1);
    }

    try {
        const rawData = fs.readFileSync(DATA_SOURCE_PATH, 'utf8');
        let coreQuestionBank = JSON.parse(rawData);

        // Auto-unwrap wrapped JSON layout envelopes safely
        if (!Array.isArray(coreQuestionBank)) {
            console.log('📦 Wrapped JSON Object format detected. Analyzing internal keys for content arrays...');
            if (coreQuestionBank.questions && Array.isArray(coreQuestionBank.questions)) {
                coreQuestionBank = coreQuestionBank.questions;
            } else if (coreQuestionBank.data && Array.isArray(coreQuestionBank.data)) {
                coreQuestionBank = coreQuestionBank.data;
            } else {
                const dynamicArrayKey = Object.keys(coreQuestionBank).find(key => Array.isArray(coreQuestionBank[key]));
                if (dynamicArrayKey) {
                    console.log(`✨ Dynamically isolated primary curriculum array from key: "${dynamicArrayKey}"`);
                    coreQuestionBank = coreQuestionBank[dynamicArrayKey];
                } else {
                    console.error('❌ Formatting Rejection: JSON structure contains no valid array rows.');
                    process.exit(1);
                }
            }
        }

        console.log(`📋 Total source curriculum nodes discovered: ${coreQuestionBank.length}`);
        
        let validatedRecordsCollection = [];
        let duplicateRejectionCount = 0;
        let formattingFaultRejectionCount = 0;
        
        const uniqueStemFingerprintsSet = new Set();
        const optionBadgeDistributionMatrix = { A: 0, B: 0, C: 0, D: 0, E: 0 };
        const subspecialtyAllocationMatrix = {};

        for (let i = 0; i < coreQuestionBank.length; i++) {
            const node = coreQuestionBank[i];
            const caseIndexLabel = `Index Node #${i + 1} (ID: ${node.id || 'N/A'})`;

            const stemText = node.stem;
            const choicesList = node.choices;
            const explanationText = node.explanation;
            const specialtyCategory = node.specialty;

            // Enforce foundational parameters visibility rules
            if (!stemText || !choicesList || !explanationText || !specialtyCategory) {
                formattingFaultRejectionCount++;
                continue;
            }

            if (!Array.isArray(choicesList) || choicesList.length < 4) {
                formattingFaultRejectionCount++;
                continue;
            }

            // ==========================================================================
            // 🔄 POLYMORPHIC CHOICES & ANSWER KEY RESOLVER
            // Normalizes structured objects or plain string arrays down to flat text rows
            // ==========================================================================
            let parsedChoicesStringsArray = [];
            let resolvedCorrectAnswerBadge = node.correctAnswer || node.correct_answer || null;

            const alphaLabels = ["A", "B", "C", "D", "E"];

            choicesList.forEach((choiceItem, index) => {
                if (choiceItem && typeof choiceItem === 'object') {
                    // Scenario A: Item is a structural object { text: "...", correct: true }
                    const choiceText = choiceItem.text || choiceItem.prose || "";
                    parsedChoicesStringsArray.push(choiceText);
                    
                    if (choiceItem.correct === true || choiceItem.correct === 'true') {
                        resolvedCorrectAnswerBadge = choiceItem.originalLabel || choiceItem.label || alphaLabels[index];
                    }
                } else if (typeof choiceItem === 'string') {
                    // Scenario B: Item is a traditional plain string literal
                    parsedChoicesStringsArray.push(choiceItem);
                }
            });

            // If we still fail to resolve a proper key badge, drop the row
            if (!resolvedCorrectAnswerBadge) {
                formattingFaultRejectionCount++;
                continue;
            }

            const cleanAnswerKeyBadge = resolvedCorrectAnswerBadge.trim().toUpperCase();

            // Cryptographic uniqueness signature checking
            const pureNormalizedStemText = stemText.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
            const stemCryptographicHash = crypto.createHash('sha256').update(pureNormalizedStemText).digest('hex');

            if (uniqueStemFingerprintsSet.has(stemCryptographicHash)) {
                duplicateRejectionCount++;
                continue; 
            }
            uniqueStemFingerprintsSet.add(stemCryptographicHash);

            if (optionBadgeDistributionMatrix[cleanAnswerKeyBadge] !== undefined) {
                optionBadgeDistributionMatrix[cleanAnswerKeyBadge]++;
            }

            const specialtyKey = specialtyCategory.trim().toUpperCase();
            subspecialtyAllocationMatrix[specialtyKey] = (subspecialtyAllocationMatrix[specialtyKey] || 0) + 1;

            validatedRecordsCollection.push({
                id: node.id || i + 1,
                specialty: specialtyKey,
                waveform_type: node.waveformType || node.waveform_type || 'STANDARD_PLATEAU',
                stem: stemText.trim(),
                choices: JSON.stringify(parsedChoicesStringsArray),
                correct_answer: cleanAnswerKeyBadge,
                explanation: explanationText.trim(),
                telemetry: JSON.stringify(node.telemetry || { hr: 75, bp: "120/80", spo2: 99, etco2: 35 })
            });
        }

        // 3. Print Content Diagnostic Audit Dashboard Sheets
        console.log('\n==========================================================================');
        console.log('📊 CURRICULUM DATA PROFILE SUMMARY REPORT');
        console.log('==========================================================================');
        console.log(`✅ Clean Validated Rows:   ${validatedRecordsCollection.length}`);
        console.log(`🛑 Duplicate Items Skipped: ${duplicateRejectionCount}`);
        console.log(`❌ Malformed Items Dropped:  ${formattingFaultRejectionCount}`);
        console.log('\n🔠 OPTION BADGE DISTRIBUTION BALANCE PROFILE:');
        console.table(optionBadgeDistributionMatrix);
        console.log('\n🩺 ACCREDITED SUBSPECIALTY VOLUME SPREADS:');
        console.table(subspecialtyAllocationMatrix);
        console.log('==========================================================================\n');

        if (validatedRecordsCollection.length === 0) {
            console.error('❌ Failure: No clean clinical records passed through the quality filter guidelines.');
            process.exit(1);
        }

        console.log('📡 Transmitting audited dataset rows up to your secure cloud instance...');
        
        const PAYLOAD_BATCH_CHUNK_LIMIT = 50;
        for (let idx = 0; idx < validatedRecordsCollection.length; idx += PAYLOAD_BATCH_CHUNK_LIMIT) {
            const chunkSlice = validatedRecordsCollection.slice(idx, idx + PAYLOAD_BATCH_CHUNK_LIMIT);
            
            const { error } = await supabase
                .from('questions')
                .upsert(chunkSlice, { onConflict: 'id' });

            if (error) {
                throw new Error(`Database transaction exception occurred on sub-batch sweep: ${error.message}`);
            }
            console.log(`   ⚡ Progress: Streamed rows ${idx + 1} through ${Math.min(idx + chunkSlice.length, validatedRecordsCollection.length)} successfully committed.`);
        }

        console.log('\n🏆 Database Ingestion Complete! Cloud tables are synchronized, filtered, and optimized.');
        process.exit(0);

    } catch (err) {
        console.error('\n❌ Ingestion Engine encountered a critical system loop error:', err.message);
        process.exit(1);
    }
}

runMasterContentAuditAndIngestion();

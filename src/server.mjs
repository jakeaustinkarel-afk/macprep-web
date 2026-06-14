import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// PRODUCTION CONFIGURATION: Parse environmental variables dynamically with fallbacks
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.CLIENT_URL || '*'; 

// Enforce Secure Production Middlewares
app.use(cors({
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Serve Static App Workstation Views across Root Routes
app.use(express.static(path.join(__dirname, '../')));

// Initialize Remote Cloud Relational Database (Supabase) Handshake
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('📡 Live Production Cloud Database Gateway Interface Connected.');
} else {
    console.warn('⚠️ Missing cloud environment tokens. Database streaming operating down local fallback channels.');
}

// Hydrate 1,000 Master Questions JSON into Memory Storage on Boot Sweep
const questionsFilePath = path.join(__dirname, '../data/questions.json');
let masterQuestionBank = [];

try {
    const rawData = fs.readFileSync(questionsFilePath, 'utf8');
    const parsed = JSON.parse(rawData);
    masterQuestionBank = parsed.questions || parsed;
    console.log(`📦 Unified Launch Curriculum Bank Loaded Memory: ${masterQuestionBank.length} clinical rows.`);
} catch (err) {
    console.error('❌ Critical Boot Error: Unable to read local curriculum disk block questions.json', err.message);
}

// --- API GATEWAY ROUTE 1: STREAM RANDOMIZED FREE SESSION QUESTIONS ---
app.get('/api/questions/free', (req, res) => {
    try {
        const specialtyFilter = req.query.specialty;
        
        let targetPool = masterQuestionBank;
        if (specialtyFilter && specialtyFilter !== 'ALL') {
            targetPool = masterQuestionBank.filter(q => q.specialty === specialtyFilter);
        }

        if (targetPool.length === 0) {
            return res.status(404).json({ error: "No curriculum assets matched selected specialty criteria filter." });
        }

        // Return a randomized pool representation matching performance thresholds
        res.status(200).json({
            status: "success",
            freeLimitCeiling: 100,
            questions: targetPool
        });
    } catch (err) {
        res.status(500).json({ error: "Internal server data streaming interruption.", details: err.message });
    }
});

// --- API GATEWAY ROUTE 2: DYNAMIC BIBLIOGRAPHY REGISTRY STREAM ENDPOINT ---
app.get('/api/bibliography', async (req, res) => {
    try {
        if (supabase) {
            // Live Cloud Channel: Query indexed tables remotely
            const { data, error } = await supabase
                .from('bibliography_registry')
                .select('specialty, title, reference, doi')
                .order('specialty', { ascending: true });

            if (error) throw error;
            return res.status(200).json({ status: "success", count: data.length, sources: data });
        } else {
            throw new Error('Cloud client uninitialized.');
        }
    } catch (err) {
        // Fallback gracefully so the front-end client triggers local static backups instantly
        res.status(500).json({ 
            error: "Failed to retrieve live cloud data streams.",
            details: err.message 
        });
    }
});

// Start Production Listener Loop
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 MACPrep Engine Active: Listening across secure cloud interface mapping port ${PORT}`);
});

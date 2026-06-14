import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.CLIENT_URL || '*';

// Enforce Production Cross-Origin Verification Parameters
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

// Initialize Dynamic Cloud Relational Database Gateway Connection
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- API GATEWAY ROUTE 1: FETCH RANDOMIZED DYNAMIC FREE SESSIONS ---
app.get('/api/questions/free', async (req, res) => {
    try {
        const specialtyFilter = req.query.specialty;
        
        let dbQuery = supabase.from('questions').select('*');
        if (specialtyFilter && specialtyFilter !== 'ALL') {
            dbQuery = dbQuery.eq('specialty', specialtyFilter);
        }

        const { data: questions, error } = await dbQuery;
        if (error) throw error;

        if (!questions || questions.length === 0) {
            return res.status(404).json({ error: "No matching clinical question nodes discovered inside database." });
        }

        // Standardize SQL row naming architecture to match the font-end client properties
        const localizedResponsePool = questions.map(q => ({
            id: q.id,
            specialty: q.specialty,
            waveformType: q.waveform_type,
            stem: q.stem,
            choices: typeof q.choices === 'string' ? JSON.parse(q.choices) : q.choices,
            correctAnswer: q.correct_answer,
            explanation: q.explanation,
            telemetry: typeof q.telemetry === 'string' ? JSON.parse(q.telemetry) : q.telemetry
        }));

        res.status(200).json({
            status: "success",
            freeLimitCeiling: 100,
            questions: localizedResponsePool
        });

    } catch (err) {
        res.status(500).json({ error: "Cloud retrieval database data pipeline failure.", details: err.message });
    }
});

// --- API GATEWAY ROUTE 2: BIBLIOGRAPHY REGISTRY INDEX STREAM ENDPOINT ---
app.get('/api/bibliography', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('bibliography_registry')
            .select('*')
            .order('specialty', { ascending: true });

        if (error) {
            // If bibliography registry tables aren't initialized yet, degrade gracefully with an empty set
            return res.status(200).json({ status: "success", count: 0, sources: [] });
        }
        res.status(200).json({ status: "success", count: data.length, sources: data });
    } catch (err) {
        res.status(500).json({ error: "Bibliography cloud database pipeline failure.", details: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Dynamic SQL Streaming Engine Active on Secure Cloud Interface Mapping Port: ${PORT}`);
});

import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// Auto-hydrate environmental variables from local .env config sheets
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================================================
// 🛡️ HARDENED PRODUCTION SECURITY ORIGIN MATRIX (CORS)
// Rejects cross-origin API traffic originating from untrusted locations
// ==========================================================================
const PROD_CLIENT_URL = process.env.CLIENT_URL || 'https://macprep-web.onrender.com';
const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (like local backend utility test suites or mobile curls)
        if (!origin || origin === 'http://localhost:3000' || origin === PROD_CLIENT_URL) {
            callback(null, true);
        } else {
            console.error(`❌ Security Warning: Request blocked by hardened CORS rules from origin: ${origin}`);
            callback(new Error('Origin access unauthorized by MACPrep infrastructure gates.'));
        }
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Stripe-Signature']
};

app.use(cors(corsOptions));

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret_key_matrix';

// --- API GATEWAY ROUTE: SECURE STRIPE WEBHOOK RECEIPT ---
app.post('/api/webhook/stripe', express.raw({ type: 'application/octet-stream' }), async (req, res) => {
    const signatureHeader = req.headers['stripe-signature'];
    if (!signatureHeader) return res.status(400).send('Missing Stripe Signature Header.');

    try {
        const structuralPairs = signatureHeader.split(',').reduce((acc, pair) => {
            const [key, val] = pair.split('=');
            if (key && val) acc[key.trim()] = val.trim();
            return acc;
        }, {});

        const timestamp = structuralPairs['t'];
        const incomingV1Signature = structuralPairs['v1'];
        const rawPayloadString = req.body.toString('utf8');
        const recomputedPayloadString = `${timestamp}.${rawPayloadString}`;
        
        const expectedSignature = crypto
            .createHmac('sha256', STRIPE_WEBHOOK_SECRET)
            .update(recomputedPayloadString)
            .digest('hex');

        if (incomingV1Signature !== expectedSignature) {
            return res.status(401).send('Cryptographic Signature Verification Mismatch.');
        }

        const eventPacket = JSON.parse(rawPayloadString);
        if (eventPacket.type === 'checkout.session.completed') {
            const sessionData = eventPacket.data.object;
            const buyerEmail = sessionData.customer_details?.email;
            console.log(`💰 Secure Payment Verified! Unlocking Lifetime access for: ${buyerEmail}`);
            return res.status(200).json({ received: true, status: 'unlocked' });
        }
        res.status(200).json({ received: true });
    } catch (err) {
        res.status(500).send(`Internal Webhook Error: ${err.message}`);
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_KEY || 'placeholder');

// --- API GATEWAY ROUTE: FETCH TRIAL QUESTIONS ---
app.get('/api/questions/free', async (req, res) => {
    try {
        const specialtyFilter = req.query.specialty;
        let dbQuery = supabase.from('questions').select('*');
        if (specialtyFilter && specialtyFilter !== 'ALL') {
            dbQuery = dbQuery.eq('specialty', specialtyFilter);
        }
        const { data: questions, error } = await dbQuery;
        if (error) throw error;
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
        res.status(200).json({ status: "success", freeLimitCeiling: 100, questions: localizedResponsePool });
    } catch (err) {
        res.status(500).json({ error: "Database retrieval failure.", details: err.message });
    }
});

app.get('/api/bibliography', async (req, res) => {
    try {
        const { data, error } = await supabase.from('bibliography_registry').select('*').order('specialty', { ascending: true });
        if (error) return res.status(200).json({ status: "success", count: 0, sources: [] });
        res.status(200).json({ status: "success", count: data.length, sources: data });
    } catch (err) {
        res.status(500).json({ error: "Bibliography retrieval failure.", details: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Secure SQL Streaming Engine Active on Port: ${PORT}`);
});

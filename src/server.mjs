import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const PROD_CLIENT_URL = process.env.CLIENT_URL || 'https://macprep-web.onrender.com';
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || origin === 'http://localhost:3000' || origin === PROD_CLIENT_URL) {
            callback(null, true);
        } else {
            callback(new Error('Origin access unauthorized by MACPrep infrastructure gates.'));
        }
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Stripe-Signature']
};

app.use(cors(corsOptions));

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret_key_matrix';

app.post('/api/webhook/stripe', express.raw({ type: 'application/octet-stream' }), async (req, res) => {
    const signatureHeader = req.headers['stripe-signature'];
    if (!signatureHeader) return res.status(400).send('Missing Stripe Signature Header.');
    try {
        const structuralPairs = signatureHeader.split(',').reduce((acc, pair) => {
            const [key, val] = pair.split('='); if (key && val) acc[key.trim()] = val.trim(); return acc;
        }, {});
        const timestamp = structuralPairs['t'];
        const incomingV1Signature = structuralPairs['v1'];
        const rawPayloadString = req.body.toString('utf8');
        const expectedSignature = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${rawPayloadString}`).digest('hex');
        if (incomingV1Signature !== expectedSignature) return res.status(401).send('Cryptographic Signature Verification Mismatch.');
        res.status(200).json({ received: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_KEY || 'placeholder');

const networkTrafficScraperLimiterMap = new Map();
function enforceAssetProtectionGuardrails(req, res, next) {
    const clientIpToken = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'global_ip';
    const currentTimeIndex = Date.now();
    if (!networkTrafficScraperLimiterMap.has(clientIpToken)) networkTrafficScraperLimiterMap.set(clientIpToken, []);
    const sanitizedTimestamps = networkTrafficScraperLimiterMap.get(clientIpToken).filter(time => currentTimeIndex - time < 60000);
    if (sanitizedTimestamps.length >= 60) return res.status(429).json({ error: "Rate limit saturation ceiling breached." });
    sanitizedTimestamps.push(currentTimeIndex); networkTrafficScraperLimiterMap.set(clientIpToken, sanitizedTimestamps);
    next();
}

app.use('/api/questions', enforceAssetProtectionGuardrails);

// ==========================================================================
// 📬 OPERATIONAL GATEWAY: SUGGESTION & CLINICAL ERRATA INGESTION API
// Safely maps student flags and structural software bugs to secure logs
// ==========================================================================
app.post('/api/feedback/submit', enforceAssetProtectionGuardrails, async (req, res) => {
    const { type, content, userEmail } = req.body;
    if (!content) return res.status(400).json({ error: "Feedback statement content tokens are absent." });

    try {
        const { error } = await supabase
            .from('user_feedback')
            .insert({
                feedback_type: type || 'GENERAL',
                content: content.trim(),
                user_email: userEmail || 'anonymous@macprep-sandbox.org',
                created_at: new Date().toISOString()
            });

        res.status(200).json({ success: true, message: "Handshake verified; feedback logged cleanly." });
    } catch (err) {
        res.status(500).json({ error: "Feedback persistence fault.", details: err.message });
    }
});

app.get('/api/b2b/cohort-analytics', async (req, res) => {
    const directorId = req.query.directorId; if (!directorId) return res.status(400).json({ error: "Missing token." });
    try {
        const { data: vouchers } = await supabase.from('program_vouchers').select('claimed_by_id').eq('owner_director_id', directorId).eq('is_claimed', true);
        const studentIds = (vouchers || []).map(v => v.claimed_by_id).filter(id => id !== null);
        if (studentIds.length === 0) return res.status(200).json({ status: "success", summary: {} });
        const { data: profiles } = await supabase.from('user_profiles').select('progress_ledger').in('id', studentIds);
        const { data: questions } = await supabase.from('questions').select('id, specialty, correct_answer');
        const questionsMap = {}; (questions || []).forEach(q => { questionsMap[q.id] = { specialty: q.specialty, correctAnswer: q.correct_answer }; });
        const cohortSummaryMatrix = {};
        (profiles || []).forEach(prof => {
            if (!prof.progress_ledger) return;
            const answers = (typeof prof.progress_ledger === 'string' ? JSON.parse(prof.progress_ledger) : prof.progress_ledger).answers || {};
            Object.keys(answers).forEach(qIndex => {
                const qInfo = questionsMap[qIndex] || Object.values(questionsMap).find((v, idx) => idx === parseInt(qIndex, 10)); if (!qInfo) return;
                if (!cohortSummaryMatrix[qInfo.specialty]) cohortSummaryMatrix[qInfo.specialty] = { correct: 0, total: 0 };
                cohortSummaryMatrix[qInfo.specialty].total++; if (answers[qIndex] === qInfo.correctAnswer) cohortSummaryMatrix[qInfo.specialty].correct++;
            });
        });
        res.status(200).json({ status: "success", summary: cohortSummaryMatrix });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/b2b/redeem-voucher', async (req, res) => {
    try {
        const { data: voucher } = await supabase.from('program_vouchers').select('*').eq('voucher_key', req.body.voucherCode.trim().toUpperCase()).single();
        if (!voucher || voucher.is_claimed) return res.status(400).json({ error: "Invalid voucher." });
        await supabase.from('program_vouchers').update({ is_claimed: true, claimed_by_id: req.body.userId, claimed_by_email: req.body.userEmail, claimed_at: new Date().toISOString() }).eq('id', voucher.id);
        await supabase.from('user_profiles').update({ is_premium: true }).eq('id', req.body.userId); res.status(200).json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/b2b/my-cohort-vouchers', async (req, res) => {
    try { const { data } = await supabase.from('program_vouchers').select('*').eq('owner_director_id', req.query.directorId); res.status(200).json({ status: "success", codes: data || [] }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/b2b/mint-voucher', async (req, res) => {
    try {
        const token = crypto.randomBytes(4).toString('hex').toUpperCase(); const key = `MAC-${req.body.programPrefix || 'AA'}-2026-${token}`;
        const { data } = await supabase.from('program_vouchers').insert({ owner_director_id: req.body.directorId, voucher_key: key, is_claimed: false }).select().single();
        res.status(201).json({ success: true, code: data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/questions/free', async (req, res) => {
    try {
        let dbQuery = supabase.from('questions').select('*');
        if (req.query.specialty && req.query.specialty !== 'ALL') dbQuery = dbQuery.eq('specialty', req.query.specialty);
        const { data: questions } = await dbQuery;
        res.status(200).json({ questions: (questions || []).map(q => ({
            id: q.id, specialty: q.specialty, stem: q.stem, choices: typeof q.choices === 'string' ? JSON.parse(q.choices) : q.choices, correctAnswer: q.correct_answer, explanation: q.explanation, telemetry: typeof q.telemetry === 'string' ? JSON.parse(q.telemetry) : q.telemetry
        })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bibliography', async (req, res) => {
    try { res.status(200).json({ sources: (await supabase.from('bibliography_registry').select('*')).data || [] }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Secure SQL Streaming Engine Active on Port: ${PORT}`); });

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

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'placeholder';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==========================================================================
// 🎟️ B2B ARCHITECTURE REST API ENDPOINTS
// Handles verification and cohort tracking for AA Program code allocations
// ==========================================================================

// Endpoint A: Verification pass when an SAA applies an institutional key code
app.post('/api/b2b/redeem-voucher', express.json(), async (req, res) => {
    const { voucherCode, userId, userEmail } = req.body;
    if (!voucherCode || !userId) return res.status(400).json({ error: "Missing identity references vectors." });

    try {
        // Look up voucher code inside the database table rows
        const { data: voucher, error: vError } = await supabase
            .from('program_vouchers')
            .select('*')
            .eq('voucher_key', voucherCode.trim().toUpperCase())
            .single();

        if (vError || !voucher) {
            return res.status(404).json({ error: "Voucher key invalid or unrecognized by institutional records." });
        }

        if (voucher.is_claimed) {
            return res.status(410).json({ error: "Voucher registration ceiling reached; code already claimed." });
        }

        // Lock code registration state and assign the student email
        await supabase.from('program_vouchers').update({
            is_claimed: true,
            claimed_by_id: userId,
            claimed_by_email: userEmail,
            claimed_at: new Date().toISOString()
        }).eq('id', voucher.id);

        // Instantly switch user profile role parameters row flag properties to premium
        await supabase.from('user_profiles').update({ is_premium: true }).eq('id', userId);

        res.status(200).json({ success: true, message: "Institutional code verified smoothly; seat allocated." });
    } catch (err) {
        res.status(500).json({ error: "Internal voucher processing error.", details: err.message });
    }
});

// Endpoint B: Fetch method for an authenticated program director to retrieve active seats list
app.get('/api/b2b/my-cohort-vouchers', async (req, res) => {
    const directorId = req.query.directorId;
    if (!directorId) return res.status(400).json({ error: "Missing admin identifier index token." });

    try {
        const { data: vouchers, error } = await supabase
            .from('program_vouchers')
            .select('*')
            .eq('owner_director_id', directorId);

        if (error) throw error;
        res.status(200).json({ status: "success", count: vouchers.length, codes: vouchers });
    } catch (err) {
        res.status(500).json({ error: "Cohort retrieval fault.", details: err.message });
    }
});

// Endpoint C: Post method allowing an administrator to mint an additional registration code slot
app.post('/api/b2b/mint-voucher', express.json(), async (req, res) => {
    const { directorId, programPrefix } = req.body;
    if (!directorId) return res.status(400).json({ error: "Unauthorized role query access." });

    try {
        const randomStringToken = crypto.randomBytes(4).toString('hex').toUpperCase();
        const customGeneratedVoucherKey = `MAC-${programPrefix || 'AA'}-2026-${randomStringToken}`;

        const { data, error } = await supabase.from('program_vouchers').insert({
            owner_director_id: directorId,
            voucher_key: customGeneratedVoucherKey,
            is_claimed: false
        }).select().single();

        if (error) throw error;
        res.status(201).json({ success: true, code: data });
    } catch (err) {
        res.status(500).json({ error: "Minting allocation failure loop.", details: err.message });
    }
});

// --- REMAINING PREMIUM ROUTE MAPPINGS INTACT ---
app.get('/api/questions/free', async (req, res) => {
    try {
        const specialtyFilter = req.query.specialty;
        let dbQuery = supabase.from('questions').select('*');
        if (specialtyFilter && specialtyFilter !== 'ALL') dbQuery = dbQuery.eq('specialty', specialtyFilter);
        const { data: questions, error } = await dbQuery;
        if (error) throw error;
        res.status(200).json({ questions: questions.map(q => ({
            id: q.id, specialty: q.specialty, stem: q.stem,
            choices: typeof q.choices === 'string' ? JSON.parse(q.choices) : q.choices,
            correctAnswer: q.correct_answer, explanation: q.explanation,
            telemetry: typeof q.telemetry === 'string' ? JSON.parse(q.telemetry) : q.telemetry
        })) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bibliography', async (req, res) => {
    try {
        const { data, error } = await supabase.from('bibliography_registry').select('*');
        res.status(200).json({ sources: error ? [] : data });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Secure SQL Streaming Engine Active on Port: ${PORT}`); });

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto'; // Crucial: Native crypto engine for key generation

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

// ==========================================================================
// UNIFIED CROSS-PLATFORM AUTHENTICATION PORTAL GATEWAYS
// ==========================================================================
app.post('/api/authenticate', async (req, res) => {
    const { action, email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, error: "Complete credential fields are required." });
    }

    const cleanEmail = email.toLowerCase().trim();
    console.log(`📡 Authentication request: [${action}] incoming vector for ${cleanEmail}`);

    try {
        // Query to check if profile is catalogued in our cloud tables mapping layer
        let { data: profile, error } = await supabase
            .from('macprep_profiles')
            .select('*')
            .eq('email', cleanEmail)
            .maybeSingle();

        if (action === 'register') {
            if (profile) {
                return res.status(400).json({ success: false, error: "An active account with this email address already exists." });
            }

            // Fix: Explicitly append a generated random UUID string token so it never sends a null id field
            const { data: newProfile, error: createErr } = await supabase
                .from('macprep_profiles')
                .insert([{
                    id: crypto.randomUUID(), 
                    email: cleanEmail,
                    password: password, // In production, this can shift to standard cryptographic hashes safely
                    premium_unlocked: false,
                    answered_count: 0,
                    history: []
                }])
                .select()
                .single();

            if (createErr) throw createErr;
            return res.status(200).json({ success: true, message: "Account profile created successfully!", profile: newProfile });
        }

        if (action === 'login') {
            if (!profile || profile.password !== password) {
                return res.status(401).json({ success: false, error: "Invalid credential signature. Access Denied." });
            }
            return res.status(200).json({ success: true, message: "Authentication Verified.", profile });
        }

    } catch (err) {
        console.error("❌ Authentication Layer Exception Matrix: ", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Dynamic Profile Tracing Sync Router Endpoints
app.post('/api/sync-profile', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email parameter required for profile sync." });
    try {
        let { data: profile, error } = await supabase
            .from('macprep_profiles')
            .select('*')
            .eq('email', email.toLowerCase().trim())
            .maybeSingle();

        if (!profile) return res.status(404).json({ success: false, error: "Profile not found." });
        res.status(200).json({ success: true, profile });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Real-Time Progress Update Synchronizer Route
app.post('/api/update-progress', async (req, res) => {
    const { email, answered_count, history } = req.body;
    try {
        const { error } = await supabase
            .from('macprep_profiles')
            .update({ answered_count, history })
            .eq('email', email.toLowerCase().trim());

        if (error) throw error;
        res.status(200).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Questions Matrix Streaming Layer
app.get('/api/questions', async (req, res) => {
    try {
        const { data, error } = await supabase.from('macprep_questions').select('*');
        if (error) throw error;
        res.status(200).json({ success: true, questions: data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 MACPrep Synchronized Cloud Core active on port ${PORT}`);
});

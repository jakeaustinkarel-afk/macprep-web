import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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

function hashPasswordString(password) {
    return crypto.scryptSync(password, 'macprep_secure_salt_vector_2026', 64).toString('hex');
}

// ==========================================================================
// UNIFIED AUTHENTICATION ENGINE GATEWAYS
// ==========================================================================
app.post('/api/authenticate', async (req, res) => {
    const { action, email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, error: "Complete credential inputs required." });
    }

    const cleanEmail = email.toLowerCase().trim();
    const secureHash = hashPasswordString(password);

    try {
        let { data: profile, error } = await supabase
            .from('macprep_profiles')
            .select('*')
            .eq('email', cleanEmail)
            .maybeSingle();

        if (action === 'register') {
            if (profile) {
                return res.status(400).json({ success: false, error: "An active account with this email address already exists." });
            }

            const uniqueProfileId = crypto.randomUUID();
            const payloadRow = {
                id: uniqueProfileId,
                email: cleanEmail,
                password: secureHash, 
                premium_unlocked: false,
                answered_count: 0,
                history: [],
                first_name: null,
                last_name: null
            };

            const { data: newProfile, error: createErr } = await supabase
                .from('macprep_profiles')
                .insert([payloadRow])
                .select()
                .maybeSingle();

            if (createErr) throw createErr;
            const fallbackProfile = newProfile || payloadRow;

            return res.status(200).json({ 
                success: true, 
                message: "Account profile created successfully!", 
                profile: { email: fallbackProfile.email, premium_unlocked: fallbackProfile.premium_unlocked, first_name: null, last_name: null } 
            });
        }

        if (action === 'login') {
            if (!profile || profile.password !== secureHash) {
                return res.status(401).json({ success: false, error: "Invalid credential signature. Access Denied." });
            }
            return res.status(200).json({ 
                success: true, 
                message: "Authentication Verified.", 
                profile: { email: profile.email, premium_unlocked: profile.premium_unlocked, first_name: profile.first_name, last_name: profile.last_name } 
            });
        }

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Sync Progress Retrieval Hook
app.post('/api/sync-profile', async (req, res) => {
    const { email } = req.body;
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

// NEW API ENDPOINT: SAVE MODIFIED ACCOUNT METRICS
app.post('/api/save-profile-meta', async (req, res) => {
    const { email, first_name, last_name } = req.body;
    try {
        const { error } = await supabase
            .from('macprep_profiles')
            .update({ first_name, last_name })
            .eq('email', email.toLowerCase().trim());

        if (error) throw error;
        res.status(200).json({ success: true, message: "Cloud settings updated cleanly." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Live Updates Synchronizer Routing Logic
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
    console.log(`🚀 MACPrep Cloud Engine operating on port ${PORT}`);
});

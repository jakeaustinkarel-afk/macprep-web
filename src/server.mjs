import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

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
// NEW ROUTE: CROSS-PLATFORM PROFILE AND PROGRESS SYNC ENGINE
// ==========================================================================
app.post('/api/sync-profile', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email parameter required for device sync." });

    console.log(`📡 Syncing cross-device operational parameters for: ${email}`);

    try {
        // Query if profile already exists in our cloud table mapping layer
        let { data: profile, error } = await supabase
            .from('macprep_profiles')
            .select('*')
            .eq('email', email.toLowerCase().trim())
            .single();

        // If user profile is missing, automatically initialize a fresh cloud repository item for them
        if (!profile) {
            console.log(`✨ Generating fresh cross-platform profile bucket for: ${email}`);
            const { data: newProfile, error: insertError } = await supabase
                .from('macprep_profiles')
                .insert([{ 
                    email: email.toLowerCase().trim(), 
                    premium_unlocked: false, 
                    answered_count: 0,
                    history: [] 
                }])
                .select()
                .single();

            if (insertError) throw insertError;
            profile = newProfile;
        }

        res.status(200).json({ success: true, profile });
    } catch (err) {
        console.error("❌ Profile Sync Failure Exception Matrix: ", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Update profile progress dynamically across devices
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
    console.log(`🚀 MACPrep Cross-Device Server running on port ${PORT}`);
});

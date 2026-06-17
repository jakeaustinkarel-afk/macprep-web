import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static frontend assets cleanly out of root directory folder spaces
app.use(express.static(path.join(__dirname, '../')));

// Initialize environment targets with path cleansing rules
let supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);
if (supabaseUrl.endsWith('/rest/v1')) supabaseUrl = supabaseUrl.replace('/rest/v1', '');
if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);

const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// =========================================================================
// 🚀 LIVE CLOUD QUESTION STREAMING GATEWAY (FIXES THE OPTION A REPEAT TRAP)
// =========================================================================
app.get('/api/questions', async (req, res) => {
    try {
        if (supabase) {
            console.log("🌐 Streaming fresh, balanced curriculum sets out of Supabase cloud...");
            const { data, error } = await supabase
                .from('questions')
                .select('*');
            
            if (error) throw error;
            return res.json({ questions: data || [] });
        } else {
            console.log("⚠️ Supabase credentials unconfigured. Returning empty backup array context.");
            return res.json({ questions: [] });
        }
    } catch (err) {
        console.error("❌ Backend question stream database transaction failure:", err.message);
        return res.status(500).json({ error: "Database cluster communication failure", questions: [] });
    }
});

// Profile Sync Endpoints Fallbacks
app.get('/api/user/profile', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Missing identity handle" });
    return res.json({ profile: null });
});

app.post('/api/user/profile', async (req, res) => {
    return res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 MACPrep Web Workstation Cluster online running on port ${PORT}`);
    console.log(`Database Client Link Status: ${supabase ? 'CONNECTED TO CLOUD' : 'INACTIVE FALLBACK'}`);
});

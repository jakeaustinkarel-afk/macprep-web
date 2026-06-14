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

// Initialize Supabase Client Connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("⚠️ Server Warning: Missing Supabase environmental credential strings inside .env");
}
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.json());
// Serve your pristine responsive frontend workspace files automatically
app.use(express.static(path.join(__dirname, '../')));

// ==========================================================================
// CORE REST API GATEWAY: STREAM QUESTIONS FROM POSTGRES
// ==========================================================================
app.get('/api/questions', async (req, res) => {
    console.log("📡 Incoming request at /api/questions gateway router... Querying cloud schema caches.");
    
    try {
        // Query your precise production database cluster table rows
        const { data, error } = await supabase
            .from('macprep_questions')
            .select('*');

        if (error) throw error;

        console.log(`📦 Cloud handshake complete. Successfully retrieved ${data.length} items from 'macprep_questions'.`);
        
        // Return clear structured payload arrays straight down the pipe
        res.status(200).json({
            success: true,
            questions: data
        });

    } catch (err) {
        console.error("❌ Database query exception mapping layer: ", err.message);
        res.status(500).json({
            success: false,
            message: "Failed to pull live matrix out of database cluster.",
            error: err.message
        });
    }
});

// Start listening for inbound cross-device browser handshakes
app.listen(PORT, () => {
    console.log(`🚀 MACPrep Production Server running cleanly on port ${PORT}`);
});

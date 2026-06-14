import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Force path resolution to explicitly point to the absolute repository root
const ROOT_DIR = path.resolve(__dirname, '..');

const app = express();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe Webhook Route
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`❌ Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    res.json({ received: true });
});

app.use(express.json());

// Explicitly serve static assets from the absolute root directory path
app.use(express.static(ROOT_DIR));

// Endpoint to fetch board questions
app.get('/api/questions', async (req, res) => {
    try {
        const { data, error } = await supabase.from('macprep_questions').select('*');
        if (error) throw error;
        res.json({ questions: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Explicit route handling targeting the absolute path to index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

// Fallback all generic requests back to index.html for smooth client-side rendering routing
app.get('*', (req, res) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`📡 Express Workstation Engine Online: Operating securely on Port ${PORT}`);
    console.log(`📂 Serving static user interfaces out of absolute location: ${ROOT_DIR}`);
});

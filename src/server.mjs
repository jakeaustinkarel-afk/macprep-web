import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fix: Dynamically track root directory whether running locally or on Render
const ROOT_DIR = path.join(__dirname, '..');

const app = express();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// 1. Stripe Webhook Endpoint (Must stay ABOVE express.json() raw body tracking)
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`❌ Webhook Signature Verification Failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.userId;

        console.log(`✨ Successful Checkout detected for User ID: ${userId}`);
        
        if (userId) {
            const { error } = await supabase
                .from('profiles')
                .update({ status: 'PREMIUM_UNLOCKED' })
                .eq('id', userId);

            if (error) {
                console.error(`❌ Supabase Sync Failure for ${userId}:`, error);
            } else {
                console.log(`✅ User ${userId} successfully upgraded to PREMIUM_UNLOCKED status.`);
            }
        }
    }

    res.json({ received: true });
});

// 2. Regular JSON Parser for ordinary API routes
app.use(express.json());

// 3. Fix: Serve ALL static front-end assets properly from the root folder
app.use(express.static(ROOT_DIR));

// 4. API Endpoint to serve questions
app.get('/api/questions', async (req, res) => {
    try {
        const { data, error } = await supabase.from('macprep_questions').select('*');
        if (error) throw error;
        res.json({ questions: data });
    } catch (err) {
        console.error('❌ Error fetching questions:', err);
        res.status(500).json({ error: err.message });
    }
});

// 5. Fix: Direct the main landing route explicit request to index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`📡 Express Workstation Engine Online: Operating securely on Port ${PORT}`);
});

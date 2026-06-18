import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Initialize Stripe client using secure container environment variables
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Initialize Supabase client
let supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);
if (supabaseUrl.endsWith('/rest/v1')) supabaseUrl = supabaseUrl.replace('/rest/v1', '');
if (supabaseUrl.endsWith('/')) supabaseUrl = supabaseUrl.slice(0, -1);

const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// =========================================================================
// 🔒 STRIPE WEBHOOK GATEWAY WITH RAW REQUEST BYTE CAPTURE
// =========================================================================
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe || !webhookSecret) {
        console.error("❌ Stripe or Webhook Secret is unconfigured in server variables.");
        return res.status(500).send("Webhook configurations missing.");
    }

    let event;

    try {
        // Cryptographically verify that the payload hasn't been intercepted or forged
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`❌ Webhook Signature Verification Failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Process high-clearance checkout event completions
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerEmail = session.customer_details?.email?.toLowerCase().trim();

        console.log(`💳 Successful Checkout Verified for Account: ${customerEmail}`);

        if (supabase && customerEmail) {
            try {
                // Check if profile row already exists for the customer
                const { data: existingProfile } = await supabase
                    .from('profiles')
                    .select('email')
                    .eq('email', customerEmail)
                    .maybeSingle();

                if (existingProfile) {
                    // Update current profile to Premium tier clearance parameters
                    const { error: updateError } = await supabase
                        .from('profiles')
                        .update({ is_premium: true })
                        .eq('email', customerEmail);

                    if (updateError) throw updateError;
                    console.log(`🌟 Successfully updated ${customerEmail} profile parameters to PREMIUM.`);
                } else {
                    // Initialize a fresh profile containing Master Premium Clearance privileges
                    const { error: insertError } = await supabase
                        .from('profiles')
                        .insert({
                            email: customerEmail,
                            is_premium: true,
                            name: "Anesthesia Care Team Professional",
                            title: "caa",
                            performance: { totalAnswered: 0, totalCorrect: 0, specialtyBreakdown: {} }
                        });

                    if (insertError) throw insertError;
                    console.log(`🌟 Created brand new profile records for premium subscriber: ${customerEmail}`);
                }
            } catch (dbErr) {
                console.error(`❌ Webhook database synchronization tracking error: ${dbErr.message}`);
                return res.status(500).send("Database sync fail.");
            }
        }
    }

    // Return a 200 receipt confirmation signature back to Stripe endpoints
    res.json({ received: true });
});

// Global standard JSON parsing middleware for all normal application routes
app.use(express.json());

// Serve static frontend assets cleanly out of root workspace directory
app.use(express.static(path.join(__dirname, '../')));

// Curriculum Streaming Endpoint Gateway
app.get('/api/questions', async (req, res) => {
    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('questions')
                .select('*');
            if (error) throw error;
            return res.json({ questions: data || [] });
        } else {
            return res.json({ questions: [] });
        }
    } catch (err) {
        console.error("❌ Questions gateway route failure:", err.message);
        return res.status(500).json({ error: "Database communication failure", questions: [] });
    }
});

// Profile Management Endpoints Gateway
app.get('/api/user/profile', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Missing tracking account email." });
    
    const cleanEmail = email.toLowerCase().trim();

    try {
        if (supabase) {
            const { data, error } = await supabase
                .from('profiles')
                .select('*')
                .eq('email', cleanEmail)
                .maybeSingle();

            if (error) throw error;
            return res.json({ profile: data || null });
        }
        return res.json({ profile: null });
    } catch (err) {
        return res.json({ profile: null });
    }
});

app.post('/api/user/profile', async (req, res) => {
    const { email, name, title, id_num, institution, avatar_data, performance } = req.body;
    if (!email) return res.status(400).json({ error: "Missing update target account reference." });
    
    const cleanEmail = email.toLowerCase().trim();

    try {
        if (supabase) {
            const { error } = await supabase
                .from('profiles')
                .upsert({
                    email: cleanEmail,
                    name,
                    title,
                    id_num,
                    institution,
                    avatar_data,
                    performance: typeof performance === 'object' ? JSON.stringify(performance) : performance
                }, { onConflict: 'email' });

            if (error) throw error;
            return res.json({ success: true });
        }
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Hardened MACPrep Cluster online running on port ${PORT}`);
    console.log(`Database Link Status: ${supabase ? 'CONNECTED' : 'OFFLINE'}`);
});


// ==========================================
// STRIPE SECURE CHECKOUT SESSION CONTROLLER
// ==========================================
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: "Missing required identifier: user email parameter." });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{
        price: process.env.STRIPE_PRODUCTION_PRICE_ID,
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}/?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${req.headers.origin}/?status=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Checkout API Failure:", err.message);
    res.status(500).json({ error: err.message });
  }
});

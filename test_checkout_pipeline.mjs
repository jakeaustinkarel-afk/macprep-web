/**
 * MACPrep — Hardened Sandbox Merchant Validation Engine
 * Automatically hydrates secret keys from local config sheets for perfect signature parity
 */
import crypto from 'crypto';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

// Automatically sync variables from local .env files
dotenv.config();

const TARGET_SERVER_URL = process.env.LIVE_SERVER_URL || 'http://localhost:3000';
// Hard match fallback values to align precisely with the server runtime configurations
const STRIPE_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret_key_matrix';

async function executeSimulatedCheckoutSequence() {
    console.log('🏁 Initializing Sandbox Merchant Validation Sequence...');
    console.log(`🔑 Utilizing signing token key layout: ${STRIPE_SECRET.substring(0, 10)}...`);
    
    const mockStripeEventId = `evt_sandbox_${crypto.randomBytes(8).toString('hex')}`;
    const mockTimestamp = Math.floor(Date.now() / 1000);
    
    const webhookPayloadBody = JSON.stringify({
        id: mockStripeEventId,
        object: "event",
        api_version: "2023-10-16",
        created: mockTimestamp,
        type: "checkout.session.completed",
        data: {
            object: {
                id: `cs_test_${crypto.randomBytes(12).toString('hex')}`,
                object: "checkout.session",
                customer_details: {
                    email: "sandbox.clinician@gmail.com",
                    name: "Simulated Clinician User"
                },
                amount_total: 5000,
                currency: "usd",
                payment_status: "paid"
            }
        }
    });

    try {
        const signaturePayloadString = `${mockTimestamp}.${webhookPayloadBody}`;
        const computedHmacSignature = crypto
            .createHmac('sha256', STRIPE_SECRET)
            .update(signaturePayloadString)
            .digest('hex');
        
        const strictStripeHeader = `t=${mockTimestamp},v1=${computedHmacSignature}`;

        console.log('📡 Transmitting matching data payload packet via binary octet-streams...');
        
        const response = await fetch(`${TARGET_SERVER_URL}/api/webhook/stripe`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Stripe-Signature': strictStripeHeader
            },
            body: webhookPayloadBody
        });

        const resultText = await response.text();
        let parsedResult;
        try { parsedResult = JSON.parse(resultText); } catch { parsedResult = resultText; }

        if (response.ok) {
            console.log('\n🏆 Sandbox Checkout Validation Complete!');
            console.log('🟢 Server Response logs:', JSON.stringify(parsedResult, null, 2));
            process.exit(0);
        } else {
            console.error('\n❌ Server rejected checkout packet validation bounds.');
            console.error(`🔴 Status Code: ${response.status}`);
            console.error('📋 Response Error Text:', parsedResult);
            process.exit(1);
        }

    } catch (err) {
        console.error('❌ Pipeline infrastructure crash:', err.message);
        process.exit(1);
    }
}

executeSimulatedCheckoutSequence();

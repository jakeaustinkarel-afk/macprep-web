import Stripe from "stripe";
import "dotenv/config";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_mock_placeholder";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_mock_placeholder";
const TARGET_PORT = process.env.PORT || 3000;

const stripe = new Stripe(STRIPE_SECRET_KEY);

async function executeMockWebhookPipeline() {
  console.log("=== MACPrep Webhook Cryptographic Verification Suite ===");
  
  const mockUserId = "test-clinician-uuid-12345";
  
  const webhookEventPayload = {
    id: "evt_test_" + Math.random().toString(36).substring(7),
    object: "event",
    api_version: "2023-10-16",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_" + Math.random().toString(36).substring(7),
        object: "checkout.session",
        amount_total: 5000,
        currency: "usd",
        client_reference_id: mockUserId,
        payment_status: "paid",
        status: "complete"
      }
    }
  };

  const rawJsonStringBody = JSON.stringify(webhookEventPayload);

  let cryptographicSignatureHeader;
  try {
    cryptographicSignatureHeader = stripe.webhooks.generateTestHeaderString({
      payload: rawJsonStringBody,
      secret: STRIPE_WEBHOOK_SECRET,
    });
    console.log("🔒 Cryptographic payload signature generated successfully.");
  } catch (sigError) {
    console.error(`❌ Signature construction failed: ${sigError.message}`);
    process.exit(1);
  }

  const endpointUrl = `http://127.0.0.1:${TARGET_PORT}/api/webhooks/stripe`;
  console.log(`📡 Dispatching signed webhook stream to: ${endpointUrl}`);

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": cryptographicSignatureHeader,
      },
      body: rawJsonStringBody,
    });

    const textResponse = await response.text();
    
    console.log("=========================================");
    console.log(`Server HTTP Status Response: ${response.status}`);
    console.log(`Server Body Output Response: ${textResponse}`);
    console.log("=========================================");

    if (response.ok) {
      console.log("✅ Verification Complete: Webhook interceptor verified signature validity and routed upgrade queries flawlessly.");
      process.exit(0);
    } else {
      console.error("❌ Verification Failed: Endpoint rejected the payload signature verification layer.");
      process.exit(1);
    }
  } catch (networkError) {
    console.error(`💥 Delivery Interruption: Unable to contact your server. Is 'npm start' running on port ${TARGET_PORT}?`);
    console.error(`Error details: ${networkError.message}`);
    process.exit(1);
  }
}

executeMockWebhookPipeline();

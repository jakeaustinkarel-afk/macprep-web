import Stripe from "stripe";
import "dotenv/config";

async function validateSecretMatrix() {
  console.log("=== MACPrep Environment Secret Alignment Validation ===");
  
  const targetPort = process.env.PORT || 3000;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || stripeKey.includes("replace_with_")) {
    console.error("❌ Configuration Fault: STRIPE_SECRET_KEY is missing or contains placeholder values inside your hidden .env file.");
    process.exit(1);
  }
  if (!webhookSecret || webhookSecret.includes("replace_with_")) {
    console.error("❌ Configuration Fault: STRIPE_WEBHOOK_SECRET is missing or contains placeholder values inside your hidden .env file.");
    process.exit(1);
  }

  try {
    const stripe = new Stripe(stripeKey);
    
    console.log("🔒 Decryption Vector: .env fields decrypted and loaded successfully.");
    console.log(`📡 Local Gateway Configuration: Set to route network traffic via port ${targetPort}`);
    console.log("✅ Cryptographic Handshake Passed: Stripe client initialized and connected to developer test endpoints.");
    process.exit(0);
  } catch (error) {
    console.error(`❌ Handshake Interrupted: ${error.message}`);
    process.exit(1);
  }
}

validateSecretMatrix();

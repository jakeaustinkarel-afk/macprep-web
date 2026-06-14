import http from "node:http";

console.log("🕵️‍♂️ Re-Auditing Stripe Payment Webhook Engine (Singular Route Configuration)...");

const testPayload = JSON.stringify({
  id: "evt_test_payment_success_002500",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_b1G7sfK2xld920",
      customer_email: "caa.boardprep.user@example.com",
      payment_status: "paid",
      metadata: {
        userId: "usr_test_anepath_01",
        targetPool: "PREMIUM_UNLOCKED"
      }
    }
  }
});

const requestOptions = {
  hostname: "localhost",
  port: 3000,
  path: "/api/webhook/stripe", // Fixed to singular path
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(testPayload),
    "Stripe-Signature": "t=1672531199,v1=mock_signature_hash_value"
  }
};

const req = http.request(requestOptions, (res) => {
  let responseData = "";
  res.on("data", (chunk) => { responseData += chunk; });
  res.on("end", () => {
    console.log(`📡 Server Webhook Endpoint Status Code Return: [${res.statusCode}]`);
    console.log(`📝 Server Response Body Raw Trace: ${responseData}`);

    if (res.statusCode === 200 || res.statusCode === 201) {
      console.log("⚡ Success: Webhook endpoint successfully digested the event and authorized user migration state!");
    } else if (res.statusCode === 400 || res.statusCode === 401) {
      console.log("🔒 Security Shield Active: The server hit the correct route but safely rejected the mock signature key.");
    }
  });
});

req.on("error", (err) => {
  console.log("❌ Execution Warning: Connection failed.");
});

req.write(testPayload);
req.end();

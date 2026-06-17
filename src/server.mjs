import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// Reconstruct __dirname for ES Modules compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// IMPORTANT: Stripe webhooks require raw body access
app.use((req, res, next) => {
    if (req.originalUrl === '/api/webhooks/stripe') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

// ========================================================
// 🖥️ STATIC WEB ASSET HOSTING MIDDLEWARE
// ========================================================
// Tell Express to serve index.html, styles.css, and frontend assets directly
app.use(express.static(path.join(__dirname, '../')));

// Master In-Memory Curriculum Data Pool
const coreCurriculumBank = [
    {
        specialty: "Cardiovascular Anesthesia",
        stem: "A 64-year-old male undergoing coronary artery bypass grafting exhibits acute onset bronchospasm following administration of a medication. Simultaneously, the capnograph curve transitions into a classic shark-fin slope morphology. Which physiologic parameters accurately dictate the calculated oxygen delivery index (DO2I)?",
        choices: {
            A: "Cardiac Index, Hemoglobin, Arterial Saturation",
            B: "Mean Arterial Pressure, Central Venous Pressure, Stroke Volume",
            C: "Pulmonary Capillary Wedge Pressure, Systemic Vascular Resistance",
            D: "Alveolar Gas Tension, Arterial Oxygen Content",
            E: "Mixed Venous Oxygen Saturation, Left Ventricular End-Diastolic Volume"
        },
        correct_answer: "A",
        explanation: "Oxygen Delivery Index (DO2I) calculation formula matches: CI x 1.34 x Hb x SaO2. Bronchospasm creates classic high-resistance expiratory delays captured visually by ascending shark-fin plateaus on the live SVG capnogram workspace layer.",
        telemetry: { difficulty_index: 0.72, discrimination_ratio: 0.58 }
    },
    {
        specialty: "Advanced Pharmacology Kinetics",
        stem: "A continuous infusion of Propofol has been running during an open AAA repair for exactly 4 hours. Which parameter describes the relative time required for the plasma concentration of this agent to decrease by 50% upon discontinuation of the infusion pump?",
        choices: {
            A: "Context-Sensitive Half-Time (t1/2cs)",
            B: "Elimination Half-Life (t1/2beta)",
            C: "Distribution Half-Life (t1/2alpha)",
            D: "Plasma Clearance Rate (Clp)",
            E: "Steady-State Volume of Distribution (Vss)"
        },
        correct_answer: "A",
        explanation: "The context-sensitive half-time describes the time necessary for the plasma drug concentration to drop by 50% after stopping an infusion of a specific duration. Propofol displays a highly duration-dependent profile due to accumulation in lipid-rich peripheral compartments over time.",
        telemetry: { difficulty_index: 0.68, discrimination_ratio: 0.64 }
    },
    {
        specialty: "Neuroanesthesia",
        stem: "During an emergent craniotomy for subdural hematoma evacuation, the surgical assistant requests deliberate hyperventilation to mitigate elevated intracranial pressure (ICP). What is the primary physiological mechanism mediating this reduction?",
        choices: {
            A: "Hypocapnia inducing cerebral vasoconstriction, thereby reducing cerebral blood volume",
            B: "Hypercapnia triggering cerebral vasodilation, improving venous outflow tracts",
            C: "Respiratory acidosis causing systemic vasoconstriction and decreased cardiac output",
            D: "Metabolic alkalosis shifting the oxyhemoglobin dissociation curve to the right",
            E: "Direct inhibition of choroid plexus cerebrospinal fluid production"
        },
        correct_answer: "A",
        explanation: "Decreasing arterial PaCO2 via hyperventilation causes local cerebral vasoconstriction, which lowers cerebral blood flow (CBF) and cerebral blood volume (CBV), rapidly lowering intracranial pressure (ICP). Effect peaks around 20-30 minutes.",
        telemetry: { difficulty_index: 0.59, discrimination_ratio: 0.71 }
    }
];

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    try {
        const event = JSON.parse(req.body);
        console.log(`📥 Webhook Event Captured: ${event.type}`);
        res.status(200).json({ received: true });
    } catch (err) {
        res.status(400).send(`Webhook Error`);
    }
});

// Dynamic API endpoint route
app.get('/api/questions', (req, res) => {
    res.json({ questions: coreCurriculumBank });
});

// Fallback route to ensure index.html serves cleanly for root navigation requests
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`===================================================`);
    console.log(`🚀 MACPREP FULL-STACK ENGINE HARDENED`);
    console.log(`📡 Hosting Workspace UI & API Gateways on port: ${PORT}`);
    console.log(`===================================================`);
});

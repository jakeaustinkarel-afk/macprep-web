import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Enable Cross-Origin Resource Sharing for production microservices
app.use(cors());

app.use((req, res, next) => {
    if (req.originalUrl === '/api/webhooks/stripe') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

// Serve static frontend tracking assets from root directory definitions
app.use(express.static(path.join(__dirname, '../')));

// =========================================================================
// 📊 COMPREHENSIVE MULTI-SPECIALTY BLUEPRINT DATABASE SEED (ALL 8 CATEGORIES)
// =========================================================================
const coreCurriculumBank = [
    {
        specialty: "Cardiovascular Anesthesia",
        stem: "A 64-year-old male undergoing coronary artery bypass grafting exhibits acute onset bronchospasm following administration of a medication. Simultaneously, the capnograph curve transitions into a classic shark-fin slope morphology. Which physiologic parameters accurately dictate the calculated oxygen delivery index (DO2I)?",
        choices: {
            A: "Cardiac Index, Hemoglobin, Arterial Saturation",
            B: "Mean Arterial Pressure, Central Venous Pressure, Stroke Volume",
            C: "Pulmonary Capillary Wedge Pressure, Systemic Vascular Resistance",
            D: "Alveolar Gas Tension, Arterial Oxygen Content",
            E: "Mixed Venous Oxygen Saturation, Left Venricular End-Displacement Volume"
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
        explanation: "Regulatory protocols define that decreasing arterial PaCO2 via controlled hyperventilation causes localized cerebral vasoconstriction, lowering cerebral blood flow (CBF) and cerebral blood volume (CBV), reducing intracranial tension rapidly.",
        telemetry: { difficulty_index: 0.59, discrimination_ratio: 0.71 }
    },
    {
        specialty: "Regional Anesthesia & Pain",
        stem: "Following an ultrasound-guided interscalene brachial plexus block for total shoulder arthroplasty, a patient develops ipsilateral ptosis, miosis, and anhidrosis. This presentation is directly caused by the unintended tracking of local anesthetic to which neural structure?",
        choices: {
            A: "Stellate Ganglion (Sympathetic Chain)",
            B: "Phrenic Nerve roots (C3-C5)",
            C: "Recurrent Laryngeal Nerve",
            D: "Suprascapular Nerve branches",
            E: "Vagus Nerve Trunk"
        },
        correct_answer: "A",
        explanation: "Ipsilateral ptosis, miosis, and anhidrosis constitute Horner's Syndrome, caused by local anesthetic tracking medially to block sympathetic efferent outputs passing through the stellate ganglion chain.",
        telemetry: { difficulty_index: 0.52, discrimination_ratio: 0.66 }
    },
    {
        specialty: "Pediatric Anesthesia",
        stem: "A 4-year-old child presenting with post-intubation croup is treated with nebulized racemic epinephrine. What is the primary receptor mechanism targeted to reduce mucosal edema in the subglottic airway?",
        choices: {
            A: "Alpha-1 adrenergic vasoconstriction",
            B: "Beta-2 adrenergic smooth muscle relaxation",
            C: "Beta-1 adrenergic positive inotropy",
            D: "Alpha-2 adrenergic central sedation",
            E: "Muscarinic-3 antagonist bronchodilation"
        },
        correct_answer: "A",
        explanation: "Racemic epinephrine works primary via Alpha-1 adrenergic receptor activation, which causes localized vasoconstriction of precapillary arterioles in the upper airway mucosa, rapidly decreasing subglottic edema.",
        telemetry: { difficulty_index: 0.61, discrimination_ratio: 0.59 }
    },
    {
        specialty: "Obstetric Anesthesia",
        stem: "A parturient undergoing emergent cesarean delivery under general anesthesia experiences sudden, severe cardiovascular collapse immediately following fetal extraction. Amniotic fluid embolism (AFE) is suspected. Which triad of features traditionally defines this pathology?",
        choices: {
            A: "Acute hypoxia, severe hypotension, and profound coagulopathy (DIC)",
            B: "Hypertension, bradycardia, and irregular respirations",
            C: "Tachycardia, respiratory alkalosis, and localized deep vein thrombosis",
            D: "Pulmonary edema, systemic hypertension, and thrombocytosis",
            E: "Hyperthermia, muscle rigidity, and metabolic acidosis"
        },
        correct_answer: "A",
        explanation: "Amniotic fluid embolism presents abruptly as a biphasic cardiorespiratory and hematologic crisis classically defined by acute hypoxemia, severe systemic hypotension/right heart failure, and consumption coagulopathy/DIC.",
        telemetry: { difficulty_index: 0.70, discrimination_ratio: 0.63 }
    },
    {
        specialty: "Thoracic Anesthesia",
        stem: "During one-lung ventilation (OLV) for a left thoracoscopic lung resection, the pulse oximeter drops abruptly to 84%. After verifying correct double-lumen tube positioning with a fiberoptic bronchoscope, what is the most appropriate initial physiological intervention?",
        choices: {
            A: "Apply Continuous Positive Airway Pressure (CPAP) to the non-ventilated lung",
            B: "Apply Positive End-Expiratory Pressure (PEEP) to the non-ventilated lung",
            C: "Increase the inspired oxygen fraction (FiO2) to 1.5",
            D: "Administer a systemic bolus dose of an intravenous vasodilator",
            E: "Immediately abort the surgical procedure and reinflate both lungs"
        },
        correct_answer: "A",
        explanation: "Applying low-flow CPAP (2-5 cmH2O) with 100% O2 to the non-ventilated lung oxygenates the blood still shunting through that lung without inflating it enough to obscure the operative view.",
        telemetry: { difficulty_index: 0.66, discrimination_ratio: 0.68 }
    },
    {
        specialty: "General Principles & Safety",
        stem: "An anesthesia workstation pipeline oxygen pressure alarm triggers. The backup oxygen cylinders are open, but the cylinder gauge indicates 400 psi. What is the approximate remaining volume of oxygen in this standard E-cylinder, and how long will it last at a flow rate of 10 L/min?",
        choices: {
            A: "Approximately 130 Liters; lasts ~13 minutes",
            B: "Approximately 660 Liters; lasts ~66 minutes",
            C: "Approximately 330 Liters; lasts ~33 minutes",
            D: "Approximately 50 Liters; lasts ~5 minutes",
            E: "Approximately 200 Liters; lasts ~20 minutes"
        },
        correct_answer: "A",
        explanation: "A full E-cylinder holds 1900-2200 psi (~660 Liters). Pressure is directly proportional to volume: (400 psi / 1900 psi) * 660 Liters = ~138 Liters. At 10 L/min, this provides roughly 13-14 minutes of operation.",
        telemetry: { difficulty_index: 0.74, discrimination_ratio: 0.55 }
    }
];

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
    try {
        const event = JSON.parse(req.body);
        res.status(200).json({ received: true });
    } catch (err) {
        res.status(400).send(`Webhook Error`);
    }
});

app.get('/api/questions', (req, res) => {
    res.json({ questions: coreCurriculumBank });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

// FIXED: Listen on environment production assigned ports or default down to 3000 safely
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`===================================================`);
    console.log(`🚀 MACPREP DEPLOYMENT RUNTIME CONTAINER ACTIVE`);
    console.log(`📡 Cloud Load-Balancer mapped to port: ${PORT}`);
    console.log(`===================================================`);
});

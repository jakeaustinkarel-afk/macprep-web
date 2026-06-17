import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Read environment variables
let supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Clean up extra trailing slashes or paths
if (supabaseUrl.endsWith('/')) {
    supabaseUrl = supabaseUrl.slice(0, -1);
}
if (supabaseUrl.endsWith('/rest/v1')) {
    supabaseUrl = supabaseUrl.replace('/rest/v1', '');
}
if (supabaseUrl.endsWith('/')) {
    supabaseUrl = supabaseUrl.slice(0, -1);
}

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Critical Error: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// =========================================================================
// 📥 MASTER EXPANSION PAYLOAD BATCH
// =========================================================================
const NEW_PREMIUM_QUESTION_BATCH = [
    {
        specialty: "Advanced Pharmacology Kinetics",
        stem: "A 52-year-old female with suspected atypical plasma cholinesterase variant properties tracks a prolonged respiratory paralysis duration of 6 hours following a standard intubating dose of Succinylcholine (1.5 mg/kg). Which diagnostic evaluation metric confirms this metabolic phenotype anomaly?",
        choices: {
            A: "Dibucaine number measurement of 20 indicating homozygous atypical variant status",
            B: "Dibucaine number measurement of 80 indicating normal homozygous wild-type status",
            C: "Fluoride number measurement of 60 indicating heterozygous wild-type expression tracking",
            D: "Total pseudo-cholinesterase quantitative volume elevation above normal reference parameters",
            E: "Post-tetanic count calculation verifying intense phase II competitive block conversion parameters"
        },
        correct_answer: "A",
        explanation: "Dibucaine is a local anesthetic that inhibits normal atypical butyrylcholinesterase (pseudocholinesterase) by roughly 80%, but only inhibits atypical variant pseudocholinesterase by roughly 20%. A dibucaine number of 20 confirms a homozygous atypical profile.",
        telemetry: { difficulty_index: 0.76, discrimination_ratio: 0.61 }
    },
    {
        specialty: "Obstetric Anesthesia",
        stem: "A 28-year-old G1P0 parturient at 39 weeks gestation with severe preeclampsia receives a continuous intravenous Magnesium Sulfate infusion at 2 g/hr for seizure prophylaxis. During an emergent cesarean delivery under general anesthesia, the practitioner administers Vecuronium for muscle relaxation. What kinetic interaction should be anticipated?",
        choices: {
            A: "Profound, unpredictable prolongation of both depolarizing and non-depolarizing neuromuscular blockade profiles",
            B: "Accelerated clearance patterns due to magnesium-mediated upregulation of acetylcholinesterase tracks",
            C: "Competitive antagonism requiring immediate doubling of standard aminosteroid dosing schedules",
            D: "Isolated resistance to depolarizing agents with normal non-depolarizing duration kinetics",
            E: "Metabolic conversion tracking into acute hypermagnesemia presenting exclusively as rigid skeletal muscles"
        },
        correct_answer: "A",
        explanation: "Magnesium stabilizes membranes and reduces pre-junctional acetylcholine release while decreasing post-junctional motor endplate sensitivity. This profoundly potentiates both depolarizing and non-depolarizing muscle relaxants.",
        telemetry: { difficulty_index: 0.69, discrimination_ratio: 0.66 }
    },
    {
        specialty: "Cardiovascular Anesthesia",
        stem: "During weaning from cardiopulmonary bypass (CPB) after an aortic valve replacement, a patient exhibits severe right ventricular (RV) failure accompanied by elevated central venous pressures (CVP) and a drop in mean arterial pressure (MAP). Transesophageal echocardiography (TEE) shows an akinetic, dilated RV. What is the most targeted initial pharmaceutical vector?",
        choices: {
            A: "Inhaled Nitric Oxide (iNO) or inhaled Epoprostenol to reduce pulmonary vascular resistance (PVR) selectively",
            B: "Systemic high-dose Phenylephrine infusion to elevate systemic afterload markers",
            C: "Intravenous Milrinone bolus combined with aggressive volume expansion to stretch myocardial compliance",
            D: "Intravenous Nitroprusside to drive simultaneous balanced systemic and venous dilation",
            E: "Systemic Vasopressin bolus to contract coronary arterial smooth muscle branches selectively"
        },
        correct_answer: "A",
        explanation: "RV failure secondary to acute pulmonary hypertension requires selective pulmonary vasodilation. Inhaled agents like iNO reduce pulmonary vascular resistance and RV afterload without causing the systemic hypotension often triggered by systemic vasodilators.",
        telemetry: { difficulty_index: 0.73, discrimination_ratio: 0.59 }
    },
    {
        specialty: "General Principles & Safety",
        stem: "An asymptomatic 32-year-old male scheduled for an elective orthopedic procedure under general anesthesia exhibits a sudden, isolated spike in end-tidal CO2 (EtCO2) from 38 to 68 mmHg within 10 minutes of induction, despite adequate minute ventilation. The core temperature monitor registers a normal baseline of 37.0°C. What is the most immediate diagnostic priority?",
        choices: {
            A: "Recognize early signs of Malignant Hyperthermia (MH), discontinue volatile agents, and prepare Dantrolene",
            B: "Diagnose a faulty soda sorb canister and increase fresh gas flows to 15 L/min to flush out lines",
            C: "Assume a profound iatrogenous hypoventilation event and increase respiratory rates to 30 breaths/minute",
            D: "Assume a mainstem bronchial intubation tracking anomaly and withdraw the endotracheal tube 2 centimeters",
            E: "Order an emergent arterial blood gas panel to evaluate isolated metabolic compensation parameters"
        },
        correct_answer: "A",
        explanation: "An abrupt, unexplained rise in EtCO2 is often the earliest and most sensitive sign of Malignant Hyperthermia (MH). Hyperthermia is a late finding. The correct action is to immediately discontinue triggering agents and prepare Dantrolene.",
        telemetry: { difficulty_index: 0.65, discrimination_ratio: 0.72 }
    }
];

async function executeBulkIngestion() {
    console.log(`🚀 Connecting securely to: ${supabaseUrl}`);
    try {
        // AUTOMATED REINFORCEMENT: Hydrate rows with unique cryptographically secure keys
        const processedBatch = NEW_PREMIUM_QUESTION_BATCH.map(question => ({
            id: crypto.randomUUID(),
            ...question
        }));

        const { data, error } = await supabase
            .from('questions')
            .insert(processedBatch);

        if (error) throw error;
        
        console.log(`===================================================`);
        console.log(`🎯 EXPANSION HYDRO-STREAM COMPLETE`);
        console.log(`🌟 Successfully updated ${processedBatch.length} board-level questions into your cloud tables.`);
        console.log(`===================================================`);
    } catch (err) {
        console.error("❌ DATABASE REJECTION DETAILS:", err);
    }
}
executeBulkIngestion();

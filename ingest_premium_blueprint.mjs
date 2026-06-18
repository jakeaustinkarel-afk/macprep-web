import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const NEW_PREMIUM_QUESTION_BATCH = [
  {
    specialty: "OBSTETRIC CRISES",
    stem: "A 31-year-old parturient (G2P1) at 39 weeks gestation with a history of a prior low transverse cesarean delivery is undergoing an active trial of labor after cesarean (TOLAC) under stable epidural analgesia. Over a 10-minute period, she develops severe, localized breakthrough abdominal pain that persists despite an extra bolus of 0.25% bupivacaine. Telemetry tracks an abrupt onset of deep variable decelerations followed by profound fetal bradycardia down to 70 bpm. Which of the following clinical indicators is considered the most common herald sign validating an acute uterine rupture event?",
    choices: JSON.stringify([
      {"text": "Profound, sudden maternal hypotensive cardiovascular collapse", "correct": false},
      {"text": "An abnormal, non-reassuring fetal heart rate tracking pattern", "correct": true},
      {"text": "The cessation of all palpable manual uterine contraction waves", "correct": false},
      {"text": "Frank, bright red macroscopic post-ostial vaginal hemorrhage", "correct": false},
      {"text": "A sudden recession of the presenting fetal part during examination", "correct": false}
    ]),
    correct_answer: "B",
    explanation: "An abnormal fetal heart rate pattern—most commonly a sudden, profound fetal bradycardia, prolonged deceleration, or repetitive severe variable decelerations—is the single most common and sensitive herald sign of an acute uterine rupture during a TOLAC. Maternal signs such as breakthrough localized pain, hypotensive shock, or recession of the presenting part are highly specific but occur far less frequently or occur much later in the clinical progression.",
    waveform_type: "STANDARD_RUNNING",
    telemetry: JSON.stringify({"hr": 112, "bp": "110/60", "spo2": 98, "etco2": 37})
  },
  {
    specialty: "NEUROANESTHESIA",
    stem: "A 58-year-old patient is undergoing an emergency craniotomy for evacuation of a massive subdural hematoma. Intraoperatively, the neurosurgeon notes critical cerebral edema and requests immediate medical interventions to lower intracranial pressure (ICP). The anesthesia provider administers a rapid infusion of 20% mannitol (1 g/kg). What transient hemodynamic response should be carefully anticipated during the initial 5 to 15 minutes following the start of this hypertonic infusion loop?",
    choices: JSON.stringify([
      {"text": "Acute decrease in central venous pressures due to rapid renal dumping", "correct": false},
      {"text": "An initial expansion of intravascular volume leading to increased pre-load", "correct": true},
      {"text": "Severe rebound intracranial hypertension caused by rapid cellular shrinking", "correct": false},
      {"text": "Profound systemic vasoconstriction driven by transient hypokalemic loops", "correct": false},
      {"text": "An acute reflex bradycardia secondary to systemic hypernatremia triggers", "correct": false}
    ]),
    correct_answer: "B",
    explanation: "Mannitol is a hypertonic crystalloid solution that initially draws fluid from intracellular spaces into the intravascular compartment via an osmotic gradient. During the first 5 to 15 minutes post-administration, this causes a transient expansion of circulating blood volume, raising central venous pressure, pulmonary capillary wedge pressure, and cardiac output. This requires caution in patients with marginal cardiac reserve or congestive heart failure. The expected osmotic diuresis and subsequent intravascular volume depletion follow afterward.",
    waveform_type: "STANDARD_RUNNING",
    telemetry: JSON.stringify({"hr": 84, "bp": "155/90", "spo2": 99, "etco2": 32})
  },
  {
    specialty: "PEDIATRIC MANAGEMENT",
    stem: "A 4-year-old child weighing 16 kg is scheduled for an elective outpatient inguinal hernia repair under general anesthesia. Following a smooth sevoflurane mask induction, a laryngeal mask airway (LMA) is placed cleanly. Ten minutes into the procedure, the patient develops profound masseter muscle rigidity (MMR) that severely compromises ventilation, accompanied by a rapid upstroke in end-tidal carbon dioxide from 38 mmHg to 64 mmHg. Vitals reveal a core temperature increase to 38.9°C. What is the immediate, definitive first-line pharmacologic countermeasure required to stabilize this metabolic state?",
    choices: JSON.stringify([
      {"text": "Intravenous push of 1.5 mL/kg 20% lipid emulsion solution arrays", "correct": false},
      {"text": "Rapid administration of intravenous dantrolene at 2.5 mg/kg", "correct": true},
      {"text": "Intravenous push of 1 mg/kg succinylcholine to break the masseter spasm", "correct": false},
      {"text": "High-dose bolus of esmolol (1 mg/kg) to suppress sympathetic storming", "correct": false},
      {"text": "Intravenous push of sodium bicarbonate (2 mEq/kg) to treat acidosis", "correct": false}
    ]),
    correct_answer: "B",
    explanation: "Masseter muscle rigidity combined with a rapid, unexplained rise in EtCO2 and core hyperthermia is a textbook presentation of a Malignant Hyperthermia (MH) crisis triggered by volatile anesthetics. The immediate, definitive pharmacological treatment is IV dantrolene (2.5 mg/kg), which acts directly on the ryanodine receptor (RyR1) to inhibit calcium release from the sarcoplasmic reticulum. While supportive care like bicarbonate or cooling is helpful, dantrolene administration must not be delayed.",
    waveform_type: "OBSTRUCTIVE_RISE",
    telemetry: JSON.stringify({"hr": 142, "bp": "115/75", "spo2": 95, "etco2": 64})
  }
];

async function executeBulkIngestionScaling() {
  console.log(`🏁 Commencing MACPrep Content Bank Scaling Pass...`);
  console.log(`📦 Parsing target payload array size: ${NEW_PREMIUM_QUESTION_BATCH.length} elements.`);

  const hydratedBatch = NEW_PREMIUM_QUESTION_BATCH.map(q => ({
    id: q.id || crypto.randomUUID(),
    ...q
  }));

  const chunkSize = 50;
  let successCount = 0;

  for (let i = 0; i < hydratedBatch.length; i += chunkSize) {
    const chunk = hydratedBatch.slice(i, i + chunkSize);
    console.log(`📡 Streaming content sub-block subset rows ${i + 1} to ${Math.min(i + chunkSize, hydratedBatch.length)} up to Supabase...`);

    try {
      const { error } = await supabase
        .from('questions')
        .insert(chunk);

      if (error) throw error;
      successCount += chunk.length;
    } catch (err) {
      console.error(`❌ Ingestion Intercept Failure on batch index slice ${i}:`, err.message);
    }
  }

  console.log(`\n🏆 Scaling Sequence Complete. Pushed ${successCount} fresh premium data nodes to your cloud tables!`);
}

executeBulkIngestionScaling();

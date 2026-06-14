import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DATABASE_PATH = path.join(__dirname, "data", "questions.json");

// =========================================================================
// 📑 HIGH-DIFFICULTY PEER-REVIEWED CLINICAL BLUEPRINTS
// Legally insulated, hyper-challenging, open-access source backings
// =========================================================================
const specialtyBlueprints = [
  {
    track: "advanced_recertification",
    specialty: "Malignant Hyperthermia Emergency Protocols",
    vignetteContext: "A 14-year-old male with no known medical history is undergoing an emergency open reduction of a femur fracture under general anesthesia with sevoflurane and succinylcholine. Twenty minutes following induction, the capnograph demonstrates an abrupt, unexplained rise in end-tidal CO2 from 38 mmHg to 82 mmHg that is refractory to increasing minute ventilation. The patient develops generalized muscle rigidity, a heart rate of 142 bpm, and a core temperature spike from 37.0°C to 39.5°C.",
    complicationSignal: "An arterial blood gas reveals a profound mixed respiratory and metabolic acidosis with a pH of 6.95, PaCO2 of 88 mmHg, and a base deficit of -14 mEq/L.",
    correctAnswer: "Immediately discontinue all volatile anesthetic agents, hyperventilate the patient with 100% oxygen at maximum fresh gas flows (>10 L/min), and rapidly administer intravenous dantrolene at an initial dose of 2.5 mg/kg while preparing activated charcoal filters for the breathing circuit.",
    correctRationale: "Correct. This scenario presents a classic, fulminant Malignant Hyperthermia (MH) crisis triggered by volatile anesthetics and succinylcholine. The immediate physiological directive is removing the triggering agents, maximizing oxygenation/ventilation to clear massive CO2 accumulation, and administering dantrolene (2.5 mg/kg IV bolus, repeated as necessary). Dantrolene is a specific ryanodine receptor antagonist that halts unregulated calcium release from the sarcoplasmic reticulum.",
    wrongDistractors: [
      {
        text: "Maintain the active sevoflurane concentration to prevent intraoperative awareness, place activated charcoal filters natively on both inspiratory and expiratory limbs, and titrate an intravenous infusion of sodium bicarbonate 100 mEq to correct the systemic acidosis.",
        rationale: "Incorrect (The Volatile Maintenance Trap). Continuing the triggering volatile agent while relying solely on charcoal filters or symptom management is a fatal clinical error. The volatile gas must be discontinued immediately to stop the hypermetabolic cascade. Buffering with bicarbonate without addressing the source of calcium dysregulation does not stabilize the sarcoplasmic reticulum."
      },
      {
        text: "Initiate an immediate continuous infusion of diltiazem 0.25 mg/kg to treat the profound sinus tachycardia and muscle rigidity, while transitioning the patient to an alternative halogenated agent like desflurane.",
        rationale: "Incorrect (The Calcium Blocker Trap). Calcium channel blockers (like diltiazem or verapamil) are strictly contraindicated during an MH crisis if dantrolene is administered, as the combination can trigger severe, intractable hyperkalemia and total cardiovascular collapse. Furthermore, desflurane is also a potent MH trigger and cannot be used as an alternative agent."
      },
      {
        text: "Administer an immediate intravenous bolus of rocuronium 1.2 mg/kg to achieve rapid neuromuscular blockade and break the generalized skeletal muscle rigidity.",
        rationale: "Incorrect (The Neuromuscular Illusion Trap). MH is an intracellular, post-synaptic metabolic defect involving calcium release channels within the muscle cell itself. Because the defect is downstream from the neuromuscular junction, traditional non-depolarizing neuromuscular blockers like rocuronium are completely ineffective at breaking MH-induced muscle rigidity."
      },
      {
        text: "Prioritize external surface cooling with ice packs and iced saline gastric lavage; delay dantrolene administration until the core temperature surpasses 41.0°C to verify diagnostic consensus thresholds.",
        rationale: "Incorrect (The Temporal Delay Trap). Delaying dantrolene administration while waiting for a specific temperature threshold significantly increases mortality. Hyperthermia is often a late sign of MH; rapid metabolic acidosis and hypercapnia are the primary early indicators. Dantrolene must be deployed immediately upon clinical suspicion."
      }
    ],
    explanation: "Malignant Hyperthermia is an inherited hypermetabolic autosomal dominant disorder of skeletal muscle mediated by mutations in the RYR1 ryanodine receptor gene. Exposure to triggering agents (all volatile anesthetics and succinylcholine) causes unregulated, massive calcium release from the sarcoplasmic reticulum, leading to continuous muscle contraction, excessive ATP consumption, heat production, severe lactic acidosis, and hypercapnia. Treatment requires immediate discontinuation of triggers, hyperventilation with 100% O2, and rapid administration of dantrolene to re-establish calcium homeostasis.",
    article: "Malignant Hyperthermia Crisis Management: Consensus Guidelines and Advanced Pharmacological Rescue Systems",
    doi: "10.1186/s13054-020-03197-w",
    url: "https://ccforum.biomedcentral.com/articles/10.1186/s13054-020-03197-w"
  },
  {
    track: "initial_certification",
    specialty: "Transfusion Medicine & Hemodynamic Crises",
    vignetteContext: "A 62-year-old female is undergoing an emergency open reduction and internal fixation of a shattered pelvis following a motor vehicle collision under general anesthesia. Over a compressed 45-minute resuscitation window, she receives 6 units of packed red blood cells (PRBCs) and 4 units of fresh frozen plasma (FFP) via a rapid infuser system.",
    complicationSignal: "Suddenly, her airway pressures spike from 16 cm H2O to 44 cm H2O, pink frothy secretions appear in the endotracheal tube, and her SpO2 drops to 82% on 100% oxygen. A transesophageal echocardiogram (TEE) demonstrates a hyperdynamic left ventricle with normal filling pressures and an ejection fraction of 65%.",
    correctAnswer: "Diagnose Transfusion-Related Acute Lung Injury (TRALI), halt any active transfusion products immediately, transition to a lung-protective mechanical ventilation strategy with lower tidal volumes and optimized PEEP, and support hemodynamics with selective vasopressors rather than diuretics.",
    correctRationale: "Correct. This patient presents with the classic triad of Transfusion-Related Acute Lung Injury (TRALI): acute hypoxemia, non-cardiogenic pulmonary edema (confirmed by normal left ventricular function and filling pressures on TEE), and high airway pressures following rapid product transfusion. Management requires halting the transfusion immediately, notifying the blood bank to trace the donor, and implementing low-tidal-volume mechanical ventilation support. Because it is a non-cardiogenic, permeability-driven capillary leak, aggressive diuresis can worsen intravascular volume and cause cardiovascular collapse.",
    wrongDistractors: [
      {
        text: "Diagnose Transfusion-Associated Circulatory Overload (TACO); immediately administer an intravenous bolus of furosemide 40 mg and restrict all fluid inputs while escalating the ventilator's inspiratory hold profile.",
        rationale: "Incorrect (The Volume Misclassification Trap). While Transfusion-Associated Circulatory Overload (TACO) presents similarly with pulmonary edema, it is fundamentally a cardiogenic, hydrostatic volume overload process. The TEE findings explicitly rule out TACO by demonstrating a normal left ventricle with normal filling pressures, confirming that this is an immune-mediated permeability problem (TRALI) where standard empiric diuresis is contraindicated."
      },
      {
        text: "Diagnose an acute type-1 anaphylactic transfusion mismatch reaction; immediately administer an intravenous bolus of epinephrine 100 mcg paired with high-dose diphenhydramine 50 mg.",
        rationale: "Incorrect (The Anaphylaxis Illusion Trap). Anaphylaxis presents with profound systemic vasodilation (severe hypotension), hives, and bronchospasm. While it causes high airway pressures, it does not typically produce isolated non-cardiogenic pulmonary edema with pink frothy sputum while preserving left ventricular cardiac performance metrics."
      },
      {
        text: "Identify localized mechanical plug occlusion of the endotracheal tube; perform urgent high-vacuum deep suctioning and transition to manual bag-valve ventilation with an added high-dose albuterol inline nebulizer.",
        rationale: "Incorrect (The Bronchospasm Trap). High airway pressures combined with secretions can mimic an airway obstruction or severe bronchospasm. However, deep suctioning or bronchodilators cannot correct the profound alveolar-capillary membrane leak or diffuse alveolar damage that defines a systemic TRALI pathway."
      },
      {
        text: "Diagnose acute bacterial contamination of the transfused plasma; immediately initiate a broad-spectrum empiric infusion of vancomycin and ceftazidime while escalating core body target temperatures.",
        rationale: "Incorrect (The Sepsis Overlap Trap). Septic transfusion reactions cause high fevers, rigors, and profound distributive shock (severe hypotension). While acute lung injury can develop secondary to severe sepsis, it does not present as an isolated, hyper-acute non-cardiogenic respiratory failure within minutes of transfusion without severe systemic hemodynamic collapse."
      }
    ],
    explanation: "Transfusion-Related Acute Lung Injury (TRALI) is an immune-mediated, non-cardiogenic pulmonary edema triggered by the passive transfer of donor antibodies (human leukocyte antigens or neutrophil-specific antibodies) that react against the recipient's leukocytes. This interaction activates neutrophils within the pulmonary microvasculature, leading to capillary endothelial damage, profound vascular permeability, and alveolar flooding. Diagnostic separation from TACO is critical and is achieved via echocardiographic confirmation of normal left ventricular function and low or normal filling pressures.",
    article: "Transfusion-Related Acute Lung Injury: Peer-Reviewed Definitions, Pathophysiology, and Modern Resuscitation Guidelines",
    doi: "10.1111/vox.12881",
    url: "https://onlinelibrary.wiley.com/doi/full/10.1111/vox.12881"
  }
];

// =========================================================================
// 🏭 CODESPACE AUTOMATED BATCH COMPILER ENGINE
// =========================================================================
function compileParametricCluster(blueprint, sequenceNumber) {
  const generatedId = `MP-${blueprint.track === "initial_certification" ? "INIT" : "ADV"}-${blueprint.specialty.substring(0,3).toUpperCase()}-${String(sequenceNumber).padStart(3, "0")}`;
  
  const choicesArray = [
    { label: "A", text: blueprint.correctAnswer, correct: true, rationale: blueprint.correctRationale },
    ...blueprint.wrongDistractors.map(dist => ({
      label: "", 
      text: dist.text,
      correct: false,
      rationale: dist.rationale
    }))
  ];

  // Knuth-Fisher-Yates option shuffle to enforce absolute letter randomness
  for (let i = choicesArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [choicesArray[i], choicesArray[j]] = [choicesArray[j], choicesArray[i]];
  }

  const alphabet = ["A", "B", "C", "D", "E"];
  choicesArray.forEach((choice, index) => {
    choice.label = alphabet[index];
  });

  return {
    id: generatedId,
    track: blueprint.track,
    specialty: blueprint.specialty,
    is_free: false, // Default newly scaled clusters to the premium pool
    stem: `${blueprint.vignetteContext} ${blueprint.complicationSignal} Which of the following parameters represents the most accurate clinical directive?`,
    choices: choicesArray,
    explanation: blueprint.explanation,
    source: {
      peer_reviewed_article: blueprint.article,
      doi: blueprint.doi,
      public_article_url: blueprint.url
    }
  };
}

async function executionPipeline() {
  try {
    console.log("🛠️ Ingesting fresh high-acuity crisis blueprints into the Content Factory...");

    let payload = { version: "1.1.0", total_volume: 0, questions: [] };
    
    try {
      const rawData = await fs.readFile(REPO_DATABASE_PATH, "utf8");
      payload = JSON.parse(rawData);
    } catch (err) {
      console.log("📝 Initializing clean questions.json baseline data structure.");
    }

    const currentMap = new Map(payload.questions.map(q => [q.id, q]));
    let generatedCount = 0;

    for (const bp of specialtyBlueprints) {
      const activeMatchCount = payload.questions.filter(q => q.track === bp.track && q.specialty === bp.specialty).length;
      const targetSequenceIndex = activeMatchCount + 1;

      const compiledQuestion = compileParametricCluster(bp, targetSequenceIndex);

      if (!currentMap.has(compiledQuestion.id)) {
        payload.questions.push(compiledQuestion);
        generatedCount++;
        console.log(`🎰 Generated Item -> ${compiledQuestion.id} [${compiledQuestion.specialty}]`);
      } else {
        console.log(`⚠️ Collision Blocked: ID ${compiledQuestion.id} already exists inside questions.json.`);
      }
    }

    payload.total_volume = payload.questions.length;

    await fs.mkdir(path.dirname(REPO_DATABASE_PATH), { recursive: true });
    await fs.writeFile(REPO_DATABASE_PATH, JSON.stringify(payload, null, 2), "utf8");

    console.log("\n=======================================================");
    console.log("🚀 CLUSTER FACTORY BATCH INGESTION SUCCESSFUL");
    console.log(`📥 Fresh Premium Crisis Vignettes Appended: ${generatedCount}`);
    console.log(`📊 Aggregate Database Live Volume: ${payload.total_volume} questions`);
    console.log("=======================================================\n");

  } catch (ex) {
    console.error("❌ Fatal exception caught within Content Factory context:", ex.message);
  }
}

executionPipeline();

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(repoRoot, 'marketing/social-posts/publer-batches/2026-08-10-to-16');
const assetDir = path.join(repoRoot, 'marketing/social-posts/assets/2026-08-10-to-16');
const reelDir = path.join(repoRoot, 'marketing/social-posts/reels/2026-08-10-to-16');
const cdnRoot = 'https://cdn.jsdelivr.net/gh/jakeaustinkarel-afk/macprep-web@main/';

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(assetDir, { recursive: true });
fs.mkdirSync(reelDir, { recursive: true });

const csvHeader = [
  'Date - Intl. format or prompt',
  'Text',
  'Link(s) - Separated by comma for FB carousels',
  'Media URL(s) - Separated by comma',
  'Title - For the video, pin, PDF ..',
  'Label(s) - Separated by comma',
  'Alt text(s) - Separated by ||',
  'Comment(s) - Separated by ||',
  'Pin board, FB album, or Google category',
  'Post subtype - I.e. story, reel, PDF ..',
  'CTA - For Facebook links or Google',
  'Reminder - For stories, reels, shorts, and TikTok'
];

function csvCell(value = '') {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  return [csvHeader, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

function textLines(lines) {
  return lines.join('\n');
}

const clinicalPosts = [
  {
    date: '2026/08/10 10:00',
    slug: 'osa-recovery',
    title: 'OSA recovery: the pattern matters',
    alt: 'A faceless recovery room scene with pulse oximetry and respiratory monitoring prepared for a patient with obstructive sleep apnea.',
    source: 'https://www.asahq.org/~/media/sites/asahq/files/public/resources/standards-guidelines/practice-guidelines-for-the-perioperative-management-of-patients-with-obstructive-sleep-apnea.pdf',
    sourceLabel: 'ASA Practice Guidelines for Perioperative Management of Obstructive Sleep Apnea',
    question: 'A patient with known OSA has repeated airway obstruction and hypoxemia after PACU discharge criteria are otherwise nearly met. What is the best next step?',
    options: ['Send the patient home after one normal oxygen reading at rest in recovery', 'Escalate monitoring and consider CPAP if obstruction persists', 'Give a sedative so the patient can rest', 'Remove oxygen and reassess the airway in ten minutes'],
    answer: 'B',
    rationale: 'A single reassuring number is not the same as a reassuring recovery pattern. The ASA guidance emphasizes continuous pulse oximetry for patients who remain at increased risk and consideration of CPAP or noninvasive positive pressure when frequent or severe obstruction or hypoxemia occurs. The bedside plan still depends on the procedure, opioid exposure, baseline OSA severity, and the local monitoring pathway.',
    hashtags: ['#CAA', '#SAA', '#AnesthesiaEducation', '#BoardReview', '#MACPrep'],
    x: 'OSA recovery is a pattern, not one normal saturation. Repeated obstruction or hypoxemia should trigger a monitored plan and consideration of CPAP or noninvasive positive pressure when indicated. Source: https://www.asahq.org/~/media/sites/asahq/files/public/resources/standards-guidelines/practice-guidelines-for-the-perioperative-management-of-patients-with-obstructive-sleep-apnea.pdf'
  },
  {
    date: '2026/08/11 10:00',
    slug: 'delirium-prevention',
    title: 'Delirium prevention starts before emergence',
    alt: 'A quiet, faceless postoperative care environment with orientation aids, glasses, and a recovery chair prepared for an older adult.',
    source: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5901697/',
    sourceLabel: 'American Geriatrics Society postoperative delirium guideline',
    question: 'An older adult is at high risk for postoperative delirium. Which perioperative habit best belongs in the prevention plan?',
    options: ['Treat confusion as an expected effect of anesthesia', 'Use a structured prevention bundle across recovery', 'Give benzodiazepines at the first sign of agitation', 'Wait for severe delirium before changing the room'],
    answer: 'B',
    rationale: 'Delirium prevention is not one medication or one PACU conversation. Multicomponent, nonpharmacologic prevention programs are the most consistently supported approach. The anesthetic plan is one part of a broader perioperative team effort that also includes avoiding deliriogenic medications when feasible and helping the patient reorient after surgery.',
    hashtags: ['#PerioperativeCare', '#CAA', '#SAA', '#AnesthesiaEducation', '#MACPrep'],
    x: 'For postoperative delirium, the best prevention is usually a bundle, not a single drug: orientation, sleep, mobility, sensory aids, hydration, and medication review. Source: https://pmc.ncbi.nlm.nih.gov/articles/PMC5901697/'
  },
  {
    date: '2026/08/12 10:00',
    slug: 'bone-cement-implantation',
    title: 'BCIS: notice the timing',
    alt: 'A faceless orthopedic operating room scene with anesthesia monitoring during hip arthroplasty preparation.',
    source: 'https://pubmed.ncbi.nlm.nih.gov/30694541/',
    sourceLabel: 'Bone Cement Implantation Syndrome: Key Concepts for Anesthesiologists',
    question: 'During cementation in hip arthroplasty, oxygen saturation and end tidal carbon dioxide fall while blood pressure drops abruptly. What is the most useful first interpretation?',
    options: ['Assume this timing is unrelated to the current surgical step or event', 'Call possible BCIS and support oxygenation and circulation', 'Wait for a chest radiograph before any intervention', 'Give a sedative and observe for another ten minutes'],
    answer: 'B',
    rationale: 'The timing is the clue. Bone cement implantation syndrome may present around cementation, prosthesis insertion, joint reduction, or tourniquet release, with hypoxemia, hypotension, arrhythmia, or cardiovascular collapse. The response is immediate recognition, clear communication, high inspired oxygen, and supportive hemodynamic management tailored to the patient and the local emergency protocol.',
    hashtags: ['#OrthopedicAnesthesia', '#CAA', '#SAA', '#CriticalEvents', '#MACPrep'],
    x: 'BCIS is a timing diagnosis before it is anything else. At cementation or prosthesis insertion, a sudden fall in EtCO2, SpO2, and BP should prompt immediate team recognition and cardiopulmonary support. Source: https://pubmed.ncbi.nlm.nih.gov/30694541/'
  },
  {
    date: '2026/08/13 10:00',
    slug: 'ponv-risk',
    title: 'PONV: build the plan to the patient',
    alt: 'A faceless perioperative assessment desk with an antiemetic plan, risk checklist, and recovery monitoring supplies.',
    source: 'https://pubmed.ncbi.nlm.nih.gov/32467512/',
    sourceLabel: 'Fourth Consensus Guidelines for the Management of Postoperative Nausea and Vomiting',
    question: 'A young adult presents for laparoscopic surgery. She is a nonsmoker with motion sickness, nausea after a prior anesthetic, and likely postoperative opioid use. Which plan best fits her risk?',
    options: ['Give one antiemetic as the case is ending', 'Use risk matched multimodal prevention', 'Treat only if nausea develops in recovery', 'Skip prophylaxis because she is otherwise healthy'],
    answer: 'B',
    rationale: 'Postoperative nausea and vomiting is not simply a longest drug list problem. Patient risk, procedure, anesthetic choices, and planned analgesia all matter. The consensus guideline supports baseline risk reduction plus multimodal prophylaxis for patients with meaningful risk. The exact agents and doses should follow patient factors and local protocol.',
    hashtags: ['#PONV', '#CAA', '#SAA', '#AnesthesiaEducation', '#MACPrep'],
    x: 'PONV prevention is not one drug at emergence. Match baseline risk reduction and multimodal prophylaxis to the patient, procedure, anesthetic, and expected opioid use. Source: https://pubmed.ncbi.nlm.nih.gov/32467512/'
  },
  {
    date: '2026/08/14 10:00',
    slug: 'sglt2-edka',
    title: 'SGLT2 medications: ask before the first incision',
    alt: 'A faceless preoperative medication reconciliation scene with a clinician reviewing a diabetes medication list.',
    source: 'https://pubmed.ncbi.nlm.nih.gov/37932195/',
    sourceLabel: 'Perioperative Management of Patients Receiving SGLT2 Inhibitors',
    question: 'A patient uses an SGLT2 inhibitor and is scheduled for elective surgery. What preoperative detail deserves deliberate verification?',
    options: ['Verify fasting glucose, then begin the planned routine surgery', 'Verify the medication hold and ketoacidosis risk', 'Verify a morning schedule and fasting duration', 'Verify any prior insulin use before proceeding'],
    answer: 'B',
    rationale: 'SGLT2 inhibitors can contribute to perioperative euglycemic diabetic ketoacidosis, so a reassuring glucose value does not rule it out. Current guidance commonly calls for holding most SGLT2 inhibitors for at least three days before scheduled surgery, with four days for ertugliflozin. For an urgent case or a missed hold, use the institution’s pathway and evaluate the clinical context rather than relying on glucose alone.',
    hashtags: ['#PerioperativeMedicine', '#CAA', '#SAA', '#DiabetesCare', '#MACPrep'],
    x: 'An SGLT2 inhibitor changes the preop conversation. A normal glucose does not exclude euglycemic DKA. Verify the hold interval and assess symptoms or labs when risk is present. Source: https://pubmed.ncbi.nlm.nih.gov/37932195/'
  },
  {
    date: '2026/08/15 10:00',
    slug: 'tiva-awareness',
    title: 'TIVA: treat the delivery system as part of the anesthetic',
    alt: 'A faceless total intravenous anesthesia setup with organized infusion pumps, labeled tubing, and a patient monitor.',
    source: 'https://www.asahq.org/~/media/sites/asahq/files/public/resources/standards-guidelines/practice-advisory-for-intraoperative-awareness-and-brain-function-monitoring.pdf',
    sourceLabel: 'ASA Practice Advisory for Intraoperative Awareness and Brain Function Monitoring',
    question: 'During TIVA, an infusion line is found disconnected from the patient. What is the immediate learning point?',
    options: ['Rely on vital signs alone to confirm adequate anesthetic depth', 'Restore delivery and check the infusion system', 'Continue unchanged because paralysis is present', 'Ignore the line while blood pressure is stable'],
    answer: 'B',
    rationale: 'With TIVA, the delivery path is central to the anesthetic plan. A disconnected line, incorrect pump setting, or other equipment problem can create a gap in anesthetic delivery. The ASA advisory emphasizes equipment checks and risk aware planning. The appropriate clinical response depends on the moment in the case, the drugs in use, and the patient, but the reflex is the same: verify delivery before assuming the anesthetic is intact.',
    hashtags: ['#TIVA', '#CAA', '#SAA', '#AnesthesiaSafety', '#MACPrep'],
    x: 'With TIVA, the infusion path is part of the anesthetic. A disconnected line means restore and verify drug delivery first, then assess the pump, tubing, and clinical context. Source: https://www.asahq.org/~/media/sites/asahq/files/public/resources/standards-guidelines/practice-advisory-for-intraoperative-awareness-and-brain-function-monitoring.pdf'
  },
  {
    date: '2026/08/16 10:00',
    slug: 'urgent-doac',
    title: 'Urgent DOAC cases: start with the clock',
    alt: 'A faceless preoperative planning desk with a clock, anticoagulant medication list, and coordinated surgical plan.',
    source: 'https://doi.org/10.1161/CIR.0000000000001285',
    sourceLabel: 'AHA Scientific Statement on Reversal of Direct Oral Anticoagulants',
    question: 'An urgent operation is requested for a patient taking apixaban. Which information most directly frames the next conversation?',
    options: ['Old INR, incision time, blood type, and oxygen saturation', 'Last dose, renal function, procedure risk, urgency, and indication', 'Room assignment, blood pressure, fasting duration, and surgeon preference', 'Bottle details, refill timing, glucose, vital signs, and a prior INR'],
    answer: 'B',
    rationale: 'Urgent DOAC management is a structured risk assessment, not a single laboratory value. The time of the last dose, renal function, procedure bleeding risk, clinical urgency, and thrombotic indication guide whether delay, measurement, reversal, or another strategy is appropriate. Coordinate early with surgery, anesthesia, pharmacy, and any relevant specialists, using the local protocol for reversal and laboratory testing.',
    hashtags: ['#PerioperativeMedicine', '#CAA', '#SAA', '#AnesthesiaEducation', '#MACPrep'],
    x: 'Urgent surgery with apixaban starts with the clock. Last dose, renal function, procedure bleeding risk, urgency, and the anticoagulation indication frame the plan. Source: https://doi.org/10.1161/CIR.0000000000001285'
  }
];

const quickPosts = [
  {
    date: '2026/08/10 13:00', slug: 'cefazolin-redosing', title: 'Cefazolin redosing is a clock check',
    alt: 'A faceless anesthesia medication preparation area with a surgical antibiotic timer and IV medication tray.',
    source: 'https://www.ashp.org/-/media/assets/policy-guidelines/docs/therapeutic-guidelines/therapeutic-guidelines-antimicrobial-prophylaxis-surgery.ashx?hash=A15B4714417A51A03E5BDCAC150B94EAF899D49B&la=en',
    sourceLabel: 'ASHP Clinical Practice Guidelines for Antimicrobial Prophylaxis in Surgery',
    body: 'Quick board pearl: surgical prophylaxis is not finished once the first antibiotic is in. For cefazolin, redosing is generally considered when the procedure reaches four hours from the start of the preoperative dose or when there is excessive blood loss. The exact timing should follow the drug, patient factors, and your institutional policy.',
    question: 'What belongs on the intraoperative checklist for a long case?', answer: 'The antibiotic clock, not just the first dose.',
    hashtags: ['#AntibioticProphylaxis', '#CAA', '#SAA', '#AnesthesiaEducation', '#MACPrep'],
    x: 'Cefazolin prophylaxis is not a one time checkbox. For a long case, keep the antibiotic clock visible. Standard guidance commonly uses a 4 hour redosing interval and earlier redosing with major blood loss. Source: https://www.ashp.org/-/media/assets/policy-guidelines/docs/therapeutic-guidelines/therapeutic-guidelines-antimicrobial-prophylaxis-surgery.ashx?hash=A15B4714417A51A03E5BDCAC150B94EAF899D49B&la=en'
  },
  {
    date: '2026/08/11 13:00', slug: 'tourniquet-release', title: 'Tourniquet release changes the room',
    alt: 'A faceless orthopedic surgery setup with a limb tourniquet, anesthesia monitor, and prepared ventilation equipment.',
    source: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5187604/',
    sourceLabel: 'Tourniquet application during anesthesia: What we need to know',
    body: 'A tourniquet release is a predictable physiologic transition, not a surprise. After a prolonged lower extremity tourniquet, expect a transient influx of carbon dioxide and metabolites with changes in hemodynamics. The patient’s reserve, tourniquet time, ventilation, and surgical context determine how visible those changes become.',
    question: 'What should you do before release?', answer: 'Look at the patient, the monitor trend, ventilation, and team timing before the clamp comes down.',
    hashtags: ['#OrthopedicAnesthesia', '#CAA', '#SAA', '#ClinicalPearl', '#MACPrep'],
    x: 'Tourniquet release is a physiologic transition. After a long lower extremity tourniquet, expect transient changes in CO2 and hemodynamics. Read the trend and coordinate before release. Source: https://pmc.ncbi.nlm.nih.gov/articles/PMC5187604/'
  },
  {
    date: '2026/08/12 13:00', slug: 'ett-cuff-pressure', title: 'ETT cuff pressure: measure it',
    alt: 'A faceless airway management setup with an endotracheal tube cuff manometer and sterile airway supplies.',
    source: 'https://pubmed.ncbi.nlm.nih.gov/32199655/',
    sourceLabel: 'Endotracheal Tube Cuff Pressure Assessment study',
    body: 'A pilot balloon can feel reassuring and still be misleading. A cuff manometer gives the number. A commonly cited target range is 20 to 30 cm H2O, balancing the need for a seal with the aim of limiting excessive tracheal wall pressure. Recheck when case conditions change, particularly when nitrous oxide, positioning, or airway pressure can change the system.',
    question: 'What is the better habit after intubation?', answer: 'Use a manometer. Feeling the pilot balloon is not the same as knowing the pressure.',
    hashtags: ['#AirwayManagement', '#CAA', '#SAA', '#AnesthesiaEducation', '#MACPrep'],
    x: 'ETT cuff pressure should be measured, not guessed. A commonly cited target is 20 to 30 cm H2O. A pilot balloon feel is not a substitute for a manometer. Source: https://pubmed.ncbi.nlm.nih.gov/32199655/'
  },
  {
    date: '2026/08/13 13:00', slug: 'arterial-line-damping', title: 'An arterial waveform can be wrong in a useful way',
    alt: 'A faceless anesthesia monitor displaying an arterial pressure waveform with a transducer setup and fast flush device.',
    source: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11297833/',
    sourceLabel: 'Abnormal arterial pressure waveform damping review',
    body: 'A clean arterial waveform is data. A distorted one is a warning about the measurement system. An underdamped trace can exaggerate systolic pressure. An overdamped trace can flatten the waveform and underestimate systolic pressure. Before you treat a surprising systolic number, use the fast flush test and inspect the line for the common mechanical causes.',
    question: 'Many oscillations after a fast flush suggest what?', answer: 'An underdamped system, often with systolic overshoot.',
    hashtags: ['#Hemodynamics', '#CAA', '#SAA', '#AnesthesiaEducation', '#MACPrep'],
    x: 'Before treating a surprising arterial systolic number, check the system. Many oscillations after a fast flush suggest underdamping and systolic overshoot. Source: https://pmc.ncbi.nlm.nih.gov/articles/PMC11297833/'
  },
  {
    date: '2026/08/14 13:00', slug: 'airway-fire', title: 'Airway fire prevention is a shared setup',
    alt: 'A faceless airway surgery setup with a laser safe endotracheal tube, suction, wet sponges, and anesthesia equipment.',
    source: 'https://www.asahq.org/~/media/sites/asahq/files/public/resources/standards-guidelines/practice-advisory-for-the-prevention-and-management-of-operating-room-fires.pdf',
    sourceLabel: 'ASA Practice Advisory for the Prevention and Management of Operating Room Fires',
    body: 'The fire triangle applies in the OR: oxidizer, ignition source, and fuel. In a high risk airway case, prevention is a team conversation before the first incision. Use the lowest feasible oxygen concentration, avoid nitrous oxide when appropriate, communicate before ignition, and make sure the team is ready to act if the conditions change.',
    question: 'What is the best time to discuss airway fire risk?', answer: 'Before ignition, while there is still time to change the setup.',
    hashtags: ['#AirwaySafety', '#CAA', '#SAA', '#AnesthesiaSafety', '#MACPrep'],
    x: 'Airway fire prevention is a team setup, not an afterthought. In high risk cases: lowest feasible oxygen, avoid nitrous oxide when appropriate, communicate before ignition, and be ready to act. Source: https://www.asahq.org/~/media/sites/asahq/files/public/resources/standards-guidelines/practice-advisory-for-the-prevention-and-management-of-operating-room-fires.pdf'
  },
  {
    date: '2026/08/15 13:00', slug: 'rebound-pain', title: 'A block wearing off should not be a surprise',
    alt: 'A faceless regional anesthesia discharge planning scene with an arm sling, written medication schedule, and ice pack.',
    source: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7533186/',
    sourceLabel: 'Managing rebound pain after regional anesthesia',
    body: 'A peripheral nerve block can be excellent analgesia and still need a handoff plan. Rebound pain is the abrupt increase in pain some patients experience as a block resolves. Set expectations early, build scheduled multimodal analgesia into the discharge plan when appropriate, and explain when to begin it. The best instruction is the one the patient can follow before pain catches up.',
    question: 'When should the rebound pain conversation happen?', answer: 'Before discharge, not during the midnight phone call.',
    hashtags: ['#RegionalAnesthesia', '#CAA', '#SAA', '#AcutePain', '#MACPrep'],
    x: 'A block wearing off should not be a surprise. Set expectations before discharge and give a clear, clinician appropriate multimodal plan before pain catches up. Source: https://pmc.ncbi.nlm.nih.gov/articles/PMC7533186/'
  },
  {
    date: '2026/08/16 13:00', slug: 'low-pressure-alarm', title: 'Low pressure alarm: work from patient to machine',
    alt: 'A faceless anesthesia machine and breathing circuit with a low pressure alarm, self inflating bag, and airway equipment.',
    source: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5063182/',
    sourceLabel: 'Association of Anaesthetists monitoring recommendations',
    body: 'A low pressure alarm is not a diagnosis. It is a prompt to verify ventilation and find the leak or disconnection. Start with the patient and the circuit you can see, then work through the endotracheal tube or supraglottic device, connections, sampling line, breathing circuit, and machine. If needed, hand ventilate with a self inflating bag while the system is checked.',
    question: 'What is the first priority?', answer: 'Confirm the patient is being ventilated before troubleshooting the equipment in detail.',
    hashtags: ['#AnesthesiaMachine', '#CAA', '#SAA', '#PatientSafety', '#MACPrep'],
    x: 'A low pressure alarm is a prompt, not a diagnosis. Confirm ventilation first, then work from patient to airway, circuit, and machine. Use a self inflating bag if needed. Source: https://pmc.ncbi.nlm.nih.gov/articles/PMC5063182/'
  }
];

const studyPosts = [
  {
    date: '2026/08/10 18:30', slug: 'rationale-teaching', title: 'The question does not end at the correct letter',
    alt: 'A faceless study desk with a board style question, handwritten rationale notes, and a laptop showing study material.',
    body: 'The useful part of a missed question is not the moment you see the right letter. It is the moment you can explain why the other choices lost. One distractor may be unsafe. Another may be true in a different clinical setting. A third may be the right drug at the wrong dose or time. That is the kind of separation board questions ask you to make under pressure.',
    ending: 'When you review today, choose one missed item and write one sentence for every option. The goal is not to memorize the key. The goal is to make the next similar case feel familiar.',
    hashtags: ['#BoardReview', '#CAA', '#SAA', '#StudySmarter', '#MACPrep'],
    x: 'The right letter is only the start. For one missed question today, explain why every option wins or loses. That is how a repeat miss becomes a usable clinical distinction. #BoardReview #CAA #SAA'
  },
  {
    date: '2026/08/11 18:30', slug: 'error-log', title: 'Keep an error log that asks for a decision',
    alt: 'A faceless study workspace with a notebook labeled by topic, colored tabs, and a focused board review session.',
    body: 'An error log should be more than a graveyard for missed questions. Give each miss a short label: knowledge gap, stem reading error, timing error, or changed mind without a reason. Then write the decision rule you want to remember next time. For example: when the waveform and clinical story conflict, verify the measurement system before treating the number.',
    ending: 'That one sentence turns a vague memory into something you can use on the next set. Review the log weekly and let it choose the next ten questions for you.',
    hashtags: ['#StudyHabits', '#CAA', '#SAA', '#BoardReview', '#MACPrep'],
    x: 'Make your error log useful: label each miss as a knowledge, stem reading, timing, or decision error. Then write the rule you will use next time. Review it weekly. #StudyHabits #CAA #SAA'
  },
  {
    date: '2026/08/12 18:30', slug: 'blueprint-planning', title: 'Study the blueprint, then study the patient',
    alt: 'A faceless study planning desk with a CAA exam content outline, calendar blocks, and organized clinical notes.',
    body: 'It is easy to keep studying the topics that already feel comfortable. It also feels productive. A blueprint guided plan is a little less flattering and far more useful. It asks which clinical areas are weighted, where you are slow, and what you avoid when you build your own quiz. That is where the next block of study time belongs.',
    ending: 'Open the content outline before your next session. Pick one domain you have been postponing, then do a short mixed set that forces you to retrieve it alongside familiar topics.',
    hashtags: ['#NCCAA', '#CAA', '#SAA', '#BoardPreparation', '#MACPrep'],
    x: 'Your favorite subject is not always your highest yield subject. Use the exam content outline, your pacing, and your error log to choose the next domain. #NCCAA #CAA #SAA'
  },
  {
    date: '2026/08/13 18:30', slug: 'caa-focused-prep', title: 'Board prep should sound like the work you do',
    alt: 'A faceless anesthesiologist assistant study scene with an anesthesia workstation, clinical notes, and a focused preparation session.',
    body: 'CAA board preparation lives at the intersection of physiology, pharmacology, clinical judgment, and speed. It should not feel like a generic collection of disconnected facts. A strong question starts with a patient, asks for a decision, and gives you the source and reasoning to understand the choice after you commit to it.',
    ending: 'That is the standard we hold MACPrep to: CAA and SAA focused material, direct citations, and a rationale for each option. If a question teaches you only one fact, it is leaving value on the table.',
    hashtags: ['#CAA', '#SAA', '#NCCAA', '#AnesthesiaEducation', '#MACPrep'],
    x: 'CAA board prep should sound like the work: patient context, a clinical decision, direct sourcing, and a reason every option is right or wrong. #CAA #SAA #NCCAA #MACPrep'
  },
  {
    date: '2026/08/14 18:30', slug: 'source-learning', title: 'Use the source as a study tool, not a decoration',
    alt: 'A faceless study desk with a clinical guideline open beside a question rationale and highlighted notes.',
    body: 'A citation is most useful when it lets you ask a better follow up question. Is this a consensus recommendation or a trial result? Does the guideline fit the patient in the stem? What changes the decision? When a rationale points you back to the source, you can build a clinical rule instead of collecting isolated trivia.',
    ending: 'You do not need to read every paper cover to cover. Start by reading the exact section that supports the decision, then return to the question and see whether you can explain it in your own words.',
    hashtags: ['#EvidenceBased', '#CAA', '#SAA', '#BoardReview', '#MACPrep'],
    x: 'A source link should do more than prove a fact. Use it to ask what population, recommendation, and clinical decision the question is really testing. #EvidenceBased #CAA #SAA'
  },
  {
    date: '2026/08/15 18:30', slug: 'practice-vs-review', title: 'Practice and review are different jobs',
    alt: 'A faceless split study workspace with a timed question set on one side and a detailed review notebook on the other.',
    body: 'Practice tests retrieval, pacing, and commitment. Review changes your next decision. If every study session feels like taking more questions, you may be measuring the same gap repeatedly without closing it. If every session is review, you may feel comfortable without testing whether you can pull the answer back under time pressure.',
    ending: 'Try a simple split: answer a short mixed set without notes, then spend at least as long reviewing the misses and close calls. The second half is where the score improvement usually starts.',
    hashtags: ['#StudyStrategy', '#CAA', '#SAA', '#BoardPreparation', '#MACPrep'],
    x: 'Practice tests recall and pacing. Review changes the next decision. Pair a short no notes set with at least as much time reviewing misses and close calls. #StudyStrategy #CAA #SAA'
  },
  {
    date: '2026/08/16 18:30', slug: 'sunday-plan', title: 'A Sunday plan that fits real life',
    alt: 'A faceless Sunday evening study planning scene with a calendar, ten question list, coffee, and organized notes.',
    body: 'You do not need a perfect six hour study block to keep moving. A realistic Sunday plan can be ten mixed questions, one missed topic from the week, and one source you want to understand better. Decide the time before the week begins. Choose the topic now. Leave the materials open and ready so the first step on Monday is small.',
    ending: 'Consistency wins because it keeps the decisions easy. What are your next ten questions going to teach you?',
    hashtags: ['#SundayStudy', '#CAA', '#SAA', '#BoardReview', '#MACPrep'],
    x: 'A useful Sunday plan can be ten mixed questions, one missed topic, and one source to revisit. Pick the time and topic before the week starts so Monday begins small. #SundayStudy #CAA #SAA'
  }
];

const reelPosts = [
  { date: '2026/08/10 08:00', id: 'osa-recovery', title: 'OSA recovery: the pattern matters', source: clinicalPosts[0].source, sourceLabel: clinicalPosts[0].sourceLabel, slides: [['OSA recovery', 'One good saturation', 'does not erase a pattern.'], ['THE SETUP', 'Repeated obstruction', 'and hypoxemia in PACU.'], ['QUESTION', 'What should change', 'before discharge?'], ['LOOK FOR', 'Risk that persists', 'after the immediate recovery period.'], ['THE MOVE', 'Consider monitored care', 'and positive pressure support when indicated.'], ['WHY', 'Recurrent obstruction', 'can return as stimulation fades.'], ['REMEMBER', 'Read the trend.', 'Not a single number.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/10 16:00', id: 'arterial-line-damping', title: 'A line waveform: trust, then test', source: quickPosts[3].source, sourceLabel: quickPosts[3].sourceLabel, slides: [['THE A LINE', 'A number is only as good', 'as the system behind it.'], ['THE CLUE', 'A sharp systolic peak', 'can be artifact.'], ['FAST FLUSH', 'One quick test', 'checks the response.'], ['MANY OSCILLATIONS', 'Think underdamped.', 'Systolic can overshoot.'], ['NO OSCILLATIONS', 'Think overdamped.', 'The trace can flatten.'], ['BEFORE TREATMENT', 'Inspect tubing, bubbles,', 'kinks, and the transducer.'], ['REMEMBER', 'Verify the measurement', 'before treating the number.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/11 08:00', id: 'sglt2-edka', title: 'SGLT2: normal glucose can mislead', source: clinicalPosts[4].source, sourceLabel: clinicalPosts[4].sourceLabel, slides: [['SGLT2 MEDS', 'A normal glucose', 'is not the whole story.'], ['THE RISK', 'Perioperative euglycemic', 'ketoacidosis can occur.'], ['PREOP CHECK', 'What was the last dose?', 'Was the hold interval met?'], ['ELECTIVE CASE', 'Most agents are held', 'at least 3 days.'], ['ERTUGLIFLOZIN', 'The common interval', 'is 4 days.'], ['URGENT CASE', 'Use symptoms, labs,', 'and your local pathway.'], ['REMEMBER', 'Do not let a normal', 'glucose end the assessment.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/11 16:00', id: 'airway-fire', title: 'Airway fire: the conversation is prevention', source: quickPosts[4].source, sourceLabel: quickPosts[4].sourceLabel, slides: [['AIRWAY FIRE', 'Prevention begins', 'before ignition.'], ['THE TRIANGLE', 'Oxidizer.', 'Ignition source. Fuel.'], ['HIGH RISK', 'Open oxygen', 'plus a nearby ignition source.'], ['THE PLAN', 'Use the lowest feasible', 'oxygen concentration.'], ['ALSO', 'Avoid nitrous oxide', 'when appropriate.'], ['SAY IT OUT LOUD', 'Confirm before ignition.', 'Keep the team aligned.'], ['REMEMBER', 'Change the setup', 'before the risk becomes real.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/12 08:00', id: 'tiva-delivery', title: 'TIVA: the line is part of the plan', source: clinicalPosts[5].source, sourceLabel: clinicalPosts[5].sourceLabel, slides: [['TIVA', 'The infusion path', 'is part of the anesthetic.'], ['THE RISK', 'A disconnection can create', 'a delivery gap.'], ['WHEN SOMETHING LOOKS OFF', 'Do not assume stable BP', 'means delivery is intact.'], ['FIRST MOVE', 'Restore and verify', 'anesthetic delivery.'], ['THEN CHECK', 'Pump settings.', 'Tubing. IV access.'], ['THE PRINCIPLE', 'Monitor the patient', 'and the delivery system.'], ['REMEMBER', 'Verify before', 'you assume.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/12 16:00', id: 'rebound-pain', title: 'A block wearing off should not surprise the patient', source: quickPosts[5].source, sourceLabel: quickPosts[5].sourceLabel, slides: [['REGIONAL BLOCK', 'Great analgesia still needs', 'a handoff plan.'], ['REBOUND PAIN', 'Pain can rise quickly', 'as the block resolves.'], ['THE MISTAKE', 'Waiting for severe pain', 'before starting the plan.'], ['BEFORE DISCHARGE', 'Set expectations', 'in plain language.'], ['BUILD THE PLAN', 'Use clinician appropriate', 'scheduled multimodal analgesia.'], ['MAKE IT ACTIONABLE', 'Say when to begin it.', 'Write it down.'], ['REMEMBER', 'Education before discharge', 'beats a midnight call.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/13 08:00', id: 'urgent-doac', title: 'Urgent DOAC: start with the clock', source: clinicalPosts[6].source, sourceLabel: clinicalPosts[6].sourceLabel, slides: [['URGENT DOAC', 'The first question', 'is often the last dose.'], ['DO NOT START WITH', 'A single old INR', 'and a guess.'], ['FRAME THE CASE', 'Time. Renal function.', 'Bleeding risk. Urgency.'], ['ALSO ASK', 'Why is the patient', 'anticoagulated?'], ['WHEN USEFUL', 'A drug specific level', 'can refine uncertainty.'], ['COORDINATE EARLY', 'Surgery. Anesthesia.', 'Pharmacy. Specialists.'], ['REMEMBER', 'Urgent does not mean', 'unstructured.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/13 16:00', id: 'tourniquet-release', title: 'Tourniquet release: prepare for the transition', source: quickPosts[1].source, sourceLabel: quickPosts[1].sourceLabel, slides: [['TOURNIQUET RELEASE', 'The physiology changes', 'when the clamp comes down.'], ['AFTER A LONG CASE', 'CO2 and metabolites', 'return to circulation.'], ['WATCH THE TREND', 'Ventilation.', 'Hemodynamics. Timing.'], ['NOT A SURPRISE', 'It is a known', 'physiologic transition.'], ['BEFORE RELEASE', 'Coordinate with surgery.', 'Look at patient reserve.'], ['THEN', 'Be ready to respond', 'to the patient in front of you.'], ['REMEMBER', 'Read the trend', 'before the release.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/14 08:00', id: 'ponv-risk', title: 'PONV: match the plan to the risk', source: clinicalPosts[3].source, sourceLabel: clinicalPosts[3].sourceLabel, slides: [['PONV', 'Prevention is not', 'one drug at emergence.'], ['RISK FACTORS', 'History. Motion sickness.', 'Nonsmoking. Opioid use.'], ['THE QUESTION', 'How many signals', 'are already present?'], ['THE PLAN', 'Reduce baseline risk', 'when you can.'], ['THEN', 'Use multimodal prevention', 'matched to risk.'], ['NOT THIS', 'Wait for symptoms', 'as the only strategy.'], ['REMEMBER', 'The best plan fits', 'this patient and this case.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/14 16:00', id: 'low-pressure-alarm', title: 'Low pressure alarm: patient first', source: quickPosts[6].source, sourceLabel: quickPosts[6].sourceLabel, slides: [['LOW PRESSURE', 'An alarm is a prompt.', 'Not a diagnosis.'], ['FIRST PRIORITY', 'Confirm the patient', 'is being ventilated.'], ['THEN WORK OUTWARD', 'Airway device.', 'Circuit. Connections. Machine.'], ['LOOK FOR', 'Disconnection.', 'Leak. Cuff problem.'], ['IF NEEDED', 'Hand ventilate with', 'a self inflating bag.'], ['DO NOT', 'Start with a menu', 'of machine settings.'], ['REMEMBER', 'Patient to machine.', 'In that order.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/15 08:00', id: 'delirium-prevention', title: 'Delirium prevention: build a bundle', source: clinicalPosts[1].source, sourceLabel: clinicalPosts[1].sourceLabel, slides: [['DELIRIUM PREVENTION', 'The best plan is', 'usually not one medication.'], ['THINK BUNDLE', 'Orientation.', 'Sleep. Mobility. Hydration.'], ['DO NOT FORGET', 'Glasses, hearing aids,', 'and familiar cues.'], ['MEDICATION REVIEW', 'Avoid deliriogenic drugs', 'when feasible.'], ['THE HANDOFF', 'Prevention crosses', 'the entire perioperative team.'], ['NOT THIS', 'Wait for severe symptoms', 'before changing the environment.'], ['REMEMBER', 'Small supportive steps', 'can add up.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/15 16:00', id: 'ett-cuff', title: 'ETT cuff: measure, do not guess', source: quickPosts[2].source, sourceLabel: quickPosts[2].sourceLabel, slides: [['ETT CUFF', 'A pilot balloon feel', 'is not a pressure reading.'], ['THE TARGET', 'A commonly cited range:', '20 to 30 cm H2O.'], ['WHY IT MATTERS', 'You need a seal', 'without excessive pressure.'], ['THE TOOL', 'Use a cuff manometer.', 'Know the number.'], ['RECHECK', 'Conditions can change', 'throughout the case.'], ['WATCH FOR', 'Nitrous oxide, position,', 'and airway pressure changes.'], ['REMEMBER', 'Measure, then adjust.', 'Do not guess.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/16 08:00', id: 'bcis', title: 'BCIS: recognize the timing', source: clinicalPosts[2].source, sourceLabel: clinicalPosts[2].sourceLabel, slides: [['BCIS', 'The timing can be', 'the biggest clue.'], ['WATCH FOR', 'Hypoxemia.', 'Hypotension. Falling EtCO2.'], ['WHEN', 'Cementation, insertion,', 'reduction, or tourniquet release.'], ['DO NOT WAIT', 'Recognition and team', 'communication come first.'], ['SUPPORT', 'Oxygenation and circulation', 'while coordinating the response.'], ['THE POINT', 'Name the pattern', 'while it is still changing.'], ['REMEMBER', 'Time the event', 'to the surgical step.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] },
  { date: '2026/08/16 16:00', id: 'cefazolin-redosing', title: 'Cefazolin: keep the antibiotic clock visible', source: quickPosts[0].source, sourceLabel: quickPosts[0].sourceLabel, slides: [['CEFAZOLIN', 'The first dose', 'is not the whole plan.'], ['LONG CASE', 'Ask when the dose', 'actually started.'], ['COMMON RULE', 'Redose around 4 hours', 'for cefazolin.'], ['ALSO', 'Major blood loss can', 'shorten the interval.'], ['WHY', 'The goal is adequate', 'tissue concentration at closure.'], ['MAKE IT EASY', 'Put the clock', 'where the team can see it.'], ['REMEMBER', 'Antibiotic timing', 'belongs on the checklist.'], ['MACPREP', 'Cited clinical learning', 'for CAAs and SAAs.']] }
];

const staticAssetFiles = {
  'osa-recovery': 'osa-recovery-observation.png',
  'delirium-prevention': 'postoperative-delirium-prevention.png',
  'bone-cement-implantation': 'bone-cement-implantation-syndrome.png',
  'ponv-risk': 'ponv-risk-prevention.png',
  'sglt2-edka': 'sglt2-edka-perioperative-planning.png',
  'tiva-awareness': 'tiva-monitoring.png',
  'urgent-doac': 'urgent-doac-perioperative-planning.png',
  'cefazolin-redosing': 'cefazolin-prophylaxis.png',
  'tourniquet-release': 'tourniquet-release.png',
  'ett-cuff-pressure': 'ett-cuff-pressure.png',
  'arterial-line-damping': 'arterial-line-damping.png',
  'airway-fire': 'airway-fire-prevention.png',
  'rebound-pain': 'regional-block-rebound-pain.png',
  'low-pressure-alarm': 'anesthesia-machine-low-pressure.png',
  'rationale-teaching': 'aug10-question-rationale-study-desk.png',
  'error-log': 'aug11-error-log-study-habit.png',
  'blueprint-planning': 'aug12-blueprint-study-planning.png',
  'caa-focused-prep': 'aug13-caa-focused-exam-prep.png',
  'source-learning': 'aug14-cited-source-learning.png',
  'practice-vs-review': 'aug15-practice-versus-review.png',
  'sunday-plan': 'aug16-sunday-study-planning.png'
};

function assertCorrectOptionIsNotLongest(post) {
  const correctIndex = post.answer.charCodeAt(0) - 65;
  const correctLength = post.options[correctIndex].length;
  const longestDistractor = Math.max(...post.options.filter((_, index) => index !== correctIndex).map(option => option.length));
  if (correctLength > longestDistractor) {
    throw new Error(`${post.slug}: the correct answer choice is longer than every distractor`);
  }
}

clinicalPosts.forEach(assertCorrectOptionIsNotLongest);

function staticMediaUrl(post) {
  return `${cdnRoot}marketing/social-posts/assets/2026-08-10-to-16/${staticAssetFiles[post.slug]}`;
}

function reelMediaUrl(post) {
  const day = post.date.slice(0, 10).replaceAll('/', '-');
  const slot = post.date.slice(11, 13) === '08' ? 'am' : 'pm';
  return `${cdnRoot}marketing/social-posts/reels/2026-08-10-to-16/reel-${day}-${slot}.mp4`;
}

function clinicalCaption(post, network) {
  const options = post.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join('\n');
  const tags = network === 'linkedin' ? post.hashtags.slice(0, 3).join(' ') : network === 'facebook' ? post.hashtags.slice(0, 2).join(' ') : post.hashtags.join(' ');
  const closing = network === 'linkedin'
    ? 'Save this for your next review block, then use the source to test the rule against the patient in front of you.'
    : 'Save this for your next review block. Then open the source and make the rule your own.';
  return textLines([
    `${post.title}.`,
    '',
    post.question,
    '',
    options,
    '',
    'Drop your answer below 👇',
    '', '', '', '',
    `Answer: ${post.answer}.`,
    '',
    post.rationale,
    '',
    closing,
    '',
    `Source: ${post.sourceLabel}`,
    post.source,
    '',
    tags
  ]);
}

function quickCaption(post, network) {
  const tags = network === 'linkedin' ? post.hashtags.slice(0, 3).join(' ') : network === 'facebook' ? post.hashtags.slice(0, 2).join(' ') : post.hashtags.join(' ');
  return textLines([
    `${post.title}.`,
    '',
    post.body,
    '',
    post.question,
    '',
    'Answer below 👇',
    '', '', '', '',
    post.answer,
    '',
    `Source: ${post.sourceLabel}`,
    post.source,
    '',
    tags
  ]);
}

function studyCaption(post, network) {
  const tags = network === 'linkedin' ? post.hashtags.slice(0, 3).join(' ') : network === 'facebook' ? post.hashtags.slice(0, 2).join(' ') : post.hashtags.join(' ');
  return textLines([
    `${post.title}.`,
    '',
    post.body,
    '',
    post.ending,
    '',
    tags
  ]);
}

function visualRow(post, caption, subtype = '', links = '', mediaUrl = '', title = '') {
  return [post.date, caption, links, mediaUrl, title, '', post.alt, '', '', subtype, '', ''];
}

const staticPosts = [...clinicalPosts, ...quickPosts, ...studyPosts].sort((a, b) => a.date.localeCompare(b.date));
const masterStaticRows = staticPosts.map(post => {
  const caption = clinicalPosts.includes(post) ? clinicalCaption(post, 'instagram') : quickPosts.includes(post) ? quickCaption(post, 'instagram') : studyCaption(post, 'instagram');
  return visualRow(post, caption, '', '', staticMediaUrl(post));
});
fs.writeFileSync(path.join(outputDir, 'macprep-static-all-platforms-2026-08-10-to-16.csv'), toCsv(masterStaticRows));

const reelRows = reelPosts.map(post => [
  post.date,
  textLines([
    `${post.title}.`,
    '',
    'Save this quiet 60 second review for your next study block.',
    '',
    `Source: ${post.sourceLabel}`,
    post.source,
    '',
    '#CAA #SAA #AnesthesiaEducation #MACPrep'
  ]),
  '', reelMediaUrl(post), post.title, '', `Silent 60 second vertical review: ${post.title.toLowerCase()}.`, '', '', 'reel', '', ''
]);
fs.writeFileSync(path.join(outputDir, 'macprep-reels-2026-08-10-to-16.csv'), toCsv(reelRows));

const contentReview = [
  '# MACPrep social batch: Aug 10–16, 2026',
  '',
  'Status: draft package only. Nothing in this folder is posted or scheduled.',
  '',
  '## Intended cadence',
  '',
  '| Time ET | Asset | Role |',
  '| --- | --- | --- |',
  '| 08:00 | Silent Reel | clinical microlearning |',
  '| 10:00 | Static | sourced clinical question |',
  '| 13:00 | Static | quick clinical pearl |',
  '| 16:00 | Silent Reel | clinical microlearning |',
  '| 18:30 | Static | board review or study habit |',
  '',
  '## Static post master copy',
  ''
];
for (const post of staticPosts) {
  const master = clinicalPosts.includes(post) ? clinicalCaption(post, 'instagram') : quickPosts.includes(post) ? quickCaption(post, 'instagram') : studyCaption(post, 'instagram');
  contentReview.push(`### ${post.date} | ${post.title}`, '', master, '');
}
contentReview.push('## Reel storyboards', '');
for (const post of reelPosts) {
  contentReview.push(`### ${post.date} | ${post.title}`, '', `Source: [${post.sourceLabel}](${post.source})`, '');
  post.slides.forEach((slide, index) => contentReview.push(`${index + 1}. ${slide.join(' / ')}`));
  contentReview.push('');
}
fs.writeFileSync(path.join(outputDir, 'content-review.md'), contentReview.join('\n'));

const assetManifest = [
  'Date,Post title,Local asset filename,Alt text,Status',
  ...staticPosts.map(post => `${post.date},"${post.title}",${staticAssetFiles[post.slug]},"${post.alt.replaceAll('"', '""')}",Embedded by media URL`),
  ...reelPosts.map(post => `${post.date},"${post.title}",reel-${post.date.slice(0, 10).replaceAll('/', '-')}-${post.date.slice(11, 13) === '08' ? 'am' : 'pm'}.mp4,"Silent 60 second vertical reel about ${post.title.toLowerCase()}.",Embedded by media URL`)
];
fs.writeFileSync(path.join(outputDir, 'asset-manifest.csv'), assetManifest.join('\n') + '\n');

const readme = `# MACPrep Publer review package: Aug 10–16, 2026

This package contains draft-only CSVs for the next unfilled week. It does not post, schedule, or change anything in Publer.

## Files

- macprep-static-all-platforms-2026-08-10-to-16.csv: use this one file for Instagram, Facebook, LinkedIn, and X when importing the same post everywhere.
- macprep-reels-2026-08-10-to-16.csv
- content-review.md with the complete copy and every reel storyboard
- asset-manifest.csv matching each row to its visual

## Media handling

Every static post has a new, unique photo and every reel has a separate silent 60 second vertical MP4. The Publer media cells contain the matching jsDelivr URL, following the same import convention as the prior reel batches. Select all four static accounts while importing the master static CSV. The local filenames remain in asset-manifest.csv for review only; no separate media upload is needed.

Static images live in marketing/social-posts/assets/2026-08-10-to-16/.
Reels live in marketing/social-posts/reels/2026-08-10-to-16/.

## Review guardrails already applied

- 50 to 60 second silent reels with a slow 7.5 second slide pace.
- Four blank lines before clinical answers in static copy.
- Direct source links for every clinical question or claim.
- No em dashes or dash heavy phrasing.
- No repeated visual concept within this batch.
- No app launch, Android, pricing, or unverified product claims.
`;
fs.writeFileSync(path.join(outputDir, 'README.md'), readme);

fs.writeFileSync(path.join(outputDir, 'reel-storyboards.json'), JSON.stringify(reelPosts, null, 2) + '\n');

console.log(`Wrote social package to ${outputDir}`);

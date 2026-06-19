# MACPrep — Question Bank Blueprint & Authoring Standard

_Built on the official NCCAA Certification Exam (CERT) content outline (2021 Job Analysis). The CERT is 180 multiple-choice items in two 90-item blocks. Source weightings below are the published domain percentages._

The point of this document is to replace the current mass-generated filler with a bank that is **mapped to the real exam**, **deeper than competitors**, and **authored to a consistent quality bar**. Build to this and the "more expansive" goal becomes concrete and measurable.

---

## 1. Domain blueprint (official weightings)

| # | Domain | Exam weight | Target share of bank |
|---|--------|------------:|---------------------:|
| 1 | Principles of Anesthesia | 9% | ~9% |
| 2 | Physiology, Pathophysiology & Management | 19% | ~19% |
| 3 | Instrumentation, Monitoring & Anesthetic Delivery Systems | 15% | ~15% |
| 4 | Subspecialty Care | 31% | ~31% |
| 5 | Pharmacology | 15% | ~15% |
| 6 | Regional Anesthesia & Pain Management | 8% | ~8% |

(The published percentages sum to ~97%; the remainder reflects rounding and unscored pretest items. Treat the weights as targets, not exact quotas.)

### Target question counts
Mapping the weights to a few bank sizes so the build has milestones:

| Domain | 1,000-item bank | 2,500-item bank | 5,000-item bank |
|--------|----------------:|----------------:|----------------:|
| Principles of Anesthesia | 90 | 225 | 450 |
| Physiology/Pathophys/Mgmt | 190 | 475 | 950 |
| Instrumentation/Monitoring/Delivery | 150 | 375 | 750 |
| Subspecialty Care | 310 | 775 | 1,550 |
| Pharmacology | 150 | 375 | 750 |
| Regional & Pain | 80 | 200 | 400 |

A bank that mirrors these proportions is, by definition, "mapped to the blueprint" — a claim competitors make and a filter students expect.

---

## 2. Subtopic taxonomy (authoring checklist)

**1. Principles of Anesthesia** — preoperative evaluation & risk (ASA class, airway exam), informed consent, NPO guidelines, comorbidity optimization, positioning & injury prevention, fluid/electrolyte basics, patient safety, professional/ethical issues.

**2. Physiology, Pathophysiology & Management** — cardiovascular, respiratory, renal, hepatic, CNS, endocrine, hematologic, acid-base. Each as normal physiology + the diseased state + intra-op management.

**3. Instrumentation, Monitoring & Anesthetic Delivery Systems** — anesthesia machine & circuit, vaporizers, scavenging, oxygen supply/fail-safe, ventilator modes, capnography, pulse oximetry, ECG, invasive pressure (arterial/CVP/PA), neuromuscular monitoring, processed EEG, ultrasound, electrical safety, machine checkout.

**4. Subspecialty Care** (the largest domain — invest most here) — cardiac, thoracic, vascular, neuro, obstetric, pediatric, trauma/burns, ambulatory, geriatric, ENT/airway, ophthalmic, orthopedic, transplant, endocrine/bariatric, remote-location/NORA.

**5. Pharmacology** — IV induction agents, volatile agents (MAC, pharmacokinetics), opioids, neuromuscular blockers & reversal (incl. sugammadex), local anesthetics (incl. LAST), vasoactive drugs, anticoagulants, autonomic drugs, antiemetics, drug interactions, context-sensitive half-time.

**6. Regional Anesthesia & Pain Management** — neuraxial (spinal/epidural/CSE), peripheral nerve blocks (upper/lower extremity, truncal), ultrasound guidance, complications, acute & chronic pain, multimodal analgesia, local anesthetic pharmacology.

**Mapping note:** the current DB specialties (e.g., `NEUROANESTHESIA`, `ADVANCED PHARMACOLOGY`, `ANESTHESIA MACHINE PHYSICS`, `OBSTETRIC CRISES`) don't match the six official domains. Re-tag every item with a `domain` (1–6) plus a `subtopic` so the bank can be filtered the way students actually study and the way the exam is scored. NEUROANESTHESIA/OB → Subspecialty Care; MACHINE PHYSICS → Instrumentation; ADVANCED PHARMACOLOGY → Pharmacology, etc.

---

## 3. Question authoring schema

Every item should conform to this shape (superset of what the live `questions` table stores; add the missing columns via migration):

```json
{
  "id": "uuid",
  "domain": 4,
  "domain_name": "Subspecialty Care",
  "subtopic": "Obstetric anesthesia — post-spinal hypotension",
  "track": "initial_certification | recertification",
  "difficulty": "easy | medium | hard",
  "stem": "Single best-answer clinical vignette ending in a focused lead-in question.",
  "choices": [
    { "label": "A", "text": "…", "correct": false, "rationale": "Why this is wrong (the specific misconception)." },
    { "label": "B", "text": "…", "correct": true,  "rationale": "Why this is right." }
  ],
  "explanation": "Teaching explanation: the principle, why the right answer is right, and why each distractor is tempting but wrong.",
  "key_concept": "One-line takeaway for spaced repetition.",
  "references": [
    { "source": "Miller's Anesthesia, 9th ed., Ch. 62", "note": "Obstetric anesthesia" }
  ],
  "status": "draft | sme_review | published",
  "author_id": "uuid",
  "reviewed_by": "uuid | null"
}
```

Notes: `correct` lives inside `choices` and is **never** sent to the client (the server strips it — already implemented). 4–5 options per item. Every item carries at least one real citation and a `status` so nothing reaches students without review.

---

## 4. Quality bar (the rubric that separates this from the current filler)

A question may be published only if **all** are true:

1. **Real clinical content.** The stem describes a specific, plausible scenario; the answer turns on an actual anesthesia principle — not generic phrasing like "execute targeted physiological correction."
2. **One defensibly-correct answer.** A content expert would agree on the key.
3. **Distractors map to real misconceptions.** Each wrong option is something a real candidate might actually pick — never meta-language like "this is a psychometric trap."
4. **Teaching explanation.** Explains the principle and addresses each distractor; a student learns even when they get it right.
5. **Cited.** At least one reference to a standard source (Miller's, Barash, Stoelting, Chestnut's, ASRA/ASA guidelines).
6. **Blueprint-tagged.** Has a `domain` + `subtopic`.
7. **SME-reviewed.** Reviewed by a credentialed CAA/anesthesiologist before `published`.

**Hard constraint:** medically accurate question authoring at scale requires clinical SME input. The samples below set the bar; they are not a license to auto-generate thousands of unreviewed items. The credible build path is author → SME review → publish, in blueprint-weighted batches.

---

## 5. Sample questions (the quality bar, illustrated)

### Sample 1 — Pharmacology — Local Anesthetic Systemic Toxicity
**Stem:** A 28-year-old, 60 kg woman receives an interscalene block with 30 mL of 0.5% bupivacaine for shoulder surgery. Five minutes later she becomes agitated and has a generalized tonic-clonic seizure, followed by a wide-complex bradycardia. The airway is secured and 100% oxygen is delivered. Which is the most appropriate next pharmacologic intervention?

- A. 20% lipid emulsion 1.5 mL/kg bolus, then infusion — **correct**
- B. Epinephrine 1 mg IV (standard ACLS dose)
- C. Propofol infusion to suppress seizure activity
- D. Flumazenil 0.2 mg IV

**Explanation:** This is local anesthetic systemic toxicity (LAST) from bupivacaine. Lipid emulsion therapy is first-line: 20% Intralipid 1.5 mL/kg lean body weight bolus over ~1 minute, then 0.25 mL/kg/min. In LAST-associated arrest, epinephrine should be given in **reduced** doses (≤1 mcg/kg), not the standard 1 mg bolus, which can worsen outcomes. Propofol is not a substitute for lipid (poor lipid load, myocardial depressant). Flumazenil is irrelevant — this is not benzodiazepine sedation.
**Reference:** ASRA Practice Advisory on LAST (Neal et al., 2018/2020 checklist).

### Sample 2 — Subspecialty Care (Obstetric) — Post-spinal hypotension
**Stem:** A healthy parturient develops a blood pressure of 80/40 mmHg two minutes after a spinal anesthetic for elective cesarean delivery. The fetal heart tracing remains reassuring. Which vasopressor is the preferred first-line agent to restore maternal blood pressure?

- A. Phenylephrine — **correct**
- B. Ephedrine
- C. Dopamine infusion
- D. Vasopressin

**Explanation:** Phenylephrine is first-line for spinal-induced hypotension at cesarean delivery. Compared with ephedrine, it is associated with higher umbilical artery pH (less fetal acidosis), because ephedrine crosses the placenta and increases fetal metabolic demand. Dopamine and vasopressin have no role in this routine setting.
**Reference:** Chestnut's Obstetric Anesthesia, 6th ed.; SOAP consensus on maternal hypotension.

### Sample 3 — Instrumentation/Monitoring — Capnography interpretation
**Stem:** During a laparoscopic case under general anesthesia, EtCO2 acutely decreases but the capnogram retains its normal rectangular morphology (it does not fall to zero). Blood pressure drops and the ventilator continues to cycle normally. Which is the most likely cause?

- A. Acute pulmonary embolism (increased alveolar dead space) — **correct**
- B. Circuit disconnection
- C. Esophageal intubation
- D. Complete ETT obstruction

**Explanation:** An acute fall in EtCO2 with a **preserved** waveform points to reduced pulmonary perfusion increasing alveolar dead space — embolism (thrombus, gas, or low cardiac output). In contrast, disconnection, esophageal intubation, and complete obstruction produce a **flat, near-zero** capnogram (no ventilation reaching/leaving alveoli). The shape of the waveform, not just the number, is the discriminator.
**Reference:** Miller's Anesthesia, 9th ed., capnography chapter.

---

## 6. Build sequence

1. **Migrate the schema** — add `domain`, `subtopic`, `difficulty`, `references`, `status`, `reviewed_by` to the questions table.
2. **Re-tag existing items** to the six domains (or retire the filler outright — recommended, given quality).
3. **Author in blueprint-weighted batches** (start with Subspecialty Care — 31%).
4. **SME review gate** before `status = published`.
5. **Expose blueprint filters** in the app (study by domain/subtopic/difficulty) — this is the visible "more expansive" feature students compare on.

Sources: NCCAA Certification Exam Handbook (nccaa.org); TrueLearn NCCAA CERT breakdown.

---

## 7. Authoring progress

**Status vocabulary** (the `questions.status` column gates visibility):
- `unreviewed` — the 3,514 legacy mass-generated items. Tagged to domains for filtering, but does **not** meet the §4 quality bar. Retire or rewrite.
- `sme_review` — authored to the §4 bar and cited, but awaiting credentialed CAA/anesthesiologist sign-off. Not yet `published`.
- `published` — SME-approved (sets `reviewed_by`). Only these should ultimately be shown to paying students.

**Batch 01** (`seeds/authored_batch_01.json`, 15 items, `status='sme_review'`): a quality-bar reference set spanning all six domains, ingested via `seeds/ingest_authored.mjs`. Covers NPO/ASA class (D1), oxyhemoglobin curve / succinylcholine-hyperkalemia (D2), pulse-oximetry methemoglobinemia / CO2 absorbent (D3), pyloric stenosis / preeclampsia-magnesium / MH / aortic stenosis (D4), sugammadex / remifentanil CSHT / local-anesthetic dosing (D5), and cesarean spinal level / ASRA LMWH timing (D6).

**Batch 02** (`seeds/authored_batch_02.json`, 15 items, `status='sme_review'`): focused on **Subspecialty Care (D4)** — the 31% blueprint weight, authored first per §6. Covers VAE / acute ICP (neuro), one-lung ventilation hypoxemia (thoracic), pericardial tamponade (cardiac), uterine atony / PDPH (OB), laryngospasm / emergence delirium (peds), CO poisoning / citrate hypocalcemia (trauma), geriatric MAC, Apfel PONV (ambulatory), airway fire (ENT), oculocardiac reflex (ophthalmic), and pheochromocytoma alpha-before-beta (endocrine).

**Authored so far:** 30 items (`sme_review`). Serving gate is wired: set `SERVE_PUBLISHED_ONLY=true` on the server to show only `status='published'` content (default off while authoring).

**Next steps:** SME review of Batches 01-02 → promote approved items to `published` + set `reviewed_by`; continue authoring blueprint-weighted batches (more Subspecialty Care, then Physiology and Pharmacology). Once a meaningful published set exists, flip `SERVE_PUBLISHED_ONLY=true` and retire the `unreviewed` filler.

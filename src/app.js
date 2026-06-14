// ==========================================================================
// MACPREP MASTER CONSOLE ROUTER & CLINICAL ENGINE WITH STATE NAVIGATION
// ==========================================================================

// Application Session Memory Layers
let currentQuestionIndex = 0;
let workstationQuestions = [];

// High-Signal Board Question Mock Pool Assets
const COMPREHENSIVE_MOCK_BANK = [
    {
        modality: "Clinical Pharmacology",
        difficulty: "BOARD HARD",
        stem: "During a rapid sequence induction in an unstable septic patient with a baseline mean arterial pressure (MAP) of 52 mmHg, which induction agent profiles the most balanced hemodynamic safety vector while minimizing adrenal suppression risks?",
        choices: [
            { letter: "A", text: "Etomidate 0.3 mg/kg IV titrated slowly over 60 seconds" },
            { letter: "B", text: "Propofol 2 mg/kg IV high-velocity syringe bolus" },
            { letter: "C", text: "Ketamine 1.5 mg/kg IV weight-adjusted dose stabilization" },
            { letter: "D", text: "Midazolam 0.1 mg/kg combined with high-dose Fentanyl protocols" }
        ]
    },
    {
        modality: "Anesthesia Physics & Equipment",
        difficulty: "BOARD LEVEL",
        stem: "An anesthesia workstation is utilizing a variable-bypass vaporizer configured for Isoflurane. If the clinician brings the machine into an operating environment located at an altitude of 10,000 feet above sea level without recalibration, how is the delivered partial pressure impacted?",
        choices: [
            { letter: "A", text: "The delivered partial pressure decreases significantly, causing under-anesthetization." },
            { letter: "B", text: "The delivered partial pressure remains approximately unaltered due to compensating vapor pressure physics." },
            { letter: "C", text: "The delivered partial pressure increases linearly, risking profound anesthetic depth." },
            { letter: "D", text: "The vaporizer completely ceases output due to safety interlock barometric constraints." }
        ]
    },
    {
        modality: "Advanced Pathophysiology & Co-morbidities",
        difficulty: "CRITICAL CARE",
        stem: "A patient undergoing an emergent laparotomy with a history of severe carcinoid syndrome manifests sudden, refractory intraoperative hypotension paired with profound bronchospasm. Which vasoactive agent is most explicitly indicated for rescue stabilization?",
        choices: [
            { letter: "A", text: "Ephedrine boluses to trigger indirect catecholamine release profiles" },
            { letter: "B", text: "Epinephrine infusion to stimulate beta-2 adrenergic mediated bronchodilation" },
            { letter: "C", text: "Octreotide 50–100 mcg IV bolus to suppress bioactive peptide secretion" },
            { letter: "D", text: "Phenylephrine titration to achieve isolated alpha-1 peripheral vasoconstriction" }
        ]
    }
];

document.addEventListener('DOMContentLoaded', () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const homeLogoLink = document.getElementById('homeLogoLink');
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');

    console.log("📡 MACPrep Clinical Workspace Controller Online.");

    // State Switch 1: Transitions from Onboarding Hub into Active Workstation
    if (launchBtn) {
        launchBtn.addEventListener('click', () => {
            onboardingHub.classList.add('hidden');
            activeWorkstationGrid.classList.remove('hidden');
            
            // Hydrate working questions array and reset tracking metrics
            workstationQuestions = [...COMPREHENSIVE_MOCK_BANK];
            currentQuestionIndex = 0;

            initializeVitalsMonitor();
            renderActiveQuestion();
        });
    }

    // State Switch 2: Transitions from Active Workstation safely back to Setup Hub
    if (homeLogoLink) {
        homeLogoLink.addEventListener('click', (e) => {
            e.preventDefault();
            activeWorkstationGrid.classList.add('hidden');
            onboardingHub.classList.remove('hidden');
        });
    }

    // Navigation Step: Process Forward Move Events
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (currentQuestionIndex < workstationQuestions.length - 1) {
                currentQuestionIndex++;
                renderActiveQuestion();
            } else {
                alert("Evaluation Matrix Exhausted: You have successfully completed this customized preparation block!");
            }
        });
    }

    // Navigation Step: Process Backward Move Events
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (currentQuestionIndex > 0) {
                currentQuestionIndex--;
                renderActiveQuestion();
            }
        });
    }

    function initializeVitalsMonitor() {
        document.getElementById('hudHR').innerText = "72";
        document.getElementById('hudBP').innerText = "122/78";
        document.getElementById('hudMAP').innerText = "92";
        document.getElementById('hudRR').innerText = "14";
        document.getElementById('hudETCO2').innerText = "36";
    }
});

// Dynamic Matrix Canvas HTML Generation Handler
window.renderActiveQuestion = function() {
    if (workstationQuestions.length === 0) return;

    const currentQ = workstationQuestions[currentQuestionIndex];
    
    // Core Layout Population
    document.getElementById('questionModality').innerText = currentQ.modality;
    document.getElementById('questionDifficulty').innerText = currentQ.difficulty;
    document.getElementById('questionStem').innerText = currentQ.stem;
    
    // Choices Canvas Generation Loop
    const container = document.getElementById('choicesContainer');
    container.innerHTML = currentQ.choices.map(choice => `
        <div class="choice-row" onclick="selectWorkspaceChoice(this)">
            <strong>${choice.letter}</strong>
            <span>${choice.text}</span>
        </div>
    `).join('');

    // Dynamic Navigation Button Management Rules
    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) {
        prevBtn.disabled = (currentQuestionIndex === 0);
    }
};

// Selection Row Event Routing Hook
window.selectWorkspaceChoice = function(element) {
    document.querySelectorAll('.choice-row').forEach(row => row.classList.remove('selected'));
    element.classList.add('selected');
};

// Polished Tabs Panel Switcher Hook
window.switchCalc = function(calcId) {
    document.querySelectorAll('.calc-tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    document.getElementById(`calc-${calcId}`).classList.remove('hidden');
    event.currentTarget.classList.add('active');
};

// ==========================================================================
// MATHEMATICAL CALCULATOR RUNTIME SUBROUTINES
// ==========================================================================
window.calculateABL = function() {
    const weight = parseFloat(document.getElementById('ablWeight').value);
    const ebvFactor = parseFloat(document.getElementById('ablEbvFactor').value);
    const initialHct = parseFloat(document.getElementById('ablInitialHct').value);
    const minHct = parseFloat(document.getElementById('ablMinHct').value);
    const resultBox = document.getElementById('ablResult');

    if (isNaN(weight) || isNaN(initialHct) || isNaN(minHct) || initialHct <= minHct) {
        resultBox.innerText = "Error: Invalid Input Metrics";
        return;
    }
    const totalEbv = weight * ebvFactor;
    const abl = Math.round((totalEbv * (initialHct - minHct)) / initialHct);
    resultBox.innerHTML = `Estimated EBV: ${Math.round(totalEbv)} mL<br><strong>Max Allowable Loss: ${abl} mL</strong>`;
};

window.calculatePedsMetrics = function() {
    const age = parseFloat(document.getElementById('pedsAge').value);
    const weight = parseFloat(document.getElementById('pedsWeight').value);
    const resultBox = document.getElementById('pedsResult');

    if (isNaN(age) || isNaN(weight)) {
        resultBox.innerText = "Error: Invalid Input Metrics";
        return;
    }
    let hourlyRate = weight <= 10 ? weight * 4 : weight <= 20 ? 40 + ((weight - 10) * 2) : 60 + ((weight - 20) * 1);
    const ettSize = (age / 4) + 3.5;
    resultBox.innerHTML = `Maint. Fluid Rate: ${hourlyRate} mL/hr<br><strong>Cuffed ETT ID Size: ${ettSize.toFixed(1)} mm</strong>`;
};

window.calculateAnionGap = function() {
    const na = parseFloat(document.getElementById('agNa').value);
    const cl = parseFloat(document.getElementById('agCl').value);
    const hco3 = parseFloat(document.getElementById('agHco3').value);
    const resultBox = document.getElementById('agResult');

    if (isNaN(na) || isNaN(cl) || isNaN(hco3)) {
        resultBox.innerText = "Error: Invalid Electrolyte Metrics";
        return;
    }
    const anionGap = na - (cl + hco3);
    let status = anionGap > 12 ? "High AG Metabolic Acidosis (MUDPILES Vector)" : anionGap < 8 ? "Low Anion Gap Array" : "Normal Range (8-12)";
    resultBox.innerHTML = `Calculated AG: ${anionGap} mEq/L<br><small style="color: #94a3b8">${status}</small>`;
};

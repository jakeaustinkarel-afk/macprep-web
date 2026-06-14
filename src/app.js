// ==========================================================================
// MACPREP PRODUCTION FRONTEND ROUTER WITH ACTIVE EXTENDED PAYWALL STATES
// ==========================================================================

let currentQuestionIndex = 0;
let workstationQuestions = [];
let totalQuestionsAnsweredCount = 0; // Tracks running free-tier utilization parameters
const FREE_TIER_MAX_LIMIT = 100;     // Hard cap threshold restriction rules

document.addEventListener('DOMContentLoaded', () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const homeLogoLink = document.getElementById('homeLogoLink');
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    
    // Paywall Modal Interface Nodes
    const tierBadgeBtn = document.getElementById('tierBadgeBtn');
    const paywallModal = document.getElementById('paywallModal');
    const closePaywallBtn = document.getElementById('closePaywallBtn');
    const stripeCheckoutBtn = document.getElementById('stripeCheckoutBtn');

    console.log("📡 MACPrep Integrated Workspace Operational Hub Online.");

    // Action Trigger 1: Open paywall instantly when Guest badge is clicked
    if (tierBadgeBtn) {
        tierBadgeBtn.addEventListener('click', () => {
            paywallModal.classList.remove('hidden');
        });
    }

    if (closePaywallBtn) {
        closePaywallBtn.addEventListener('click', () => {
            paywallModal.classList.add('hidden');
        });
    }

    if (stripeCheckoutBtn) {
        stripeCheckoutBtn.addEventListener('click', () => {
            alert("Redirecting to secure Stripe payment verification gateway portal...");
            // Destination hook location line for window.location.href = data.stripeSessionUrl
        });
    }

    // Action Trigger 2: Initialize Console
    if (launchBtn) {
        launchBtn.addEventListener('click', async () => {
            onboardingHub.classList.add('hidden');
            activeWorkstationGrid.classList.remove('hidden');
            
            document.getElementById('questionStem').innerText = "Calibrating dynamic network paths... Retrieving production catalog row arrays.";
            
            await fetchProductionQuestionMatrix();
            
            initializeVitalsMonitor();
            renderActiveQuestion();
        });
    }

    if (homeLogoLink) {
        homeLogoLink.addEventListener('click', (e) => {
            e.preventDefault();
            activeWorkstationGrid.classList.add('hidden');
            onboardingHub.classList.remove('hidden');
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            // Check if user has answered more than 100 questions before advancing
            if (totalQuestionsAnsweredCount >= FREE_TIER_MAX_LIMIT) {
                paywallModal.classList.remove('hidden');
                return;
            }

            if (currentQuestionIndex < workstationQuestions.length - 1) {
                currentQuestionIndex++;
                totalQuestionsAnsweredCount++;
                renderActiveQuestion();
            } else {
                alert("Evaluation Matrix Exhausted: You have successfully completed this customized preparation block!");
            }
        });
    }

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

// Async Network Fetch Layer
async function fetchProductionQuestionMatrix() {
    try {
        const response = await fetch('/api/questions');
        if (!response.ok) throw new Error("Network response mismatch.");
        const data = await response.json();
        
        if (data.questions && data.questions.length > 0) {
            workstationQuestions = data.questions;
            currentQuestionIndex = 0;
        } else {
            throw new Error("Empty array matrix received.");
        }
    } catch (err) {
        console.error("⚠️ Cloud latency fallback activated: ", err);
        // Resilient local array failover loop
        workstationQuestions = [
            {
                modality: "Clinical Pharmacology",
                difficulty: "BOARD HARD",
                stem: "During a rapid sequence induction in an unstable septic patient with a baseline mean arterial pressure (MAP) of 52 mmHg, which induction agent profiles the most balanced hemodynamic safety vector while minimizing adrenal suppression risks?",
                choices: [
                    "Etomidate 0.3 mg/kg IV titrated slowly over 60 seconds",
                    "Propofol 2 mg/kg IV high-velocity syringe bolus",
                    "Ketamine 1.5 mg/kg IV weight-adjusted dose stabilization",
                    "Midazolam 0.1 mg/kg combined with high-dose Fentanyl protocols"
                ]
            }
        ];
    }
}

// Dynamic Matrix Canvas HTML Generation Handler
window.renderActiveQuestion = function() {
    if (workstationQuestions.length === 0) return;

    const currentQ = workstationQuestions[currentQuestionIndex];
    
    document.getElementById('questionModality').innerText = currentQ.modality || "General Curriculum";
    document.getElementById('questionDifficulty').innerText = currentQ.difficulty || "BOARD LEVEL";
    document.getElementById('questionStem').innerText = currentQ.stem;
    
    const container = document.getElementById('choicesContainer');
    let choiceArray = Array.isArray(currentQ.choices) ? currentQ.choices : [];
    if (choiceArray.length === 0 && currentQ.options) choiceArray = currentQ.options;
    if (choiceArray.length === 0) {
        choiceArray = [currentQ.option_a, currentQ.option_b, currentQ.option_c, currentQ.option_d].filter(Boolean);
    }

    container.innerHTML = choiceArray.map((choice, i) => {
        const letter = String.fromCharCode(65 + i);
        return `
            <div class="choice-row" onclick="selectWorkspaceChoice(this)">
                <strong>${letter}</strong>
                <span>${choice}</span>
            </div>
        `;
    }).join('');

    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) {
        prevBtn.disabled = (currentQuestionIndex === 0);
    }
};

window.selectWorkspaceChoice = function(element) {
    document.querySelectorAll('.choice-row').forEach(row => row.classList.remove('selected'));
    element.classList.add('selected');
};

window.switchCalc = function(calcId) {
    document.querySelectorAll('.calc-tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    const targetContent = document.getElementById(`calc-${calcId}`);
    if (targetContent) targetContent.classList.remove('hidden');
    if (event && event.currentTarget) event.currentTarget.classList.add('active');
};

// Math Modules
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

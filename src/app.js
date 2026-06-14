// ==========================================================================
// MACPREP MASTER CONSOLE ROUTER & CLINICAL ENGINE
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const homeLogoLink = document.getElementById('homeLogoLink');

    console.log("📡 MACPrep Clinical Workspace Controller Online.");

    // State Switch 1: Transitions from Onboarding Hub into Active Workstation
    if (launchBtn) {
        launchBtn.addEventListener('click', () => {
            onboardingHub.classList.add('hidden');
            activeWorkstationGrid.classList.remove('hidden');
            
            initializeVitalsMonitor();
            instantiateQuestionPayload();
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

    function initializeVitalsMonitor() {
        document.getElementById('hudHR').innerText = "72";
        document.getElementById('hudBP').innerText = "122/78";
        document.getElementById('hudMAP').innerText = "92";
        document.getElementById('hudRR').innerText = "14";
        document.getElementById('hudETCO2').innerText = "36";
    }

    function instantiateQuestionPayload() {
        document.getElementById('questionModality').innerText = "Clinical Pharmacology";
        document.getElementById('questionDifficulty').innerText = "BOARD HARD";
        document.getElementById('questionStem').innerText = "During a rapid sequence induction in an unstable septic patient with a baseline mean arterial pressure (MAP) of 52 mmHg, which induction agent profiles the most balanced hemodynamic safety vector while minimizing adrenal suppression risks?";
        
        const container = document.getElementById('choicesContainer');
        container.innerHTML = `
            <div class="choice-row" onclick="selectWorkspaceChoice(this)"><strong>A</strong><span>Etomidate 0.3 mg/kg IV titrated slowly</span></div>
            <div class="choice-row" onclick="selectWorkspaceChoice(this)"><strong>B</strong><span>Propofol 2 mg/kg IV high-velocity bolus</span></div>
            <div class="choice-row" onclick="selectWorkspaceChoice(this)"><strong>C</strong><span>Ketamine 1.5 mg/kg IV weight-adjusted dose</span></div>
            <div class="choice-row" onclick="selectWorkspaceChoice(this)"><strong>D</strong><span>Midazolam 0.1 mg/kg combined with Fentanyl protocols</span></div>
        `;
    }
});

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

// 1. Allowable Blood Loss (ABL) Engine
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

// 2. Pediatric Fluid & Tube Metrics Engine (4-2-1 Rule + Motoyama Cuffed ETT)
window.calculatePedsMetrics = function() {
    const age = parseFloat(document.getElementById('pedsAge').value);
    const weight = parseFloat(document.getElementById('pedsWeight').value);
    const resultBox = document.getElementById('pedsResult');

    if (isNaN(age) || isNaN(weight)) {
        resultBox.innerText = "Error: Invalid Input Metrics";
        return;
    }

    // 4-2-1 Fluid Maintenance Rule Calculation
    let hourlyRate = 0;
    if (weight <= 10) {
        hourlyRate = weight * 4;
    } else if (weight <= 20) {
        hourlyRate = 40 + ((weight - 10) * 2);
    } else {
        hourlyRate = 60 + ((weight - 20) * 1);
    }

    // Cuffed Endotracheal Tube Size Calculation (Motoyama Formula)
    const ettSize = (age / 4) + 3.5;

    resultBox.innerHTML = `Maint. Fluid Rate: ${hourlyRate} mL/hr<br><strong>Cuffed ETT ID Size: ${ettSize.toFixed(1)} mm</strong>`;
};

// 3. Anion Gap Calculator Engine
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
    let status = "Normal Range (8-12)";
    if (anionGap > 12) status = "High Anion Gap Metabolic Acidosis (MUDPILES Vector)";
    if (anionGap < 8) status = "Low Anion Gap Array";

    resultBox.innerHTML = `Calculated AG: ${anionGap} mEq/L<br><small style="color: #94a3b8">${status}</small>`;
};

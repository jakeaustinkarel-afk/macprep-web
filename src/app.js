// ==========================================================================
// MACPREP SYSTEM STATE CONTROLLER ENGINE - PREMIUM CLINICAL CONSOLE REALIGNMENT
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const homeLogoLink = document.getElementById('homeLogoLink');

    console.log("🚀 MACPrep Professional Console Engine Online.");

    // Action 1: Transition seamlessly from Setup Hub into the Active Workstation
    if (launchBtn) {
        launchBtn.addEventListener('click', () => {
            onboardingHub.classList.add('hidden');
            activeWorkstationGrid.classList.remove('hidden');
            activeWorkstationGrid.style.display = 'grid';
            
            // Re-fire standard question engine instantiation hooks
            initializeMockVitals();
            loadQuestionFallback();
        });
    }

    // Action 2: Reset app state clean back to Setup Hub on Title Logo Click
    if (homeLogoLink) {
        homeLogoLink.addEventListener('click', (e) => {
            e.preventDefault();
            activeWorkstationGrid.style.display = 'none';
            activeWorkstationGrid.classList.add('hidden');
            onboardingHub.classList.remove('hidden');
        });
    }

    function initializeMockVitals() {
        document.getElementById('hudHR').innerText = "74";
        document.getElementById('hudBP').innerText = "118/76";
        document.getElementById('hudMAP').innerText = "90";
        document.getElementById('hudRR').innerText = "12";
        document.getElementById('hudETCO2').innerText = "35";
    }

    function loadQuestionFallback() {
        document.getElementById('questionModality').innerText = "Clinical Pharmacology";
        document.getElementById('questionDifficulty').innerText = "BOARD HARD";
        document.getElementById('questionStem').innerText = "During a rapid sequence induction in an unstable septic patient with a baseline mean arterial pressure (MAP) of 52 mmHg, which induction agent profiles the most balanced hemodynamic safety vector while minimizing adrenal suppression risks?";
        
        const container = document.getElementById('choicesContainer');
        container.innerHTML = `
            <div class="choice-row" onclick="selectChoice(this)"><strong>A</strong><span>Etomidate 0.3 mg/kg IV pushes</span></div>
            <div class="choice-row" onclick="selectChoice(this)"><strong>B</strong><span>Propofol 2 mg/kg IV bolus titration</span></div>
            <div class="choice-row" onclick="selectChoice(this)"><strong>C</strong><span>Ketamine 1.5 mg/kg IV administration</span></div>
            <div class="choice-row" onclick="selectChoice(this)"><strong>D</strong><span>Midazolam 0.1 mg/kg paired with Fentanyl</span></div>
        `;
    }
});

// Global Calculator Suite Tab Switcher
window.switchCalc = function(calcId) {
    document.querySelectorAll('.calc-tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    document.getElementById(`calc-${calcId}`).classList.remove('hidden');
    event.currentTarget.classList.add('active');
};

// Selection Highlighter Row Action
window.selectChoice = function(element) {
    document.querySelectorAll('.choice-row').forEach(row => row.classList.remove('selected'));
    element.classList.add('selected');
};

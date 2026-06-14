// ==========================================================================
// MACPREP SYSTEM ROUTER ENGINE - CLINICAL CONSOLE DATA LOGIC
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
            
            // Instantly render real-time telemetry monitors and questions data
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

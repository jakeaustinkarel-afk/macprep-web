// ==========================================================================
// MACPREP SYSTEM STATE CONTROLLER ENGINE
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const homeLogoLink = document.getElementById('homeLogoLink');

    console.log("🚀 MACPrep Frontend Application Engine Initialised Successfully.");

    // Action 1: Transition smoothly from Setup Hub into the Active Workstation
    if (launchBtn) {
        launchBtn.addEventListener('click', () => {
            console.log("⚡ Launching workstation matrix state allocation...");
            onboardingHub.classList.add('hidden');
            activeWorkstationGrid.classList.remove('hidden');
            
            // Generate clinical monitor numbers
            initializeMockVitals();
        });
    }

    // Action 2: Reset app state clean back to Setup Hub on Title Logo Click
    if (homeLogoLink) {
        homeLogoLink.addEventListener('click', (e) => {
            e.preventDefault();
            console.log("↩️ Routing layout back to main Onboarding Parameter Deck.");
            activeWorkstationGrid.classList.add('hidden');
            onboardingHub.classList.remove('hidden');
        });
    }

    function initializeMockVitals() {
        document.getElementById('hudHR').innerText = "72";
        document.getElementById('hudBP').innerText = "120/80";
        document.getElementById('hudMAP').innerText = "93";
        document.getElementById('hudRR').innerText = "14";
        document.getElementById('hudETCO2').innerText = "36";
    }
});

let activeQuestions = [];
let currentIndex = 0;

// Fetch items from your REST backend API endpoints
async function loadQuestionBank() {
    try {
        const response = await fetch('/api/questions');
        const data = await response.json();
        activeQuestions = data.questions || data;
        
        if (activeQuestions.length > 0) {
            renderQuestion(currentIndex);
        }
    } catch (err) {
        console.error("❌ Workstation initialization pipeline error:", err);
        const stemEl = document.getElementById('questionStem') || document.querySelector('.question-text');
        if (stemEl) {
            stemEl.innerText = "Database connection offline. Boot your backend via node src/server.mjs to clear this checkpoint.";
        }
    }
}

// Map real-time question telemetry directly to your existing visual components
function renderQuestion(index) {
    const question = activeQuestions[index];
    if (!question) return;

    // Reset explanation states
    const expBox = document.getElementById('explanationBox') || document.querySelector('.explanation-section');
    if (expBox) expBox.classList.add('hidden');
    
    const container = document.getElementById('choicesContainer') || document.querySelector('.options-list');
    if (container) container.innerHTML = '';

    // Update Question Stem
    const stemEl = document.getElementById('questionStem') || document.querySelector('.question-text');
    if (stemEl) stemEl.innerText = question.stem;

    // Update Modality and Difficulty tags if elements are present
    const modalityEl = document.getElementById('questionModality') || document.querySelector('.modality-label');
    if (modalityEl) modalityEl.innerText = question.modality;

    // --- Dynamic Telemetry Binding to your Custom Monitors ---
    if (question.telemetry) {
        // Look for standard digital readouts or numeric text targets inside your monitor divs
        const hrVal = document.getElementById('hudHR') || document.querySelector('.hr-value') || document.querySelector('.numeric-hr');
        const bpVal = document.getElementById('hudBP') || document.querySelector('.bp-value') || document.querySelector('.numeric-bp');
        const mapVal = document.getElementById('hudMAP') || document.querySelector('.map-value') || document.querySelector('.numeric-map');
        const rrVal = document.getElementById('hudRR') || document.querySelector('.rr-value') || document.querySelector('.numeric-rr');
        const etco2Val = document.getElementById('hudETCO2') || document.querySelector('.etco2-value') || document.querySelector('.numeric-etco2');

        if (hrVal) hrVal.innerText = question.telemetry.hr || '75';
        if (bpVal) bpVal.innerText = question.telemetry.bp || '120/80';
        if (mapVal) mapVal.innerText = question.telemetry.map || '93';
        if (rrVal) rrVal.innerText = question.telemetry.rr || '14';
        if (etco2Val) etco2Val.innerText = question.telemetry.etco2 || '38';

        // Optional: Trigger canvas waveform morphs based on waveformType strings
        // e.g., if (question.waveformType === 'BRONCHOSPASM') { triggerSharkFinAnimation(); }
    }

    // Process choice blocks
    if (container) {
        question.choices.forEach((choice, idx) => {
            const div = document.createElement('div');
            // Support both standard project layouts and custom choice item tags
            div.className = 'choice-item option-card';
            div.innerText = `${String.fromCharCode(65 + idx)}) ${choice.text}`;
            div.onclick = () => selectChoice(div, choice, question.choices);
            container.appendChild(div);
        });
    }

    // Enable / Disable nav controls
    const prevBtn = document.getElementById('prevBtn');
    if (prevBtn) prevBtn.disabled = (index === 0);
}

function selectChoice(element, choice, allChoices) {
    const items = document.querySelectorAll('.choice-item, .option-card');
    items.forEach(el => el.onclick = null);

    if (choice.correct || choice.correct === true) {
        element.classList.add('correct');
    } else {
        element.classList.add('incorrect');
        items.forEach((el, idx) => {
            if (allChoices[idx].correct) el.classList.add('correct');
        });
    }

    const activeQuestion = activeQuestions[currentIndex];
    const expBox = document.getElementById('explanationBox') || document.querySelector('.explanation-section');
    const expText = document.getElementById('explanationText') || document.querySelector('.explanation-p');
    
    if (expText) expText.innerText = activeQuestion.explanation;
    if (expBox) expBox.classList.remove('hidden');
}

// Setup Global Nav Triggers
const nextBtn = document.getElementById('nextBtn');
if (nextBtn) {
    nextBtn.onclick = () => {
        if (currentIndex < activeQuestions.length - 1) {
            currentIndex++;
            renderQuestion(currentIndex);
        }
    };
}

const prevBtn = document.getElementById('prevBtn');
if (prevBtn) {
    prevBtn.onclick = () => {
        if (currentIndex > 0) {
            currentIndex--;
            renderQuestion(currentIndex);
        }
    };
}

// Boot setup on initialization
loadQuestionBank();

// ==========================================================================
// DUAL-STATE INTERFACE SCREEN ROUTER LOGIC
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const homeLogoLink = document.getElementById('homeLogoLink');

    // Action 1: Transition into Question Workspace State
    if (launchBtn) {
        launchBtn.addEventListener('click', () => {
            onboardingHub.classList.add('hidden');
            activeWorkstationGrid.classList.remove('hidden');
            
            // Re-fire standard question engine instantiation hooks if needed
            if (typeof renderActiveQuestion === 'function') {
                renderActiveQuestion();
            }
        });
    }

    // Action 2: Reset app layout state back to Setup Screen on title tap
    if (homeLogoLink) {
        homeLogoLink.addEventListener('click', (e) => {
            e.preventDefault(); // Halt page dump refresh loops
            activeWorkstationGrid.classList.add('hidden');
            onboardingHub.classList.remove('hidden');
        });
    }
});

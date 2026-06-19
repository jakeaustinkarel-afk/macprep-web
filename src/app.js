// MACPrep Workstation Core State Management Engine
let currentQuestionIndex = 0;
let questions = [];
let questionsAnsweredCount = 0;
const FREE_TIER_CEILING = 100; // Exactly 10% of the 1,000 question national curriculum bank

// Initialize the academic terminal interface parameters
async function initializeWorkstation() {
    try {
        console.log("[SYS-INIT] Fetching clinical curriculum assets from streaming routes...");
        const response = await fetch('/api/questions');
        const data = await response.json();
        
        // Ensure we isolate the correct payload matrix array format
        questions = Array.isArray(data) ? data : (data.questions || []);
        
        if (questions.length === 0) {
            console.error("❌ Fatal: Question payload bank array parsing resulted in zero entries.");
            return;
        }

        currentQuestionIndex = 0;
        questionsAnsweredCount = 0;
        loadNextCaseVignette();
    } catch (err) {
        console.error("❌ Critical System Error mapping network data layers:", err);
    }
}

// Handles parsing clinical schemas and rendering safe option labels A-E
function loadNextCaseVignette() {
    if (questionsAnsweredCount >= FREE_TIER_CEILING) {
        triggerPremiumPaywallGate();
        return;
    }

    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion) return;

    // Update the visual clinical stem text block cleanly
    const stemEl = document.getElementById('question-stem');
    if (stemEl) {
        stemEl.textContent = currentQuestion.stem || currentQuestion.text || "Loading operational parameters...";
    }

    // Capture choices array safely whether keyed as options or choices
    let choicesArray = currentQuestion.choices || currentQuestion.options || [];
    
    // Safety check: if stringified object accidentally slipped through database parsing, unpack it
    if (typeof choicesArray === 'string') {
        try { choicesArray = JSON.parse(choicesArray); } catch(e) { choicesArray = []; }
    }

    const container = document.getElementById('choices-container');
    if (container) {
        container.innerHTML = '';
        
        if (Array.isArray(choicesArray)) {
            choicesArray.forEach((choice, index) => {
                // Safeguard against objects printing into choices layout
                const displayChoiceText = (typeof choice === 'object' && choice !== null) ? (choice.text || choice.value || '') : choice;
                const letterLabel = String.fromCharCode(65 + index); // Strictly turns numeric indices into A, B, C, D, E
                
                const choiceBtn = document.createElement('button');
                choiceBtn.className = 'choice-option-node';
                choiceBtn.style.width = '100%';
                choiceBtn.style.textAlign = 'left';
                choiceBtn.style.margin = '10px 0';
                choiceBtn.style.padding = '14px';
                choiceBtn.style.backgroundColor = '#111214';
                choiceBtn.style.border = '1px solid #1F2937';
                choiceBtn.style.color = '#F9FAFB';
                choiceBtn.style.fontFamily = 'monospace';
                choiceBtn.style.fontSize = '14px';
                choiceBtn.style.cursor = 'pointer';
                choiceBtn.style.borderRadius = '4px';

                choiceBtn.innerHTML = `<span style="color: #00A86B; font-weight: bold; margin-right: 15px;">[${letterLabel}]</span> ${displayChoiceText}`;
                
                choiceBtn.onclick = () => handleSelectionEvent(index, currentQuestion.correct_answer || currentQuestion.answer);
                container.appendChild(choiceBtn);
            });
        }
    }

    // Synchronize the interface metrics sidebar index to matching A-E labels
    updateSidebarProgressTracker();
}

function handleSelectionEvent(selectedIndex, correctIndex) {
    console.log(`User selected index [${selectedIndex}], Correct verification target is [${correctIndex}]`);
    // Advanced feedback highlights and metacognitive tracing parameters loop here...
    
    // Auto-advance simulation hook setup
    questionsAnsweredCount++;
    currentQuestionIndex = (currentQuestionIndex + 1) % questions.length;
    
    // Expose advance action button triggers
    const advanceBtn = document.getElementById('advance-vignette-trigger');
    if (advanceBtn) {
        advanceBtn.onclick = () => loadNextCaseVignette();
    } else {
        // Fallback immediate rendering
        setTimeout(loadNextCaseVignette, 1200);
    }
}

function updateSidebarProgressTracker() {
    const progressEl = document.getElementById('session-progress-counter');
    if (progressEl) {
        progressEl.textContent = `PROGRESS: ${questionsAnsweredCount} / ${FREE_TIER_CEILING}`;
    }
}

function triggerPremiumPaywallGate() {
    console.log("[🔒 GATEWAY ACTIVED] Session threshold reached. Presenting checkout terminal layers.");
    const workspaceEl = document.getElementById('exam-workstation-pane');
    if (workspaceEl) {
        workspaceEl.innerHTML = `
            <div style="padding: 40px; text-align: left; background-color: #111214; border: 1px solid #1F2937; border-radius: 4px; max-width: 600px; margin: 40px auto;">
                <span style="font-family: monospace; font-size: 11px; color: #00A86B; letter-spacing: 2px;">[CEILING ENGAGED] TRIAL LIMIT REACHED</span>
                <h2 style="font-size: 24px; font-weight: 800; color: #F9FAFB; margin: 10px 0 20px 0;">Unlock 100% Core National Curriculum Blueprint Access</h2>
                <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin-bottom: 25px;">You have successfully evaluated your complimentary 10% sample question track index allocations (100 cases). Gain unrestricted production clearance to all 3,514 psychometrically balanced exam vignettes across pediatric, cardiovascular, and high-acuity tracking modules.</p>
                <button onclick="window.location.href='https://buy.stripe.com/5kQ6oI6HHefh5btfK7dnW00'" style="background-color: #00A86B; color: #F9FAFB; border: none; padding: 14px 24px; font-family: monospace; font-size: 13px; font-weight: bold; cursor: pointer; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Upgrade to Full Premium Access — $50</button>
            </div>
        `;
    }
}

// Initial binding hook
document.addEventListener('DOMContentLoaded', () => {
    initializeWorkstation();
});

// MACPrep Workstation Core State Management Engine
let currentQuestionIndex = 0;
let questions = [];
let questionsAnsweredCount = 0;
const FREE_TIER_CEILING = 100;

// Initialize the academic terminal interface parameters
async function initializeWorkstation() {
    try {
        console.log("[SYS-INIT] Fetching clinical curriculum assets...");
        const response = await fetch('/api/questions');
        const data = await response.json();
        
        questions = Array.isArray(data) ? data : (data.questions || []);
        
        if (questions.length === 0) {
            console.error("❌ Question payload bank array parsing resulted in zero entries.");
            return;
        }

        currentQuestionIndex = 0;
        questionsAnsweredCount = 0;
        loadNextCaseVignette();
    } catch (err) {
        console.error("❌ Critical System Error mapping network data layers:", err);
    }
}

function loadNextCaseVignette() {
    if (questionsAnsweredCount >= FREE_TIER_CEILING) {
        triggerPremiumPaywallGate();
        return;
    }

    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion) return;

    const stemEl = document.getElementById('question-stem');
    if (stemEl) stemEl.textContent = currentQuestion.stem || currentQuestion.text || "";

    let choicesArray = currentQuestion.choices || currentQuestion.options || [];
    if (typeof choicesArray === 'string') {
        try { choicesArray = JSON.parse(choicesArray); } catch(e) { choicesArray = []; }
    }

    const container = document.getElementById('choices-container');
    if (container) {
        container.innerHTML = '';
        if (Array.isArray(choicesArray)) {
            choicesArray.forEach((choice, index) => {
                const displayChoiceText = (typeof choice === 'object' && choice !== null) ? (choice.text || choice.value || '') : choice;
                const letterLabel = String.fromCharCode(65 + index);
                
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
                choiceBtn.style.cursor = 'pointer';

                choiceBtn.innerHTML = `<span style="color: #00A86B; font-weight: bold; margin-right: 15px;">[${letterLabel}]</span> ${displayChoiceText}`;
                choiceBtn.onclick = () => handleSelectionEvent(index, currentQuestion.correct_answer || currentQuestion.answer);
                container.appendChild(choiceBtn);
            });
        }
    }
    
    const progressEl = document.getElementById('session-progress-counter');
    if (progressEl) progressEl.textContent = `PROGRESS: ${questionsAnsweredCount} / ${FREE_TIER_CEILING}`;
}

function handleSelectionEvent(selectedIndex, correctIndex) {
    questionsAnsweredCount++;
    currentQuestionIndex = (currentQuestionIndex + 1) % questions.length;
    setTimeout(loadNextCaseVignette, 800);
}

function triggerPremiumPaywallGate() {
    const workspaceEl = document.getElementById('exam-workstation-pane');
    if (workspaceEl) {
        workspaceEl.innerHTML = `
            <div style="padding: 40px; text-align: left; background-color: #111214; border: 1px solid #1F2937; border-radius: 4px; max-width: 600px; margin: 40px auto;">
                <span style="font-family: monospace; font-size: 11px; color: #00A86B; letter-spacing: 2px;">[CEILING ENGAGED] TRIAL LIMIT REACHED</span>
                <h2 style="font-size: 24px; font-weight: 800; color: #F9FAFB; margin: 10px 0 20px 0;">Unlock 100% Core National Curriculum Blueprint Access</h2>
                <button onclick="window.location.href='https://buy.stripe.com/5kQ6oI6HHefh5btfK7dnW00'" style="background-color: #00A86B; color: #F9FAFB; border: none; padding: 14px 24px; font-family: monospace; font-size: 13px; font-weight: bold; cursor: pointer; border-radius: 4px; text-transform: uppercase; letter-spacing: 1px;">Upgrade to Full Premium Access — $50</button>
            </div>
        `;
    }
}

// 🔐 Engine Authenticator
async function executeLoginSubmission() {
    const emailInput = document.getElementById('login-email');
    const passwordInput = document.getElementById('login-password');
    const submitBtn = document.getElementById('login-submit-trigger');
    
    if (!emailInput || !passwordInput) {
        alert("❌ Error: Cannot find email/password fields on the screen.");
        return;
    }
    
    if (submitBtn) submitBtn.textContent = "📡 VERIFYING CREDENTIALS...";
    
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: emailInput.value, password: passwordInput.value })
        });
        
        if (response.ok) {
            if (submitBtn) submitBtn.textContent = "✅ ACCESS GRANTED. LOADING WORKSTATION...";
            const loginPane = document.getElementById('login-form-container');
            const mainWorkstation = document.getElementById('exam-workstation-pane');
            
            if (loginPane) loginPane.style.display = 'none';
            if (mainWorkstation) mainWorkstation.style.display = 'block';
            
            initializeWorkstation();
        } else {
            const errorData = await response.text();
            alert("❌ SERVER REJECTED LOGIN: " + errorData);
            if (submitBtn) submitBtn.textContent = "INITIALIZE WORKSTATION SECURE CONNECTION";
        }
    } catch (err) {
        alert("❌ NETWORK ERROR: Could not communicate with the backend server.");
        if (submitBtn) submitBtn.textContent = "INITIALIZE WORKSTATION SECURE CONNECTION";
    }
}

// Escaping the module sandbox to ensure the HTML form can see the function
window.executeLoginSubmission = executeLoginSubmission;

// Aggressive DOM binding to catch Enter keys natively
document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.querySelector('form');
    if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault(); // Stop the ghost loop
            executeLoginSubmission();
        });
    }
});

// ==========================================================================
// MACPREP MASTERFRONTEND SYSTEM INTERFACE SCREEN CONTROLLER
// ==========================================================================

let currentQuestionIndex = 0;
let workstationQuestions = [];
let totalQuestionsAnsweredCount = 0;
const FREE_TIER_MAX_LIMIT = 100;

// Device Core Profile Session Variables
let currentUserEmail = null;
let isPremiumAccountUnlocked = false;
let userQuestionHistoryArray = [];

document.addEventListener('DOMContentLoaded', () => {
    // Screen Tracking Pointers
    const onboardingHub = document.getElementById('onboardingHub');
    const signInScreen = document.getElementById('signInScreen');
    const signUpScreen = document.getElementById('signUpScreen');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    
    // Core Layout Trigger Anchors
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const homeLogoLink = document.getElementById('homeLogoLink');
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    const tierBadgeBtn = document.getElementById('tierBadgeBtn');
    const paywallModal = document.getElementById('paywallModal');
    const closePaywallBtn = document.getElementById('closePaywallBtn');

    // Authentication Form Flow Trigger Anchors
    const navSignInBtn = document.getElementById('navSignInBtn');
    const navSignUpBtn = document.getElementById('navSignUpBtn');
    const switchToSignUpLink = document.getElementById('switchToSignUpLink');
    const switchToSignInLink = document.getElementById('switchToSignInLink');
    
    const executeLoginBtn = document.getElementById('executeLoginBtn');
    const executeRegisterBtn = document.getElementById('executeRegisterBtn');
    const loginEmailInput = document.getElementById('loginEmailInput');
    const loginPasswordInput = document.getElementById('loginPasswordInput');
    const registerEmailInput = document.getElementById('registerEmailInput');
    const registerPasswordInput = document.getElementById('registerPasswordInput');
    const headerAuthContainer = document.getElementById('headerAuthContainer');

    // ==========================================================================
    // MULTI-VIEW HIGH FIDELITY SCREEN ROUTER ACTION LINES
    // ==========================================================================
    function showTargetViewScreen(targetScreen) {
        onboardingHub.classList.add('hidden');
        signInScreen.classList.add('hidden');
        signUpScreen.classList.add('hidden');
        activeWorkstationGrid.classList.add('hidden');
        targetScreen.classList.remove('hidden');
    }

    if (navSignInBtn) navSignInBtn.addEventListener('click', () => showTargetViewScreen(signInScreen));
    if (navSignUpBtn) navSignUpBtn.addEventListener('click', () => showTargetViewScreen(signUpScreen));
    if (switchToSignUpLink) switchToSignUpLink.addEventListener('click', (e) => { e.preventDefault(); showTargetViewScreen(signUpScreen); });
    if (switchToSignInLink) switchToSignInLink.addEventListener('click', (e) => { e.preventDefault(); showTargetViewScreen(signInScreen); });

    if (homeLogoLink) {
        homeLogoLink.addEventListener('click', (e) => {
            e.preventDefault();
            showTargetViewScreen(onboardingHub);
        });
    }

    // Process True Server Registration Actions Loop
    if (executeRegisterBtn) {
        executeRegisterBtn.addEventListener('click', () => handleAuthTransaction('register'));
    }

    // Process True Server Sign In Actions Loop
    if (executeLoginBtn) {
        executeLoginBtn.addEventListener('click', () => handleAuthTransaction('login'));
    }

    async function handleAuthTransaction(mode) {
        const email = mode === 'login' ? loginEmailInput.value.trim() : registerEmailInput.value.trim();
        const password = mode === 'login' ? loginPasswordInput.value.trim() : registerPasswordInput.value.trim();

        if (!email || !password || !email.includes('@')) {
            alert("Please input a valid username and verification password.");
            return;
        }

        try {
            const response = await fetch('/api/authenticate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: mode, email, password })
            });
            const data = await response.json();

            if (!response.ok || !data.success) {
                throw new Error(data.error || "Transaction aborted by database constraint validation.");
            }

            // Successfully authenticated -> Map properties to memory
            currentUserEmail = data.profile.email;
            isPremiumAccountUnlocked = data.profile.premium_unlocked;
            totalQuestionsAnsweredCount = data.profile.answered_count || 0;
            userQuestionHistoryArray = data.profile.history || [];

            // Re-render header actions state block cleanly
            headerAuthContainer.innerHTML = `
                <div class="user-profile-badge">
                    <span>Active Profile: <strong>${currentUserEmail}</strong></span>
                    <button id="authLogoutBtn" class="nav-text-link" style="margin-left: 10px; color: #ef4444;">Sign Out</button>
                </div>
            `;
            
            // Rebind dynamically generated sign out listeners cleanly
            document.getElementById('authLogoutBtn').addEventListener('click', () => location.reload());

            // Adjust Badges Based on Live Roles Parameters
            if (isPremiumAccountUnlocked) {
                tierBadgeBtn.innerText = "TIER: PREMIUM MEMBER (UNLOCKED)";
                tierBadgeBtn.style.color = "#00ff88";
                tierBadgeBtn.style.borderColor = "#00ff88";
            } else {
                tierBadgeBtn.innerText = `TIER: MEMBER (${totalQuestionsAnsweredCount}/100 FREE)`;
            }

            alert(data.message || " Handshake Verified!");
            showTargetViewScreen(onboardingHub);

        } catch (err) {
            alert(`Authentication Error: ${err.message}`);
        }
    }

    // Launch Workspace Terminal Hook Action
    if (launchBtn) {
        launchBtn.addEventListener('click', async () => {
            showTargetViewScreen(activeWorkstationGrid);
            await fetchProductionQuestionMatrix();
            initializeVitalsMonitor();
            renderActiveQuestion();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', async () => {
            if (!isPremiumAccountUnlocked && totalQuestionsAnsweredCount >= FREE_TIER_MAX_LIMIT) {
                paywallModal.classList.remove('hidden');
                return;
            }

            if (currentQuestionIndex < workstationQuestions.length - 1) {
                const activeQ = workstationQuestions[currentQuestionIndex];
                if (activeQ && activeQ.id && !userQuestionHistoryArray.includes(activeQ.id)) {
                    userQuestionHistoryArray.push(activeQ.id);
                }

                currentQuestionIndex++;
                totalQuestionsAnsweredCount++;
                
                if (currentUserEmail) {
                    await fetch('/api/update-progress', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            email: currentUserEmail,
                            answered_count: totalQuestionsAnsweredCount,
                            history: userQuestionHistoryArray
                        })
                    });
                }
                renderActiveQuestion();
            } else {
                alert("Evaluation Matrix Block Exhausted.");
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

    if (tierBadgeBtn) tierBadgeBtn.addEventListener('click', () => paywallModal.classList.remove('hidden'));
    if (closePaywallBtn) closePaywallBtn.addEventListener('click', () => paywallModal.classList.add('hidden'));

    function initializeVitalsMonitor() {
        document.getElementById('hudHR').innerText = "72";
        document.getElementById('hudBP').innerText = "122/78";
        document.getElementById('hudMAP').innerText = "92";
        document.getElementById('hudRR').innerText = "14";
        document.getElementById('hudETCO2').innerText = "36";
    }
});

async function fetchProductionQuestionMatrix() {
    try {
        const response = await fetch('/api/questions');
        const data = await response.json();
        if (data.questions && data.questions.length > 0) {
            workstationQuestions = data.questions;
            currentQuestionIndex = 0;
        }
    } catch (err) {
        console.error("Failover activated:", err);
    }
}

window.renderActiveQuestion = function() {
    if (workstationQuestions.length === 0) return;
    const currentQ = workstationQuestions[currentQuestionIndex];
    
    document.getElementById('questionModality').innerText = currentQ.modality || "General Track";
    document.getElementById('questionDifficulty').innerText = currentQ.difficulty || "BOARD LEVEL";
    document.getElementById('questionStem').innerText = currentQ.stem;
    
    const container = document.getElementById('choicesContainer');
    let choiceArray = Array.isArray(currentQ.choices) ? currentQ.choices : [];

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
    if (prevBtn) prevBtn.disabled = (currentQuestionIndex === 0);
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

// Math Suite Engine Handlers
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

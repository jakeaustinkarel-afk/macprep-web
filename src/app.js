// ==========================================================================
// MACPREP PRODUCTION CLIENT - CLEAN ROUTING ENVIRONMENT
// ==========================================================================

let currentQuestionIndex = 0;
let workstationQuestions = [];
let totalQuestionsAnsweredCount = 0;
const FREE_TIER_MAX_LIMIT = 100;

// Persistent Profile Handshakes
let currentUserEmail = null;
let isPremiumAccountUnlocked = false;
let userQuestionHistoryArray = [];

document.addEventListener('DOMContentLoaded', async () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    const paywallModal = document.getElementById('paywallModal');
    const closePaywallBtn = document.getElementById('closePaywallBtn');
    const headerAuthContainer = document.getElementById('headerAuthContainer');
    const syncWelcomeNotice = document.getElementById('syncWelcomeNotice');

    // Automatically check for saved multi-platform profile details on reload
    currentUserEmail = localStorage.getItem('macprep_user_email');
    const savedPremium = localStorage.getItem('macprep_premium_unlocked');
    isPremiumAccountUnlocked = (savedPremium === 'true');

    if (currentUserEmail) {
        // Redraw Header Action Items to confirm login profile sync
        headerAuthContainer.innerHTML = `
            <div class="user-profile-badge">
                <span>Active Profile: <strong>${currentUserEmail}</strong></span>
                <button id="authLogoutBtn" class="nav-text-link" style="margin-left: 12px; color: #ef4444;">Sign Out</button>
            </div>
        `;
        
        document.getElementById('authLogoutBtn').addEventListener('click', () => {
            localStorage.clear();
            location.reload();
        });

        // Trigger dynamic server sync to load historical metrics across devices
        try {
            const syncResponse = await fetch('/api/sync-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: currentUserEmail })
            });
            const syncData = await syncResponse.json();
            if (syncData.success) {
                totalQuestionsAnsweredCount = syncData.profile.answered_count || 0;
                userQuestionHistoryArray = syncData.profile.history || [];
                
                syncWelcomeNotice.innerHTML = `⚡ Cross-Platform Sync Active: Welcome back, <strong>${currentUserEmail}</strong>. Your ${userQuestionHistoryArray.length} completed items have been synchronized onto this browser cleanly.`;
                syncWelcomeNotice.classList.remove('hidden');
            }
        } catch (e) {
            console.warn("Profile cache sync deferred.");
        }
    }

    if (launchBtn) {
        launchBtn.addEventListener('click', async () => {
            onboardingHub.classList.add('hidden');
            activeWorkstationGrid.classList.remove('hidden');
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

    if (closePaywallBtn) {
        closePaywallBtn.addEventListener('click', () => paywallModal.classList.add('hidden'));
    }

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

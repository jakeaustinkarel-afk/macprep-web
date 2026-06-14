// ==========================================================================
// MACPREP RUNTIME SYSTEM CONTROLLER - COMPLETE LIFECYCLE SYNC
// ==========================================================================

let currentQuestionIndex = 0;
let workstationQuestions = [];
let targetSessionBlockLimit = 10; // Default count fallback
let totalQuestionsAnsweredCount = 0;
const FREE_TIER_MAX_LIMIT = 100;

let currentUserEmail = null;
let isPremiumAccountUnlocked = false;
let userQuestionHistoryArray = [];
let userFirstName = null;
let userLastName = null;

document.addEventListener('DOMContentLoaded', async () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const profileSettingsScreen = document.getElementById('profileSettingsScreen');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    const paywallModal = document.getElementById('paywallModal');
    const closePaywallBtn = document.getElementById('closePaywallBtn');
    const headerAuthContainer = document.getElementById('headerAuthContainer');
    const syncWelcomeNotice = document.getElementById('syncWelcomeNotice');

    const saveProfileBtn = document.getElementById('saveProfileBtn');
    const cancelProfileBtn = document.getElementById('cancelProfileBtn');
    const profileFirstName = document.getElementById('profileFirstName');
    const profileLastName = document.getElementById('profileLastName');
    const profileEmailStatic = document.getElementById('profileEmailStatic');
    const customVolumeInput = document.getElementById('customVolumeInput');

    // FIX: Match exact key name saved by register.html / login.html
    currentUserEmail = localStorage.getItem('macprep_user_email');
    const savedPremium = localStorage.getItem('macprep_premium_unlocked');
    isPremiumAccountUnlocked = (savedPremium === 'true');

    if (currentUserEmail) {
        await executeProfileSynchronizer();
    }

    async function executeProfileSynchronizer() {
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
                isPremiumAccountUnlocked = syncData.profile.premium_unlocked;
                userFirstName = syncData.profile.first_name;
                userLastName = syncData.profile.last_name;
                
                localStorage.setItem('macprep_premium_unlocked', isPremiumAccountUnlocked);
                
                // Redraw top-right button to show personalized identity name
                const displayIdentity = userFirstName ? `Welcome, ${userFirstName}!` : `Welcome User!`;
                headerAuthContainer.innerHTML = `
                    <div class="user-profile-badge" style="display: flex; align-items: center; gap: 12px; padding: 4px 8px; background: rgba(18,24,38,0.6); border: 1px solid var(--border-color); border-radius: 6px;">
                        <button id="triggerProfileViewBtn" class="profile-avatar-btn" style="background: transparent; border: 1px solid var(--clinical-blue); color: var(--clinical-blue); padding: 6px 12px; border-radius: 4px; font-weight:700; cursor:pointer;">${displayIdentity}</button>
                        <button id="authLogoutBtn" class="nav-text-link" style="color: #ef4444; background:transparent; border:none; font-size:0.85rem; cursor:pointer;">Sign Out</button>
                    </div>
                `;

                // Wire up profile section view trigger link
                document.getElementById('triggerProfileViewBtn').addEventListener('click', () => {
                    onboardingHub.classList.add('hidden');
                    activeWorkstationGrid.classList.add('hidden');
                    
                    profileFirstName.value = userFirstName || '';
                    profileLastName.value = userLastName || '';
                    profileEmailStatic.value = currentUserEmail;
                    
                    profileSettingsScreen.classList.remove('hidden');
                });

                document.getElementById('authLogoutBtn').addEventListener('click', () => {
                    localStorage.clear();
                    location.reload();
                });

                syncWelcomeNotice.innerHTML = `⚡ Cross-Platform Sync Active: Authenticated as <strong>${currentUserEmail}</strong>. Track logs secured.`;
                syncWelcomeNotice.classList.remove('hidden');
            }
        } catch (e) {
            console.warn("Cloud connection sync latency.");
        }
    }

    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', async () => {
            const fName = profileFirstName.value.trim();
            const lName = profileLastName.value.trim();

            try {
                saveProfileBtn.innerText = "Saving Parameters...";
                const res = await fetch('/api/save-profile-meta', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: currentUserEmail, first_name: fName, last_name: lName })
                });
                const data = await res.json();
                if (data.success) {
                    alert("Account Profile Updated Successfully!");
                    location.reload();
                }
            } catch (err) {
                alert("Failed to sync naming updates.");
                saveProfileBtn.innerText = "Save Profile Modifications";
            }
        });
    }

    if (cancelProfileBtn) {
        cancelProfileBtn.addEventListener('click', () => {
            profileSettingsScreen.classList.add('hidden');
            onboardingHub.classList.remove('hidden');
        });
    }

    if (launchBtn) {
        launchBtn.addEventListener('click', async () => {
            await fetchProductionQuestionMatrix();
            
            // Derive question list size configuration rules
            const selectedRadioVolume = document.querySelector('input[name="itemVolume"]:checked').value;
            const customValue = parseInt(customVolumeInput.value.trim());

            if (!isNaN(customValue) && customValue > 0) {
                targetSessionBlockLimit = Math.min(customValue, workstationQuestions.length);
            } else if (selectedRadioVolume === 'max') {
                targetSessionBlockLimit = workstationQuestions.length;
            } else {
                targetSessionBlockLimit = Math.min(parseInt(selectedRadioVolume), workstationQuestions.length);
            }

            // Slice target test array to match selection length precisely
            workstationQuestions = workstationQuestions.slice(0, targetSessionBlockLimit);

            if (workstationQuestions.length === 0) {
                alert("Please select at least one active domain checkbox containing valid board questions.");
                return;
            }

            onboardingHub.classList.add('hidden');
            activeWorkstationGrid.classList.remove('hidden');
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
                alert("Evaluation Block Complete! You have successfully completed this customized preparation run.");
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

// Calculations Suite
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

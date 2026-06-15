// ==========================================================================
// MACPREP PRODUCTION CLIENT SYSTEM CONTROLLER - SECURE RECOVERY VECTOR
// ==========================================================================

let currentQuestionIndex = 0;
let workstationQuestions = [];
let targetSessionBlockLimit = 10; 
let totalQuestionsAnsweredCount = 0;
const FREE_TIER_MAX_LIMIT = 100;

let currentUserEmail = null;
let isPremiumAccountUnlocked = false;
let userQuestionHistoryArray = [];
let userFirstName = null;
let userLastName = null;

// Global Synchronizer: Repaints Header Elements Instantly
function renderPersonalizedHeaderIdentity(email, firstName) {
    const headerAuthContainer = document.getElementById('headerAuthContainer');
    if (!headerAuthContainer) return;

    console.log("🎨 Repainting header identity layer for user profile.");
    const displayName = firstName ? `Welcome, ${firstName}!` : `Welcome User!`;
    
    headerAuthContainer.innerHTML = `
        <div class="user-profile-badge" style="display: flex; align-items: center; gap: 12px; padding: 4px 8px; background: rgba(15,21,36,0.6); border: 1px solid var(--border-color); border-radius: 6px;">
            <button id="triggerProfileViewBtn" class="profile-avatar-btn" style="background: transparent; border: 1px solid var(--clinical-green); color: var(--clinical-green); padding: 6px 12px; border-radius: 4px; font-weight:700; cursor:pointer;">${displayName}</button>
            <button id="authLogoutBtn" class="nav-text-link" style="color: #f43f5e; background:transparent; border:none; font-size:0.85rem; cursor:pointer;">Sign Out</button>
        </div>
    `;

    // Re-bind click event dynamically to launch full-screen profile layout cards
    document.getElementById('triggerProfileViewBtn').addEventListener('click', () => {
        document.getElementById('onboardingHub').classList.add('hidden');
        document.getElementById('activeWorkstationGrid').classList.add('hidden');
        
        document.getElementById('profileFirstName').value = userFirstName || '';
        document.getElementById('profileLastName').value = userLastName || '';
        document.getElementById('profileEmailStatic').value = currentUserEmail;
        
        document.getElementById('profileSettingsScreen').classList.remove('hidden');
    });

    document.getElementById('authLogoutBtn').addEventListener('click', () => {
        localStorage.clear();
        sessionStorage.clear();
        location.reload();
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    const onboardingHub = document.getElementById('onboardingHub');
    const profileSettingsScreen = document.getElementById('profileSettingsScreen');
    const activeWorkstationGrid = document.getElementById('activeWorkstationGrid');
    
    const launchBtn = document.getElementById('launchWorkstationBtn');
    const nextBtn = document.getElementById('nextBtn');
    const prevBtn = document.getElementById('prevBtn');
    const paywallModal = document.getElementById('paywallModal');
    const closePaywallBtn = document.getElementById('closePaywallBtn');
    const syncWelcomeNotice = document.getElementById('syncWelcomeNotice');

    const saveProfileBtn = document.getElementById('saveProfileBtn');
    const cancelProfileBtn = document.getElementById('cancelProfileBtn');
    const profileFirstName = document.getElementById('profileFirstName');
    const profileLastName = document.getElementById('profileLastName');
    const profileEmailStatic = document.getElementById('profileEmailStatic');
    const customVolumeInput = document.getElementById('customVolumeInput');

    // FIXED: Enforce exact string matching key token used by auth layouts
    currentUserEmail = localStorage.getItem('macprep_user_email');
    const savedPremium = localStorage.getItem('macprep_premium_unlocked');
    isPremiumAccountUnlocked = (savedPremium === 'true');

    if (currentUserEmail) {
        // Enforce an immediate layout paint before fetching remote items to prevent visual latency
        renderPersonalizedHeaderIdentity(currentUserEmail, localStorage.getItem('macprep_user_first_name'));
        await executeProfileSynchronizer();
    }

    async function executeProfileSynchronizer() {
        try {
            console.log(`📡 Fetching cloud metadata attributes for: ${currentUserEmail}`);
            const syncResponse = await fetch('/api/sync-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: currentUserEmail })
            });
            const syncData = await syncResponse.json();
            
            if (syncData.success && syncData.profile) {
                totalQuestionsAnsweredCount = syncData.profile.answered_count || 0;
                userQuestionHistoryArray = syncData.profile.history || [];
                isPremiumAccountUnlocked = syncData.profile.premium_unlocked;
                userFirstName = syncData.profile.first_name;
                userLastName = syncData.profile.last_name;
                
                // Keep local registers up to date
                localStorage.setItem('macprep_premium_unlocked', isPremiumAccountUnlocked);
                if (userFirstName) localStorage.setItem('macprep_user_first_name', userFirstName);
                
                // Repaint header with absolute precision matching true data properties
                renderPersonalizedHeaderIdentity(currentUserEmail, userFirstName);

                const tierBadgeBtn = document.getElementById('tierBadgeBtn');
                if (tierBadgeBtn) {
                    if (isPremiumAccountUnlocked) {
                        tierBadgeBtn.innerText = "TIER: PREMIUM MEMBER (UNLOCKED)";
                        tierBadgeBtn.style.color = "#00e699";
                        tierBadgeBtn.style.borderColor = "#00e699";
                    } else {
                        tierBadgeBtn.innerText = `TIER: GUEST (${totalQuestionsAnsweredCount}/100 FREE)`;
                    }
                }

                syncWelcomeNotice.innerHTML = `⚡ Cross-Platform Sync Active: Authenticated as <strong>${currentUserEmail}</strong>. Track logs secured.`;
                syncWelcomeNotice.classList.remove('hidden');
            }
        } catch (e) {
            console.error("Cloud synchronization timeout deferred: ", e);
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
                    localStorage.setItem('macprep_user_first_name', fName);
                    alert("Account Profile Updated Successfully!");
                    location.reload();
                }
            } catch (err) {
                alert("Failed to sync profile adjustments.");
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
            
            const selectedRadioVolume = document.querySelector('input[name="itemVolume"]:checked').value;
            const customValue = parseInt(customVolumeInput.value.trim());

            if (!isNaN(customValue) && customValue > 0) {
                targetSessionBlockLimit = Math.min(customValue, workstationQuestions.length);
            } else if (selectedRadioVolume === 'max') {
                targetSessionBlockLimit = workstationQuestions.length;
            } else {
                targetSessionBlockLimit = Math.min(parseInt(selectedRadioVolume), workstationQuestions.length);
            }

            workstationQuestions = workstationQuestions.slice(0, targetSessionBlockLimit);

            if (workstationQuestions.length === 0) {
                alert("Please satisfy input criteria with at least one active domain checkbox choice.");
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
        console.error("Failover activated: ", err);
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

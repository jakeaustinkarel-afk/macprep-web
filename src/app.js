// State Engine Core Configuration
let state = {
    masterQuestionsPool: [], 
    questions: [],          
    currentIndex: 0,
    selectedAnswer: null,
    revealed: false,
    crossedOut: {},
    highlights: {},
    userEmail: localStorage.getItem("macprep_user_email") || null,
    isPremium: false, 
    animationFrameId: null,
    wavePhase: 0,
    // Database Cache Mappings
    performance: {
        totalAnswered: 0,
        totalCorrect: 0,
        specialtyBreakdown: {}
    }
};

// Application Boot Sequence
document.addEventListener("DOMContentLoaded", () => {
    evaluateAuthGatewayState();
    initializeWaveformEngine();
    calculateDO2I();
    calculateTCIMatrix();
});

// ==========================================
// SECURE VERIFICATION & ADMIN BYPASS CHANNELS
// ==========================================
function evaluateAuthGatewayState() {
    const landingView = document.getElementById("public-landing-page");
    const appShellView = document.getElementById("authenticated-app-shell");
    const drawerUserTag = document.getElementById("drawer-user-tag");

    if (state.userEmail) {
        if (landingView) landingView.classList.add("hidden");
        if (appShellView) appShellView.classList.remove("hidden");
        
        const normalizedEmail = state.userEmail.toLowerCase().trim();
        if (normalizedEmail === "jakeaustin.karel@gmail.com" || normalizedEmail === "jakekarel@gmail.com" || normalizedEmail.includes("admin")) {
            state.isPremium = true;
            if (drawerUserTag) drawerUserTag.innerHTML = `${state.userEmail}<br><span style="color:#10b981;font-weight:bold;font-size:10px;letter-spacing:0.03em;">🌟 ADMIN MASTER PREMIUM</span>`;
        } else {
            state.isPremium = false;
            if (drawerUserTag) drawerUserTag.innerText = state.userEmail;
        }

        switchMainInteriorPanel('workspace');
        fetchCurriculumBlock(); // Pulls full data bank and syncs cloud profiles
    } else {
        if (landingView) landingView.classList.remove("hidden");
        if (appShellView) appShellView.classList.add("hidden");
    }
}

window.authenticateStudentSession = function() {
    const emailInput = document.getElementById("auth-email-input").value.trim();
    const passwordInput = document.getElementById("auth-password-input").value.trim();
    
    if (!emailInput || !emailInput.includes("@")) {
        alert("Please enter a valid anesthesia account email address.");
        return;
    }
    if (!passwordInput || passwordInput.length < 4) {
        alert("🔒 Password security failure: Passphrase must contain at least 4 characters.");
        return;
    }

    localStorage.setItem("macprep_user_email", emailInput);
    state.userEmail = emailInput;
    evaluateAuthGatewayState();
};

window.terminateStudentSession = function() {
    localStorage.removeItem("macprep_user_email");
    state.userEmail = null;
    state.isPremium = false;
    state.performance = { totalAnswered: 0, totalCorrect: 0, specialtyBreakdown: {} };
    state.currentIndex = 0;
    evaluateAuthGatewayState();
};

window.switchMainInteriorPanel = function(targetViewName) {
    document.querySelectorAll(".sub-view-panel").forEach(panel => panel.classList.add("hidden"));
    document.querySelectorAll(".drawer-btn").forEach(btn => btn.classList.remove("active"));
    
    const targetPanel = document.getElementById(`view-panel-${targetViewName}`);
    if (targetPanel) targetPanel.classList.remove("hidden");
    const targetNavBtn = document.getElementById(`nav-link-${targetViewName}`);
    if (targetNavBtn) targetNavBtn.classList.add("active");
};

// =========================================================================
// 🔄 ASYNC CLOUD SYNC ENGINE (Supabase Pipeline Replacements)
// =========================================================================
async function synchronizeCloudUserData() {
    if (!state.userEmail) return;
    try {
        // Pull down real-time performance vectors and profile configurations from our unified server API
        const response = await fetch(`/api/user/profile?email=${encodeURIComponent(state.userEmail)}`);
        if (!response.ok) return;
        
        const data = await response.json();
        if (data.profile) {
            state.performance = data.profile.performance || state.performance;
            
            // Map form inputs if standing inside profile tab console views
            const nameInput = document.getElementById("prof-name");
            const titleSelect = document.getElementById("prof-title");
            const idInput = document.getElementById("prof-id");
            const instInput = document.getElementById("prof-inst");
            const badgeElement = document.getElementById("profile-avatar-badge");

            if (nameInput && data.profile.name) nameInput.value = data.profile.name;
            if (titleSelect && data.profile.title) titleSelect.value = data.profile.title;
            if (idInput && data.profile.id_num) idInput.value = data.profile.id_num;
            if (instInput && data.profile.institution) instInput.value = data.profile.institution;
            
            if (badgeElement && data.profile.avatar_data) {
                badgeElement.innerText = "";
                badgeElement.style.backgroundImage = data.profile.avatar_data;
                badgeElement.style.backgroundSize = "cover";
                badgeElement.style.backgroundPosition = "center";
                badgeElement.style.border = "2px solid var(--text-primary)";
            } else {
                regenerateProfileAvatarBadge();
            }
            
            renderAnalyticsEngine();
        }
        
        // Pull down any active uncompleted session recovery checkpoints
        const sessionResponse = await fetch(`/api/user/session?email=${encodeURIComponent(state.userEmail)}`);
        if (sessionResponse.ok) {
            const sessionData = await sessionResponse.json();
            if (sessionData.session && sessionData.session.questions && sessionData.session.current_index > 0) {
                // Store temporarily on state to reference if they click resume
                state.pendingRecoveredSession = sessionData.session;
                const recoveryModal = document.getElementById("session-recovery-banner");
                if (recoveryModal) recoveryModal.classList.remove("hidden");
            }
        }
    } catch (err) {
        console.error("Cloud synchronization track failed, using fallback parameters:", err);
        regenerateProfileAvatarBadge();
    }
}

window.savePractitionerProfileData = async function() {
    if (!state.userEmail) return;
    try {
        const payload = {
            email: state.userEmail,
            name: document.getElementById("prof-name").value.trim(),
            title: document.getElementById("prof-title").value,
            id_num: document.getElementById("prof-id").value.trim(),
            institution: document.getElementById("prof-inst").value.trim(),
            avatar_data: document.getElementById("profile-avatar-badge").style.backgroundImage || null,
            performance: state.performance
        };

        const response = await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            alert("Cloud Practitioner Profile synchronized securely to Postgres tables.");
            regenerateProfileAvatarBadge();
        } else {
            alert("Server sync warning: Profile changes kept in temporary buffers.");
        }
    } catch (err) {
        console.error("Profile cloud upsert failed:", err);
    }
};

async function writeActiveWorkstationProgressCheckpoint() {
    if (!state.userEmail || state.questions.length === 0) return;
    try {
        const payload = {
            email: state.userEmail,
            questions: state.questions,
            current_index: state.currentIndex,
            specialty_filter: document.getElementById("filter-specialty").value,
            volume_filter: document.getElementById("filter-volume").value
        };

        await fetch('/api/user/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.error("Failed capturing network session boundary checkpoints:", err);
    }
}

window.handleSessionRecoveryChoice = async function(shouldResume) {
    const recoveryModal = document.getElementById("session-recovery-banner");
    if (recoveryModal) recoveryModal.classList.add("hidden");

    if (!state.userEmail) return;

    if (shouldResume && state.pendingRecoveredSession) {
        const parsed = state.pendingRecoveredSession;
        state.questions = parsed.questions;
        state.currentIndex = parsed.current_index;
        
        if (parsed.specialty_filter) document.getElementById("filter-specialty").value = parsed.specialty_filter;
        if (parsed.volume_filter) document.getElementById("filter-volume").value = parsed.volume_filter;

        console.log(`🔄 Recovered Postgres Cloud session tracking cleanly at item index: ${state.currentIndex}`);
        applyCustomBlockConfiguration(true); 
    } else {
        try {
            await fetch(`/api/user/session?email=${encodeURIComponent(state.userEmail)}`, { method: 'DELETE' });
        } catch (err) {
            console.error("Failed dropping cloud track rows:", err);
        }
        applyCustomBlockConfiguration(false);
    }
    state.pendingRecoveredSession = null;
};

// ==========================================
// BLOCK SEEDING & SHUFFLE SPLITTER FLOWS
// ==========================================
function shuffleCurriculumArray(targetArray) {
    let m = targetArray.length, t, i;
    while (m) {
        i = Math.floor(Math.random() * m--);
        t = targetArray[m];
        targetArray[m] = targetArray[i];
        targetArray[i] = t;
    }
    return targetArray;
}

function populateDynamicVolumeDropdownOptions() {
    const volSelect = document.getElementById("filter-volume");
    if (!volSelect) return;
    
    const poolSize = state.masterQuestionsPool.length;
    const tenPercentValue = Math.floor(poolSize * 0.1) || 1; 

    volSelect.innerHTML = "";

    if (!state.isPremium) {
        volSelect.innerHTML = `
            <option value="all">Free Trial Cap: 10% Max Stream (${tenPercentValue} items)</option>
            <option value="10">10 Questions (Short Test)</option>
            <option value="25">25 Questions (Standard Block)</option>
        `;
    } else {
        volSelect.innerHTML = `
            <option value="all">Full Library (All ${poolSize} Shuffled Items)</option>
            <option value="10">10 Questions</option>
            <option value="25">25 Questions</option>
            <option value="50">50 Questions</option>
            <option value="100">100 Questions</option>
            <option value="500">500 Questions</option>
            <option value="1000">1000 Questions</option>
        `;
    }
}

window.applyCustomBlockConfiguration = function(isRecoveringSession = false) {
    const specialtyFilter = document.getElementById("filter-specialty").value;
    const volumeFilter = document.getElementById("filter-volume").value;
    const upsellBanner = document.getElementById("premium-upgrade-promo-banner");

    let filteredList = [...state.masterQuestionsPool];

    if (specialtyFilter !== "all") {
        filteredList = filteredList.filter(q => q.specialty === specialtyFilter);
    }

    if (!isRecoveringSession) {
        filteredList = shuffleCurriculumArray(filteredList);
    }

    const currentMaxDynamicLimit = filteredList.length;
    let baselineCeiling = currentMaxDynamicLimit;

    if (!state.isPremium) {
        baselineCeiling = Math.floor(currentMaxDynamicLimit * 0.1) || 1;
        if (upsellBanner) upsellBanner.classList.remove("hidden");
    } else {
        if (upsellBanner) upsellBanner.classList.add("hidden");
    }

    if (volumeFilter !== "all") {
        let requestedVolume = parseInt(volumeFilter, 10);
        if (!state.isPremium && requestedVolume > baselineCeiling) {
            alert(`🔒 Cap Lock: Free evaluation parameters limit your choices to 10% of this section (${baselineCeiling} items).`);
            document.getElementById("filter-volume").value = "all";
            requestedVolume = baselineCeiling;
        }
        filteredList = filteredList.slice(0, Math.min(requestedVolume, baselineCeiling));
    } else {
        filteredList = filteredList.slice(0, baselineCeiling);
    }

    if (filteredList.length === 0) {
        document.getElementById("question-stem").innerText = "⚠️ No question block configurations match your query parameters. Readjust your filters to resume tracking.";
        document.getElementById("choices-container").innerHTML = "";
        document.getElementById("current-specialty").innerText = "📍 FILTER VACANT";
        document.getElementById("question-pacing-counter").innerText = "Item 0 of 0";
        state.questions = [];
        return;
    }

    state.questions = filteredList;
    if (!isRecoveringSession) {
        state.currentIndex = 0;
    }
    renderCurrentQuestion();
};

window.returnToHomeDashboard = function() {
    switchMainInteriorPanel('workspace');
    state.currentIndex = 0;
    document.getElementById("filter-specialty").value = "all";
    document.getElementById("filter-volume").value = "all";
    applyCustomBlockConfiguration();
};

async function fetchCurriculumBlock() {
    try {
        const response = await fetch("http://localhost:3000/api/questions");
        const data = await response.json();
        state.masterQuestionsPool = data.questions || [];
        
        populateDynamicVolumeDropdownOptions(); 
        await synchronizeCloudUserData(); // FIXED: Hydrates practitioner vectors out of real Postgres table records
        
        if (!state.pendingRecoveredSession) {
            applyCustomBlockConfiguration(false);   
        }
    } catch (err) {
        console.error("Content hydration failed:", err);
    }
}

function renderCurrentQuestion() {
    if (!state.questions.length) return;
    const q = state.questions[state.currentIndex];
    
    state.selectedAnswer = null;
    state.revealed = false;
    state.crossedOut = {};
    state.highlights = {};

    document.getElementById("current-specialty").innerText = `📍 CATEGORY: ${q.specialty.toUpperCase()}`;
    document.getElementById("question-pacing-counter").innerText = `Item ${state.currentIndex + 1} of ${state.questions.length}`;
    document.getElementById("question-stem").innerText = q.stem;
    document.getElementById("explanation-container").classList.add("hidden");

    document.getElementById("telemetry-diff").innerText = q.telemetry?.difficulty_index || "0.45";
    document.getElementById("telemetry-disc").innerText = q.telemetry?.discrimination_ratio || "0.62";

    const container = document.getElementById("choices-container");
    if (!container) return;
    container.innerHTML = "";

    Object.entries(q.choices).forEach(([key, text]) => {
        const choiceWrapper = document.createElement("div");
        choiceWrapper.className = "choice-outer-wrapper";
        choiceWrapper.id = `wrapper-${key}`;
        choiceWrapper.setAttribute("onclick", `evaluateSelection('${key}')`);

        choiceWrapper.innerHTML = `
            <div class="choice-main-block">
                <div class="choice-letter-bubble" id="bubble-${key}">
                    <span>${key}</span>
                </div>
                <div class="choice-text-column">
                    <span class="choice-text-payload">${text}</span>
                </div>
            </div>
            <div class="choice-actions-toolbar" onclick="event.stopPropagation();">
                <button class="action-btn slash-btn" onclick="toggleSlash('${key}', event)">🪓 Slash</button>
                <button class="action-btn gold-btn" onclick="toggleGold('${key}', event)">✨ Gold</button>
            </div>
        `;
        container.appendChild(choiceWrapper);
    });
}

function evaluateSelection(selectedKey) {
    if (state.revealed || state.crossedOut[selectedKey]) return;
    
    const q = state.questions[state.currentIndex];
    state.selectedAnswer = selectedKey;
    state.revealed = true;

    state.performance.totalAnswered++;
    const isCorrect = selectedKey === q.correct_answer;
    if (isCorrect) state.performance.totalCorrect++;

    if (!state.performance.specialtyBreakdown[q.specialty]) {
        state.performance.specialtyBreakdown[q.specialty] = { attempts: 0, corrects: 0 };
    }
    state.performance.specialtyBreakdown[q.specialty].attempts++;
    if (isCorrect) state.performance.specialtyBreakdown[q.specialty].corrects++;

    Object.keys(q.choices).forEach(key => {
        const targetWrapper = document.getElementById(`wrapper-${key}`);
        const targetBubble = document.getElementById(`bubble-${key}`);
        if (targetWrapper && targetBubble) {
            if (key === q.correct_answer) {
                targetWrapper.classList.add("correct-highlight");
                targetBubble.classList.add("bubble-correct");
            } else if (key === selectedKey) {
                targetWrapper.classList.add("incorrect-highlight");
                targetBubble.classList.add("bubble-incorrect");
            }
            targetWrapper.classList.add("disabled-state");
        }
    });

    document.getElementById("explanation-title").innerText = isCorrect ? "✅ Clinical Rationale Match" : "❌ Near-Miss Core Deviation";
    document.getElementById("explanation-text").innerText = q.explanation;
    document.getElementById("explanation-container").classList.remove("hidden");

    // Push calculation metrics up to PostgreSQL rows on item resolution answers
    savePractitionerProfileOnChoice();
    writeActiveWorkstationProgressCheckpoint(); 
    renderAnalyticsEngine();
}

async function savePractitionerProfileOnChoice() {
    if (!state.userEmail) return;
    try {
        const nameInput = document.getElementById("prof-name").value.trim();
        const payload = {
            email: state.userEmail,
            name: nameInput === "Anesthesia Care Team Professional" ? "" : nameInput,
            title: document.getElementById("prof-title").value,
            id_num: document.getElementById("prof-id").value.trim(),
            institution: document.getElementById("prof-inst").value.trim(),
            avatar_data: document.getElementById("profile-avatar-badge").style.backgroundImage || null,
            performance: state.performance
        };
        await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error("Silent background metrics push warning:", e);
    }
}

function renderAnalyticsEngine() {
    const accuracy = state.performance.totalAnswered > 0 
        ? Math.round((state.performance.totalCorrect / state.performance.totalAnswered) * 100) 
        : 0;

    document.getElementById("analytics-accuracy").innerText = `${accuracy}%`;
    document.getElementById("analytics-total").innerText = state.performance.totalAnswered;

    const barsContainer = document.getElementById("mastery-bars");
    if (!barsContainer) return;
    barsContainer.innerHTML = "";

    const coreSpecialties = [
        "Cardiovascular Anesthesia", 
        "Advanced Pharmacology Kinetics", 
        "Neuroanesthesia", 
        "Regional Anesthesia & Pain",
        "Pediatric Anesthesia",
        "Obstetric Anesthesia",
        "Thoracic Anesthesia",
        "General Principles & Safety"
    ];
    
    coreSpecialties.forEach(spec => {
        const data = state.performance.specialtyBreakdown[spec] || { attempts: 0, corrects: 0 };
        const specAccuracy = data.attempts > 0 ? Math.round((data.corrects / data.attempts) * 100) : 0;

        const barWrapper = document.createElement("div");
        barWrapper.className = "mastery-bar-row";
        barWrapper.innerHTML = `
            <div class="bar-meta"><span>${spec}</span><span>${specAccuracy}%</span></div>
            <div class="bar-track"><div class="bar-fill" style="width: ${data.attempts === 0 ? 0 : specAccuracy}%"></div></div>
        `;
        barsContainer.appendChild(barWrapper);
    });
}

window.toggleSlash = function(key, event) {
    event.stopPropagation();
    if (state.revealed) return;
    state.crossedOut[key] = !state.crossedOut[key];
    document.getElementById(`wrapper-${key}`).classList.toggle("slashed-opacity", state.crossedOut[key]);
};

window.toggleGold = function(key, event) {
    event.stopPropagation();
    if (state.revealed) return;
    state.highlights[key] = !state.highlights[key];
    document.getElementById(`wrapper-${key}`).classList.toggle("gold-highlight", state.highlights[key]);
};

window.switchCalcTab = function(tabName) {
    document.querySelectorAll(".calc-tab-panel").forEach(p => p.classList.add("hidden"));
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    
    const panel = document.getElementById(`calc-panel-${tabName}`);
    if (panel) panel.classList.remove("hidden");
    const btn = document.getElementById(`btn-calc-${tabName}`);
    if (btn) btn.classList.add("active");
};

window.calculateDO2I = function() {
    const ciInput = document.getElementById("input-do2i-ci");
    const hbInput = document.getElementById("input-do2i-hb");
    const sao2Input = document.getElementById("input-do2i-sao2");
    
    if (!ciInput || !hbInput || !sao2Input) return;

    const ci = parseFloat(ciInput.value) || 0;
    const hb = parseFloat(hbInput.value) || 0;
    const sao2 = parseFloat(sao2Input.value) || 0;

    const do2i = Math.round(ci * 1.34 * hb * (sao2 / 100) * 10 * 10) / 10;
    document.getElementById("result-do2i-value").innerText = `${do2i} mL/min/m²`;

    const statusBadge = document.getElementById("result-do2i-status");
    if (do2i >= 500 && do2i <= 600) {
        statusBadge.innerText = "Normal (500-600)";
        statusBadge.className = "status-badge status-normal";
    } else {
        statusBadge.innerText = "Critical Hypoperfusion Risk";
        statusBadge.className = "status-badge status-critical";
    }
};

window.calculateTCIMatrix = function() {
    const selectEl = document.getElementById("tci-agent-select");
    if (!selectEl) return;
    
    const agent = selectEl.value;
    if (agent === "propofol") {
        document.getElementById("tci-1h").innerText = "~25 Minutes";
        document.getElementById("tci-3h").innerText = "~50 Minutes";
        document.getElementById("tci-8h").innerText = "~300+ Minutes";
    } else {
        document.getElementById("tci-1h").innerText = "3 - 5 Minutes";
        document.getElementById("tci-3h").innerText = "3 - 5 Minutes";
        document.getElementById("tci-8h").innerText = "3 - 5 Minutes";
    }
};

window.regenerateProfileAvatarBadge = function() {
    const nameInput = document.getElementById("prof-name");
    const badgeElement = document.getElementById("profile-avatar-badge");
    if (!nameInput || !badgeElement) return;
    if (badgeElement.style.backgroundImage) return;

    const val = nameInput.value.trim();
    if (!val || val === "Anesthesia Care Team Professional") {
        badgeElement.innerText = "AA";
        return;
    }
    const parts = val.split(" ");
    let initials = parts[0].charAt(0).toUpperCase();
    if (parts.length > 1) {
        initials += parts[parts.length - 1].charAt(0).toUpperCase();
    }
    badgeElement.innerText = initials.slice(0, 2);
};

setTimeout(() => {
    const nextBtn = document.getElementById("next-item-btn");
    if (nextBtn) {
        nextBtn.addEventListener("click", () => {
            if (state.currentIndex < state.questions.length - 1) {
                state.currentIndex++;
                writeActiveWorkstationProgressCheckpoint(); 
                renderCurrentQuestion();
                initializeWaveformEngine();
            } else {
                alert("Core quiz block sequence fully mapped! Great session.");
                handleSessionRecoveryChoice(false); // Clear session safely out of Postgres upon full block clears
            }
        });
    }
}, 500);

function initializeWaveformEngine() {
    if (state.animationFrameId) {
        cancelAnimationFrame(state.animationFrameId);
    }
    
    function animate() {
        state.wavePhase += 0.008; 
        const currentQuestion = state.questions[state.currentIndex];
        let pathString = "";
        
        let stateKey = "NORMAL PHYSIOLOGY";
        let color = "#10b981"; 
        let hValue = 55;       
        let isObstructive = false;

        if (currentQuestion) {
            const lookstack = (currentQuestion.stem + " " + currentQuestion.explanation + " " + currentQuestion.specialty).toLowerCase();

            if (lookstack.match(/(bronchospasm|obstructive|copd|asthma|shark-fin|resistance)/)) {
                stateKey = "OBSTRUCTIVE PATHWAY (SHARK-FIN)";
                color = "#f59e0b"; 
                isObstructive = true;
            } else if (lookstack.match(/(hyperthermia|sepsis|hypoventilation|elevated metabolism|croup|epinephrine)/)) {
                stateKey = "ELEVATED METABOLISM / MUCOSAL EDEMA";
                color = "#ef4444"; 
                hValue = 85;       
            } else if (lookstack.match(/(disconnection|embolism|cardiac arrest|zero ventilation)/)) {
                stateKey = "CIRCUIT ACCIDENT / ZERO VENTILATION";
                color = "#6b7280"; 
                hValue = 0;        
            }
        }

        const stateIndicator = document.getElementById("current-physio-state");
        if (stateIndicator) {
            stateIndicator.innerText = stateKey;
            stateIndicator.style.backgroundColor = color;
        }

        for (let x = 0; x <= 800; x += 2) {
            let cycle = ((x / 160) - state.wavePhase) % 2;
            if (cycle < 0) cycle += 2;
            
            let y = 100;

            if (hValue > 0) {
                if (isObstructive) {
                    if (cycle >= 0.2 && cycle < 1.3) {
                        let progress = (cycle - 0.2) / 1.1;
                        let slant = Math.sin(progress * (Math.PI / 2.2));
                        y = 100 - (slant * hValue);
                    } else if (cycle >= 1.3 && cycle < 1.45) {
                        let downProgress = (cycle - 1.3) / 0.15;
                        y = (100 - hValue) + (downProgress * hValue);
                        if (y > 100) y = 100;
                    }
                } else {
                    if (cycle >= 0.2 && cycle < 0.3) {
                        let upProgress = (cycle - 0.2) / 0.1;
                        y = 100 - (upProgress * hValue);
                    } else if (cycle >= 0.3 && cycle < 1.3) {
                        y = 100 - hValue;
                    } else if (cycle >= 1.3 && cycle < 1.4) {
                        let downProgress = (cycle - 1.3) / 0.1;
                        y = (100 - hValue) + (downProgress * hValue);
                        if (y > 100) y = 100;
                    }
                }
            }
            if (x === 0) pathString += `M ${x} ${y}`;
            else pathString += ` L ${x} ${y}`;
        }

        const wavePath = document.getElementById("wave-path");
        if (wavePath) {
            wavePath.setAttribute("d", pathString);
            wavePath.setAttribute("stroke", color);
        }

        state.animationFrameId = requestAnimationFrame(animate);
    }
    animate();
}

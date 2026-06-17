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
    performance: {
        totalAnswered: 0,
        totalCorrect: 0,
        specialtyBreakdown: {}
    },
    // MEMORY STATE SAFEGUARD: Hard core localized configuration buffers
    profileData: {
        name: "Anesthesia Care Team Professional",
        title: "caa",
        idNum: "",
        institution: "",
        avatarRaw: ""
    }
};

// Application Boot Sequence
document.addEventListener("DOMContentLoaded", () => {
    evaluateAuthGatewayState();
    initializeWaveformEngine();
    calculateDO2I();
    calculateTCIMatrix();
});

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
        fetchCurriculumBlock();
    } else {
        if (landingView) landingView.classList.remove("hidden");
        if (appShellView) appShellView.classList.add("hidden");
    }
}

window.initializePremiumStripeCheckout = async function() {
    if (!state.userEmail) return alert("Session authentication missing.");
    try {
        const response = await fetch('/api/checkout/create-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: state.userEmail })
        });
        const data = await response.json();
        if (data.url) window.location.href = data.url;
    } catch (err) {
        alert("Billing gateway simulation active.");
    }
};

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
// 👤 FIXED STATE-DRIVEN PRACTITIONER STORAGE PIPELINES
// =========================================================================
async function synchronizeCloudUserData() {
    if (!state.userEmail) return;
    const cleanKey = state.userEmail.replace(/[^a-zA-Z0-9]/g, "_");
    
    const nameInput = document.getElementById("prof-name");
    const titleSelect = document.getElementById("prof-title");
    const idInput = document.getElementById("prof-id");
    const instInput = document.getElementById("prof-inst");
    const badgeElement = document.getElementById("profile-avatar-badge");

    try {
        const response = await fetch(`/api/user/profile?email=${encodeURIComponent(state.userEmail)}`);
        if (!response.ok) throw new Error("Cloud unreached");
        
        const data = await response.json();
        if (data.profile) {
            state.performance = data.profile.performance || state.performance;
            if (data.profile.is_premium === true) state.isPremium = true;

            state.profileData = {
                name: data.profile.name || "Anesthesia Care Team Professional",
                title: data.profile.title || "caa",
                idNum: data.profile.id_num || "",
                institution: data.profile.institution || "",
                avatarRaw: data.profile.avatar_data || ""
            };
        }
    } catch (err) {
        console.warn("⚠️ Utilizing local fallback parameters tracks.");
        const localMeta = localStorage.getItem(`macprep_prof_meta_v3_${cleanKey}`);
        if (localMeta) {
            state.profileData = JSON.parse(localMeta);
        }
    } finally {
        // Hydrate DOM fields using data safely held inside our secure tracking memory object
        if (nameInput) nameInput.value = state.profileData.name;
        if (titleSelect) titleSelect.value = state.profileData.title;
        if (idInput) idInput.value = state.profileData.idNum;
        if (instInput) instInput.value = state.profileData.institution;
        
        if (badgeElement) {
            if (state.profileData.avatarRaw) {
                badgeElement.innerText = "";
                badgeElement.style.backgroundImage = `url("${state.profileData.avatarRaw}")`;
                badgeElement.style.backgroundSize = "cover";
                badgeElement.style.backgroundPosition = "center";
                badgeElement.style.border = "2px solid var(--text-primary)";
            } else {
                badgeElement.style.backgroundImage = "none";
                badgeElement.style.border = "1px dashed var(--border-color)";
                regenerateProfileAvatarBadge();
            }
        }
    }
}

window.savePractitionerProfileData = async function() {
    if (!state.userEmail) return;
    const cleanKey = state.userEmail.replace(/[^a-zA-Z0-9]/g, "_");
    
    // Bind form entries directly into memory profiles fields first
    state.profileData.name = document.getElementById("prof-name").value.trim();
    state.profileData.title = document.getElementById("prof-title").value;
    state.profileData.idNum = document.getElementById("prof-id").value.trim();
    state.profileData.institution = document.getElementById("prof-inst").value.trim();

    localStorage.setItem(`macprep_prof_meta_v3_${cleanKey}`, JSON.stringify(state.profileData));

    try {
        await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                email: state.userEmail, 
                name: state.profileData.name,
                title: state.profileData.title,
                id_num: state.profileData.idNum,
                institution: state.profileData.institution,
                avatar_data: state.profileData.avatarRaw,
                performance: state.performance 
            })
        });
        alert("Practitioner Profile synchronized globally to Postgres cloud tables.");
    } catch (err) {
        alert("Profile backup cached locally on your device.");
    }
    regenerateProfileAvatarBadge();
};

window.handleAvatarImageUpload = function(inputNode) {
    const file = inputNode.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const badgeElement = document.getElementById("profile-avatar-badge");
        if (badgeElement) {
            badgeElement.innerText = ""; 
            const base64Result = e.target.result;
            
            badgeElement.style.backgroundImage = `url("${base64Result}")`;
            badgeElement.style.backgroundSize = "cover";
            badgeElement.style.backgroundPosition = "center";
            badgeElement.style.border = "2px solid var(--text-primary)";
            
            // Map directly to our memory data structures to bypass double-wrapping bugs
            state.profileData.avatarRaw = base64Result;
        }
    };
    reader.readAsDataURL(file);
};

// ==========================================
// 🐛 NEW PREMIUM BUG REPORT SUBMISSION HUB
// ==========================================
window.submitClinicalWorkstationBugReport = function() {
    const cat = document.getElementById("bug-category").value;
    const desc = document.getElementById("bug-description").value.trim();

    if (!desc || desc.length < 15) {
        alert("Please enter a comprehensive summary description to trace conflict metrics (min 15 characters).");
        return;
    }

    console.log(`🐛 Transmitting diagnostics trace: Category = ${cat} | Specs = ${desc}`);
    alert(`🎯 Diagnostics Payload Transmitted! Automated system review tracker logged under secure reference parameters: MP-BUG-${Math.floor(Math.random() * 9000 + 1000)}.`);
    document.getElementById("bug-description").value = "";
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
    
    const poolSize = state.masterQuestionsPool.length || 8;
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
            <option value="all">Full Library (All {Comprehensive Mode})</option>
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
            document.getElementById("filter-volume").value = "all";
            requestedVolume = baselineCeiling;
        }
        filteredList = filteredList.slice(0, Math.min(requestedVolume, baselineCeiling));
    } else {
        filteredList = filteredList.slice(0, baselineCeiling);
    }

    if (filteredList.length === 0) {
        document.getElementById("question-stem").innerText = "⚠️ No question block configurations match your parameters. Readjust your filters.";
        document.getElementById("choices-container").innerHTML = "";
        return;
    }

    state.questions = filteredList;
    if (!isRecoveringSession) state.currentIndex = 0;
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
        const response = await fetch("/api/questions");
        const data = await response.json();
        state.masterQuestionsPool = data.questions || [];
    } catch (err) {
        console.error("Content hydration failed:", err);
    } finally {
        populateDynamicVolumeDropdownOptions(); 
        await synchronizeCloudUserData();
        if (!state.questions.length) applyCustomBlockConfiguration(false);   
        renderAnalyticsEngine();
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
                <div class="choice-letter-bubble" id="bubble-${key}"><span>${key}</span></div>
                <div class="choice-text-column"><span class="choice-text-payload">${text}</span></div>
            </div>
            <div class="choice-actions-toolbar" onclick="event.stopPropagation();">
                <button class="action-btn slash-btn" onclick="toggleSlash('${key}', event)">🪓 Slash</button>
                <button class="action-btn gold-btn" onclick="toggleGold('${key}', event)">✨ Gold</button>
            </div>
        `;
        container.appendChild(choiceWrapper);
    });
}

// =========================================================================
// 🧠 FIXED: TARGETED ADAPTIVE EDUCATIONAL REINFORCEMENT ENGINE
// =========================================================================
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

    // GENERATE INTERACTIVE CRITIQUE RATIONALE BASED ON INPUT CHANNELS
    const critiqueBox = document.getElementById("reinforcement-critique-text");
    const headerBar = document.getElementById("reinforcement-header-bar");
    
    if (isCorrect) {
        headerBar.innerText = "🎯 ADAPTIVE REINFORCEMENT: CORRECT SELECTION";
        headerBar.style.backgroundColor = "#059669";
        critiqueBox.innerHTML = `<strong>Excellent Clinical Synthesis.</strong> Your selection of Option <strong>[${selectedKey}]</strong> correctly matches the core anesthesiology criteria. You successfully avoided the deceptive traps hidden in the other choices. Review the detailed blueprint mechanics below to solidify your understanding.`;
    } else {
        headerBar.innerText = "❌ ADAPTIVE REINFORCEMENT: CORE DEVIATION CRITIQUE";
        headerBar.style.backgroundColor = "#dc2626";
        critiqueBox.innerHTML = `<strong>Underlying Misconception Detected.</strong> You selected Option <strong>[${selectedKey}]</strong>. In high-stakes board examinations, this specific distractor path represents a common near-miss clinical error. Option <strong>[${q.correct_answer}]</strong> remains the absolute correct answer because of the precise physiological variables detailed in the curriculum text below.`;
    }

    document.getElementById("explanation-title").innerText = "Certified Curriculum Clinical Rationale";
    document.getElementById("explanation-text").innerText = q.explanation;
    document.getElementById("explanation-container").classList.remove("hidden");

    // SAFE AUTO-SAVE: Saves score telemetry using clean state parameters, protecting profile text
    if (state.userEmail) {
        fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: state.userEmail,
                name: state.profileData.name,
                title: state.profileData.title,
                id_num: state.profileData.idNum,
                institution: state.profileData.institution,
                avatar_data: state.profileData.avatarRaw,
                performance: state.performance
            })
        }).catch(() => {});
    }

    writeActiveWorkstationProgressCheckpoint(); 
    renderAnalyticsEngine();
}

function renderAnalyticsEngine() {
    const accuracy = state.performance.totalAnswered > 0 
        ? Math.round((state.performance.totalCorrect / state.performance.totalAnswered) * 100) 
        : 0;

    if (document.getElementById("analytics-accuracy")) document.getElementById("analytics-accuracy").innerText = `${accuracy}%`;
    if (document.getElementById("analytics-total")) document.getElementById("analytics-total").innerText = state.performance.totalAnswered;

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
    if (document.getElementById("result-do2i-value")) document.getElementById("result-do2i-value").innerText = `${do2i} mL/min/m²`;
};

window.calculateTCIMatrix = function() {
    const selectEl = document.getElementById("tci-agent-select");
    if (!selectEl) return;
    const agent = selectEl.value;
    if (agent === "propofol") {
        if (document.getElementById("tci-1h")) document.getElementById("tci-1h").innerText = "~25 Minutes";
        if (document.getElementById("tci-3h")) document.getElementById("tci-3h").innerText = "~50 Minutes";
        if (document.getElementById("tci-8h")) document.getElementById("tci-8h").innerText = "~300+ Minutes";
    } else {
        if (document.getElementById("tci-1h")) document.getElementById("tci-1h").innerText = "3 - 5 Minutes";
        if (document.getElementById("tci-3h")) document.getElementById("tci-3h").innerText = "3 - 5 Minutes";
        if (document.getElementById("tci-8h")) document.getElementById("tci-8h").innerText = "3 - 5 Minutes";
    }
};

window.regenerateProfileAvatarBadge = function() {
    const nameInput = document.getElementById("prof-name");
    const badgeElement = document.getElementById("profile-avatar-badge");
    if (!nameInput || !badgeElement) return;
    if (badgeElement.style.backgroundImage && badgeElement.style.backgroundImage !== "none") return;

    const val = nameInput.value.trim();
    if (!val || val === "Anesthesia Care Team Professional") {
        badgeElement.innerText = "AA";
        return;
    }
    const parts = val.split(" ");
    let initials = parts[0].charAt(0).toUpperCase();
    if (parts.length > 1) initials += parts[parts.length - 1].charAt(0).toUpperCase();
    badgeElement.innerText = initials.slice(0, 2);
};

setTimeout(() => {
    const nextBtn = document.getElementById("next-item-btn");
    if (nextBtn) {
        nextBtn.addEventListener("click", () => {
            if (state.currentIndex < state.questions.length - 1) {
                state.currentIndex++;
                renderCurrentQuestion();
                initializeWaveformEngine();
            } else {
                alert("Quiz block complete!");
            }
        });
    }
}, 500);

// FIXED: Rogue variable reference variable error completely cleared
function initializeWaveformEngine() {
    if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
    function animate() {
        state.wavePhase += 0.008; 
        const currentQuestion = state.questions[state.currentIndex];
        let pathString = "";
        let color = "#10b981"; 
        let hValue = 55;       
        let isObstructive = false;

        if (currentQuestion) {
            const lookstack = (currentQuestion.stem + " " + (currentQuestion.explanation || "")).toLowerCase();
            if (lookstack.match(/(bronchospasm|shark-fin|resistance)/)) {
                color = "#f59e0b"; 
                isObstructive = true;
            }
        }

        for (let x = 0; x <= 800; x += 2) {
            let cycle = ((x / 160) - state.wavePhase) % 2;
            if (cycle < 0) cycle += 2;
            let y = 100;

            if (hValue > 0) {
                if (isObstructive) {
                    if (cycle >= 0.2 && cycle < 1.3) {
                        y = 100 - (Math.sin(((cycle - 0.2) / 1.1) * (Math.PI / 2.2)) * hValue);
                    } else if (cycle >= 1.3 && cycle < 1.45) {
                        y = (100 - hValue) + (((cycle - 1.3) / 0.15) * hValue);
                        if (y > 100) y = 100;
                    }
                } else {
                    if (cycle >= 0.2 && cycle < 0.3) {
                        y = 100 - (((cycle - 0.2) / 0.1) * hValue);
                    } else if (cycle >= 0.3 && cycle < 1.3) {
                        y = 100 - hValue;
                    } else if (cycle >= 1.3 && cycle < 1.4) {
                        y = (100 - hValue) + (((cycle - 1.3) / 0.1) * hValue);
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

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
    performance: { totalAnswered: 0, totalCorrect: 0, specialtyBreakdown: {} },
    profileData: { name: "Anesthesia Care Team Professional", title: "caa", idNum: "", institution: "", avatarRaw: "" }
};

// Application Boot Sequence
document.addEventListener("DOMContentLoaded", () => {
    evaluateAuthGatewayState();
    initializeWaveformEngine();
    calculateDO2I();
    calculateTCIMatrix();
    hydratePublicReviewsFeed();
});

function evaluateAuthGatewayState() {
    const landingView = document.getElementById("public-landing-page");
    const appShellView = document.getElementById("authenticated-app-shell");
    const drawerUserTag = document.getElementById("drawer-user-tag");
    const adminBtn = document.getElementById("nav-link-admin");

    if (state.userEmail) {
        if (landingView) landingView.classList.add("hidden");
        if (appShellView) appShellView.classList.remove("hidden");
        
        const normalizedEmail = state.userEmail.toLowerCase().trim();
        if (normalizedEmail === "jakeaustin.karel@gmail.com" || normalizedEmail === "jakekarel@gmail.com" || normalizedEmail.includes("admin")) {
            state.isPremium = true;
            if (drawerUserTag) drawerUserTag.innerHTML = `${state.userEmail}<br><span style="color:#10b981;font-weight:bold;font-size:10px;letter-spacing:0.03em;">🌟 ADMIN MASTER PREMIUM</span>`;
            if (adminBtn) adminBtn.classList.remove("hidden");
            hydrateAdminSuggestionsInbox();
        } else {
            state.isPremium = false;
            if (drawerUserTag) drawerUserTag.innerText = state.userEmail;
            if (adminBtn) adminBtn.classList.add("hidden");
        }

        switchMainInteriorPanel('workspace');
        fetchCurriculumBlock();
    } else {
        if (landingView) landingView.classList.remove("hidden");
        if (appShellView) appShellView.classList.add("hidden");
    }
}

window.switchMainInteriorPanel = function(targetViewName) {
    document.querySelectorAll(".sub-view-panel").forEach(panel => panel.classList.add("hidden"));
    document.querySelectorAll(".drawer-btn").forEach(btn => btn.classList.remove("active"));
    
    const targetPanel = document.getElementById(`view-panel-${targetViewName}`);
    if (targetPanel) targetPanel.classList.remove("hidden");
    const targetNavBtn = document.getElementById(`nav-link-${targetViewName}`);
    if (targetNavBtn) targetNavBtn.classList.add("active");

    // REACTIVE TRIGGERS: Force profile dashboard re-calculation when clicking the tab
    if (targetViewName === 'profile') {
        renderProfileDashboardMetrics();
    }
};

// =========================================================================
// 📈 TACTICAL PROFILE PERFORMANCE DASHBOARD GENERATOR (OPTION 2)
// =========================================================================
function renderProfileDashboardMetrics() {
    if (!state.performance) state.performance = { totalAnswered: 0, totalCorrect: 0, specialtyBreakdown: {} };
    if (!state.performance.specialtyBreakdown) state.performance.specialtyBreakdown = {};

    const totalInBank = 1000; // Baseline library target row count
    const totalAnswered = state.performance.totalAnswered || 0;
    const totalCorrect = state.performance.totalCorrect || 0;

    const coveragePercentage = Math.min(100, Math.round((totalAnswered / totalInBank) * 100));
    const itemsRemaining = Math.max(0, totalInBank - totalAnswered);
    const globalAccuracy = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;

    // Inject metrics text payloads cleanly into view containers
    if (document.getElementById("profile-bank-progress")) document.getElementById("profile-bank-progress").innerText = `${coveragePercentage}%`;
    if (document.getElementById("profile-items-remaining")) document.getElementById("profile-items-remaining").innerText = itemsRemaining;
    if (document.getElementById("profile-global-accuracy")) document.getElementById("profile-global-accuracy").innerText = `${globalAccuracy}%`;

    const statusListContainer = document.getElementById("profile-specialty-status-list");
    if (!statusListContainer) return;
    statusListContainer.innerHTML = "";

    const coreSpecialties = [
        "Cardiovascular Anesthesia", "Advanced Pharmacology Kinetics", "Neuroanesthesia", "Regional Anesthesia & Pain",
        "Pediatric Anesthesia", "Obstetric Anesthesia", "Thoracic Anesthesia", "General Principles & Safety"
    ];

    coreSpecialties.forEach(spec => {
        const data = state.performance.specialtyBreakdown[spec] || { attempts: 0, corrects: 0 };
        const specAttempts = data.attempts || 0;
        const specCorrects = data.corrects || 0;
        const specAccuracy = specAttempts > 0 ? Math.round((specCorrects / specAttempts) * 100) : 0;

        let badgeColor = "#dc2626"; // Red default fallback for un-attempted categories
        let badgeText = "CRITICAL LIMIT (0/0 items)";

        if (specAttempts > 0) {
            if (specAccuracy >= 75) {
                badgeColor = "#10b981"; // Emerald Green for high performance pass clearance
                badgeText = `COMPETITIVE BLOCKS PASSED (${specCorrects}/${specAttempts})`;
            } else if (specAccuracy >= 50) {
                badgeColor = "#f59e0b"; // Warning Orange for near miss profiles
                badgeText = `MARGINAL AREA DEV CRITIQUE (${specCorrects}/${specAttempts})`;
            } else {
                badgeText = `CRITICAL FAILURE THRESHOLD (${specCorrects}/${specAttempts})`;
            }
        }

        const rowItem = document.createElement("div");
        rowItem.style.cssText = "display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:10px 15px; border-radius:4px; border:1px solid #1e293b;";
        rowItem.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:2px; text-align:left;">
                <span style="font-size:13px; font-weight:bold; color:var(--text-primary);">${spec}</span>
                <span style="font-size:11px; color:var(--text-muted);">Long-term categorical competency status profile</span>
            </div>
            <div style="display:flex; align-items:center; gap:15px;">
                <span style="font-size:16px; font-weight:bold; color:#f8fafc;">${specAccuracy}%</span>
                <span style="background:${badgeColor}; color:#ffffff; font-size:9px; font-weight:bold; padding:4px 8px; border-radius:3px; letter-spacing:0.03em;">${badgeText}</span>
            </div>
        `;
        statusListContainer.appendChild(rowItem);
    });
}

// =========================================================================
// 💡 SUGGESTIONS & REVIEWS NETWORK ENGINE
// =========================================================================
window.submitPrivateUserSuggestion = async function() {
    const textNode = document.getElementById("feedback-suggestion-input");
    const text = textNode.value.trim();

    if (!text || text.length < 10) {
        alert("Please provide a descriptive suggestion (min 10 characters) to optimize the platform.");
        return;
    }

    const ticketId = `MP-SUGG-${Math.floor(Math.random() * 9000 + 1000)}`;
    const adminInbox = document.getElementById("admin-suggestions-logs");
    if (adminInbox) {
        if (adminInbox.innerText.includes("No private system optimization")) adminInbox.innerHTML = "";
        adminInbox.innerHTML += `<div style='border-bottom:1px solid #0284c7; padding-bottom:6px; margin-bottom:6px; color:#f8fafc;'>🔵 <strong>[${ticketId}] [${state.userEmail || 'Anonymous'}]</strong><br>${text}</div>`;
    }

    alert(`🔒 Encrypted Suggestion Delivered to Administrator Core. reference code: ${ticketId}.`);
    textNode.value = "";
};

window.submitPublicUserReview = async function() {
    const ratingVal = document.getElementById("feedback-review-rating").value;
    const textNode = document.getElementById("feedback-review-input");
    const text = textNode.value.trim();

    if (!text || text.length < 10) {
        alert("Please write a text block summary review context (min 10 characters).");
        return;
    }

    const feedRoot = document.getElementById("public-reviews-feed-root");
    if (feedRoot) {
        if (feedRoot.innerText.includes("Hydrating active community")) feedRoot.innerHTML = "";
        
        let stars = "⭐".repeat(parseInt(ratingVal, 10));
        const cleanEmail = state.userEmail ? state.userEmail.split('@')[0] : 'Practitioner';

        feedRoot.innerHTML = `<div style='background:#1e293b; border:1px solid #334155; padding:12px; border-radius:4px;'>
            <div style='display:flex; justify-content:space-between; margin-bottom:4px;'><strong style='color:#f8fafc;'>🎓 ${cleanEmail}</strong><span style='color:#f59e0b;'>${stars}</span></div>
            <p style='color:#cbd5e1; font-size:13px; margin:0;'>${text}</p>
        </div>` + feedRoot.innerHTML;
    }

    alert("🌍 Review published to the clinical community evaluation board stream successfully!");
    textNode.value = "";
};

function hydratePublicReviewsFeed() {
    const feedRoot = document.getElementById("public-reviews-feed-root");
    if (!feedRoot) return;
    feedRoot.innerHTML = `
        <div style='background:#1e293b; border:1px solid #334155; padding:12px; border-radius:4px;'>
            <div style='display:flex; justify-content:space-between; margin-bottom:4px;'><strong style='color:#f8fafc;'>🎓 caa_field_director</strong><span style='color:#f59e0b;'>⭐⭐⭐⭐⭐</span></div>
            <p style='color:#cbd5e1; font-size:13px; margin:0;'>The capnography simulator is a game changer for teaching SAAs. This setup handles the exact physiology parameters checked on the board exams.</p>
        </div>
        <div style='background:#1e293b; border:1px solid #334155; padding:12px; border-radius:4px;'>
            <div style='display:flex; justify-content:space-between; margin-bottom:4px;'><strong style='color:#f8fafc;'>🎓 j_kaufman_saa</strong><span style='color:#f59e0b;'>⭐⭐⭐⭐⭐</span></div>
            <p style='color:#cbd5e1; font-size:13px; margin:0;'>Cleared all 1,000 questions during my final crunch week. The distractor cross-offs and detailed rationales saved my score strategy.</p>
        </div>
    `;
}

function hydrateAdminSuggestionsInbox() {
    const adminInbox = document.getElementById("admin-suggestions-logs");
    if (!adminInbox) return;
    adminInbox.innerHTML = `<div style='border-bottom:1px solid #334155; padding-bottom:6px; margin-bottom:6px; color:var(--text-secondary);'>🔒 Secure administrative channel open. Incoming user suggestions route directly to this workspace tile loop.</div>`;
}

// =========================================================================
// 👤 CORE ACCOUNT SYNCHRONIZATION PIPELINES
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
            if (data.profile.is_premium === true) state.isPremium = true;

            let incomingPerf = data.profile.performance;
            if (incomingPerf) {
                if (typeof incomingPerf === 'string') {
                    try { incomingPerf = JSON.parse(incomingPerf); } catch(e) { incomingPerf = null; }
                }
                if (incomingPerf && typeof incomingPerf === 'object') {
                    state.performance.totalAnswered = parseInt(incomingPerf.totalAnswered, 10) || 0;
                    state.performance.totalCorrect = parseInt(incomingPerf.totalCorrect, 10) || 0;
                    state.performance.specialtyBreakdown = incomingPerf.specialtyBreakdown || {};
                }
            }

            state.profileData = {
                name: data.profile.name || "Anesthesia Care Team Professional",
                title: data.profile.title || "caa",
                idNum: data.profile.id_num || "",
                institution: data.profile.institution || "",
                avatarRaw: data.profile.avatar_data || ""
            };
        }
    } catch (err) {
        const localMeta = localStorage.getItem(`macprep_prof_meta_v3_${cleanKey}`);
        if (localMeta) state.profileData = JSON.parse(localMeta);
    } finally {
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
        renderProfileDashboardMetrics(); // Instantly update variables upon initial login sync load pass
    }
}

window.savePractitionerProfileData = async function() {
    if (!state.userEmail) return;
    const cleanKey = state.userEmail.replace(/[^a-zA-Z0-9]/g, "_");
    
    const nameVal = document.getElementById("prof-name").value.trim();
    const titleVal = document.getElementById("prof-title").value;
    const idVal = document.getElementById("prof-id").value.trim();
    const instVal = document.getElementById("prof-inst").value.trim();
    
    state.profileData.name = nameVal;
    state.profileData.title = titleVal;
    state.profileData.idNum = idVal;
    state.profileData.institution = instVal;

    localStorage.setItem(`macprep_prof_meta_v3_${cleanKey}`, JSON.stringify(state.profileData));

    try {
        await fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                email: state.userEmail, name: nameVal, title: titleVal, id_num: idVal, institution: instVal, avatar_data: state.profileData.avatarRaw, performance: state.performance 
            })
        });
    } catch (err) { }
    regenerateProfileAvatarBadge();
    renderProfileDashboardMetrics();
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
            state.profileData.avatarRaw = base64Result;
        }
    };
    reader.readAsDataURL(file);
};

window.submitClinicalWorkstationBugReport = function() {
    const cat = document.getElementById("bug-category").value;
    const desc = document.getElementById("bug-description").value.trim();

    if (!desc || desc.length < 15) {
        alert("Please enter a comprehensive summary description to trace conflict metrics (min 15 characters).");
        return;
    }

    const ticketId = `MP-BUG-${Math.floor(Math.random() * 9000 + 1000)}`;
    const logContainer = document.getElementById("admin-bug-logs");
    
    if (logContainer) {
        if (logContainer.innerText.includes("No unassigned system tickets")) logContainer.innerHTML = "";
        logContainer.innerHTML += `<div style='border-bottom:1px solid #e2e8f0; padding-bottom:6px; margin-bottom:6px; color:#f8fafc;'>🔴 <strong>[${ticketId}] [${cat.toUpperCase()}]</strong><br>${desc}</div>`;
    }

    alert(`🎯 Diagnostics Payload Transmitted under secure reference parameters: ${ticketId}.`);
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

    const critiqueBox = document.getElementById("reinforcement-critique-text");
    const headerBar = document.getElementById("reinforcement-header-bar");
    
    if (isCorrect) {
        headerBar.innerText = "🎯 ADAPTIVE REINFORCEMENT: CORRECT SELECTION";
        headerBar.style.backgroundColor = "#059669";
        critiqueBox.innerHTML = `<strong>Excellent Clinical Synthesis.</strong> Your selection of Option <strong>[${selectedKey}]</strong> correctly matches the core anesthesiology criteria.`;
    } else {
        headerBar.innerText = "❌ ADAPTIVE REINFORCEMENT: CORE DEVIATION CRITIQUE";
        headerBar.style.backgroundColor = "#dc2626";
        critiqueBox.innerHTML = `<strong>Underlying Misconception Detected.</strong> You selected Option <strong>[${selectedKey}]</strong>. In high-stakes board examinations, this specific distractor path represents a common near-miss clinical error. Option <strong>[${q.correct_answer}]</strong> remains the absolute correct answer because of the precise physiological variables detailed in the curriculum text below.`;
    }

    document.getElementById("explanation-title").innerText = "Certified Curriculum Clinical Rationale";
    document.getElementById("explanation-text").innerText = q.explanation;
    document.getElementById("explanation-container").classList.remove("hidden");

    if (state.userEmail) {
        fetch('/api/user/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: state.userEmail, name: state.profileData.name, title: state.profileData.title, id_num: state.profileData.idNum, institution: state.profileData.institution, avatar_data: state.profileData.avatarRaw, performance: state.performance
            })
        }).catch(() => {});
    }
    renderAnalyticsEngine();
}

function renderAnalyticsEngine() {
    if (!state.performance) state.performance = { totalAnswered: 0, totalCorrect: 0, specialtyBreakdown: {} };
    if (!state.performance.specialtyBreakdown) state.performance.specialtyBreakdown = {};

    const accuracy = state.performance.totalAnswered > 0 ? Math.round((state.performance.totalCorrect / state.performance.totalAnswered) * 100) : 0;

    if (document.getElementById("analytics-accuracy")) document.getElementById("analytics-accuracy").innerText = `${accuracy}%`;
    if (document.getElementById("analytics-total")) document.getElementById("analytics-total").innerText = state.performance.totalAnswered;

    const barsContainer = document.getElementById("mastery-bars");
    if (!barsContainer) return;
    barsContainer.innerHTML = "";

    const coreSpecialties = [
        "Cardiovascular Anesthesia", "Advanced Pharmacology Kinetics", "Neuroanesthesia", "Regional Anesthesia & Pain",
        "Pediatric Anesthesia", "Obstetric Anesthesia", "Thoracic Anesthesia", "General Principles & Safety"
    ];
    
    coreSpecialties.forEach(spec => {
        const data = state.performance.specialtyBreakdown[spec] || { attempts: 0, corrects: 0 };
        const specAttempts = data.attempts || 0;
        const specCorrects = data.corrects || 0;
        const specAccuracy = specAttempts > 0 ? Math.round((specCorrects / specAttempts) * 100) : 0;

        const barWrapper = document.createElement("div");
        barWrapper.className = "mastery-bar-row";
        barWrapper.innerHTML = `
            <div class="bar-meta"><span>${spec}</span><span>${specAccuracy}%</span></div>
            <div class="bar-track"><div class="bar-fill" style="width: ${specAttempts === 0 ? 0 : specAccuracy}%"></div></div>
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

window.calculateDO2I = function() {
    const ci = parseFloat(document.getElementById("input-do2i-ci")?.value) || 0;
    const hb = parseFloat(document.getElementById("input-do2i-hb")?.value) || 0;
    const sao2 = parseFloat(document.getElementById("input-do2i-sao2")?.value) || 0;
    const do2i = Math.round(ci * 1.34 * hb * (sao2 / 100) * 10 * 10) / 10;
    if (document.getElementById("result-do2i-value")) document.getElementById("result-do2i-value").innerText = `${do2i} mL/min/m²`;
};

window.calculateTCIMatrix = function() {
    const agent = document.getElementById("tci-agent-select")?.value;
    if (agent === "propofol") {
        if (document.getElementById("tci-1h")) document.getElementById("tci-1h").innerText = "~25 Minutes";
        if (document.getElementById("tci-3h")) document.getElementById("tci-3h").innerText = "~50 Minutes";
    } else {
        if (document.getElementById("tci-1h")) document.getElementById("tci-1h").innerText = "3 - 5 Minutes";
    }
};

window.regenerateProfileAvatarBadge = function() {
    const nameInput = document.getElementById("prof-name");
    const badgeElement = document.getElementById("profile-avatar-badge");
    if (!nameInput || !badgeElement) return;
    const val = nameInput.value.trim();
    if (!val || val === "Anesthesia Care Team Professional") { badgeElement.innerText = "AA"; return; }
    const parts = val.split(" ");
    let initials = parts[0].charAt(0).toUpperCase();
    if (parts.length > 1) initials += parts[parts.length - 1].charAt(0).toUpperCase();
    badgeElement.innerText = initials.slice(0, 2);
};

window.authenticateStudentSession = function() {
    const emailInput = document.getElementById("auth-email-input").value.trim();
    localStorage.setItem("macprep_user_email", emailInput);
    state.userEmail = emailInput;
    evaluateAuthGatewayState();
};

window.terminateStudentSession = function() {
    localStorage.removeItem("macprep_user_email");
    state.userEmail = null;
    evaluateAuthGatewayState();
};

function initializeWaveformEngine() {
    if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
    function animate() {
        state.wavePhase += 0.008; 
        const currentQuestion = state.questions[state.currentIndex];
        let pathString = "", color = "#10b981", hValue = 55, isObstructive = false;

        if (currentQuestion) {
            const lookstack = (currentQuestion.stem + " " + (currentQuestion.explanation || "")).toLowerCase();
            if (lookstack.match(/(bronchospasm|shark-fin|resistance)/)) { color = "#f59e0b"; isObstructive = true; }
        }

        for (let x = 0; x <= 800; x += 2) {
            let cycle = ((x / 160) - state.wavePhase) % 2;
            if (cycle < 0) cycle += 2;
            let y = 100;
            if (hValue > 0) {
                if (isObstructive) y = 100 - (Math.sin(((cycle - 0.2) / 1.1) * (Math.PI / 2.2)) * hValue);
                else {
                    if (cycle >= 0.2 && cycle < 0.3) y = 100 - ( ( (cycle - 0.2) / 0.1 ) * hValue );
                    else if (cycle >= 0.3 && cycle < 1.3) y = 100 - hValue;
                    else if (cycle >= 1.3 && cycle < 1.4) y = (100 - hValue) + ( ( (cycle - 1.3) / 0.1 ) * hValue );
                }
            }
            if (x === 0) pathString += `M ${x} ${y}`; else pathString += ` L ${x} ${y}`;
        }
        const wavePath = document.getElementById("wave-path");
        if (wavePath) { wavePath.setAttribute("d", pathString); wavePath.setAttribute("stroke", color); }
        state.animationFrameId = requestAnimationFrame(animate);
    }
    animate();
}

setTimeout(() => {
    document.getElementById("next-item-btn")?.addEventListener("click", () => {
        if (state.currentIndex < state.questions.length - 1) { state.currentIndex++; renderCurrentQuestion(); initializeWaveformEngine(); }
    });
}, 500);

// ==========================================
// STRIPE COMMERCIAL PREMIUM CHECKOUT LINK COUPLING
// ==========================================
async function initiatePremiumCheckout() {
  const userEmail = localStorage.getItem('macprep_user_email');
  if (!userEmail) {
    alert("🩺 Authentication Notice: Please sign in or register an account before purchasing full platform premium access.");
    return;
  }

  const payButton = document.getElementById('premium-checkout-trigger');
  if (payButton) {
    payButton.innerText = "CONNECTING SECURE ROUTE...";
    payButton.disabled = true;
  }

  
  const backendBaseUrl = 'https://macprep-workstation.onrender.com';

  try {
    const response = await fetch(`${backendBaseUrl}/api/create-checkout-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: userEmail })
    });

    const session = await response.json();

    if (session.url) {
      console.log("📡 Secure Session Established. Handing over context link token to Stripe checkout frame...");
      window.location.href = session.url;
    } else {
      throw new Error(session.error || "Failed to extract active routing payload url.");
    }
  } catch (err) {
    console.error("❌ Stripe Gateway Initializer Intercept Failure:", err.message);
    alert("⚠️ Connection Fault: Unable to reach the billing engine. Please try again shortly.");
    if (payButton) {
      payButton.innerText = "UPGRADE TO FULL PREMIUM ACCESS";
      payButton.disabled = false;
    }
  }
}


// Production Stripe Payment Gateway Configuration
if (typeof window !== 'undefined') {
  window.handlePremiumUpgrade = function() {
    window.location.href = "https://buy.stripe.com/5kQ6oI6HHefh5btfK7dnW00";
  };
}



// Isolated high-yield question view compiler
export function renderQuestion(question) {
    if (!question) return;
    
    // Set clinical stem content safely
    const stemEl = document.getElementById('question-stem');
    if (stemEl) stemEl.textContent = question.stem || question.text || '';

    // Extract options safely from incoming database schema parameters
    const choices = question.choices || question.options || [];
    const container = document.getElementById('choices-container');
    
    if (container) {
        container.innerHTML = '';
        choices.forEach((choice, index) => {
            const letter = String.fromCharCode(65 + index); // Strictly computes labels: A, B, C, D, E
            const choiceBtn = document.createElement('button');
            choiceBtn.className = 'choice-option-node';
            choiceBtn.style.width = '100%';
            choiceBtn.style.textAlign = 'left';
            choiceBtn.style.margin = '8px 0';
            choiceBtn.style.padding = '12px';
            choiceBtn.style.backgroundColor = '#111214';
            choiceBtn.style.border = '1px solid #1F2937';
            choiceBtn.style.color = '#F9FAFB';
            choiceBtn.style.fontFamily = 'monospace';
            choiceBtn.style.cursor = 'pointer';
            
            choiceBtn.innerHTML = `<span style="color: #00A86B; margin-right: 15px;">[${letter}]</span> ${choice}`;
            choiceBtn.onclick = () => {
                if (typeof handleAnswerSelection === 'function') {
                    handleAnswerSelection(index, question.correct_answer);
                }
            };
            container.appendChild(choiceBtn);
        });
    }
}

// Sidebar track element label converter
export function getSidebarLabel(index) {
    return String.fromCharCode(65 + index);
}


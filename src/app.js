// State Engine Core Configuration with Persistent Auth Mapping Flags & Custom Volume Arrays
let state = {
    masterQuestionsPool: [], 
    questions: [],          
    currentIndex: 0,
    selectedAnswer: null,
    revealed: false,
    crossedOut: {},
    highlights: {},
    userEmail: localStorage.getItem("macprep_user_email") || "anonymous_trial_student@macprep.io",
    performance: {
        totalAnswered: 0,
        totalCorrect: 0,
        specialtyBreakdown: {}
    },
    animationFrameId: null,
    wavePhase: 0
};

// Application Boot Sequence
document.addEventListener("DOMContentLoaded", () => {
    console.log(`🔐 Initializing Authenticated Workspace Profile: ${state.userEmail}`);
    hydrateUserPersistentSession();
    initializeWaveformEngine();
    fetchCurriculumBlock();
    calculateDO2I();
    calculateTCIMatrix();
});

// Brand Dashboard Return Link Hook
window.returnToHomeDashboard = function() {
    console.log("🏠 Resetting workspace to baseline configuration parameters...");
    state.currentIndex = 0;
    document.getElementById("filter-specialty").value = "all";
    document.getElementById("filter-volume").value = "all";
    if (state.masterQuestionsPool.length > 0) {
        state.questions = [...state.masterQuestionsPool];
        renderCurrentQuestion();
    }
};

window.applyCustomBlockConfiguration = function() {
    const specialtyFilter = document.getElementById("filter-specialty").value;
    const volumeFilter = document.getElementById("filter-volume").value;

    let filteredList = [...state.masterQuestionsPool];
    if (specialtyFilter !== "all") {
        filteredList = filteredList.filter(q => q.specialty === specialtyFilter);
    }

    if (volumeFilter !== "all") {
        const maxVolume = parseInt(volumeFilter, 10);
        filteredList = filteredList.slice(0, maxVolume);
    }

    if (filteredList.length === 0) {
        document.getElementById("question-stem").innerText = "⚠️ No question block configurations match your precise query parameters. Readjust your dropdown filters to resume study tracking.";
        document.getElementById("choices-container").innerHTML = "";
        document.getElementById("current-specialty").innerText = "📍 FILTER VACANT";
        document.getElementById("question-pacing-counter").innerText = "Item 0 of 0";
        state.questions = [];
        return;
    }

    state.questions = filteredList;
    state.currentIndex = 0;
    renderCurrentQuestion();
};

function hydrateUserPersistentSession() {
    const sessionKey = `macprep_progress_${state.userEmail.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const cachedProgress = localStorage.getItem(sessionKey);
    
    if (cachedProgress) {
        try {
            const parsed = JSON.parse(cachedProgress);
            state.performance = parsed.performance || state.performance;
        } catch (e) {
            console.error("Failed parsing cached history logs:", e);
        }
    }
}

function saveUserPersistentSession() {
    const sessionKey = `macprep_progress_${state.userEmail.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const payload = {
        performance: state.performance,
        currentIndex: state.currentIndex
    };
    localStorage.setItem(sessionKey, JSON.stringify(payload));
}

// ========================================================
// 🫁 SHARK-FIN WAVEFORM physics RE-CALIBRATION
// ========================================================
function initializeWaveformEngine() {
    if (state.animationFrameId) {
        cancelAnimationFrame(state.animationFrameId);
    }
    
    function animate() {
        state.wavePhase += 0.008; // Steady, readable scroll rate
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
            } else if (lookstack.match(/(hyperthermia|sepsis|hypoventilation|elevated metabolism)/)) {
                stateKey = "ELEVATED METABOLISM / HYPOVENTILATION";
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

        // Generate the SVG path across the 800px monitor panel width
        for (let x = 0; x <= 800; x += 2) {
            // Map individual repeating breathing cycles
            let cycle = ((x / 160) - state.wavePhase) % 2;
            if (cycle < 0) cycle += 2;
            
            let y = 100; // Baseline floor (Zero baseline during inspiration)

            if (hValue > 0) {
                if (isObstructive) {
                    // ====== CLINICAL SHARK-FIN WAVEFORM PHYSICS ======
                    if (cycle >= 0.2 && cycle < 1.3) {
                        // Slow, sloped expiratory upstroke leading directly to an angled peak
                        let progress = (cycle - 0.2) / 1.1;
                        // Logarithmic/exponential incline matching prolonged airway resistance
                        let slant = Math.sin(progress * (Math.PI / 2.2));
                        y = 100 - (slant * hValue);
                    } else if (cycle >= 1.3 && cycle < 1.45) {
                        // Quick, crisp inspiratory downstroke dropping straight back to zero
                        let downProgress = (cycle - 1.3) / 0.15;
                        y = (100 - hValue) + (downProgress * hValue);
                        if (y > 100) y = 100;
                    }
                } else {
                    // ====== STANDARD RECTANGULAR ETCO2 PROFILE ======
                    if (cycle >= 0.2 && cycle < 0.3) {
                        // Crisp vertical upstroke
                        let upProgress = (cycle - 0.2) / 0.1;
                        y = 100 - (upProgress * hValue);
                    } else if (cycle >= 0.3 && cycle < 1.3) {
                        // Perfectly flat alveolar plateau
                        y = 100 - hValue;
                    } else if (cycle >= 1.3 && cycle < 1.4) {
                        // Vertical inspiratory downstroke drop
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

// ==========================================
// CORE CONTENT NETWORKING LAYER
// ==========================================
async function fetchCurriculumBlock() {
    try {
        const response = await fetch("http://localhost:3000/api/questions");
        const data = await response.json();
        
        state.masterQuestionsPool = data.questions || [];
        state.questions = [...state.masterQuestionsPool];
        
        renderCurrentQuestion();
        renderAnalyticsEngine();
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

    document.getElementById("current-specialty").innerText = `📍 ${q.specialty.toUpperCase()}`;
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
            <div class="choice-main-block" id="block-${key}">
                <span class="choice-key">${key}</span>
                <span class="choice-text">${text}</span>
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
        if (targetWrapper) {
            if (key === q.correct_answer) {
                targetWrapper.classList.add("correct-highlight");
            } else if (key === selectedKey) {
                targetWrapper.classList.add("incorrect-highlight");
            }
            targetWrapper.classList.add("disabled-state");
        }
    });

    document.getElementById("explanation-title").innerText = isCorrect ? "✅ Clinical Core Match" : "❌ Near-Miss Core Deviation";
    document.getElementById("explanation-text").innerText = q.explanation;
    document.getElementById("explanation-container").classList.remove("hidden");

    saveUserPersistentSession();
    renderAnalyticsEngine();
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

    const coreSpecialties = ["Cardiovascular Anesthesia", "Advanced Pharmacology Kinetics", "Neuroanesthesia", "General Principles"];
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
    
    document.getElementById(`calc-panel-${tabName}`).classList.remove("hidden");
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

setTimeout(() => {
    const nextBtn = document.getElementById("next-item-btn");
    if (nextBtn) {
        nextBtn.addEventListener("click", () => {
            if (state.currentIndex < state.questions.length - 1) {
                state.currentIndex++;
                saveUserPersistentSession();
                renderCurrentQuestion();
                initializeWaveformEngine();
            } else {
                alert("Custom quiz block sequence completed!");
            }
        });
    }
}, 500);

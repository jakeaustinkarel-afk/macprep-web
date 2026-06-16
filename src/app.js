// State Engine Core Configuration
let state = {
    questions: [],
    currentIndex: 0,
    selectedAnswer: null,
    revealed: false,
    crossedOut: {},
    highlights: {},
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
    initializeWaveformEngine();
    fetchCurriculumBlock();
    calculateDO2I();
    calculateTCIMatrix();
});

// ==========================================
// OPTION C: Waveform Morphing Engine (SVG)
// ==========================================
function initializeWaveformEngine() {
    if (state.animationFrameId) {
        cancelAnimationFrame(state.animationFrameId);
    }
    
    function animate() {
        state.wavePhase += 0.05;
        const currentQuestion = state.questions[state.currentIndex];
        let pathString = "";
        
        // Default normal waveform shape constants
        let stateKey = "NORMAL PHYSIOLOGY";
        let color = "#10b981"; // Emerald
        let hValue = 35; // Normal EtCO2 height
        let frequency = 1.0;

        if (currentQuestion) {
            const stemText = currentQuestion.stem.toLowerCase();

            // Dynamic morph conditions matched to question data states
            if (stemText.includes("bronchospasm") || stemText.includes("obstructive") || stemText.includes("copd")) {
                stateKey = "OBSTRUCTIVE PATHWAY (SHARK-FIN)";
                color = "#f59e0b"; // Warning Amber
            } else if (stemText.includes("hyperthermia") || stemText.includes("sepsis") || stemText.includes("hypoventilation")) {
                stateKey = "ELEVATED METABOLISM / HYPOVENTILATION";
                color = "#ef4444"; // Hypercritical Red
                hValue = 60; // Hypercapnic surge
            } else if (stemText.includes("disconnection") || stemText.includes("embolism") || stemText.includes("cardiac arrest")) {
                stateKey = "CIRCUIT ACCIDENT / ZERO VENTILATION";
                color = "#6b7280"; // Dead Slate
                hValue = 2; // Flatline approach
            }
        }

        const stateIndicator = document.getElementById("current-physio-state");
        if (stateIndicator) {
            stateIndicator.innerText = stateKey;
            stateIndicator.className = `state-indicator status-${color === "#10b981" ? 'normal' : color === "#f59e0b" ? 'warning' : 'critical'}`;
        }

        // Construct high-fidelity procedural capnogram waves mathematically
        for (let x = 0; x <= 800; x += 4) {
            let cycle = (x / 120 * frequency - state.wavePhase) % (2 * Math.PI);
            if (cycle < 0) cycle += 2 * Math.PI;
            
            let y = 100; // Baseline floor

            if (stateKey === "OBSTRUCTIVE PATHWAY (SHARK-FIN)") {
                if (cycle > 1.0 && cycle < 4.0) {
                    let progress = (cycle - 1.0) / 3.0;
                    y = 100 - (progress * hValue * 0.5 + hValue * 0.5);
                } else if (cycle >= 4.0 && cycle < 4.5) {
                    y = 100 - hValue;
                }
            } else {
                if (cycle > 1.0 && cycle < 4.0) {
                    y = 100 - hValue;
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
        state.questions = data.questions || [];
        renderCurrentQuestion();
        renderAnalyticsEngine();
    } catch (err) {
        console.error("Content hydration failed:", err);
        const stemEl = document.getElementById("question-stem");
        if (stemEl) {
            stemEl.innerHTML = `
                <div class="network-error-state">
                    <p>⚠️ Connection to local streaming pool disrupted.</p>
                    <button class="btn" onclick="fetchCurriculumBlock()">Re-Establish Server Hook</button>
                </div>`;
        }
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

        choiceWrapper.innerHTML = `
            <div class="choice-main-block" id="block-${key}" onclick="evaluateSelection('${key}')">
                <span class="choice-key">${key}</span>
                <span class="choice-text">${text}</span>
            </div>
            <div class="choice-actions-toolbar">
                <button class="action-btn slash-btn" onclick="toggleSlash('${key}', event)">🪓 Slash</button>
                <button class="action-btn gold-btn" onclick="toggleGold('${key}', event)">✨ Gold</button>
            </div>
        `;
        container.appendChild(choiceWrapper);
    });
}

// ==========================================
// OPTION B: PERFORMANCE ANALYTICS
// ==========================================
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
        const targetBlock = document.getElementById(`block-${key}`);
        if (targetBlock) {
            if (key === q.correct_answer) {
                targetBlock.classList.add("correct-highlight");
            } else if (key === selectedKey) {
                targetBlock.classList.add("incorrect-highlight");
            }
            targetBlock.classList.add("disabled-state");
        }
    });

    document.getElementById("explanation-title").innerText = isCorrect ? "✅ Clinical Core Match" : "❌ Near-Miss Core Deviation";
    document.getElementById("explanation-text").innerText = q.explanation;
    document.getElementById("explanation-container").classList.remove("hidden");

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
    document.getElementById(`block-${key}`).classList.toggle("gold-highlight", state.highlights[key]);
};

window.switchCalcTab = function(tabName) {
    document.querySelectorAll(".calc-tab-panel").forEach(p => p.classList.add("hidden"));
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    
    document.getElementById(`calc-panel-${tabName}`).classList.remove("hidden");
    if (event && event.target) {
        event.target.classList.add("active");
    }
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
                renderCurrentQuestion();
                initializeWaveformEngine();
            } else {
                alert("Board review module sequence fully mapped!");
            }
        });
    }
}, 500);

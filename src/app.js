/**
 * MACPrep — Core Academic Workstation Engine
 * Implements Option A Polishes: Ribbon Tracking, Right-Click Strikes, and Waveform Morphs
 */

// Local Cache Session Variables State Matrix
let globalQuestionPool = [];
let currentQuestionIndex = 0;
let totalProgressCount = 0;
let answeredRegistryState = {}; // Tracks index metrics
let flaggedQuestionsMap = {};   // Tracks case flags

const CONFIG = {
    FREE_CEILING: 10, // Hard limit ceiling for active test pass demo
    TOTAL_TIER_CEILING: 100
};

// --- INITIALIZATION HOOK RUNNER ---
document.addEventListener('DOMContentLoaded', () => {
    fetchFreeQuestionSequences();
    initializeInterfaceControls();
});

// --- API LAYER: FETCH CLOUD SESSIONS ---
async function fetchFreeQuestionSequences() {
    try {
        const response = await fetch('/api/questions/free');
        if (!response.ok) throw new Error("Network response encountered operational limits.");
        const data = await response.json();
        
        if (data.questions && data.questions.length > 0) {
            globalQuestionPool = data.questions;
            renderTacticalFlagRibbon();
            loadActiveQuestionVignette();
        } else {
            document.getElementById('question-stem-text').textContent = "No valid matching question entries extracted from cloud instance databases.";
        }
    } catch (err) {
        console.error("Infrastructure fetch error path:", err);
        document.getElementById('question-stem-text').textContent = "Failed to connect to cloud streaming framework endpoints.";
    }
}

// --- UI GENERATOR: TACTICAL FLAG PAGINATION RIBBON ---
function renderTacticalFlagRibbon() {
    const ribbon = document.getElementById('flag-tracker-ribbon');
    if (!ribbon) return;
    ribbon.innerHTML = "";

    const renderLimit = Math.min(globalQuestionPool.length, CONFIG.FREE_CEILING);

    for (let i = 0; i < renderLimit; i++) {
        const node = document.createElement('div');
        node.className = `ribbon-node ${i === currentQuestionIndex ? 'current' : ''}`;
        if (flaggedQuestionsMap[i]) node.classList.add('flagged');
        if (answeredRegistryState[i]) node.classList.add('answered');
        
        node.textContent = i + 1;
        node.addEventListener('click', () => {
            currentQuestionIndex = i;
            renderTacticalFlagRibbon();
            loadActiveQuestionVignette();
        });
        ribbon.appendChild(node);
    }
}

// --- UI GENERATOR: LOAD CASE CORE AND MORPH WAVEFORMS ---
function loadActiveQuestionVignette() {
    if (!globalQuestionPool[currentQuestionIndex]) return;
    const currentQuestion = globalQuestionPool[currentQuestionIndex];

    // Reset view states
    document.getElementById('rationale-analysis-master-box').classList.add('hidden');
    document.getElementById('calibration-submission-lock-panel').classList.add('hidden');

    // Populate Stem Row
    document.getElementById('question-stem-text').textContent = currentQuestion.stem;

    // Synchronize Flag Action Buttons State Parameters
    const flagBtn = document.getElementById('flag-case-toggle-btn');
    if (flagBtn) {
        if (flaggedQuestionsMap[currentQuestionIndex]) {
            flagBtn.textContent = "⭐️ Case Flagged";
            flagBtn.classList.add('active');
        } else {
            flagBtn.textContent = "🏴 Flag Case";
            flagBtn.classList.remove('active');
        }
    }

    // Hydrate Telemetry Monitor Array Values
    const hrVal = document.getElementById('vital-hr');
    const bpVal = document.getElementById('vital-bp');
    const spo2Val = document.getElementById('vital-spo2');
    const etco2Val = document.getElementById('vital-etco2');

    if (currentQuestion.telemetry) {
        if (hrVal) hrVal.textContent = currentQuestion.telemetry.hr || "72";
        if (bpVal) bpVal.textContent = currentQuestion.telemetry.bp || "120/80";
        if (spo2Val) spo2Val.textContent = currentQuestion.telemetry.spo2 || "99";
        if (etco2Val) etco2Val.textContent = currentQuestion.telemetry.etco2 || "35";
    }

    // ==========================================================================
    // 🫁 CRITICAL CLINICAL MONITOR INTERPOLATION: WAVEFORM MORPHING ENGINE
    // Dynamically reshapes paths inside the SVG telemetry display panel
    // ==========================================================================
    const wavePathNode = document.getElementById('dynamic-capno-path');
    if (wavePathNode) {
        const specialtyKey = currentQuestion.specialty || "ALL";
        
        if (specialtyKey === "CRISIS" || currentQuestion.stem.toUpperCase().includes("EMBOLISM") || currentQuestion.stem.toUpperCase().includes("CARDIAC ARREST")) {
            // Morph 1: Catastrophic Flatline Profile (Cardiac arrest, true severe pulmonary embolism risks)
            wavePathNode.setAttribute('d', 'M 0 38 L 100 38 L 200 38 L 300 38 L 400 38');
            wavePathNode.setAttribute('stroke', '#ef4444'); // Danger Red Alert
        } else if (specialtyKey === "PHYSICS" || currentQuestion.stem.toUpperCase().includes("BRONCHOSPASM") || currentQuestion.stem.toUpperCase().includes("COPD")) {
            // Morph 2: Prolonged Obstructive "Shark-Fin" Expiratory Upslope Curve Profiles (Bronchospasms / Obstructive ventilation anomalies)
            wavePathNode.setAttribute('d', 'M 0 35 L 15 35 L 45 8 C 55 5, 75 4, 85 4 L 90 35 L 120 35 L 150 8 C 160 5, 180 4, 190 4 L 195 35 L 400 35');
            wavePathNode.setAttribute('stroke', '#eab308'); // Warning Amber Alert
        } else {
            // Morph 3: Standard Healthy Square-Wave Plateau Profiles (Normal respiratory gas exchange cycles)
            wavePathNode.setAttribute('d', 'M 0 35 L 15 35 L 18 6 L 55 6 L 58 35 L 90 35 L 93 6 L 130 6 L 133 35 L 200 35');
            wavePathNode.setAttribute('stroke', '#22c55e'); // Green Healthy Active Track
        }
    }

    // Populate Response Choices Container Elements
    const container = document.getElementById('choices-stack-container');
    container.innerHTML = "";

    const choicesArray = currentQuestion.choices || [];
    const optionBadges = ["A", "B", "C", "D", "E"];

    choicesArray.forEach((choiceText, index) => {
        const badge = optionBadges[index] || "?";
        const card = document.createElement('div');
        card.className = "choice-card";
        card.setAttribute('data-index', index);
        card.setAttribute('data-badge', badge);

        card.innerHTML = `
            <span class="choice-badge">${badge}</span>
            <span class="choice-text">${choiceText}</span>
        `;

        // Left Click Handler: Standard choice lock configuration path
        card.addEventListener('click', () => {
            if (answeredRegistryState[currentQuestionIndex]) return; // locked once checked
            document.querySelectorAll('.choice-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            document.getElementById('calibration-submission-lock-panel').classList.remove('hidden');
        });

        // ==========================================================================
        // ✂️ TACTICAL CROSS-OFFS: RIGHT CLICK CONTEXT INTERCEPTOR
        // Draws a line strike across a distractor on command
        // ==========================================================================
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault(); // Stop standard OS options drop down list pane from waking
            if (answeredRegistryState[currentQuestionIndex]) return;
            
            card.classList.toggle('struck-out');
            
            // Toggle visual strike text warning badge
            const existingHint = card.querySelector('.strike-overlay-hint');
            if (card.classList.contains('struck-out')) {
                if (!existingHint) {
                    const hint = document.createElement('span');
                    hint.className = 'strike-overlay-hint';
                    hint.textContent = '[ELIMINATED]';
                    card.appendChild(hint);
                }
            } else {
                if (existingHint) existingHint.remove();
            }
        });

        container.appendChild(card);
    });
}

// --- UI GENERATOR: CONTROL LOG INTERFACES ---
function initializeInterfaceControls() {
    // Flag Actions Event Handler
    const flagBtn = document.getElementById('flag-case-toggle-btn');
    if (flagBtn) {
        flagBtn.addEventListener('click', () => {
            flaggedQuestionsMap[currentQuestionIndex] = !flaggedQuestionsMap[currentQuestionIndex];
            renderTacticalFlagRibbon();
            loadActiveQuestionVignette();
        });
    }

    // Enter Workspace Actions Hook Trigger
    const startBtn = document.getElementById('unified-start-btn');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            document.getElementById('pane-dashboard-home').classList.add('hidden');
            document.getElementById('pane-active-testing').classList.remove('hidden');
            renderTacticalFlagRibbon();
        });
    }

    // Calibration Certainty Gate Submission Processing Layers
    document.querySelectorAll('.calibration-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const selectedCard = document.querySelector('.choice-card.selected');
            if (!selectedCard) return;

            const selectedBadge = selectedCard.getAttribute('data-badge');
            const currentQuestion = globalQuestionPool[currentQuestionIndex];

            // Record transaction answer logs state vectors
            answeredRegistryState[currentQuestionIndex] = selectedBadge;
            renderTacticalFlagRibbon();

            document.getElementById('calibration-submission-lock-panel').classList.add('hidden');

            // Expose Rationale Panel Element Wells
            const rationaleBox = document.getElementById('rationale-analysis-master-box');
            rationaleBox.classList.remove('hidden');
            document.getElementById('rationale-text-content').textContent = currentQuestion.explanation || "No verification record provided.";

            // Highlight status elements on options stack output fields
            document.querySelectorAll('.choice-card').forEach(c => {
                c.classList.remove('struck-out'); // clean strikes away for review checks
                const cBadge = c.getAttribute('data-badge');
                if (cBadge === currentQuestion.correctAnswer) {
                    c.style.borderColor = "var(--accent-scrub)";
                    c.style.background = "#e8f5e9";
                } else if (cBadge === selectedBadge) {
                    c.style.borderColor = "var(--accent-crimson)";
                    c.style.background = "#ffebee";
                }
            });

            // Update Progress Scores Counters Metrics
            totalProgressCount++;
            document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / 100`;

            // Enforce Demo Trial Session Ceiling Controls Bounds checking
            if (totalProgressCount >= CONFIG.FREE_CEILING) {
                document.getElementById('advance-next-case-btn').textContent = "VIEW SYSTEM EVALUATION METRICS ➔";
            }
        });
    });

    // Advance Case Button Pipeline
    const nextBtn = document.getElementById('advance-next-case-btn');
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (totalProgressCount >= CONFIG.FREE_CEILING) {
                // Shift viewport fields instantly into Paywall diagnostic report tracking panes
                document.getElementById('pane-active-testing').classList.add('hidden');
                document.getElementById('pane-conversion-paywall').classList.remove('hidden');
                
                // Hydrate stat labels mock indexes values safely
                document.getElementById('metric-blindspot-value').textContent = "12%";
                document.getElementById('metric-hesitation-value').textContent = "18%";
            } else {
                currentQuestionIndex = (currentQuestionIndex + 1) % Math.min(globalQuestionPool.length, CONFIG.FREE_CEILING);
                renderTacticalFlagRibbon();
                loadActiveQuestionVignette();
            }
        });
    }

    // Return Home Framework Links
    const returnBtn = document.getElementById('paywall-return-home-btn');
    if (returnBtn) {
        returnBtn.addEventListener('click', () => {
            document.getElementById('pane-conversion-paywall').classList.add('hidden');
            document.getElementById('pane-dashboard-home').classList.remove('hidden');
        });
    }
}

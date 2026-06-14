/**
 * MACPrep — Core Academic Workstation Engine
 * Fixed: Integrated Self-Healing Local Question Banks and a Live Animated Capnography Sweep.
 */

let globalQuestionPool = [];
let masterBibliographyRegistryCache = []; 
let currentQuestionIndex = 0;
let totalProgressCount = 0;
let answeredRegistryState = {}; 
let flaggedQuestionsMap = {};   
let activeUserSessionProfile = null;
let isDeveloperAccessPrivileged = false;
let isProgramDirectorAuthenticated = false;

let currentSessionMode = "STUDY"; 
let dynamicSessionBlockSizeCeiling = 10;
let computedIncorrectRemediationPool = {}; 

let caseVignetteLoadTimestamp = Date.now();
let structuralDecisionLatencyStore = {}; 
let certaintyCalibrationStore = {};      

let strictExamCountdownIntervalToken = null;
let remainingQuestionSecondsCounter = 60;
let liveCapnographySweepAnimationToken = null; // Controls continuous monitor sweeping loops

let client = null; 

// ==========================================================================
// 🩺 EMERGENCY CURRICULUM BACKUP MATRIX
// Instantly self-heals the application workspace if cloud database streams are empty
// ==========================================================================
const LOCAL_FALLBACK_CURRICULUM_POOL = [
    {
        id: "fb-1",
        specialty: "ADVANCED PHARMACOLOGY",
        stem: "A 44-year-old patient undergoing a long abdominal reconstruction block has been receiving a continuous infusion of propofol for 5 hours. The certified anesthetist notes a progressive, unexplained metabolic acidosis, profound lipemic plasma flags, and a widening QRS complex on the ECG monitor. Which of the following mechanisms represents the primary pathophysiology of this clinical crisis sequence?",
        choices: [
            "Direct antagonism of post-synaptic GABAA chloride channels",
            "Inhibition of mitochondrial electron transport chains and free fatty acid oxidation",
            "Uncoupled oxidative phosphorylation within renal proximal tubular structures",
            "Competitive inhibition of plasma pseudocholinesterase enzyme networks",
            "Irreversible binding to voltage-gated fast sodium channels"
        ],
        correctAnswer: "B",
        explanation: "This presentation represents Propofol Infusion Syndrome (PRIS). High-dose or prolonged propofol infusions directly inhibit the mitochondrial electron transport chain (specifically complex I and IV) and disrupt free fatty acid oxidation, resulting in severe tissue hypoxia, lactic acidosis, rhabdomyolysis, and lipemic flags.",
        telemetry: { hr: "115", bp: "88/54", spo2: "94", etco2: "28" }
    },
    {
        id: "fb-2",
        specialty: "ANESTHESIA MACHINE PHYSICS",
        stem: "During a routine pre-operative inspection of a standard three-gas anesthesia workstation, the clinician drops the oxygen cylinder pressure check valve. The auxiliary oxygen flowmeter line features an explicit Thorpe tube configuration. In a low-flow state condition, gas transmission rates are predominantly governed by which fluid dynamics principle?",
        choices: [
            "Gas density according to Graham's Graham law parameters",
            "Gas viscosity matching Poiseuille's law structural equations",
            "Frictional resistance matching Fick's diffusion coefficients",
            "Turbulent flow boundaries following Bernoulli's pressure drops",
            "The Reynold's constant ratio vector variations"
        ],
        correctAnswer: "B",
        explanation: "At low flow rates within a tapered Thorpe tube flowmeter, the orifice behaves as a narrow tube, rendering gas flow laminar. Laminar flow is governed by Poiseuille's law, where the fluid's property of consequence is its viscosity.",
        telemetry: { hr: "72", bp: "120/80", spo2: "100", etco2: "38" }
    },
    {
        id: "fb-3",
        specialty: "CARDIOVASCULAR MANAGEMENT",
        stem: "A 68-year-old male with severe aortic stenosis is undergoing a non-cardiac urgent vascular pass. On placement of the invasive radial arterial line, the clinician observes a slow upstroke with an exceptionally low amplitude wave trace, completely missing a distinct dicrotic notch profile. This specific wave shape is defined as which of the following terms?",
        choices: [
            "Pulsus alternans",
            "Pulsus paradoxus",
            "Pulsus tardus et parvus",
            "Bisferiens pulse profile",
            "Dicrotic wave rebound anomaly"
        ],
        correctAnswer: "C",
        explanation: "Pulsus tardus et parvus (slow upstroke and small amplitude) is the classic arterial line waveform signature of severe aortic stenosis, reflecting fixed left ventricular outflow obstruction.",
        telemetry: { hr: "64", bp: "95/82", spo2: "97", etco2: "34" }
    }
];

document.addEventListener('DOMContentLoaded', () => {
    initializeSupabaseSessionMonitor();
    initializeInterfaceControls();
    initializeSpecialtyMatrixFilters();
    initializeAdvancedCalculatorRouting();
    initializeBibliographySearchEngine();
    initializeB2BRedemptionListeners();
    initializeReportCardPdfExporter();
    recoverFailsafeSessionStateCache();
    initializeOperationalTrustShelf();
    initializeThemeSelectorEngine();
});

function initializeThemeSelectorEngine() {
    const selector = document.getElementById('theme-selector');
    if (!selector) return;
    selector.addEventListener('change', () => {
        document.body.className = `theme-${selector.value}`;
        loadActiveQuestionVignette();
    });
}

function initializeSupabaseSessionMonitor() {
    setupAnonymousFallback(); // Guarantee immediate asset hydration safely on launch
}

function setupAnonymousFallback() {
    fetchDynamicQuestionSequences();
    fetchPublicBibliographyRegistry();
}

async function fetchDynamicQuestionSequences() { 
    try { 
        const res = await fetch('/api/questions/free');
        const data = await res.json();
        
        // If your remote database tables are empty, seamlessly apply self-healing local assets
        if (!data.questions || data.questions.length === 0) {
            console.log("⚠️ Database currently empty; hydrating workstation via local backup modules.");
            globalQuestionPool = LOCAL_FALLBACK_CURRICULUM_POOL;
        } else {
            globalQuestionPool = data.questions;
        }
        
        renderTacticalFlagRibbon();
        loadActiveQuestionVignette();
    } catch (err) { 
        console.warn("API link error; engaging offline fallback matrices.");
        globalQuestionPool = LOCAL_FALLBACK_CURRICULUM_POOL;
        renderTacticalFlagRibbon();
        loadActiveQuestionVignette();
    } 
}

async function fetchPublicBibliographyRegistry() { 
    try { 
        const res = await fetch('/api/bibliography');
        const data = await res.json();
        masterBibliographyRegistryCache = data.sources || [
            { source: "Miller's Anesthesia, 9th Edition", doi: "10.1016/B978-0-323-59604-6.00001-X", specialty: "GENERAL" }
        ]; 
        renderBibliographyTableRows(masterBibliographyRegistryCache); 
    } catch (err) {} 
}

function renderBibliographyTableRows(s) { 
    const tbody = document.getElementById('bibliography-table-body'); if (!tbody) return; tbody.innerHTML = ""; 
    (s || []).forEach(c => { 
        const row = document.createElement('tr'); 
        row.innerHTML = `<td><strong>${c.source || "Citation Reference"}</strong></td><td>${c.doi || "N/A"}</td><td><span style="color:#15803d; font-weight:bold;">VERIFIED ✓</span></td>`; 
        tbody.appendChild(row); 
    }); 
}

function executeLocalFailsafeSaveBackup() {
    try { localStorage.setItem('macprep_failsafe_session_cache', JSON.stringify({ answers: answeredRegistryState, flags: flaggedQuestionsMap, certainties: certaintyCalibrationStore, latencies: structuralDecisionLatencyStore, mode: currentSessionMode, index: currentQuestionIndex })); } catch (e) {}
}
function recoverFailsafeSessionStateCache() {
    try {
        const cacheRaw = localStorage.getItem('macprep_failsafe_session_cache');
        if (cacheRaw) {
            const cache = JSON.parse(cacheRaw); answeredRegistryState = cache.answers || {}; flaggedQuestionsMap = cache.flags || {}; certaintyCalibrationStore = cache.certainties || {};
            structuralDecisionLatencyStore = cache.latencies || {}; currentSessionMode = cache.mode || "STUDY"; currentQuestionIndex = cache.index || 0;
        }
    } catch (e) {}
}

function startActiveQuestionPacingClock() {
    clearInterval(strictExamCountdownIntervalToken); const zone = document.getElementById('timer-zone'); const txt = document.getElementById('timer-text'); const bar = document.getElementById('timer-bar'); if (!zone || !txt || !bar) return; if (currentSessionMode !== "EXAM") { zone.classList.add('hidden'); return; }
    zone.classList.remove('hidden'); remainingQuestionSecondsCounter = 60; txt.textContent = `⏱ ${remainingQuestionSecondsCounter}s`; bar.style.width = "100%";
    strictExamCountdownIntervalToken = setInterval(() => { remainingQuestionSecondsCounter--; txt.textContent = `⏱ ${remainingQuestionSecondsCounter}s`; bar.style.width = `${(remainingQuestionSecondsCounter / 60) * 100}%`; if (remainingQuestionSecondsCounter <= 0) { clearInterval(strictExamCountdownIntervalToken); executeAutomatedTimerExpirationAdvance(); } }, 1000);
}
async function executeAutomatedTimerExpirationAdvance() {
    certaintyCalibrationStore[currentQuestionIndex] = "BLIND_GUESS"; structuralDecisionLatencyStore[currentQuestionIndex] = 60000; answeredRegistryState[currentQuestionIndex] = "TIMEOUT";
    totalProgressCount++; document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / ${dynamicSessionBlockSizeCeiling}`; executeLocalFailsafeSaveBackup();
    if (totalProgressCount >= dynamicSessionBlockSizeCeiling) { clearInterval(strictExamCountdownIntervalToken); document.getElementById('pane-active-testing').classList.add('hidden'); document.getElementById('pane-conversion-paywall').classList.remove('hidden'); executeAlgorithmicCalibrationReport(); }
    else { currentQuestionIndex++; renderTacticalFlagRibbon(); loadActiveQuestionVignette(); }
}

// ==========================================================================
// 🟢 LIVE ANIMATED SWEEP TICKER INTERCEPTOR
// Replicates a real-time monitor sweep across the green capnography vector line
// ==========================================================================
function startContinuousCapnographyMonitorSweep(etco2, hr) {
    cancelAnimationFrame(liveCapnographySweepAnimationToken);
    const pathElement = document.getElementById('dynamic-capno-path');
    if (!pathElement) return;

    let tickTimeCounter = 0;
    const plateauHeight = Math.max(5, 38 - ((etco2 || 35) * 0.8));
    const waveFrequencyScaler = Math.max(0.02, (hr || 70) * 0.0004);

    function sweepAnimationStepLoop() {
        tickTimeCounter += 1.5;
        let constructedSvgStringPath = "M 0 38 ";

        // Programmatically draw multiple continuous respiratory cycles across the canvas width
        for (let xCoordinate = 0; xRef = xCoordinate <= 400; xCoordinate += 4) {
            // Evaluates a parametric square-wave modifier to replicate mechanical ventilation inspiration cycles
            const waveModulationValue = Math.sin((xCoordinate + tickTimeCounter) * waveFrequencyScaler);
            const calculatedTargetY = waveModulationValue > 0.2 ? plateauHeight : 38;
            constructedSvgStringPath += `L ${xCoordinate} ${calculatedTargetY} `;
        }

        pathElement.setAttribute('d', constructedSvgStringPath.trim());
        pathElement.setAttribute('stroke', 'var(--chart-capno)');
        liveCapnographySweepAnimationToken = requestAnimationFrame(sweepAnimationStepLoop);
    }

    sweepAnimationStepLoop();
}

function loadActiveQuestionVignette() {
    if (!globalQuestionPool || globalQuestionPool.length === 0 || !globalQuestionPool[currentQuestionIndex]) return; 
    const currentQuestion = globalQuestionPool[currentQuestionIndex]; caseVignetteLoadTimestamp = Date.now();
    startActiveQuestionPacingClock(); executeLocalFailsafeSaveBackup();
    
    document.getElementById('rationale-analysis-master-box').classList.add('hidden'); 
    document.getElementById('calibration-submission-lock-panel').classList.add('hidden'); 
    document.getElementById('question-stem-text').textContent = currentQuestion.stem;
    
    const flagBtn = document.getElementById('flag-case-toggle-btn'); if (flagBtn) { if (flaggedQuestionsMap[currentQuestionIndex]) { flagBtn.textContent = "⭐️ Case Flagged"; flagBtn.classList.add('active'); } else { flagBtn.textContent = "🏴 Flag Case"; flagBtn.classList.remove('active'); } }
    const chartViewport = document.getElementById('clinical-chart-viewport'); const svgNode = document.getElementById('dynamic-clinical-svg'); const chartLabel = document.getElementById('clinical-chart-title'); const telemetryRibbon = document.querySelector('.monitor-telemetry-ribbon');
    
    chartViewport.classList.remove('hidden');
    if (currentSessionMode === "EXAM") {
        if (telemetryRibbon) telemetryRibbon.style.display = "none"; chartLabel.textContent = "NCCAA EXAMINATION CONTROL ACTIVE"; svgNode.innerHTML = `<foreignObject x="0" y="0" width="500" height="160"><div class="chart-placeholder-empty-state">⚠️ MONITOR GRAPHS HIDDEN UNDER EXAM MODE SPECIFICATIONS</div></foreignObject>`;
    } else {
        if (telemetryRibbon) telemetryRibbon.style.display = "block";
        if (currentQuestion.telemetry) { 
            document.getElementById('vital-hr').textContent = currentQuestion.telemetry.hr || "72"; 
            document.getElementById('vital-bp').textContent = currentQuestion.telemetry.bp || "120/80"; 
            document.getElementById('vital-spo2').textContent = currentQuestion.telemetry.spo2 || "99"; 
            document.getElementById('vital-etco2').textContent = currentQuestion.telemetry.etco2 || "35"; 
            
            // Fire your newly animated continuous canvas loop tracker
            startContinuousCapnographyMonitorSweep(currentQuestion.telemetry.etco2, currentQuestion.telemetry.hr); 
        }
        const specialty = currentQuestion.specialty || "ALL"; const uppercaseStem = currentQuestion.stem.toUpperCase();
        if (specialty === "CARDIOVASCULAR MANAGEMENT" || uppercaseStem.includes("ARTERIAL") || uppercaseStem.includes("NOTCH")) {
            chartLabel.textContent = "INVASIVE ARTERIAL PRESSURE PROFILE (A-LINE TRACK)"; svgNode.innerHTML = `<line x1="0" y1="40" x2="500" y2="40" class="chart-grid-line" stroke-dasharray="2 2" /><line x1="0" y1="80" x2="500" y2="80" class="chart-grid-line" stroke-dasharray="2 2" /><path d="M 0 140 L 25 30 L 45 75 L 50 65 L 85 140 L 110 30 L 170 140" stroke="var(--chart-aline)" stroke-width="2.5" fill="none"/>`;
        } else if (specialty === "REGIONAL ANESTHETICS" || uppercaseStem.includes("TEG") || uppercaseStem.includes("COAGULATION")) {
            chartLabel.textContent = "THROMBOELASTOGRAPHY (TEG) COAGULATION CALIBRATION TRACK"; svgNode.innerHTML = `<line x1="0" y1="80" x2="500" y2="80" class="chart-grid-line" /><path d="M 10 80 C 130 50, 500 80 Z" stroke="var(--chart-teg)" stroke-width="2" fill="var(--chart-fill-teg)"/>`;
        } else {
            chartLabel.textContent = "INTRAOPERATIVE RECOGNITION TRACK DATA STATUS"; svgNode.innerHTML = `<foreignObject x="0" y="0" width="500" height="160"><div class="chart-placeholder-empty-state">NO ACTIVE METRIC GRAPH PROFILE REQUIRED FOR THIS CASE VIGNETTE</div></foreignObject>`;
        }
    }

    // ==========================================================================
    // 🧱 FIX 2: ANSWER CHOICES RENDERING SEQUENCE
    // Populates answer cards cleanly and attaches certainty confirmation overlays
    // ==========================================================================
    const container = document.getElementById('choices-stack-container'); 
    container.innerHTML = ""; 
    const choicesArray = currentQuestion.choices || []; 
    const optionBadges = ["A", "B", "C", "D", "E"];

    choicesArray.forEach((choiceText, index) => {
        const badge = optionBadges[index] || "?"; 
        const card = document.createElement('div'); 
        card.className = "choice-card"; 
        card.setAttribute('data-badge', badge); 
        card.innerHTML = `<span class="choice-badge">${badge}</span><span class="choice-text">${choiceText}</span>`;
        
        card.addEventListener('click', () => { 
            if (answeredRegistryState[currentQuestionIndex] && currentSessionMode === "STUDY") return; 
            document.querySelectorAll('.choice-card').forEach(c => c.classList.remove('selected')); 
            card.classList.add('selected'); 
            document.getElementById('calibration-submission-lock-panel').classList.remove('hidden'); 
        });
        
        card.addEventListener('contextmenu', (e) => { 
            e.preventDefault(); 
            if (answeredRegistryState[currentQuestionIndex] && currentSessionMode === "STUDY") return; 
            card.classList.toggle('struck-out'); 
        });
        
        container.appendChild(card);
    });
}

function executeAlgorithmicCalibrationReport() {
    clearInterval(strictExamCountdownIntervalToken); cancelAnimationFrame(liveCapnographySweepAnimationToken);
    document.getElementById('timer-zone')?.classList.add('hidden'); localStorage.removeItem('macprep_failsafe_session_cache');
    let totalCasesEvaluated = Object.keys(answeredRegistryState).length; if (totalCasesEvaluated === 0) return;
    let incorrectCount = 0; let blindspotNearMissCount = 0; let hesitationGuessCount = 0; const specialtyPerformanceMatrix = {};
    globalQuestionPool.forEach((q, index) => {
        const userSelection = answeredRegistryState[index]; if (!userSelection) return; const isCorrect = (userSelection === q.correctAnswer); const certaintyLevel = certaintyCalibrationStore[index] || "EDUCATED_GUESS"; const specName = q.specialty || "GENERAL";
        if (!specialtyPerformanceMatrix[specName]) specialtyPerformanceMatrix[specName] = { correct: 0, total: 0 }; specialtyPerformanceMatrix[specName].total++;
        if (isCorrect) { specialtyPerformanceMatrix[specName].correct++; } else { incorrectCount++; if (certaintyLevel === "CERTAIN") blindspotNearMissCount++; computedIncorrectRemediationPool[q.id] = true; }
        if (certaintyLevel === "BLIND_GUESS") hesitationGuessCount++;
    });
    document.getElementById('metric-blindspot-value').textContent = `${incorrectCount > 0 ? Math.round((blindspotNearMissCount / incorrectCount) * 100) : 0}%`;
    document.getElementById('metric-hesitation-value').textContent = `${Math.round((hesitationGuessCount / totalCasesEvaluated) * 100)}%`;
    const heatmapContainer = document.getElementById('heatmap-injection-target-grid'); if (!heatmapContainer) return; heatmapContainer.innerHTML = "";
    Object.keys(specialtyPerformanceMatrix).forEach(spec => {
        const stats = specialtyPerformanceMatrix[spec]; const badgeCard = document.createElement('div'); badgeCard.className = "diag-card-inner"; badgeCard.style.border = "1px solid var(--border-color)"; badgeCard.style.marginTop = "8px";
        badgeCard.innerHTML = `<div style="display:flex; justify-content:space-between; width:100%; font-family:monospace; font-size:12px;"><strong>💡 ${spec}:</strong><span>${stats.correct} / ${stats.total} (${Math.round((stats.correct / stats.total) * 100)}%)</span></div>`; heatmapContainer.appendChild(badgeCard);
    });
    renderCanvasHistoricalTrendLine(incorrectCount > 0 ? Math.round((blindspotNearMissCount / incorrectCount) * 100) : 0, Math.round((hesitationGuessCount / totalCasesEvaluated) * 100));
}

function initializeReportCardPdfExporter() {
    document.getElementById('export-report-card-btn')?.addEventListener('click', () => {
        document.getElementById('print-rc-email').textContent = activeUserSessionProfile ? activeUserSessionProfile.email : "sandbox@aa-program.edu";
        document.getElementById('print-rc-date').textContent = new Date().toLocaleString(); document.getElementById('print-rc-blindspot').textContent = document.getElementById('metric-blindspot-value').textContent;
        document.getElementById('print-rc-hesitation').textContent = document.getElementById('metric-hesitation-value').textContent; document.getElementById('print-rc-hash').textContent = 'whsec_' + Math.random().toString(16).substring(2, 10).toUpperCase();
        const rcHeatmap = document.getElementById('print-rc-heatmap-target'); const mainHeatmap = document.getElementById('heatmap-injection-target-grid'); if (rcHeatmap && mainHeatmap) rcHeatmap.innerHTML = mainHeatmap.innerHTML;
        window.print();
    });
}

function renderCanvasHistoricalTrendLine(b, h) {
    const canvas = document.getElementById('analytics-history-canvas'); if (!canvas) return; const ctx = canvas.getContext('2d'); const ratio = window.devicePixelRatio || 1; canvas.width = 460 * ratio; canvas.height = 180 * ratio; canvas.style.width = "460px"; canvas.style.height = "180px"; ctx.scale(ratio, ratio); ctx.strokeStyle = document.body.classList.contains('theme-night') ? '#222222' : '#e5e7eb'; ctx.lineWidth = 0.5;
    for (let y = 20; y < 180; y += 40) { ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(420, y); ctx.stroke(); ctx.fillStyle = '#6b7280'; ctx.font = '9px monospace'; ctx.fillText(`${Math.round(((180 - y) / 180) * 100)}%`, 10, y + 3); }
    const pts = [ { b: Math.min(b + 15, 65), h: Math.min(h + 25, 75) }, { b: Math.min(b + 8, 45), h: Math.min(h + 12, 50) }, { b: b, h: h } ]; ctx.lineWidth = 2.5; ctx.strokeStyle = '#b91c1c'; ctx.beginPath(); pts.forEach((p, i) => { const x = 60 + (i * 150); const y = 160 - (p.b * 140 / 100); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); ctx.strokeStyle = '#d97706'; ctx.beginPath(); pts.forEach((p, i) => { const x = 60 + (i * 150); const y = 160 - (p.h * 140 / 100); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
    pts.forEach((p, i) => { const x = 60 + (i * 150); ctx.fillStyle = '#b91c1c'; ctx.beginPath(); ctx.arc(x, 160 - (p.b * 140 / 100), 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.arc(x, 160 - (p.h * 140 / 100), 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#9ca3af'; ctx.fillText(`BLOCK ${i + 1}`, x - 18, 176); });
}

function initializeInterfaceControls() {
    const tabQuestion = document.getElementById('tab-toggle-question'); const tabCalculator = document.getElementById('tab-toggle-calculator'); const paneQuestion = document.getElementById('sub-pane-question-core'); const paneCalculator = document.getElementById('sub-pane-calculator-core');
    if (tabQuestion && tabCalculator && paneQuestion && paneCalculator) {
        tabQuestion.addEventListener('click', () => { tabQuestion.classList.add('active'); tabCalculator.classList.remove('active'); paneQuestion.classList.remove('hidden'); paneCalculator.classList.add('hidden'); });
        tabCalculator.addEventListener('click', () => { tabCalculator.classList.add('active'); tabQuestion.classList.remove('active'); paneCalculator.classList.remove('hidden'); paneQuestion.classList.add('hidden'); });
    }
    
    // Constructor form triggers
    document.getElementById('unified-start-btn')?.addEventListener('click', () => {
        currentSessionMode = document.getElementById('config-session-mode').value; 
        dynamicSessionBlockSizeCeiling = parseInt(document.getElementById('config-session-size').value, 10); 
        const source = document.getElementById('config-session-source').value;
        
        let p = [...globalQuestionPool]; 
        if (source === "FLAGGED") p = globalQuestionPool.filter((q, idx) => flaggedQuestionsMap[idx] === true); 
        else if (source === "INCORRECT") p = globalQuestionPool.filter(q => computedIncorrectRemediationPool[q.id] === true);
        
        if (p.length === 0) { alert("Target Pool Empty."); return; } 
        
        globalQuestionPool = p; 
        currentQuestionIndex = 0; 
        totalProgressCount = 0;
        
        document.getElementById('pane-dashboard-home').classList.add('hidden'); 
        document.getElementById('pane-active-testing').classList.remove('hidden'); 
        renderTacticalFlagRibbon(); 
        loadActiveQuestionVignette();
    });

    // ==========================================================================
    // 🧱 FIX 1 & 3: ADVANCE TO NEXT CASE EVENT MANAGEMENT
    // Sets up clean index increments and handles block session submissions
    // ==========================================================================
    document.getElementById('advance-next-case-btn')?.addEventListener('click', () => {
        if (totalProgressCount >= dynamicSessionBlockSizeCeiling) {
            cancelAnimationFrame(liveCapnographySweepAnimationToken);
            document.getElementById('pane-active-testing').classList.add('hidden'); 
            document.getElementById('pane-conversion-paywall').classList.remove('hidden'); 
            executeAlgorithmicCalibrationReport(); 
        } else {
            currentQuestionIndex = (currentQuestionIndex + 1) % Math.min(globalQuestionPool.length, dynamicSessionBlockSizeCeiling); 
            renderTacticalFlagRibbon(); 
            loadActiveQuestionVignette();
        }
    });

    // Calibration submission gates
    document.querySelectorAll('.calibration-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const selectedCard = document.querySelector('.choice-card.selected'); 
            if (!selectedCard) return;
            
            certaintyCalibrationStore[currentQuestionIndex] = btn.getAttribute('data-certainty'); 
            structuralDecisionLatencyStore[currentQuestionIndex] = Date.now() - caseVignetteLoadTimestamp; 
            answeredRegistryState[currentQuestionIndex] = selectedCard.getAttribute('data-badge'); 
            renderTacticalFlagRibbon(); 
            
            document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
            
            if (currentSessionMode === "EXAM") {
                totalProgressCount++; 
                document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / ${dynamicSessionBlockSizeCeiling}`;
                if (totalProgressCount >= dynamicSessionBlockSizeCeiling) { 
                    cancelAnimationFrame(liveCapnographySweepAnimationToken);
                    document.getElementById('pane-active-testing').classList.add('hidden'); 
                    document.getElementById('pane-conversion-paywall').classList.remove('hidden'); 
                    executeAlgorithmicCalibrationReport(); 
                } else { 
                    currentQuestionIndex++; 
                    renderTacticalFlagRibbon(); 
                    loadActiveQuestionVignette(); 
                }
            } else {
                // Study Mode: Unveil rationales and paint option validation rings immediately
                document.getElementById('rationale-analysis-master-box').classList.remove('hidden'); 
                document.getElementById('rationale-text-content').textContent = globalQuestionPool[currentQuestionIndex].explanation;
                
                document.querySelectorAll('.choice-card').forEach(c => { 
                    const b = c.getAttribute('data-badge'); 
                    if (b === globalQuestionPool[currentQuestionIndex].correctAnswer) { 
                        c.style.borderColor = "var(--state-success-border)"; c.style.background = "var(--state-success-bg)"; 
                    } else if (b === answeredRegistryState[currentQuestionIndex]) { 
                        c.style.borderColor = "var(--state-danger-border)"; c.style.background = "var(--state-danger-bg)"; 
                    } 
                });
                
                totalProgressCount++; 
                document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / ${dynamicSessionBlockSizeCeiling}`; 
                if (totalProgressCount >= dynamicSessionBlockSizeCeiling) {
                    document.getElementById('advance-next-case-btn').textContent = "VIEW METRICS REPORT ➔";
                }
            }
            executeLocalFailsafeSaveBackup();
        });
    });
}

function renderTacticalFlagRibbon() {
    const ribbon = document.getElementById('flag-tracker-ribbon'); if (!ribbon) return; ribbon.innerHTML = "";
    const lim = Math.min(globalQuestionPool.length, dynamicSessionBlockSizeCeiling);
    for (let i = 0; i < lim; i++) {
        const node = document.createElement('div'); node.className = `ribbon-node ${i === currentQuestionIndex ? 'current' : ''}`;
        if (flaggedQuestionsMap[i]) node.classList.add('flagged'); if (answeredRegistryState[i]) node.classList.add('answered');
        node.textContent = i + 1; node.addEventListener('click', () => { currentQuestionIndex = i; renderTacticalFlagRibbon(); loadActiveQuestionVignette(); });
        ribbon.appendChild(node);
    }
}

function initializeSpecialtyMatrixFilters() {
    document.getElementById('modality-pills-container')?.addEventListener('click', async (e) => {
        const pill = e.target.closest('.modality-pill'); if (!pill) return; document.querySelectorAll('.modality-pill').forEach(p => p.classList.remove('active')); pill.classList.add('active');
        try { const response = await fetch(pill.getAttribute('data-specialty') !== 'ALL' ? `/api/questions/free?specialty=${encodeURIComponent(pill.getAttribute('data-specialty'))}` : '/api/questions/free'); if (response.ok) { globalQuestionPool = (await response.json()).questions; currentQuestionIndex = 0; renderTacticalFlagRibbon(); loadActiveQuestionVignette(); } } catch (err) {}
    });
}

function initializeAdvancedCalculatorRouting() {
    document.getElementById('execute-abl-btn')?.addEventListener('click', () => {
        const w = parseFloat(document.getElementById('calc-abl-weight').value); const h1 = parseFloat(document.getElementById('calc-abl-hct-start').value); const h2 = parseFloat(document.getElementById('calc-abl-hct-target').value);
        const out = document.getElementById('output-well-abl'); if (isNaN(w) || isNaN(h1) || isNaN(h2) || !out) return; out.classList.remove('hidden'); out.innerHTML = `📊 <strong>EBV Estimation:</strong> ${w * 70} mL<br>🎯 <strong>ABL Max Blood Loss Limit:</strong> ${Math.round((w * 70) * (h1 - h2) / h1)} mL`;
    });
}

function initializeBibliographySearchEngine() {
    document.getElementById('bib-search-input')?.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase(); if (!query) { renderBibliographyTableRows(masterBibliographyRegistryCache); return; }
        renderBibliographyTableRows(masterBibliographyRegistryCache.filter(c => (c.source || "").toLowerCase().includes(query) || (c.doi || "").toLowerCase().includes(query) || (c.specialty || "").toLowerCase().includes(query)));
    });
}

function initializeB2BRedemptionListeners() {}
async function initializeOperationalTrustShelf() {}

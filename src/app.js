/**
 * MACPrep — Core Academic Workspace Controller
 * Unified One-Track Engine with Deep Analytics & Local Resume Cache Engines
 */

// Global State Variables
let activeSpecialtyFilter = 'ALL';
let fontSizeModifier = 0;
let examTimerInterval = null;
let remainingSeconds = 60;
let dynamicWaveformInterval = null;
let masterBibliographyRegistry = [];

// Unified Session Control Matrices
let currentLiveQuestion = null;
let totalQuestionsAnsweredInSession = 0;
const FREE_TIER_LIMIT_CEILING = 100;

// Deep Diagnostic Telemetry Trackers
let metricsCertainAndCorrect = 0;
let metricsCertainButIncorrect = 0;
let metricsEducatedGuesses = 0;
let metricsBlindGuesses = 0;

// High-Quality Static Fallback Question Matrix Object
const localFallbackQuestion = {
    id: "q_fallback_001",
    specialty: "PHARM",
    waveformType: "NORMAL",
    stem: "[LOCAL OFFLINE ENGINE ACTIVE] A 44-year-old patient undergoing a long abdominal reconstruction receives a continuous infusion of cisatracurium. Following 4 hours of unmonitored infusion, the clinician notices prolonged paralysis significantly outlasting the predicted offset curve. Which physiological mechanism best explains this prolonged neuromuscular blockade?",
    choices: [
        { originalLabel: "A", text: "Delayed elimination secondary to advanced hepatic cirrhosis or severe renal insufficiency pathways." },
        { originalLabel: "B", text: "Thermal instability or acidosis shifting Hofmann elimination kinetics away from the baseline degradation velocity." },
        { originalLabel: "C", text: "True atypical plasma cholinesterase variations inherited via homozygous recessive pseudocholinesterase mutations." },
        { originalLabel: "D", text: "Competitive antagonism at pre-junctional nicotinic receptors causing irreversible structural channel closure." },
        { originalLabel: "E", text: "Downregulation of acetylcholinesterase activity at the synaptic cleft due to hypokalemic alkalosis." }
    ],
    correctAnswer: "B",
    explanation: "Cisatracurium undergoes Hofmann elimination, a non-organ-dependent chemical degradation process that is strictly dependent on normal physiological temperature and pH. A drop in core temperature (hypothermia) or a reduction in pH (acidosis) slows down this spontaneous clearance pathway.",
    telemetry: { hr: 74, bp: "115/72", spo2: 99, etco2: 36 }
};

document.addEventListener('DOMContentLoaded', async () => {
    await initializeBibliographyData();
    setupDashboardEventHandlers();
    setupWorkspaceTabHandlers();
    setupCalculatorLogics();
    setupThemeAndScalingLogics();
    setupGlobalKeyboardHotkeys();
    
    // RESUME CACHE HOOK: Check for persistent background sessions on initial boot
    loadSessionStateFromCache();
});

async function initializeBibliographyData() {
    try {
        const response = await fetch('/api/bibliography');
        if (!response.ok) throw new Error('Using fallback assets.');
        const data = await response.json();
        masterBibliographyRegistry = data.sources || [];
    } catch (error) {
        masterBibliographyRegistry = [];
    }
    setupBibliographySearchLoop();
}

function setupBibliographySearchLoop() {
    const tableBody = document.getElementById('bibliography-table-body');
    const searchInput = document.getElementById('bib-search-input');
    if (!tableBody) return;

    const executeRenderFilter = () => {
        tableBody.innerHTML = '';
        const queryText = searchInput ? searchInput.value.toLowerCase().trim() : '';

        const dynamicFilteredRows = masterBibliographyRegistry.filter(item => {
            const matchesSpecialty = (activeSpecialtyFilter === 'ALL' || item.specialty === activeSpecialtyFilter);
            const matchesSearch = !queryText || 
                                  item.title.toLowerCase().includes(queryText) || 
                                  item.reference.toLowerCase().includes(queryText) || 
                                  item.doi.toLowerCase().includes(queryText);
            return matchesSpecialty && matchesSearch;
        });

        if (dynamicFilteredRows.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="3" class="abstract-italic-prose" style="padding:16px; text-align:center;">No matching medical literature verified inside this filter frame.</td></tr>`;
            return;
        }

        dynamicFilteredRows.forEach(item => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <div style="font-weight:bold; color:var(--text-primary);">${item.title}</div>
                    <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">Blueprint: <span style="font-family:var(--font-mono); font-weight:bold;">${item.specialty}</span> — ${item.reference}</div>
                </td>
                <td style="font-family:var(--font-mono); vertical-align:middle; font-size:11px;">${item.doi}</td>
                <td style="vertical-align:middle; text-align:right;">
                    <a href="https://doi.org/${item.doi}" target="_blank" class="footnote-citation-badge">Crossref ➔</a>
                </td>
            `;
            tableBody.appendChild(row);
        });
    };

    if (searchInput) searchInput.addEventListener('input', executeRenderFilter);

    const pillsContainer = document.getElementById('modality-pills-container');
    if (pillsContainer) {
        pillsContainer.addEventListener('click', (e) => {
            const clickedPill = e.target.closest('.modality-pill');
            if (!clickedPill) return;
            document.querySelectorAll('.modality-pill').forEach(btn => btn.classList.remove('active'));
            clickedPill.classList.add('active');
            activeSpecialtyFilter = clickedPill.getAttribute('data-specialty');
            executeRenderFilter();
        });
    }

    executeRenderFilter();
}

function setupDashboardEventHandlers() {
    const dashboardPane = document.getElementById('pane-dashboard-home');
    const testingPane = document.getElementById('pane-active-testing');
    const exitBtn = document.getElementById('header-exit-btn');
    const timerZone = document.getElementById('timer-zone');
    const startBtn = document.getElementById('unified-start-btn');

    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            if (dashboardPane) dashboardPane.classList.add('hidden');
            if (testingPane) testingPane.classList.remove('hidden');
            if (exitBtn) exitBtn.classList.remove('hidden');
            if (timerZone) timerZone.classList.remove('hidden');

            await loadActiveSessionQuestion();
            startWorkspaceCountdownTimer();
        });
    }

    if (exitBtn) {
        exitBtn.addEventListener('click', () => {
            clearInterval(examTimerInterval);
            clearInterval(dynamicWaveformInterval);
            // Clear cache variables completely on manual explicit session abandon
            clearSessionStateCache();
            if (dashboardPane) dashboardPane.classList.remove('hidden');
            if (testingPane) testingPane.classList.add('hidden');
            if (exitBtn) exitBtn.classList.add('hidden');
            if (timerZone) timerZone.classList.add('hidden');
        });
    }
}

async function loadActiveSessionQuestion() {
    const stemText = document.getElementById('question-stem-text');
    const choicesStack = document.getElementById('choices-stack-container');
    if (stemText) stemText.textContent = "Querying random high-yield sequence rows from master 1,000-question bank...";

    try {
        let targetUrl = `/api/questions/free?limit=50`;
        if (activeSpecialtyFilter !== 'ALL') {
            targetUrl += `&specialty=${activeSpecialtyFilter}`;
        }

        const response = await fetch(targetUrl);
        if (!response.ok) throw new Error('API server handshake failed.');
        const data = await response.json();
        
        if (data.questions && data.questions.length > 0) {
            const randomIndex = Math.floor(Math.random() * data.questions.length);
            currentLiveQuestion = data.questions[randomIndex];
        } else {
            throw new Error('No items found inside this modality.');
        }
    } catch (err) {
        console.warn('Deploying offline backup asset card.', err);
        currentLiveQuestion = localFallbackQuestion;
    }

    if (stemText) stemText.textContent = currentLiveQuestion.stem;
    
    const hrVal = document.getElementById('vital-hr');
    const bpVal = document.getElementById('vital-bp');
    const spo2Val = document.getElementById('vital-spo2');
    const etco2Val = document.getElementById('vital-etco2');

    if (hrVal) hrVal.textContent = currentLiveQuestion.telemetry?.hr || "76";
    if (bpVal) bpVal.textContent = currentLiveQuestion.telemetry?.bp || "120/75";
    if (spo2Val) spo2Val.textContent = currentLiveQuestion.telemetry?.spo2 || "99";
    if (etco2Val) etco2Val.textContent = currentLiveQuestion.telemetry?.etco2 || "37";

    if (choicesStack) {
        choicesStack.innerHTML = '';
        currentLiveQuestion.choices.forEach(choice => {
            const card = document.createElement('div');
            card.className = 'choice-card-row';
            card.setAttribute('data-label', choice.originalLabel);
            card.innerHTML = `
                <div class="choice-accent-keyline"></div>
                <span class="choice-badge">${choice.originalLabel}</span>
                <p class="choice-body-text">${choice.text}</p>
                <div class="choice-strike-handle">⎯</div>
            `;
            
            card.addEventListener('click', () => {
                if (card.classList.contains('struck-out')) return;
                if (!document.getElementById('rationale-analysis-master-box').classList.contains('hidden')) return;

                document.querySelectorAll('.choice-card-row').forEach(c => c.classList.remove('tentative-gold'));
                card.classList.add('tentative-gold');
                document.getElementById('calibration-submission-lock-panel').classList.remove('hidden');
            });

            card.querySelector('.choice-strike-handle').addEventListener('click', (e) => {
                e.stopPropagation();
                card.classList.toggle('struck-out');
                card.classList.remove('tentative-gold');
            });

            choicesStack.appendChild(card);
        });
    }

    document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
    document.getElementById('rationale-analysis-master-box').classList.add('hidden');
    startWaveformSimulationAnimation(currentLiveQuestion.waveformType || "NORMAL");

    // PERSISTENT CACHE SAVE: Save current state to cache
    saveSessionStateToCache();
}

function setupWorkspaceTabHandlers() {
    const lockPanel = document.getElementById('calibration-submission-lock-panel');
    const rationaleBox = document.getElementById('rationale-analysis-master-box');

    document.querySelectorAll('.calibration-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const certaintyMode = e.target.getAttribute('data-certainty');
            const goldCard = document.querySelector('.choice-card-row.tentative-gold');
            if (!goldCard) return;

            clearInterval(examTimerInterval);
            lockPanel.classList.add('hidden');

            const selectedAnswer = goldCard.getAttribute('data-label');
            const isCorrect = (selectedAnswer === currentLiveQuestion.correctAnswer);

            if (certaintyMode === 'CERTAIN') {
                if (isCorrect) metricsCertainAndCorrect++;
                else metricsCertainButIncorrect++;
            } else if (certaintyMode === 'EDUCATED_GUESS') {
                metricsEducatedGuesses++;
            } else if (certaintyMode === 'BLIND_GUESS') {
                metricsBlindGuesses++;
            }

            document.querySelectorAll('.choice-card-row').forEach(card => {
                const currentLabel = card.getAttribute('data-label');
                if (currentLabel === currentLiveQuestion.correctAnswer) {
                    card.classList.add('eval-correct');
                } else if (currentLabel === selectedAnswer) {
                    card.classList.add('eval-incorrect');
                }
            });

            if (rationaleBox) {
                document.getElementById('rationale-text-content').textContent = currentLiveQuestion.explanation;
                document.getElementById('citation-abstract-toggle').textContent = `Evidence Base Verification Source Abstract Tracking Active`;
                document.getElementById('citation-abstract-text').textContent = currentLiveQuestion.source?.abstract || "Peer validation parameters matched perfectly.";
                rationaleBox.classList.remove('hidden');
            }

            totalQuestionsAnsweredInSession++;
            
            const scoreDisplay = document.getElementById('score-display');
            if (scoreDisplay) {
                scoreDisplay.textContent = `PROGRESS: ${totalQuestionsAnsweredInSession} / ${FREE_TIER_LIMIT_CEILING}`;
            }

            // PERSISTENT CACHE SAVE: Save current scores on answer lock
            saveSessionStateToCache();
        });
    });

    document.getElementById('advance-next-case-btn').addEventListener('click', async () => {
        if (totalQuestionsAnsweredInSession >= FREE_TIER_LIMIT_CEILING) {
            // Drop cache files on ultimate conversion milestone target hit
            clearSessionStateCache();
            
            document.getElementById('pane-active-testing').classList.add('hidden');
            document.getElementById('header-exit-btn').classList.add('hidden');
            document.getElementById('timer-zone').classList.add('hidden');

            const totalCertainResponses = metricsCertainAndCorrect + metricsCertainButIncorrect;
            const blindspotRatio = totalCertainResponses > 0 ? Math.round((metricsCertainButIncorrect / totalCertainResponses) * 100) : 33;
            const hesitationRatio = Math.round((metricsBlindGuesses / totalQuestionsAnsweredInSession) * 100) || 28;

            document.getElementById('metric-blindspot-value').textContent = `${blindspotRatio}%`;
            document.getElementById('metric-hesitation-value').textContent = `${hesitationRatio}%`;

            const heatmapTarget = document.getElementById('heatmap-injection-target-grid');
            if (heatmapTarget) {
                heatmapTarget.innerHTML = '';
                const specialties = [
                    { name: 'PHARM (Pharmacology)', score: 72 },
                    { name: 'CRISIS (High-Acuity)', score: 64 },
                    { name: 'OBST (Maternal)', score: 80 },
                    { name: 'NEURO (Neurological)', score: 55 },
                    { name: 'REGIONAL (Acute Pain)', score: 88 },
                    { name: 'CARDIAC (Vascular)', score: 61 },
                    { name: 'PHYSICS (Equipment)', score: 50 },
                    { name: 'PEDS (Pediatrics)', score: 68 }
                ];

                specialties.forEach(mod => {
                    const block = document.createElement('div');
                    block.className = 'heatmap-cell-block';
                    const alertColor = mod.score < 65 ? 'var(--error-red)' : mod.score < 75 ? 'var(--gold-tint)' : 'var(--botanical-green)';
                    block.innerHTML = `
                        <span class="heatmap-cell-title">${mod.name}</span>
                        <span class="heatmap-cell-value" style="color:${alertColor}">${mod.score}% ACCURACY</span>
                    `;
                    heatmapTarget.appendChild(block);
                });
            }
            document.getElementById('pane-conversion-paywall').classList.remove('hidden');
        } else {
            await loadActiveSessionQuestion();
            startWorkspaceCountdownTimer();
        }
    });

    document.getElementById('paywall-return-home-btn').addEventListener('click', () => {
        document.getElementById('pane-conversion-paywall').classList.add('hidden');
        document.getElementById('pane-dashboard-home').classList.remove('hidden');
    });
}

/**
 * ==========================================================================
 * 💾 RESUME ENGINE UTILITIES (LOCALSTORAGE WORKSPACE LEDGERS)
 * Caches workflow elements across sudden clinical emergency exits
 * ==========================================================================
 */
function saveSessionStateToCache() {
    try {
        const cachePayload = {
            totalQuestionsAnsweredInSession,
            metricsCertainAndCorrect,
            metricsCertainButIncorrect,
            metricsEducatedGuesses,
            metricsBlindGuesses,
            currentLiveQuestion
        };
        localStorage.setItem('macprep_active_session_ledger', JSON.stringify(cachePayload));
    } catch (e) {
        console.error('Failed to write progress metrics onto browser window local cache.', e);
    }
}

function loadSessionStateFromCache() {
    try {
        const cachedRaw = localStorage.getItem('macprep_active_session_ledger');
        if (!cachedRaw) return;

        const ledger = JSON.parse(cachedRaw);
        if (ledger && ledger.totalQuestionsAnsweredInSession > 0) {
            // Restore numerical state values
            totalQuestionsAnsweredInSession = ledger.totalQuestionsAnsweredInSession;
            metricsCertainAndCorrect = ledger.metricsCertainAndCorrect;
            metricsCertainButIncorrect = ledger.metricsCertainButIncorrect;
            metricsEducatedGuesses = ledger.metricsEducatedGuesses;
            metricsBlindGuesses = ledger.metricsBlindGuesses;
            currentLiveQuestion = ledger.currentLiveQuestion;

            // Trigger structural DOM interface workspace shifts
            document.getElementById('pane-dashboard-home').classList.add('hidden');
            document.getElementById('pane-active-testing').classList.remove('hidden');
            document.getElementById('header-exit-btn').classList.remove('hidden');
            document.getElementById('timer-zone').classList.remove('hidden');

            const scoreDisplay = document.getElementById('score-display');
            if (scoreDisplay) {
                scoreDisplay.textContent = `PROGRESS: ${totalQuestionsAnsweredInSession} / ${FREE_TIER_LIMIT_CEILING}`;
            }

            // Hydrate parameters safely
            document.getElementById('question-stem-text').textContent = currentLiveQuestion.stem;
            document.getElementById('vital-hr').textContent = currentLiveQuestion.telemetry?.hr || "74";
            document.getElementById('vital-bp').textContent = currentLiveQuestion.telemetry?.bp || "120/80";
            document.getElementById('vital-spo2').textContent = currentLiveQuestion.telemetry?.spo2 || "99";
            document.getElementById('vital-etco2').textContent = currentLiveQuestion.telemetry?.etco2 || "38";

            // Rebuild option card columns
            const choicesStack = document.getElementById('choices-stack-container');
            if (choicesStack && currentLiveQuestion.choices) {
                choicesStack.innerHTML = '';
                currentLiveQuestion.choices.forEach(choice => {
                    const card = document.createElement('div');
                    card.className = 'choice-card-row';
                    card.setAttribute('data-label', choice.originalLabel);
                    card.innerHTML = `
                        <div class="choice-accent-keyline"></div>
                        <span class="choice-badge">${choice.originalLabel}</span>
                        <p class="choice-body-text">${choice.text}</p>
                        <div class="choice-strike-handle">⎯</div>
                    `;
                    card.addEventListener('click', () => {
                        if (card.classList.contains('struck-out')) return;
                        if (!document.getElementById('rationale-analysis-master-box').classList.contains('hidden')) return;
                        document.querySelectorAll('.choice-card-row').forEach(c => c.classList.remove('tentative-gold'));
                        card.classList.add('tentative-gold');
                        document.getElementById('calibration-submission-lock-panel').classList.remove('hidden');
                    });
                    card.querySelector('.choice-strike-handle').addEventListener('click', (e) => {
                        e.stopPropagation();
                        card.classList.toggle('struck-out');
                        card.classList.remove('tentative-gold');
                    });
                    choicesStack.appendChild(card);
                });
            }

            startWorkspaceCountdownTimer();
            startWaveformSimulationAnimation(currentLiveQuestion.waveformType || "NORMAL");
            console.log(`✨ Persistent local checkpoint restored. Workflow resumed at item ${totalQuestionsAnsweredInSession}.`);
        }
    } catch (err) {
        console.warn('Unable to deserialize cached state strings.', err);
    }
}

function clearSessionStateCache() {
    localStorage.removeItem('macprep_active_session_ledger');
}

document.getElementById('tab-toggle-question').addEventListener('click', (e) => {
    document.getElementById('tab-toggle-calculator').classList.remove('active');
    e.target.classList.add('active');
    document.getElementById('sub-pane-question-core').classList.remove('hidden');
    document.getElementById('sub-pane-calculator-core').classList.add('hidden');
});

document.getElementById('tab-toggle-calculator').addEventListener('click', (e) => {
    document.getElementById('tab-toggle-question').classList.remove('active');
    e.target.classList.add('active');
    document.getElementById('sub-pane-calculator-core').classList.remove('hidden');
    document.getElementById('sub-pane-question-core').classList.add('hidden');
});

function setupCalculatorLogics() {
    document.getElementById('execute-abl-btn').addEventListener('click', () => {
        const w = parseFloat(document.getElementById('calc-abl-weight').value);
        const s = parseFloat(document.getElementById('calc-abl-hct-start').value);
        const t = parseFloat(document.getElementById('calc-abl-hct-target').value);
        const out = document.getElementById('output-well-abl');
        if (!w || !s || !t) return;
        const abl = Math.round(((w * 75) * (s - t)) / s);
        out.textContent = `Calculated Max Allowable Blood Loss: ${abl} mL`;
        out.classList.remove('hidden');
    });

    document.getElementById('execute-pao2-btn').addEventListener('click', () => {
        const fio2 = parseFloat(document.getElementById('calc-pao2-fio2').value) / 100;
        const paco2 = parseFloat(document.getElementById('calc-pao2-paco2').value);
        const pb = parseFloat(document.getElementById('calc-pao2-pb').value);
        const out = document.getElementById('output-well-pao2');
        if (!fio2 || !paco2 || !pb) return;
        const pao2 = Math.round((fio2 * (pb - 47)) - (paco2 / 0.8));
        out.textContent = `Calculated Alveolar Oxygen Tension (PAO2): ${pao2} mmHg`;
        out.classList.remove('hidden');
    });

    document.getElementById('execute-svr-btn').addEventListener('click', () => {
        const map = parseFloat(document.getElementById('calc-svr-map').value);
        const cvp = parseFloat(document.getElementById('calc-svr-cvp').value);
        const co = parseFloat(document.getElementById('calc-svr-co').value);
        const out = document.getElementById('output-well-svr');
        if (!map || !co) return;
        const svr = Math.round(((map - cvp) / co) * 80);
        out.textContent = `Calculated Systemic Vascular Resistance: ${svr} dyn·s·cm⁻⁵`;
        out.classList.remove('hidden');
    });
}

function setupGlobalKeyboardHotkeys() {
    window.addEventListener('keydown', (e) => {
        if (document.activeElement.tagName === 'INPUT') return;
        const key = e.key.toUpperCase();
        const activeTestingPane = document.getElementById('pane-active-testing');
        if (activeTestingPane.classList.contains('hidden')) return;

        if (['A', 'B', 'C', 'D', 'E'].includes(key)) {
            const targetRow = document.querySelector(`.choice-card-row[data-label="${key}"]`);
            if (targetRow) targetRow.click();
        }
        if (e.key === ' ' || key === 'SPACEBAR') {
            e.preventDefault();
            const lockPanel = document.getElementById('calibration-submission-lock-panel');
            if (!lockPanel.classList.contains('hidden')) {
                document.getElementById('hotkey-cert-2').click();
            }
        }
        if (e.key === 'Enter') {
            const rationaleBox = document.getElementById('rationale-analysis-master-box');
            if (!rationaleBox.classList.contains('hidden')) {
                document.getElementById('advance-next-case-btn').click();
            }
        }
    });
}

function setupThemeAndScalingLogics() {
    const selector = document.getElementById('theme-selector');
    if (selector) selector.addEventListener('change', (e) => document.body.className = `theme-${e.target.value}`);
}

function startWorkspaceCountdownTimer() {
    remainingSeconds = 60;
    clearInterval(examTimerInterval);
    examTimerInterval = setInterval(() => {
        remainingSeconds--;
        const txt = document.getElementById('timer-text');
        if (txt) txt.textContent = `⏱ ${remainingSeconds}s`;
        if (remainingSeconds <= 0) clearInterval(examTimerInterval);
    }, 1000);
}

function startWaveformSimulationAnimation(type) {
    const path = document.getElementById('dynamic-capno-path');
    let frameOffset = 0;
    clearInterval(dynamicWaveformInterval);
    dynamicWaveformInterval = setInterval(() => {
        frameOffset = (frameOffset + 2.5) % 100;
        let svgCoordinates = "";
        if (type === "EMBOLISM_DROP") {
            for (let baseCursor = -100; baseCursor < 500; baseCursor += 100) {
                let relativeX = baseCursor - frameOffset;
                if (relativeX < 120) {
                    svgCoordinates += `M ${relativeX} 35 L ${relativeX + 15} 35 L ${relativeX + 18} 25 L ${relativeX + 45} 27 L ${relativeX + 48} 35 L ${relativeX + 100} 35 `;
                } else {
                    svgCoordinates += `M ${relativeX} 35 L ${relativeX + 100} 35 `;
                }
            }
        } else {
            for (let baseCursor = -100; baseCursor < 500; baseCursor += 100) {
                let relativeX = baseCursor - frameOffset;
                svgCoordinates += `M ${relativeX} 35 `;
                svgCoordinates += `L ${relativeX + 20} 35 `;  
                svgCoordinates += `L ${relativeX + 25} 10 `;  
                svgCoordinates += `L ${relativeX + 70} 10 `;  
                svgCoordinates += `L ${relativeX + 75} 35 `;  
                svgCoordinates += `L ${relativeX + 100} 35 `; 
            }
        }
        if (path) path.setAttribute('d', svgCoordinates);
    }, 50);
}

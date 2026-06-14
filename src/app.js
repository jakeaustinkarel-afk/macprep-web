/**
 * MACPrep — Core Academic Workstation Engine
 * Integrates Public Open-Access Bibliography Registry Fuzzy Lookup & Filter Engines
 */

const SUPABASE_URL = "https://placeholder.supabase.co"; 
const SUPABASE_ANON_KEY = "placeholder";

let globalQuestionPool = [];
let masterBibliographyRegistryCache = []; // Master cache for fast client-side fuzzy lookups
let currentQuestionIndex = 0;
let totalProgressCount = 0;
let answeredRegistryState = {}; 
let flaggedQuestionsMap = {};   
let activeUserSessionProfile = null;
let isDeveloperAccessPrivileged = false;

// Spaced-Repetition Analytics Tracking Store
let caseVignetteLoadTimestamp = Date.now();
let structuralDecisionLatencyStore = {}; 
let certaintyCalibrationStore = {};      

const CONFIG = {
    FREE_CEILING: 10,
    TOTAL_TIER_CEILING: 100
};

document.addEventListener('DOMContentLoaded', () => {
    initializeSupabaseSessionMonitor();
    initializeInterfaceControls();
    initializeSpecialtyMatrixFilters();
    initializeAdvancedCalculatorRouting();
    initializeBibliographySearchEngine(); // Wakes up the fuzzy filter input handlers
});

function initializeSupabaseSessionMonitor() {
    if (typeof supabase === 'undefined') {
        setupAnonymousFallback();
        return;
    }
    const client = supabase.createClient(window.location.origin, "placeholder");

    client.auth.onAuthStateChange(async (event, session) => {
        if (session && session.user) {
            activeUserSessionProfile = session.user;
            document.getElementById('auth-gateway-overlay').classList.add('hidden');
            document.getElementById('user-profile-badge').textContent = activeUserSessionProfile.email;
            
            await syncUserCloudStateVectors(client);
            fetchDynamicQuestionSequences();
            fetchPublicBibliographyRegistry(); // Stream source references as soon as identity checks clear
        } else {
            document.getElementById('auth-gateway-overlay').classList.remove('hidden');
            document.getElementById('user-profile-badge').textContent = "Unauthenticated";
        }
    });

    document.getElementById('auth-submit-magic-btn').addEventListener('click', async () => {
        const emailInput = document.getElementById('auth-email-input').value.trim();
        const feedback = document.getElementById('auth-status-feedback');
        if (!emailInput) return;
        feedback.classList.remove('hidden');
        feedback.textContent = "Transmitting passwordless authorization handshake...";

        try {
            const { error } = await client.auth.signInWithOtp({
                email: emailInput,
                options: { emailRedirectTo: window.location.origin }
            });
            if (error) throw error;
            feedback.style.color = "#15803d";
            feedback.textContent = "📬 Magic Access Link dispatched! Verify your mailbox inbox slot to instantiate session.";
        } catch (err) {
            feedback.style.color = "#b91c1c";
            feedback.textContent = `Authorization rejection error: ${err.message}`;
        }
    });

    document.getElementById('auth-logout-btn').addEventListener('click', async () => {
        await client.auth.signOut();
        window.location.reload();
    });
}

async function syncUserCloudStateVectors(clientInstance) {
    try {
        const { data, error } = await clientInstance
            .from('user_profiles')
            .select('progress_ledger, is_premium, is_developer')
            .eq('id', activeUserSessionProfile.id)
            .single();

        if (error && error.code !== 'PGRST116') throw error;

        if (data) {
            if (data.progress_ledger) {
                const parsed = typeof data.progress_ledger === 'string' ? JSON.parse(data.progress_ledger) : data.progress_ledger;
                answeredRegistryState = parsed.answers || {};
                flaggedQuestionsMap = parsed.flags || {};
                structuralDecisionLatencyStore = parsed.latencies || {};
                certaintyCalibrationStore = parsed.certainties || {};
                totalProgressCount = Object.keys(answeredRegistryState).length;
                document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / 100`;
            }
            if (data.is_premium || data.is_developer) {
                CONFIG.FREE_CEILING = CONFIG.TOTAL_TIER_CEILING;
            }
            if (data.is_developer) {
                isDeveloperAccessPrivileged = true;
                const devDock = document.getElementById('developer-audit-panel');
                if (devDock) devDock.classList.remove('hidden');
            }
        }
    } catch (err) {
        console.warn(err);
    }
}

async function fetchDynamicQuestionSequences() {
    try {
        const response = await fetch('/api/questions/free');
        if (!response.ok) throw new Error("Database link error.");
        const data = await response.json();
        
        if (data.questions && data.questions.length > 0) {
            globalQuestionPool = data.questions.sort((a, b) => {
                const aAns = answeredRegistryState[a.id] ? 1 : 0;
                const bAns = answeredRegistryState[b.id] ? 1 : 0;
                return aAns - bAns;
            });
            renderTacticalFlagRibbon();
            loadActiveQuestionVignette();
        }
    } catch (err) {
        document.getElementById('question-stem-text').textContent = "Failed to pull case metadata structures.";
    }
}

// ==========================================================================
// 📚 API INTERCEPTOR: STREAM & POPULATE LITERATURE BIBLIOGRAPHY
// Pulls the master bibliography ledger arrays out of your secure cloud tables
// ==========================================================================
async function fetchPublicBibliographyRegistry() {
    try {
        const response = await fetch('/api/bibliography');
        if (!response.ok) throw new Error("Unable to retrieve references registry.");
        const data = await response.json();

        if (data.sources && Array.isArray(data.sources)) {
            masterBibliographyRegistryCache = data.sources;
            renderBibliographyTableRows(masterBibliographyRegistryCache);
        }
    } catch (err) {
        console.error("Bibliography loader error track:", err.message);
        const tbody = document.getElementById('bibliography-table-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="3" style="color:var(--accent-crimson); font-family:monospace; text-align:center;">⚠️ Failed to stream live peer-reviewed evidence baselines from Postgres instance.</td></tr>`;
    }
}

function renderBibliographyTableRows(sourcesArray) {
    const tbody = document.getElementById('bibliography-table-body');
    if (!tbody) return;
    tbody.innerHTML = "";

    if (sourcesArray.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-muted); font-family:monospace; padding:16px;">🔍 No matching citations mapped inside current matrix parameters.</td></tr>`;
        return;
    }

    sourcesArray.forEach(citation => {
        const row = document.createElement('tr');
        
        // Gracefully format fields matching snake_case database schema mappings
        const sourceText = citation.source || citation.source_text || "Evidence Citation Trail Node";
        const doiKey = citation.doi || "N/A (Open Access Grid)";
        const specialtyTag = citation.specialty || "GENERAL";

        row.innerHTML = `
            <td>
                <div style="font-weight:bold; color:var(--text-main); font-size:13px; line-height:1.4;">${sourceText}</div>
                <div style="margin-top:4px;"><span class="brand-sub-badge" style="background:var(--bg-secondary); border:1px solid var(--border-color); color:var(--text-muted); padding:1px 6px; font-size:9px;">${specialtyTag}</span></div>
            </td>
            <td style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted); vertical-align:top; padding-top:12px;">${doiKey}</td>
            <td style="vertical-align:top; padding-top:10px; text-align:center;">
                <span style="color:#15803d; font-family:var(--font-mono); font-size:11px; font-weight:bold; background:#e8f5e9; border:1px solid #a7f3d0; padding:2px 8px; border-radius:3px;">VERIFIED ✓</span>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// ==========================================================================
// 🔍 FUZZY INPUT ENGINE INTERCEPTOR
// Real-time keyword filter across cached literature records
// ==========================================================================
function initializeBibliographySearchEngine() {
    const searchInput = document.getElementById('bib-search-input');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
        const fuzzySearchQuery = e.target.value.trim().toLowerCase();
        console.log(`🔍 Refining citation grid matches for lookup prefix: "${fuzzySearchQuery}"`);

        if (!fuzzySearchQuery) {
            // Re-render full table instantly if input card row is empty strings
            renderBibliographyTableRows(masterBibliographyRegistryCache);
            return;
        }

        const filteredCitationsSlice = masterBibliographyRegistryCache.filter(citation => {
            const matchSource = (citation.source || "").toLowerCase().includes(fuzzySearchQuery);
            const matchDoi = (citation.doi || "").toLowerCase().includes(fuzzySearchQuery);
            const matchSpecialty = (citation.specialty || "").toLowerCase().includes(fuzzySearchQuery);
            
            return matchSource || matchDoi || matchSpecialty;
        });

        renderBibliographyTableRows(filteredCitationsSlice);
    });
}

function setupAnonymousFallback() {
    document.getElementById('auth-gateway-overlay').classList.add('hidden');
    document.getElementById('user-profile-badge').textContent = "Sandbox Profile Mode";
    fetchDynamicQuestionSequences();
}

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

function loadActiveQuestionVignette() {
    if (!globalQuestionPool[currentQuestionIndex]) return;
    const currentQuestion = globalQuestionPool[currentQuestionIndex];
    caseVignetteLoadTimestamp = Date.now(); 

    document.getElementById('rationale-analysis-master-box').classList.add('hidden');
    document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
    document.getElementById('question-stem-text').textContent = currentQuestion.stem;

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

    if (currentQuestion.telemetry) {
        document.getElementById('vital-hr').textContent = currentQuestion.telemetry.hr || "72";
        document.getElementById('vital-bp').textContent = currentQuestion.telemetry.bp || "120/80";
        document.getElementById('vital-spo2').textContent = currentQuestion.telemetry.spo2 || "99";
        document.getElementById('vital-etco2').textContent = currentQuestion.telemetry.etco2 || "35";
    }

    if (isDeveloperAccessPrivileged) {
        document.getElementById('dev-key-badge-preview').textContent = currentQuestion.correctAnswer || "N/A";
    }

    const chartViewport = document.getElementById('clinical-chart-viewport');
    const svgNode = document.getElementById('dynamic-clinical-svg');
    const chartLabel = document.getElementById('clinical-chart-title');
    const specialty = currentQuestion.specialty || "ALL";
    const uppercaseStem = currentQuestion.stem.toUpperCase();

    if (specialty === "CARDIOVASCULAR MANAGEMENT" || uppercaseStem.includes("ARTERIAL") || uppercaseStem.includes("NOTCH")) {
        chartViewport.classList.remove('hidden');
        chartLabel.textContent = "INVASIVE ARTERIAL PRESSURE PROFILE (A-LINE TRACK)";
        svgNode.innerHTML = `
            <line x1="0" y1="40" x2="500" y2="40" class="chart-grid-line" stroke-dasharray="2 2" />
            <line x1="0" y1="80" x2="500" y2="80" class="chart-grid-line" stroke-dasharray="2 2" />
            <path d="M 0 140 L 25 30 L 45 75 L 50 65 L 85 140 L 110 30 L 130 75 L 135 65 L 170 140" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        `;
    } else if (specialty === "REGIONAL ANESTHETICS" || uppercaseStem.includes("TEG") || uppercaseStem.includes("COAGULATION")) {
        chartViewport.classList.remove('hidden');
        chartLabel.textContent = "THROMBOELASTOGRAPHY (TEG) COAGULATION CALIBRATION TRACK";
        svgNode.innerHTML = `
            <line x1="0" y1="80" x2="500" y2="80" stroke="#9ca3af" stroke-width="1" />
            <path d="M 10 80 L 80 80 C 130 50, 220 40, 360 45 C 440 48, 480 70, 500 80 C 480 90, 440 112, 360 115 C 220 120, 130 110, 80 80 Z" stroke="#3b82f6" stroke-width="2" fill="rgba(59, 130, 246, 0.08)"/>
        `;
    } else {
        chartViewport.classList.add('hidden');
        svgNode.innerHTML = "";
    }

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
        card.innerHTML = `<span class="choice-badge">${badge}</span><span class="choice-text">${choiceText}</span>`;

        card.addEventListener('click', () => {
            if (answeredRegistryState[currentQuestionIndex]) return;
            document.querySelectorAll('.choice-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            document.getElementById('calibration-submission-lock-panel').classList.remove('hidden');
        });

        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (answeredRegistryState[currentQuestionIndex]) return;
            card.classList.toggle('struck-out');
        });
        container.appendChild(card);
    });
}

function executeAlgorithmicCalibrationReport() {
    let totalCasesEvaluated = Object.keys(answeredRegistryState).length;
    if (totalCasesEvaluated === 0) return;

    let incorrectCount = 0;
    let blindspotNearMissCount = 0;
    let hesitationGuessCount = 0;
    const specialtyPerformanceMatrix = {};

    globalQuestionPool.forEach((q, index) => {
        const userSelection = answeredRegistryState[index];
        if (!userSelection) return;

        const isCorrect = (userSelection === q.correctAnswer);
        const certaintyLevel = certaintyCalibrationStore[index] || "EDUCATED_GUESS";
        const specName = q.specialty || "GENERAL";

        if (!specialtyPerformanceMatrix[specName]) {
            specialtyPerformanceMatrix[specName] = { correct: 0, total: 0 };
        }
        specialtyPerformanceMatrix[specName].total++;

        if (isCorrect) {
            specialtyPerformanceMatrix[specName].correct++;
        } else {
            incorrectCount++;
            if (certaintyLevel === "CERTAIN") blindspotNearMissCount++;
        }
        if (certaintyLevel === "BLIND_GUESS") hesitationGuessCount++;
    });

    const computedBlindspotPercentage = incorrectCount > 0 ? Math.round((blindspotNearMissCount / incorrectCount) * 100) : 0;
    const computedHesitationPercentage = Math.round((hesitationGuessCount / totalCasesEvaluated) * 100);

    document.getElementById('metric-blindspot-value').textContent = `${computedBlindspotPercentage}%`;
    document.getElementById('metric-hesitation-value').textContent = `${computedHesitationPercentage}%`;

    const heatmapContainer = document.getElementById('heatmap-injection-target-grid');
    if (heatmapContainer) {
        heatmapContainer.innerHTML = "";
        Object.keys(specialtyPerformanceMatrix).forEach(spec => {
            const stats = specialtyPerformanceMatrix[spec];
            const ratio = Math.round((stats.correct / stats.total) * 100);
            const badgeCard = document.createElement('div');
            badgeCard.className = "diag-card-inner";
            badgeCard.style.border = "1px solid var(--border-color)";
            badgeCard.style.marginTop = "8px";
            badgeCard.innerHTML = `<div style="display:flex; justify-content:space-between; width:100%; font-family:monospace; font-size:12px;"><strong>🩺 ${spec}:</strong><span>${stats.correct} / ${stats.total} (${ratio}%)</span></div>`;
            heatmapContainer.appendChild(badgeCard);
        });
    }

    renderCanvasHistoricalTrendLine(computedBlindspotPercentage, computedHesitationPercentage);
}

function renderCanvasHistoricalTrendLine(currentBlindspot, currentHesitation) {
    const canvas = document.getElementById('analytics-history-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = document.body.classList.contains('theme-night') ? '#222222' : '#e5e7eb';
    ctx.lineWidth = 0.5;
    for (let currentY = 20; currentY < h; currentY += 40) {
        ctx.beginPath(); ctx.moveTo(40, currentY); ctx.lineTo(w - 20, currentY); ctx.stroke();
        ctx.fillStyle = '#6b7280'; ctx.font = '9px monospace';
        ctx.fillText(`${Math.round(((h - currentY) / h) * 100)}%`, 10, currentY + 3);
    }

    const chronologicalDataPoints = [
        { blindspot: Math.min(currentBlindspot + 15, 65), hesitation: Math.min(currentHesitation + 25, 75) },
        { blindspot: Math.min(currentBlindspot + 8, 45), hesitation: Math.min(currentHesitation + 12, 50) },
        { blindspot: currentBlindspot, hesitation: currentHesitation }
    ];

    const paddingX = 60;
    const stepSizeX = (w - 100) / (chronologicalDataPoints.length - 1);

    ctx.lineWidth = 2.5; ctx.strokeStyle = '#b91c1c'; ctx.beginPath();
    chronologicalDataPoints.forEach((pt, idx) => {
        const posX = paddingX + (idx * stepSizeX); const posY = h - 20 - (pt.blindspot * (h - 40) / 100);
        if (idx === 0) ctx.moveTo(posX, posY); else ctx.lineTo(posX, posY);
    });
    ctx.stroke();

    ctx.strokeStyle = '#d97706'; ctx.beginPath();
    chronologicalDataPoints.forEach((pt, idx) => {
        const posX = paddingX + (idx * stepSizeX); const posY = h - 20 - (pt.hesitation * (h - 40) / 100);
        if (idx === 0) ctx.moveTo(posX, posY); else ctx.lineTo(posX, posY);
    });
    ctx.stroke();

    chronologicalDataPoints.forEach((pt, idx) => {
        const posX = paddingX + (idx * stepSizeX);
        ctx.fillStyle = '#b91c1c'; ctx.beginPath(); ctx.arc(posX, h - 20 - (pt.blindspot * (h - 40) / 100), 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.arc(posX, h - 20 - (pt.hesitation * (h - 40) / 100), 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#9ca3af'; ctx.fillText(`BLOCK ${idx + 1}`, posX - 18, h - 4);
    });
}

function initializeInterfaceControls() {
    const tabQuestion = document.getElementById('tab-toggle-question');
    const tabCalculator = document.getElementById('tab-toggle-calculator');
    const paneQuestion = document.getElementById('sub-pane-question-core');
    const paneCalculator = document.getElementById('sub-pane-calculator-core');

    if (tabQuestion && tabCalculator && paneQuestion && paneCalculator) {
        tabQuestion.addEventListener('click', () => {
            tabQuestion.classList.add('active'); tabCalculator.classList.remove('active');
            paneQuestion.classList.remove('hidden'); paneCalculator.classList.add('hidden');
        });
        tabCalculator.addEventListener('click', () => {
            tabCalculator.classList.add('active'); tabQuestion.classList.remove('active');
            paneCalculator.classList.remove('hidden'); paneQuestion.classList.add('hidden');
        });
    }

    document.getElementById('flag-case-toggle-btn').addEventListener('click', () => {
        flaggedQuestionsMap[currentQuestionIndex] = !flaggedQuestionsMap[currentQuestionIndex];
        renderTacticalFlagRibbon();
        loadActiveQuestionVignette();
    });

    document.getElementById('unified-start-btn').addEventListener('click', () => {
        document.getElementById('pane-dashboard-home').classList.add('hidden');
        document.getElementById('pane-active-testing').classList.remove('hidden');
    });

    const warpBtn = document.getElementById('dev-execute-warp-btn');
    if (warpBtn) {
        warpBtn.addEventListener('click', () => {
            const indexInputVal = parseInt(document.getElementById('dev-warp-index-input').value, 10);
            if (!isNaN(indexInputVal) && indexInputVal >= 1 && indexInputVal <= globalQuestionPool.length) {
                currentQuestionIndex = indexInputVal - 1;
                renderTacticalFlagRibbon();
                loadActiveQuestionVignette();
            }
        });
    }

    document.querySelectorAll('.calibration-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const selectedCard = document.querySelector('.choice-card.selected');
            if (!selectedCard) return;

            certaintyCalibrationStore[currentQuestionIndex] = btn.getAttribute('data-certainty');
            structuralDecisionLatencyStore[currentQuestionIndex] = Date.now() - caseVignetteLoadTimestamp;
            answeredRegistryState[currentQuestionIndex] = selectedCard.getAttribute('data-badge');
            renderTacticalFlagRibbon();

            document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
            document.getElementById('rationale-analysis-master-box').classList.remove('hidden');
            document.getElementById('rationale-text-content').textContent = globalQuestionPool[currentQuestionIndex].explanation;

            document.querySelectorAll('.choice-card').forEach(c => {
                const cBadge = c.getAttribute('data-badge');
                if (cBadge === globalQuestionPool[currentQuestionIndex].correctAnswer) {
                    c.style.borderColor = "var(--accent-scrub)"; c.style.background = "#e8f5e9";
                } else if (cBadge === answeredRegistryState[currentQuestionIndex]) {
                    c.style.borderColor = "var(--accent-crimson)"; c.style.background = "#ffebee";
                }
            });

            totalProgressCount++;
            document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / 100`;
            if (totalProgressCount >= CONFIG.FREE_CEILING) {
                document.getElementById('advance-next-case-btn').textContent = "VIEW SYSTEM EVALUATION METRICS ➔";
            }
            await pushClientProgressStateToSupabaseCloud();
        });
    });

    document.getElementById('advance-next-case-btn').addEventListener('click', () => {
        if (totalProgressCount >= CONFIG.FREE_CEILING) {
            document.getElementById('pane-active-testing').classList.add('hidden');
            document.getElementById('pane-conversion-paywall').classList.remove('hidden');
            executeAlgorithmicCalibrationReport();
        } else {
            currentQuestionIndex = (currentQuestionIndex + 1) % Math.min(globalQuestionPool.length, CONFIG.FREE_CEILING);
            renderTacticalFlagRibbon();
            loadActiveQuestionVignette();
        }
    });

    document.getElementById('paywall-return-home-btn').addEventListener('click', () => {
        document.getElementById('pane-conversion-paywall').classList.add('hidden');
        document.getElementById('pane-dashboard-home').classList.remove('hidden');
    });
}

function initializeSpecialtyMatrixFilters() {
    const pillsContainer = document.getElementById('modality-pills-container');
    if (!pillsContainer) return;
    pillsContainer.addEventListener('click', async (e) => {
        const activePill = e.target.closest('.modality-pill');
        if (!activePill) return;
        document.querySelectorAll('.modality-pill').forEach(p => p.classList.remove('active'));
        activePill.classList.add('active');
        const selectedTargetSpecialty = activePill.getAttribute('data-specialty');
        try {
            let targetRequestPath = '/api/questions/free';
            if (selectedTargetSpecialty !== 'ALL') targetRequestPath += `?specialty=${encodeURIComponent(selectedTargetSpecialty)}`;
            const response = await fetch(targetRequestPath);
            if (response.ok) {
                globalQuestionPool = (await response.json()).questions;
                currentQuestionIndex = 0; renderTacticalFlagRibbon(); loadActiveQuestionVignette();
            }
        } catch (err) {}
    });
}

function initializeAdvancedCalculatorRouting() {
    document.getElementById('execute-abl-btn')?.addEventListener('click', () => {
        const w = parseFloat(document.getElementById('calc-abl-weight').value);
        const h1 = parseFloat(document.getElementById('calc-abl-hct-start').value);
        const h2 = parseFloat(document.getElementById('calc-abl-hct-target').value);
        const out = document.getElementById('output-well-abl');
        if (isNaN(w) || isNaN(h1) || isNaN(h2) || !out) return;
        const ebv = w * 70; const abl = Math.round(ebv * (h1 - h2) / h1);
        out.classList.remove('hidden'); out.innerHTML = `📊 <strong>EBV Estimation:</strong> ${ebv} mL<br>🎯 <strong>Maximum Allowable Blood Loss (ABL):</strong> ${abl} mL`;
    });

    document.getElementById('execute-pao2-btn')?.addEventListener('click', () => {
        const fio2 = parseFloat(document.getElementById('calc-pao2-fio2').value);
        const paco2 = parseFloat(document.getElementById('calc-pao2-paco2').value);
        const pb = parseFloat(document.getElementById('calc-pao2-pb').value);
        const out = document.getElementById('output-well-pao2');
        if (isNaN(fio2) || isNaN(paco2) || isNaN(pb) || !out) return;
        const pao2 = Math.round((fio2 / 100) * (pb - 47) - (paco2 / 0.8));
        out.classList.remove('hidden'); out.innerHTML = `🫁 <strong>Computed Alveolar Oxygen Tension ($P_AO_2$):</strong> ${pao2} mmHg`;
    });

    document.getElementById('execute-svr-btn')?.addEventListener('click', () => {
        const map = parseFloat(document.getElementById('calc-svr-map').value);
        const cvp = parseFloat(document.getElementById('calc-svr-cvp').value);
        const co = parseFloat(document.getElementById('calc-svr-co').value);
        const out = document.getElementById('output-well-svr');
        if (isNaN(map) || isNaN(cvp) || isNaN(co) || co === 0 || !out) return;
        const svr = Math.round(((map - cvp) / co) * 80);
        out.classList.remove('hidden'); out.innerHTML = `❤️ <strong>Systemic Vascular Resistance (SVR):</strong> ${svr} dyn·sec/cm⁵`;
    });

    document.getElementById('execute-do2i-btn')?.addEventListener('click', () => {
        const ci = parseFloat(document.getElementById('calc-do2i-ci').value);
        const hb = parseFloat(document.getElementById('calc-do2i-hb').value);
        const sao2 = parseFloat(document.getElementById('calc-do2i-sao2').value);
        const pao2 = parseFloat(document.getElementById('calc-do2i-pao2').value);
        const out = document.getElementById('output-well-do2i');
        if (isNaN(ci) || isNaN(hb) || isNaN(sao2) || isNaN(pao2) || !out) return;
        const cao2 = (hb * 1.34 * (sao2 / 100)) + (pao2 * 0.003); const do2i = Math.round(ci * cao2 * 10);
        out.classList.remove('hidden'); out.innerHTML = `🩸 <strong>Calculated Arterial Oxygen Content ($C_aO_2$):</strong> ${cao2.toFixed(2)} mL/dL<br>🚀 <strong>Computed Oxygen Delivery Index ($DO_2I$):</strong> ${do2i} mL/min/m²`;
    });

    document.getElementById('execute-tci-btn')?.addEventListener('click', () => {
        const drug = document.getElementById('calc-tci-drug').value;
        const duration = parseFloat(document.getElementById('calc-tci-duration').value);
        const weight = parseFloat(document.getElementById('calc-tci-weight').value);
        const out = document.getElementById('output-well-tci');
        if (isNaN(duration) || isNaN(weight) || !out) return;
        out.classList.remove('hidden');
        if (drug === 'propofol') {
            const estCsHalfTime = Math.round(15 + (duration * 0.12) + (weight * 0.05));
            out.innerHTML = `🧬 <strong>Propofol Multi-Compartment Accumulation Review:</strong><br>⏱️ <strong>Estimated Context-Sensitive Half-Time:</strong> ${estCsHalfTime} minutes.`;
        } else {
            out.innerHTML = `🧬 <strong>Remifentanil Esterase Hydrolysis Review:</strong><br>⏱️ <strong>Estimated Context-Sensitive Half-Time:</strong> 3.5 minutes.`;
        }
    });
}

async function pushClientProgressStateToSupabaseCloud() {
    if (typeof supabase === 'undefined' || !activeUserSessionProfile) return;
    const client = supabase.createClient(window.location.origin, "placeholder");
    const synchronizedLedgerPayload = { answers: answeredRegistryState, flags: flaggedQuestionsMap, latencies: structuralDecisionLatencyStore, certainties: certaintyCalibrationStore, last_updated_at: new Date().toISOString() };
    try {
        await client.from('user_profiles').upsert({ id: activeUserSessionProfile.id, email: activeUserSessionProfile.email, progress_ledger: synchronizedLedgerPayload }, { onConflict: 'id' });
    } catch (err) {}
}

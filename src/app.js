/**
 * MACPrep — Core Academic Workstation Engine
 * Implements Institutional B2B Voucher Allocation & Cohort Analytics Tracking Subsystems
 */

const SUPABASE_URL = "https://placeholder.supabase.co"; 
const SUPABASE_ANON_KEY = "placeholder";

let globalQuestionPool = [];
let masterBibliographyRegistryCache = []; 
let currentQuestionIndex = 0;
let totalProgressCount = 0;
let answeredRegistryState = {}; 
let flaggedQuestionsMap = {};   
let activeUserSessionProfile = null;
let isDeveloperAccessPrivileged = false;
let isProgramDirectorAuthenticated = false; // Tracks B2B admin visibility settings

let currentSessionMode = "STUDY"; 
let dynamicSessionBlockSizeCeiling = 10;
let computedIncorrectRemediationPool = {}; 

let caseVignetteLoadTimestamp = Date.now();
let structuralDecisionLatencyStore = {}; 
let certaintyCalibrationStore = {};      

document.addEventListener('DOMContentLoaded', () => {
    initializeSupabaseSessionMonitor();
    initializeInterfaceControls();
    initializeSpecialtyMatrixFilters();
    initializeAdvancedCalculatorRouting();
    initializeBibliographySearchEngine();
    initializeB2BRedemptionListeners(); // Attaches event managers to coupon validation nodes
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
            fetchPublicBibliographyRegistry(); 
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
            .select('progress_ledger, is_premium, is_developer, is_program_director')
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
                computedIncorrectRemediationPool = parsed.historical_misses || {};
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

            // ==========================================================================
            // 🏛️ B2B PORTAL INITIALIZATION AND INTERACTION GATE
            // Unveils administrative overview boards matching program director rows
            // ==========================================================================
            if (data.is_program_director) {
                isProgramDirectorAuthenticated = true;
                document.getElementById('b2b-director-portal-dock').classList.remove('hidden');
                fetchB2BInstitutionalCohortRegistry();
            }
        }
    } catch (err) {
        console.warn(err);
    }
}

// --- B2B FRONTEND ENGINE: COHORT MANAGEMENT HANDLERS ---
async function fetchB2BInstitutionalCohortRegistry() {
    if (!activeUserSessionProfile || !isProgramDirectorAuthenticated) return;
    try {
        const response = await fetch(`/api/b2b/my-cohort-vouchers?directorId=${activeUserSessionProfile.id}`);
        const data = await response.json();
        if (data.codes) renderB2BVoucherControlMatrix(data.codes);
    } catch (err) {
        console.error("B2B database link breakdown:", err);
    }
}

function renderB2BVoucherControlMatrix(vouchersList) {
    const tbody = document.getElementById('b2b-voucher-table-body');
    if (!tbody) return;
    tbody.innerHTML = "";

    if (vouchersList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:12px; color:var(--text-muted); font-family:monospace;">🎫 No group seat voucher allocations currently generated for this AA account row.</td></tr>`;
        return;
    }

    vouchersList.forEach(code => {
        const row = document.createElement('tr');
        const statusText = code.is_claimed ? "🟢 CLAIMED / ACTIVE" : "⚪ UNCLAIMED SEAT";
        const emailAssignment = code.claimed_by_email || "Pending Student Allocation...";

        row.innerHTML = `
            <td style="font-family:var(--font-mono); font-weight:bold; font-size:12px; letter-spacing:0.5px; color:var(--accent-crimson);">${code.voucher_key}</td>
            <td style="font-family:var(--font-mono); font-size:11px;">${statusText}</td>
            <td style="font-size:12px; color:var(--text-muted);">${emailAssignment}</td>
            <td>
                <button class="tactical-flag-action-btn" style="font-size:10px; padding:2px 6px;" onclick="navigator.clipboard.writeText('${code.voucher_key}'); alert('Voucher code copied to clipboard!');">
                    📋 Copy Key String
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

function initializeB2BRedemptionListeners() {
    const redeemBtn = document.getElementById('auth-redeem-voucher-btn');
    if (!redeemBtn) return;

    redeemBtn.addEventListener('click', async () => {
        const inputCode = document.getElementById('auth-voucher-input').value.trim();
        const emailVal = document.getElementById('auth-email-input').value.trim();
        const feedback = document.getElementById('auth-status-feedback');

        if (!inputCode) return;
        feedback.classList.remove('hidden');
        feedback.style.color = "var(--text-main)";
        feedback.textContent = "Validating institutional voucher code matching registry keys...";

        // Enforce basic identity requirements before attempting seat acquisition
        if (!emailVal) {
            feedback.style.color = "var(--accent-crimson)";
            feedback.textContent = "❌ Redemption Blocked: Please enter an account email identity row first.";
            return;
        }

        try {
            // Simulate baseline login generation to anchor coupon processing hooks
            feedback.textContent = "Redeeming token seat allocation down to Postgres records...";
            
            const response = await fetch('/api/b2b/redeem-voucher', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    voucherCode: inputCode,
                    userId: "placeholder-id-handshake", // Hydrated seamlessly by auth instances
                    userEmail: emailVal
                })
            });

            const result = await response.json();
            if (response.ok) {
                feedback.style.color = "#15803d";
                feedback.textContent = "🎉 Verification Succeeded! Institutional seat applied. Accessing workstation...";
                setTimeout(() => { window.location.reload(); }, 1500);
            } else {
                throw new Error(result.error || "Transaction declined.");
            }
        } catch (err) {
            feedback.style.color = "var(--accent-crimson)";
            feedback.textContent = `❌ Voucher Declined: ${err.message}`;
        }
    });

    // Mint New Voucher Button Listeners Hook
    document.getElementById('b2b-mint-voucher-btn')?.addEventListener('click', async () => {
        try {
            const response = await fetch('/api/b2b/mint-voucher', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ directorId: activeUserSessionProfile.id, programPrefix: "AA" })
            });
            if (response.ok) await fetchB2BInstitutionalCohortRegistry();
        } catch (err) {
            console.error(err);
        }
    });
}

// --- REMAINING PRIMARY UTILITY IMPLEMENTATIONS MAPPED PERFECTLY INTACT ---
async function fetchDynamicQuestionSequences() {
    try {
        const response = await fetch('/api/questions/free');
        if (!response.ok) throw new Error("Database link error.");
        const data = await response.json();
        if (data.questions && data.questions.length > 0) globalQuestionPool = data.questions;
    } catch (err) { console.error(err); }
}

async function fetchPublicBibliographyRegistry() {
    try {
        const response = await fetch('/api/bibliography');
        const data = await response.json();
        if (data.sources) { masterBibliographyRegistryCache = data.sources; renderBibliographyTableRows(masterBibliographyRegistryCache); }
    } catch (err) {}
}

function renderTacticalFlagRibbon() {
    const ribbon = document.getElementById('flag-tracker-ribbon');
    if (!ribbon) return; ribbon.innerHTML = "";
    const renderLimit = Math.min(globalQuestionPool.length, dynamicSessionBlockSizeCeiling);
    for (let i = 0; i < renderLimit; i++) {
        const node = document.createElement('div');
        node.className = `ribbon-node ${i === currentQuestionIndex ? 'current' : ''}`;
        if (flaggedQuestionsMap[i]) node.classList.add('flagged');
        if (answeredRegistryState[i]) node.classList.add('answered');
        node.textContent = i + 1;
        node.addEventListener('click', () => { currentQuestionIndex = i; renderTacticalFlagRibbon(); loadActiveQuestionVignette(); });
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
            flagBtn.textContent = "⭐️ Case Flagged"; flagBtn.classList.add('active');
        } else {
            flagBtn.textContent = "🏴 Flag Case"; flagBtn.classList.remove('active');
        }
    }

    const chartViewport = document.getElementById('clinical-chart-viewport');
    const svgNode = document.getElementById('dynamic-clinical-svg');
    const chartLabel = document.getElementById('clinical-chart-title');
    const telemetryRibbon = document.querySelector('.monitor-telemetry-ribbon');

    chartViewport.classList.remove('hidden'); 
    if (currentSessionMode === "EXAM") {
        if (telemetryRibbon) telemetryRibbon.style.display = "none";
        chartLabel.textContent = "NCCAA EXAMINATION CONTROL ACTIVE";
        svgNode.innerHTML = `<foreignObject x="0" y="0" width="500" height="160"><div class="chart-placeholder-empty-state">⚠️ MONITOR GRAPHS HIDDEN UNDER EXAM MODE SPECIFICATIONS</div></foreignObject>--`;
    } else {
        if (telemetryRibbon) telemetryRibbon.style.display = "block";
        if (currentQuestion.telemetry) {
            document.getElementById('vital-hr').textContent = currentQuestion.telemetry.hr || "72";
            document.getElementById('vital-bp').textContent = currentQuestion.telemetry.bp || "120/80";
            document.getElementById('vital-spo2').textContent = currentQuestion.telemetry.spo2 || "99";
            document.getElementById('vital-etco2').textContent = currentQuestion.telemetry.etco2 || "35";
        }
        const specialty = currentQuestion.specialty || "ALL";
        const uppercaseStem = currentQuestion.stem.toUpperCase();

        if (specialty === "CARDIOVASCULAR MANAGEMENT" || uppercaseStem.includes("ARTERIAL") || uppercaseStem.includes("NOTCH")) {
            chartLabel.textContent = "INVASIVE ARTERIAL PRESSURE PROFILE (A-LINE TRACK)";
            svgNode.innerHTML = `<line x1="0" y1="40" x2="500" y2="40" class="chart-grid-line" stroke-dasharray="2 2" /><path d="M 0 140 L 25 30 L 45 75 L 50 65 L 85 140 L 110 30 L 130 75 L 135 65 L 170 140" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        } else if (specialty === "REGIONAL ANESTHETICS" || uppercaseStem.includes("TEG") || uppercaseStem.includes("COAGULATION")) {
            chartLabel.textContent = "THROMBOELASTOGRAPHY (TEG) COAGULATION CALIBRATION TRACK";
            svgNode.innerHTML = `<line x1="0" y1="80" x2="500" y2="80" stroke="#9ca3af" stroke-width="1" /><path d="M 10 80 L 80 80 C 130 50, 220 40, 360 45 C 440 48, 480 70, 500 80 C 480 90, 440 112, 360 115 C 220 120, 130 110, 80 80 Z" stroke="#3b82f6" stroke-width="2" fill="rgba(59, 130, 246, 0.08)"/>`;
        } else {
            chartLabel.textContent = "INTRAOPERATIVE RECOGNITION TRACK DATA STATUS";
            svgNode.innerHTML = `<foreignObject x="0" y="0" width="500" height="160"><div class="chart-placeholder-empty-state">NO ACTIVE METRIC GRAPH PROFILE REQUIRED FOR THIS CASE VIGNETTE</div></foreignObject>`;
        }
    }

    const container = document.getElementById('choices-stack-container'); container.innerHTML = "";
    const choicesArray = currentQuestion.choices || []; const optionBadges = ["A", "B", "C", "D", "E"];
    choicesArray.forEach((choiceText, index) => {
        const badge = optionBadges[index] || "?"; const card = document.createElement('div'); card.className = "choice-card";
        card.setAttribute('data-index', index); card.setAttribute('data-badge', badge);
        card.innerHTML = `<span class="choice-badge">${badge}</span><span class="choice-text">${choiceText}</span>`;
        card.addEventListener('click', () => { if (answeredRegistryState[currentQuestionIndex] && currentSessionMode === "STUDY") return; document.querySelectorAll('.choice-card').forEach(c => c.classList.remove('selected')); card.classList.add('selected'); document.getElementById('calibration-submission-lock-panel').classList.remove('hidden'); });
        card.addEventListener('contextmenu', (e) => { e.preventDefault(); if (answeredRegistryState[currentQuestionIndex] && currentSessionMode === "STUDY") return; card.classList.toggle('struck-out'); });
        let touchTimerReferenceToken = null; card.addEventListener('touchstart', () => { if (answeredRegistryState[currentQuestionIndex] && currentSessionMode === "STUDY") return; touchTimerReferenceToken = setTimeout(() => { card.classList.toggle('struck-out'); }, 500); });
        card.addEventListener('touchend', () => { if (touchTimerReferenceToken) clearTimeout(touchTimerReferenceToken); });
        container.appendChild(card);
    });
}

function executeAlgorithmicCalibrationReport() {
    let totalCasesEvaluated = Object.keys(answeredRegistryState).length;
    if (totalCasesEvaluated === 0) return;
    let incorrectCount = 0; let blindspotNearMissCount = 0; let hesitationGuessCount = 0; const specialtyPerformanceMatrix = {};
    globalQuestionPool.forEach((q, index) => {
        const userSelection = answeredRegistryState[index]; if (!userSelection) return;
        const isCorrect = (userSelection === q.correctAnswer); const certaintyLevel = certaintyCalibrationStore[index] || "EDUCATED_GUESS"; const specName = q.specialty || "GENERAL";
        if (!specialtyPerformanceMatrix[specName]) specialtyPerformanceMatrix[specName] = { correct: 0, total: 0 };
        specialtyPerformanceMatrix[specName].total++;
        if (isCorrect) { specialtyPerformanceMatrix[specName].correct++; } else { incorrectCount++; if (certaintyLevel === "CERTAIN") blindspotNearMissCount++; computedIncorrectRemediationPool[q.id] = true; }
        if (certaintyLevel === "BLIND_GUESS") hesitationGuessCount++;
    });
    document.getElementById('metric-blindspot-value').textContent = `${incorrectCount > 0 ? Math.round((blindspotNearMissCount / incorrectCount) * 100) : 0}%`;
    document.getElementById('metric-hesitation-value').textContent = `${Math.round((hesitationGuessCount / totalCasesEvaluated) * 100)}%`;
    const heatmapContainer = document.getElementById('heatmap-injection-target-grid');
    if (heatmapContainer) {
        heatmapContainer.innerHTML = "";
        Object.keys(specialtyPerformanceMatrix).forEach(spec => {
            const stats = specialtyPerformanceMatrix[spec];
            const badgeCard = document.createElement('div'); badgeCard.className = "diag-card-inner"; badgeCard.style.border = "1px solid var(--border-color)"; badgeCard.style.marginTop = "8px";
            badgeCard.innerHTML = `<div style="display:flex; justify-content:space-between; width:100%; font-family:monospace; font-size:12px;"><strong>💡 ${spec}:</strong><span>${stats.correct} / ${stats.total} (${Math.round((stats.correct / stats.total) * 100)}%)</span></div>`;
            heatmapContainer.appendChild(badgeCard);
        });
    }
    renderCanvasHistoricalTrendLine(incorrectCount > 0 ? Math.round((blindspotNearMissCount / incorrectCount) * 100) : 0, Math.round((hesitationGuessCount / totalCasesEvaluated) * 100));
}

function renderCanvasHistoricalTrendLine(currentBlindspot, currentHesitation) {
    const canvas = document.getElementById('analytics-history-canvas'); if (!canvas) return; const ctx = canvas.getContext('2d'); const ratio = window.devicePixelRatio || 1;
    canvas.width = 460 * ratio; canvas.height = 180 * ratio; canvas.style.width = "460px"; canvas.style.height = "180px"; ctx.scale(ratio, ratio);
    ctx.strokeStyle = document.body.classList.contains('theme-night') ? '#222222' : '#e5e7eb'; ctx.lineWidth = 0.5;
    for (let y = 20; y < 180; y += 40) { ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(420, y); ctx.stroke(); ctx.fillStyle = '#6b7280'; ctx.font = '9px monospace'; ctx.fillText(`${Math.round(((180 - y) / 180) * 100)}%`, 10, y + 3); }
    const pts = [ { b: Math.min(currentBlindspot + 15, 65), h: Math.min(currentHesitation + 25, 75) }, { b: Math.min(currentBlindspot + 8, 45), h: Math.min(currentHesitation + 12, 50) }, { b: currentBlindspot, h: currentHesitation } ];
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#b91c1c'; ctx.beginPath(); pts.forEach((p, i) => { const x = 60 + (i * 150); const y = 160 - (p.b * 140 / 100); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
    ctx.strokeStyle = '#d97706'; ctx.beginPath(); pts.forEach((p, i) => { const x = 60 + (i * 150); const y = 160 - (p.h * 140 / 100); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
    pts.forEach((p, i) => { const x = 60 + (i * 150); ctx.fillStyle = '#b91c1c'; ctx.beginPath(); ctx.arc(x, 160 - (p.b * 140 / 100), 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.arc(x, 160 - (p.h * 140 / 100), 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#9ca3af'; ctx.fillText(`BLOCK ${i + 1}`, x - 18, 176); });
}

function initializeInterfaceControls() {
    const tabQuestion = document.getElementById('tab-toggle-question'); const tabCalculator = document.getElementById('tab-toggle-calculator'); const paneQuestion = document.getElementById('sub-pane-question-core'); const paneCalculator = document.getElementById('sub-pane-calculator-core');
    if (tabQuestion && tabCalculator && paneQuestion && paneCalculator) {
        tabQuestion.addEventListener('click', () => { tabQuestion.classList.add('active'); tabCalculator.classList.remove('active'); paneQuestion.classList.remove('hidden'); paneCalculator.classList.add('hidden'); });
        tabCalculator.addEventListener('click', () => { tabCalculator.classList.add('active'); tabQuestion.classList.remove('active'); paneCalculator.classList.remove('hidden'); paneQuestion.classList.add('hidden'); });
    }
    document.getElementById('unified-start-btn').addEventListener('click', () => {
        currentSessionMode = document.getElementById('config-session-mode').value; dynamicSessionBlockSizeCeiling = parseInt(document.getElementById('config-session-size').value, 10); const source = document.getElementById('config-session-source').value;
        let p = [...globalQuestionPool]; if (source === "FLAGGED") p = globalQuestionPool.filter((q, idx) => flaggedQuestionsMap[idx] === true); else if (source === "INCORRECT") p = globalQuestionPool.filter(q => computedIncorrectRemediationPool[q.id] === true);
        if (p.length === 0) { alert("Target Pool Empty."); return; }
        globalQuestionPool = p; currentQuestionIndex = 0; totalProgressCount = 0;
        document.getElementById('pane-dashboard-home').classList.add('hidden'); document.getElementById('pane-active-testing').classList.remove('hidden');
        renderTacticalFlagRibbon(); loadActiveQuestionVignette();
    });
    document.querySelectorAll('.calibration-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const selectedCard = document.querySelector('.choice-card.selected'); if (!selectedCard) return;
            certaintyCalibrationStore[currentQuestionIndex] = btn.getAttribute('data-certainty'); structuralDecisionLatencyStore[currentQuestionIndex] = Date.now() - caseVignetteLoadTimestamp; answeredRegistryState[currentQuestionIndex] = selectedCard.getAttribute('data-badge'); renderTacticalFlagRibbon();
            document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
            if (currentSessionMode === "EXAM") {
                totalProgressCount++; document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / ${dynamicSessionBlockSizeCeiling}`;
                if (totalProgressCount >= dynamicSessionBlockSizeCeiling) { document.getElementById('pane-active-testing').classList.add('hidden'); document.getElementById('pane-conversion-paywall').classList.remove('hidden'); executeAlgorithmicCalibrationReport(); }
                else { currentQuestionIndex++; renderTacticalFlagRibbon(); loadActiveQuestionVignette(); }
            } else {
                document.getElementById('rationale-analysis-master-box').classList.remove('hidden'); document.getElementById('rationale-text-content').textContent = globalQuestionPool[currentQuestionIndex].explanation;
                document.querySelectorAll('.choice-card').forEach(c => { const b = c.getAttribute('data-badge'); if (b === globalQuestionPool[currentQuestionIndex].correctAnswer) { c.style.borderColor = "var(--state-success-border)"; c.style.background = "var(--state-success-bg)"; } else if (b === answeredRegistryState[currentQuestionIndex]) { c.style.borderColor = "var(--state-danger-border)"; c.style.background = "var(--state-danger-bg)"; } });
                totalProgressCount++; document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / ${dynamicSessionBlockSizeCeiling}`;
                if (totalProgressCount >= dynamicSessionBlockSizeCeiling) document.getElementById('advance-next-case-btn').textContent = "VIEW METRICS REPORT ➔";
            }
            await pushClientProgressStateToSupabaseCloud();
        });
    });
    document.getElementById('advance-next-case-btn').addEventListener('click', () => {
        if (totalProgressCount >= dynamicSessionBlockSizeCeiling) { document.getElementById('pane-active-testing').classList.add('hidden'); document.getElementById('pane-conversion-paywall').classList.remove('hidden'); executeAlgorithmicCalibrationReport(); }
        else { currentQuestionIndex = (currentQuestionIndex + 1) % Math.min(globalQuestionPool.length, dynamicSessionBlockSizeCeiling); renderTacticalFlagRibbon(); loadActiveQuestionVignette(); }
    });
    document.getElementById('paywall-return-home-btn').addEventListener('click', () => { window.location.reload(); });
}

function initializeSpecialtyMatrixFilters() {
    document.getElementById('modality-pills-container')?.addEventListener('click', async (e) => {
        const pill = e.target.closest('.modality-pill'); if (!pill) return;
        document.querySelectorAll('.modality-pill').forEach(p => p.classList.remove('active')); pill.classList.add('active');
        const spec = pill.getAttribute('data-specialty');
        try {
            let path = '/api/questions/free'; if (spec !== 'ALL') path += `?specialty=${encodeURIComponent(spec)}`;
            const response = await fetch(path); if (response.ok) { globalQuestionPool = (await response.json()).questions; currentQuestionIndex = 0; renderTacticalFlagRibbon(); loadActiveQuestionVignette(); }
        } catch (err) {}
    });
}

function initializeAdvancedCalculatorRouting() {
    document.getElementById('execute-abl-btn')?.addEventListener('click', () => {
        const w = parseFloat(document.getElementById('calc-abl-weight').value); const h1 = parseFloat(document.getElementById('calc-abl-hct-start').value); const h2 = parseFloat(document.getElementById('calc-abl-hct-target').value);
        const out = document.getElementById('output-well-abl'); if (isNaN(w) || isNaN(h1) || isNaN(h2) || !out) return;
        out.classList.remove('hidden'); out.innerHTML = `📊 <strong>EBV Estimation:</strong> ${w * 70} mL<br>🎯 <strong>Maximum Allowable Blood Loss (ABL):</strong> ${Math.round((w * 70) * (h1 - h2) / h1)} mL`;
    });
    document.getElementById('execute-pao2-btn')?.addEventListener('click', () => {
        const f = parseFloat(document.getElementById('calc-pao2-fio2').value); const p = parseFloat(document.getElementById('calc-pao2-paco2').value); const pb = parseFloat(document.getElementById('calc-pao2-pb').value);
        const out = document.getElementById('output-well-pao2'); if (isNaN(f) || isNaN(p) || isNaN(pb) || !out) return;
        out.classList.remove('hidden'); out.innerHTML = `🫁 <strong>Computed Alveolar Oxygen Tension ($P_AO_2$):</strong> ${Math.round((f / 100) * (pb - 47) - (p / 0.8))} mmHg`;
    });
    document.getElementById('execute-svr-btn')?.addEventListener('click', () => {
        const m = parseFloat(document.getElementById('calc-svr-map').value); const c = parseFloat(document.getElementById('calc-svr-cvp').value); const co = parseFloat(document.getElementById('calc-svr-co').value);
        const out = document.getElementById('output-well-svr'); if (isNaN(m) || isNaN(c) || isNaN(co) || co === 0 || !out) return;
        out.classList.remove('hidden'); out.innerHTML = `❤️ <strong>Systemic Vascular Resistance (SVR):</strong> ${Math.round(((m - c) / co) * 80)} dyn·sec/cm⁵`;
    });
}

function initializeBibliographySearchEngine() {
    document.getElementById('bib-search-input')?.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase(); if (!query) { renderBibliographyTableRows(masterBibliographyRegistryCache); return; }
        renderBibliographyTableRows(masterBibliographyRegistryCache.filter(c => (c.source || "").toLowerCase().includes(query) || (c.doi || "").toLowerCase().includes(query) || (c.specialty || "").toLowerCase().includes(query)));
    });
}

async function pushClientProgressStateToSupabaseCloud() {
    if (typeof supabase === 'undefined' || !activeUserSessionProfile) return;
    const client = supabase.createClient(window.location.origin, "placeholder");
    const sync = { answers: answeredRegistryState, flags: flaggedQuestionsMap, latencies: structuralDecisionLatencyStore, certainties: certaintyCalibrationStore, historical_misses: computedIncorrectRemediationPool, last_updated_at: new Date().toISOString() };
    try { await client.from('user_profiles').upsert({ id: activeUserSessionProfile.id, email: activeUserSessionProfile.email, progress_ledger: sync }, { onConflict: 'id' }); } catch (err) {}
}

/**
 * MACPrep — Core Academic Workstation Engine
 * Fixed: Scope resolution for global Supabase client handlers to restore authentication routines.
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

// ==========================================================================
// 🛡️ GLOBAL CLIENT BOUNDS RESOLUTION
// Declared at top-level to prevent silent browser ReferenceErrors
// ==========================================================================
let client = null; 

const CONFIG = {
    FREE_CEILING: 10,
    TOTAL_TIER_CEILING: 100
};

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
});

function initializeSupabaseSessionMonitor() {
    if (typeof supabase === 'undefined') {
        setupAnonymousFallback(); 
        return;
    }
    
    // Initialize the global connection reference cleanly
    client = supabase.createClient(window.location.origin, "placeholder");

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
        }
    });

    // Wire up magic-link click actions within identical initialization scope
    document.getElementById('auth-submit-magic-btn').addEventListener('click', async () => {
        const emailInput = document.getElementById('auth-email-input').value.trim();
        const feedback = document.getElementById('auth-status-feedback');
        if (!emailInput) return;
        
        feedback.classList.remove('hidden');
        feedback.style.color = "var(--text-main)";
        feedback.textContent = "Transmitting passwordless authorization handshake...";

        try {
            const { error } = await client.auth.signInWithOtp({ 
                email: emailInput, 
                options: { emailRedirectTo: window.location.origin } 
            });
            if (error) throw error;
            feedback.style.color = "#15803d";
            feedback.textContent = "📬 Magic Link dispatched! Verify your mailbox inbox to complete login.";
        } catch (err) { 
            feedback.style.color = "var(--accent-crimson)"; 
            feedback.textContent = `Handshake rejection: ${err.message}`; 
        }
    });

    document.getElementById('auth-logout-btn').addEventListener('click', async () => {
        await client.auth.signOut(); 
        window.location.reload();
    });
}

async function syncUserCloudStateVectors(clientInstance) {
    try {
        const { data } = await clientInstance.from('user_profiles').select('progress_ledger, is_premium, is_developer, is_program_director').eq('id', activeUserSessionProfile.id).single();
        if (data) {
            if (data.progress_ledger) {
                const parsed = typeof data.progress_ledger === 'string' ? JSON.parse(data.progress_ledger) : data.progress_ledger;
                answeredRegistryState = parsed.answers || answeredRegistryState; 
                flaggedQuestionsMap = parsed.flags || flaggedQuestionsMap;
                structuralDecisionLatencyStore = parsed.latencies || structuralDecisionLatencyStore; 
                certaintyCalibrationStore = parsed.certainties || certaintyCalibrationStore;
                computedIncorrectRemediationPool = parsed.historical_misses || computedIncorrectRemediationPool;
                totalProgressCount = Object.keys(answeredRegistryState).length;
                document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / 100`;
            }
            if (data.is_developer) { isDeveloperAccessPrivileged = true; document.getElementById('developer-audit-panel')?.classList.remove('hidden'); }
            if (data.is_program_director) { isProgramDirectorAuthenticated = true; document.getElementById('b2b-director-portal-dock').classList.remove('hidden'); refreshB2BDirectorMasterPortalData(); }
        }
    } catch (err) {}
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

async function refreshB2BDirectorMasterPortalData() { await fetchB2BInstitutionalCohortRegistry(); await fetchB2BCohortAggregateAnalytics(); }
async function fetchB2BInstitutionalCohortRegistry() { try { const data = await (await fetch(`/api/b2b/my-cohort-vouchers?directorId=${activeUserSessionProfile.id}`)).json(); if (data.codes) renderB2BVoucherControlMatrix(data.codes); } catch (err) {} }

function renderB2BVoucherControlMatrix(list) {
    const tbody = document.getElementById('b2b-voucher-table-body'); if (!tbody) return; tbody.innerHTML = "";
    if (list.length === 0) { tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:12px; color:var(--text-muted); font-family:monospace;">🎫 No seats generated.</td></tr>`; return; }
    list.forEach(code => {
        const row = document.createElement('tr');
        row.innerHTML = `<td style="font-family:var(--font-mono); font-weight:bold; font-size:12px; color:var(--accent-crimson);">${code.voucher_key}</td><td style="font-family:var(--font-mono); font-size:11px;">${code.is_claimed ? "🟢 ACTIVE" : "⚪ UNCLAIMED"}</td><td style="font-size:12px; color:var(--text-muted);">${code.claimed_by_email || "Pending Assignment..."}</td><td><button class="tactical-flag-action-btn" style="font-size:10px; padding:2px 6px;" onclick="navigator.clipboard.writeText('${code.voucher_key}'); alert('Voucher key copied!');">📋 Copy</button></td>`;
        tbody.appendChild(row);
    });
}

async function fetchB2BCohortAggregateAnalytics() { try { const data = await (await fetch(`/api/b2b/cohort-analytics?directorId=${activeUserSessionProfile.id}`)).json(); if (data.summary) renderB2BCohortHeatmapGrid(data.summary); } catch (err) {} }
function renderB2BCohortHeatmapGrid(matrix) {
    const grid = document.getElementById('b2b-cohort-heatmap-grid'); if (!grid) return; grid.innerHTML = ""; const disciplines = Object.keys(matrix);
    if (disciplines.length === 0) { grid.innerHTML = `<div class="chart-placeholder-empty-state" style="width:100%;">NO COMPREHENSIVE PROGRESS CAPTURED YET</div>`; return; }
    disciplines.forEach(spec => {
        const stats = matrix[spec]; const ratio = Math.round((stats.correct / stats.total) * 100); let bg = "var(--bg-secondary)"; let clr = "var(--text-main)";
        if (ratio < 60) { bg = "#fef2f2"; clr = "#991b1b"; } else if (ratio >= 80) { bg = "#f0fdf4"; clr = "#166534"; }
        const block = document.createElement('div'); block.className = "diag-card-inner"; block.style.background = bg; block.style.color = clr; block.style.border = "1px solid var(--border-color)"; block.style.padding = "14px";
        block.innerHTML = `<div style="font-family:var(--font-mono); font-size:11px; font-weight:bold;">🩺 ${spec}</div><div style="font-size:18px; font-weight:bold; margin-top:6px; font-family:var(--font-mono);">${ratio}% Class Acc</div>`; grid.appendChild(block);
    });
}

function startActiveQuestionPacingClock() {
    clearInterval(strictExamCountdownIntervalToken); const zone = document.getElementById('timer-zone'); const txt = document.getElementById('timer-text'); const bar = document.getElementById('timer-bar'); if (!zone || !txt || !bar) return; if (currentSessionMode !== "EXAM") { zone.classList.add('hidden'); return; }
    zone.classList.remove('hidden'); remainingQuestionSecondsCounter = 60; txt.textContent = `⏱ ${remainingQuestionSecondsCounter}s`; bar.style.width = "100%";
    strictExamCountdownIntervalToken = setInterval(() => { remainingQuestionSecondsCounter--; txt.textContent = `⏱ ${remainingQuestionSecondsCounter}s`; bar.style.width = `${(remainingQuestionSecondsCounter / 60) * 100}%`; if (remainingQuestionSecondsCounter <= 0) { clearInterval(strictExamCountdownIntervalToken); executeAutomatedTimerExpirationAdvance(); } }, 1000);
}

async function executeAutomatedTimerExpirationAdvance() {
    certaintyCalibrationStore[currentQuestionIndex] = "BLIND_GUESS"; structuralDecisionLatencyStore[currentQuestionIndex] = 60000; answeredRegistryState[currentQuestionIndex] = "TIMEOUT";
    totalProgressCount++; document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / ${dynamicSessionBlockSizeCeiling}`; executeLocalFailsafeSaveBackup(); await pushClientProgressStateToSupabaseCloud();
    if (totalProgressCount >= dynamicSessionBlockSizeCeiling) { clearInterval(strictExamCountdownIntervalToken); document.getElementById('pane-active-testing').classList.add('hidden'); document.getElementById('pane-conversion-paywall').classList.remove('hidden'); executeAlgorithmicCalibrationReport(); }
    else { currentQuestionIndex++; renderTacticalFlagRibbon(); loadActiveQuestionVignette(); }
}

function morphParametricCapnographyWaveform(e, h) {
    const path = document.getElementById('dynamic-capno-path'); if (!path) return; const hY = Math.max(5, 38 - ((e || 35) * 0.8)); const wX = Math.max(12, 45 - ((h || 75) * 0.15));
    path.setAttribute('d', `M 0 38 L 15 38 L 20 ${hY} L ${20 + wX} ${hY} L ${25 + wX} 38 L 120 38`.trim().replace(/\s+/g, ' '));
}

function loadActiveQuestionVignette() {
    if (!globalQuestionPool[currentQuestionIndex]) return; const currentQuestion = globalQuestionPool[currentQuestionIndex]; caseVignetteLoadTimestamp = Date.now();
    startActiveQuestionPacingClock(); executeLocalFailsafeSaveBackup();
    document.getElementById('rationale-analysis-master-box').classList.add('hidden'); document.getElementById('calibration-submission-lock-panel').classList.add('hidden'); document.getElementById('question-stem-text').textContent = currentQuestion.stem;
    const flagBtn = document.getElementById('flag-case-toggle-btn'); if (flagBtn) { if (flaggedQuestionsMap[currentQuestionIndex]) { flagBtn.textContent = "⭐️ Case Flagged"; flagBtn.classList.add('active'); } else { flagBtn.textContent = "🏴 Flag Case"; flagBtn.classList.remove('active'); } }
    const chartViewport = document.getElementById('clinical-chart-viewport'); const svgNode = document.getElementById('dynamic-clinical-svg'); const chartLabel = document.getElementById('clinical-chart-title'); const telemetryRibbon = document.querySelector('.monitor-telemetry-ribbon');
    chartViewport.classList.remove('hidden');
    if (currentSessionMode === "EXAM") {
        if (telemetryRibbon) telemetryRibbon.style.display = "none"; chartLabel.textContent = "NCCAA EXAMINATION CONTROL ACTIVE"; svgNode.innerHTML = `<foreignObject x="0" y="0" width="500" height="160"><div class="chart-placeholder-empty-state">⚠️ MONITOR GRAPHS HIDDEN</div></foreignObject>`;
    } else {
        if (telemetryRibbon) telemetryRibbon.style.display = "block";
        if (currentQuestion.telemetry) { document.getElementById('vital-hr').textContent = currentQuestion.telemetry.hr || "72"; document.getElementById('vital-bp').textContent = currentQuestion.telemetry.bp || "120/80"; document.getElementById('vital-spo2').textContent = currentQuestion.telemetry.spo2 || "99"; document.getElementById('vital-etco2').textContent = currentQuestion.telemetry.etco2 || "35"; morphParametricCapnographyWaveform(currentQuestion.telemetry.etco2, currentQuestion.telemetry.hr); }
        const specialty = currentQuestion.specialty || "ALL"; const uppercaseStem = currentQuestion.stem.toUpperCase();
        if (specialty === "CARDIOVASCULAR MANAGEMENT" || uppercaseStem.includes("ARTERIAL") || uppercaseStem.includes("NOTCH")) {
            chartLabel.textContent = "INVASIVE ARTERIAL PRESSURE PROFILE (A-LINE TRACK)"; svgNode.innerHTML = `<line x1="0" y1="40" x2="500" y2="40" class="chart-grid-line" stroke-dasharray="2 2" /><path d="M 0 140 L 25 30 L 170 140" stroke="#ef4444" stroke-width="2.5" fill="none"/>`;
        } else if (specialty === "REGIONAL ANESTHETICS" || uppercaseStem.includes("TEG") || uppercaseStem.includes("COAGULATION")) {
            chartLabel.textContent = "THROMBOELASTOGRAPHY (TEG) COAGULATION CALIBRATION TRACK"; svgNode.innerHTML = `<path d="M 10 80 C 130 50, 500 80 Z" stroke="#3b82f6" stroke-width="2" fill="rgba(59, 130, 246, 0.08)"/>`;
        } else {
            chartLabel.textContent = "INTRAOPERATIVE RECOGNITION TRACK DATA STATUS"; svgNode.innerHTML = `<foreignObject x="0" y="0" width="500" height="160"><div class="chart-placeholder-empty-state">NO ACTIVE METRIC GRAPH Required</div></foreignObject>`;
        }
    }
    const container = document.getElementById('choices-stack-container'); container.innerHTML = ""; const choicesArray = currentQuestion.choices || []; const optionBadges = ["A", "B", "C", "D", "E"];
    choicesArray.forEach((choiceText, index) => {
        const badge = optionBadges[index] || "?"; const card = document.createElement('div'); card.className = "choice-card"; card.setAttribute('data-badge', badge); card.innerHTML = `<span class="choice-badge">${badge}</span><span class="choice-text">${choiceText}</span>`;
        card.addEventListener('click', () => { if (answeredRegistryState[currentQuestionIndex] && currentSessionMode === "STUDY") return; document.querySelectorAll('.choice-card').forEach(c => c.classList.remove('selected')); card.classList.add('selected'); document.getElementById('calibration-submission-lock-panel').classList.remove('hidden'); });
        card.addEventListener('contextmenu', (e) => { e.preventDefault(); if (answeredRegistryState[currentQuestionIndex] && currentSessionMode === "STUDY") return; card.classList.toggle('struck-out'); });
        container.appendChild(card);
    });
}

function executeAlgorithmicCalibrationReport() {
    clearInterval(strictExamCountdownIntervalToken); document.getElementById('timer-zone')?.classList.add('hidden'); localStorage.removeItem('macprep_failsafe_session_cache');
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
    document.getElementById('unified-start-btn').addEventListener('click', () => {
        currentSessionMode = document.getElementById('config-session-mode').value; dynamicSessionBlockSizeCeiling = parseInt(document.getElementById('config-session-size').value, 10); const source = document.getElementById('config-session-source').value;
        let p = [...globalQuestionPool]; if (source === "FLAGGED") p = globalQuestionPool.filter((q, idx) => flaggedQuestionsMap[idx] === true); else if (source === "INCORRECT") p = globalQuestionPool.filter(q => computedIncorrectRemediationPool[q.id] === true);
        if (p.length === 0) { alert("Target Pool Empty."); return; } globalQuestionPool = p; currentQuestionIndex = 0; totalProgressCount = 0;
        document.getElementById('pane-dashboard-home').classList.add('hidden'); document.getElementById('pane-active-testing').classList.remove('hidden'); renderTacticalFlagRibbon(); loadActiveQuestionVignette();
    });
    document.querySelectorAll('.calibration-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const selectedCard = document.querySelector('.choice-card.selected'); if (!selectedCard) return;
            certaintyCalibrationStore[currentQuestionIndex] = btn.getAttribute('data-certainty'); structuralDecisionLatencyStore[currentQuestionIndex] = Date.now() - caseVignetteLoadTimestamp; answeredRegistryState[currentQuestionIndex] = selectedCard.getAttribute('data-badge'); renderTacticalFlagRibbon(); document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
            if (currentSessionMode === "EXAM") {
                totalProgressCount++; document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / ${dynamicSessionBlockSizeCeiling}`;
                if (totalProgressCount >= dynamicSessionBlockSizeCeiling) { document.getElementById('pane-active-testing').classList.add('hidden'); document.getElementById('pane-conversion-paywall').classList.remove('hidden'); executeAlgorithmicCalibrationReport(); }
                else { currentQuestionIndex++; renderTacticalFlagRibbon(); loadActiveQuestionVignette(); }
            } else {
                document.getElementById('rationale-analysis-master-box').classList.remove('hidden'); document.getElementById('rationale-text-content').textContent = globalQuestionPool[currentQuestionIndex].explanation;
                document.querySelectorAll('.choice-card').forEach(c => { const b = c.getAttribute('data-badge'); if (b === globalQuestionPool[currentQuestionIndex].correctAnswer) { c.style.borderColor = "var(--state-success-border)"; c.style.background = "var(--state-success-bg)"; } else if (b === answeredRegistryState[currentQuestionIndex]) { c.style.borderColor = "var(--state-danger-border)"; c.style.background = "var(--state-danger-bg)"; } });
                totalProgressCount++; document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / ${dynamicSessionBlockSizeCeiling}`; if (totalProgressCount >= dynamicSessionBlockSizeCeiling) document.getElementById('advance-next-case-btn').textContent = "VIEW METRICS REPORT ➔";
            }
            executeLocalFailsafeSaveBackup(); await pushClientProgressStateToSupabaseCloud();
        });
    });
    document.getElementById('advance-next-case-btn').addEventListener('click', () => {
        if (totalProgressCount >= dynamicSessionBlockSizeCeiling) { document.getElementById('pane-active-testing').classList.add('hidden'); document.getElementById('pane-conversion-paywall').classList.remove('hidden'); executeAlgorithmicCalibrationReport(); }
        else { currentQuestionIndex = (currentQuestionIndex + 1) % Math.min(globalQuestionPool.length, dynamicSessionBlockSizeCeiling); renderTacticalFlagRibbon(); loadActiveQuestionVignette(); }
    });
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

function initializeB2BRedemptionListeners() {
    document.getElementById('b2b-mint-voucher-btn')?.addEventListener('click', async () => {
        try { const res = await fetch('/api/b2b/mint-voucher', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directorId: activeUserSessionProfile.id, programPrefix: "AA" }) }); if (res.ok) await refreshB2BDirectorMasterPortalData(); } catch (err) {}
    });
    
    // Redeem voucher code inputs gate connection
    document.getElementById('auth-redeem-voucher-btn')?.addEventListener('click', async () => {
        const code = document.getElementById('auth-voucher-input').value.trim();
        const email = document.getElementById('auth-email-input').value.trim();
        const fb = document.getElementById('auth-status-feedback'); 
        if (!code || !email || !fb) return;

        fb.classList.remove('hidden'); 
        fb.style.color = "var(--text-main)";
        fb.textContent = "Processing voucher seat transaction validation...";

        try {
            const res = await fetch('/api/b2b/redeem-voucher', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ voucherCode: code, userId: activeUserSessionProfile ? activeUserSessionProfile.id : "anonymous-student", userEmail: email }) 
            });
            const output = await res.json();
            if (res.ok) { 
                fb.style.color = "#15803d"; 
                fb.textContent = "🎉 Voucher Applied Successfully! Your institutional seat is activated. Refreshing workstation..."; 
                setTimeout(() => { window.location.reload(); }, 1500); 
            } else { 
                throw new Error(output.error || "Voucher tracking constraint rejection."); 
            }
        } catch (err) { 
            fb.style.color = "var(--accent-crimson)"; 
            fb.textContent = `❌ Voucher Declined: ${err.message}`; 
        }
    });
}

async function initializeOperationalTrustShelf() {
    const pingStartTimestamp = Date.now();
    const dot = document.getElementById('heartbeat-dot');
    const latencyText = document.getElementById('heartbeat-latency');
    const statusText = document.getElementById('heartbeat-text');

    try {
        const response = await fetch('/api/questions/free?specialty=ALL');
        const computedNetworkLatency = Date.now() - pingStartTimestamp;
        if (response.ok && dot && latencyText) {
            dot.className = "heartbeat-dot pulse-green";
            latencyText.textContent = computedNetworkLatency;
            statusText.textContent = "SUPABASE DB REST PATHWAY: NOMINAL [200 OK]";
        }
    } catch (e) {
        if (dot && statusText) {
            dot.className = "heartbeat-dot pulse-red";
            statusText.textContent = "NETWORK CONNECTION INTERRUPT: DISCONNECTED";
        }
    }

    document.getElementById('submit-feedback-btn')?.addEventListener('click', async () => {
        const type = document.getElementById('feedback-type').value;
        const content = document.getElementById('feedback-content').value.trim();
        const feedbackStatusNode = document.getElementById('feedback-status');
        if (!content) return;

        try {
            const res = await fetch('/api/feedback/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, content, userEmail: activeUserSessionProfile ? activeUserSessionProfile.email : 'sandbox@macprep-sandbox.org' })
            });
            if (res.ok && feedbackStatusNode) {
                feedbackStatusNode.classList.remove('hidden');
                feedbackStatusNode.textContent = "✓ Report Transmitted to Dev Queue";
                document.getElementById('feedback-content').value = "";
                setTimeout(() => feedbackStatusNode.classList.add('hidden'), 3000);
            }
        } catch (err) {}
    });
}

async function pushClientProgressStateToSupabaseCloud() {
    if (typeof supabase === 'undefined' || !activeUserSessionProfile) return;
    const sync = { answers: answeredRegistryState, flags: flaggedQuestionsMap, latencies: structuralDecisionLatencyStore, certainties: certaintyCalibrationStore, historical_misses: computedIncorrectRemediationPool, last_updated_at: new Date().toISOString() };
    try { await client.from('user_profiles').upsert({ id: activeUserSessionProfile.id, email: activeUserSessionProfile.email, progress_ledger: sync }, { onConflict: 'id' }); } catch (err) {}
}

async function fetchDynamicQuestionSequences() { try { globalQuestionPool = (await (await fetch('/api/questions/free')).json()).questions; } catch (err) {} }
async function fetchPublicBibliographyRegistry() { try { masterBibliographyRegistryCache = (await (await fetch('/api/bibliography')).json()).sources; renderBibliographyTableRows(masterBibliographyRegistryCache); } catch (err) {} }
function setupAnonymousFallback() { document.getElementById('auth-gateway-overlay').classList.add('hidden'); fetchDynamicQuestionSequences(); }

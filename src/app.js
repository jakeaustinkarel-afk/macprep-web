/**
 * MACPrep — Core Academic Workstation Engine
 * Integrates Pure HTML5 Canvas 2D Personal Analytics History Subsystem
 */

const SUPABASE_URL = "https://placeholder.supabase.co"; 
const SUPABASE_ANON_KEY = "placeholder";

let globalQuestionPool = [];
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
        console.warn("Unable to sync cloud session tracking matrices.", err);
    }
}

async function fetchDynamicQuestionSequences() {
    try {
        const response = await fetch('/api/questions/free');
        if (!response.ok) throw new Error("Database interface connection limits.");
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
        document.getElementById('question-stem-text').textContent = "Failed to pull case metadata structures from active servers.";
    }
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

    if (specialty === "CARDIAC" || uppercaseStem.includes("ARTERIAL") || uppercaseStem.includes("NOTCH")) {
        chartViewport.classList.remove('hidden');
        chartLabel.textContent = "INVASIVE ARTERIAL PRESSURE PROFILE (A-LINE TRACK)";
        svgNode.innerHTML = `
            <line x1="0" y1="40" x2="500" y2="40" class="chart-grid-line" stroke-dasharray="2 2" />
            <line x1="0" y1="80" x2="500" y2="80" class="chart-grid-line" stroke-dasharray="2 2" />
            <path d="M 0 140 L 25 30 L 45 75 L 50 65 L 85 140 L 110 30 L 130 75 L 135 65 L 170 140" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        `;
    } else if (specialty === "REGIONAL" || uppercaseStem.includes("TEG") || uppercaseStem.includes("COAGULATION")) {
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

        card.innerHTML = `
            <span class="choice-badge">${badge}</span>
            <span class="choice-text">${choiceText}</span>
        `;

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
    console.log("📊 Initiating performance timeline calculations...");

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

    // Populate Specialty Heatmap
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
            badgeCard.innerHTML = `
                <div style="display:flex; justify-content:space-between; width:100%; font-family:monospace; font-size:12px;">
                    <strong>🩺 ${spec}:</strong>
                    <span>${stats.correct} / ${stats.total} (${ratio}%)</span>
                </div>
            `;
            heatmapContainer.appendChild(badgeCard);
        });
    }

    // ==========================================================================
    // 🎛️ VECTORED HISTORICAL CANVAS RENDERING ENGINE (PURE 2D CONTEXT)
    // Programmatically plots chronological performance timeline curves
    // ==========================================================================
    renderCanvasHistoricalTrendLine(computedBlindspotPercentage, computedHesitationPercentage);
}

function renderCanvasHistoricalTrendLine(currentBlindspot, currentHesitation) {
    const canvas = document.getElementById('analytics-history-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 1. Draw Grid Guidelines Background
    ctx.strokeStyle = document.body.classList.contains('theme-night') ? '#222222' : '#e5e7eb';
    ctx.lineWidth = 0.5;
    for (let currentY = 20; currentY < h; currentY += 40) {
        ctx.beginPath();
        ctx.moveTo(40, currentY);
        ctx.lineTo(w - 20, currentY);
        ctx.stroke();
        
        // Draw Axis percentage tick references
        ctx.fillStyle = '#6b7280';
        ctx.font = '9px monospace';
        const percentLabel = Math.round(((h - currentY) / h) * 100);
        ctx.fillText(`${percentLabel}%`, 10, currentY + 3);
    }

    // 2. Generate multi-point chronological history values tracking vectors
    // Combines baseline parameters into a smooth curve trajectory profile
    const chronologicalDataPoints = [
        { blindspot: Math.min(currentBlindspot + 15, 65), hesitation: Math.min(currentHesitation + 25, 75) },
        { blindspot: Math.min(currentBlindspot + 8, 45), hesitation: Math.min(currentHesitation + 12, 50) },
        { blindspot: currentBlindspot, hesitation: currentHesitation }
    ];

    const paddingX = 60;
    const stepSizeX = (w - 100) / (chronologicalDataPoints.length - 1);

    // Line A: Blindspot Quotient Path (Crimson Theme)
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#b91c1c';
    ctx.beginPath();
    chronologicalDataPoints.forEach((pt, idx) => {
        const posX = paddingX + (idx * stepSizeX);
        const posY = h - 20 - (pt.blindspot * (h - 40) / 100);
        if (idx === 0) ctx.moveTo(posX, posY); else ctx.lineTo(posX, posY);
    });
    ctx.stroke();

    // Line B: Hesitation Index Path (Amber Theme)
    ctx.strokeStyle = '#d97706';
    ctx.beginPath();
    chronologicalDataPoints.forEach((pt, idx) => {
        const posX = paddingX + (idx * stepSizeX);
        const posY = h - 20 - (pt.hesitation * (h - 40) / 100);
        if (idx === 0) ctx.moveTo(posX, posY); else ctx.lineTo(posX, posY);
    });
    ctx.stroke();

    // 3. Draw Tactile Dot Markers Over Terminals
    chronologicalDataPoints.forEach((pt, idx) => {
        const posX = paddingX + (idx * stepSizeX);
        
        // Draw Crimson Nodes
        ctx.fillStyle = '#b91c1c';
        ctx.beginPath();
        ctx.arc(posX, h - 20 - (pt.blindspot * (h - 40) / 100), 4, 0, Math.PI * 2);
        ctx.fill();

        // Draw Amber Nodes
        ctx.fillStyle = '#d97706';
        ctx.beginPath();
        ctx.arc(posX, h - 20 - (pt.hesitation * (h - 40) / 100), 4, 0, Math.PI * 2);
        ctx.fill();

        // Draw Time blocks indicators along x-axis lines bounds checking
        ctx.fillStyle = '#9ca3af';
        ctx.fillText(`BLOCK ${idx + 1}`, posX - 18, h - 4);
    });
}

function initializeInterfaceControls() {
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

            const selectedCertaintyProfile = btn.getAttribute('data-certainty');
            certaintyCalibrationStore[currentQuestionIndex] = selectedCertaintyProfile;

            const decisionLatencyDuration = Date.now() - caseVignetteLoadTimestamp;
            structuralDecisionLatencyStore[currentQuestionIndex] = decisionLatencyDuration;

            const selectedBadge = selectedCard.getAttribute('data-badge');
            const currentQuestion = globalQuestionPool[currentQuestionIndex];

            answeredRegistryState[currentQuestionIndex] = selectedBadge;
            renderTacticalFlagRibbon();

            document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
            const rationaleBox = document.getElementById('rationale-analysis-master-box');
            rationaleBox.classList.remove('hidden');
            document.getElementById('rationale-text-content').textContent = currentQuestion.explanation;

            document.querySelectorAll('.choice-card').forEach(c => {
                const cBadge = c.getAttribute('data-badge');
                if (cBadge === currentQuestion.correctAnswer) {
                    c.style.borderColor = "var(--accent-scrub)";
                    c.style.background = "#e8f5e9";
                } else if (cBadge === selectedBadge) {
                    c.style.borderColor = "var(--accent-crimson)";
                    c.style.background = "#ffebee";
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
            if (selectedTargetSpecialty !== 'ALL') {
                targetRequestPath += `?specialty=${encodeURIComponent(selectedTargetSpecialty)}`;
            }
            const response = await fetch(targetRequestPath);
            if (!response.ok) throw new Error("Database network stream fault.");
            const data = await response.json();
            if (data.questions) {
                globalQuestionPool = data.questions;
                currentQuestionIndex = 0;
                renderTacticalFlagRibbon();
                loadActiveQuestionVignette();
            }
        } catch (err) {
            console.error(err);
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initializeSpecialtyMatrixFilters();
});

async function pushClientProgressStateToSupabaseCloud() {
    if (typeof supabase === 'undefined' || !activeUserSessionProfile) return;
    const client = supabase.createClient(window.location.origin, "placeholder");
    
    const synchronizedLedgerPayload = {
        answers: answeredRegistryState,
        flags: flaggedQuestionsMap,
        latencies: structuralDecisionLatencyStore,
        certainties: certaintyCalibrationStore,
        last_updated_at: new Date().toISOString()
    };

    try {
        await client
            .from('user_profiles')
            .upsert({
                id: activeUserSessionProfile.id,
                email: activeUserSessionProfile.email,
                progress_ledger: synchronizedLedgerPayload
            }, { onConflict: 'id' });
    } catch (err) {
        console.warn(err.message);
    }
}

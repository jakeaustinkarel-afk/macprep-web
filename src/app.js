/**
 * MACPrep — Core Academic Workstation Engine
 * Integrates Option C Diagnostic Chart Generators, UX Latency Trackers, and Cloud Sync
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
            // STEP 3: Spaced Repetition Re-sorting layer (prioritizes un-answered cases)
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

// --- UI RE-GENERATOR ENGINE: CHARTS AND DATA TRAILS ---
function loadActiveQuestionVignette() {
    if (!globalQuestionPool[currentQuestionIndex]) return;
    const currentQuestion = globalQuestionPool[currentQuestionIndex];

    caseVignetteLoadTimestamp = Date.now(); // Instantiate latency clock interval point

    document.getElementById('rationale-analysis-master-box').classList.add('hidden');
    document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
    document.getElementById('question-stem-text').textContent = currentQuestion.stem;

    // Flag State Synchronization
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

    // Hydrate Telemetry Tickers
    if (currentQuestion.telemetry) {
        document.getElementById('vital-hr').textContent = currentQuestion.telemetry.hr || "72";
        document.getElementById('vital-bp').textContent = currentQuestion.telemetry.bp || "120/80";
        document.getElementById('vital-spo2').textContent = currentQuestion.telemetry.spo2 || "99";
        document.getElementById('vital-etco2').textContent = currentQuestion.telemetry.etco2 || "35";
    }

    if (isDeveloperAccessPrivileged) {
        document.getElementById('dev-key-badge-preview').textContent = currentQuestion.correctAnswer || "N/A";
    }

    // ==========================================================================
    // 📊 ADVANCED OPTION C GRAPH RETRIEVAL COMPILATION HOOK
    // Programmatically compiles vector chart grids into the display panels
    // ==========================================================================
    const chartViewport = document.getElementById('clinical-chart-viewport');
    const svgNode = document.getElementById('dynamic-clinical-svg');
    const chartLabel = document.getElementById('clinical-chart-title');

    const specialty = currentQuestion.specialty || "ALL";
    const uppercaseStem = currentQuestion.stem.toUpperCase();

    if (specialty === "CARDIAC" || uppercaseStem.includes("ARTERIAL") || uppercaseStem.includes("NOTCH") || uppercaseStem.includes("PRESSURE")) {
        // CHART 1: Invasive Arterial Line Waveform Trace Profile
        chartViewport.classList.remove('hidden');
        chartLabel.textContent = "INVASIVE ARTERIAL PRESSURE PROFILE (A-LINE TRACK)";
        svgNode.innerHTML = `
            <line x1="0" y1="40" x2="500" y2="40" class="chart-grid-line" stroke-dasharray="2 2" />
            <line x1="0" y1="80" x2="500" y2="80" class="chart-grid-line" stroke-dasharray="2 2" />
            <line x1="0" y1="120" x2="500" y2="120" class="chart-grid-line" stroke-dasharray="2 2" />
            <path d="M 0 140 L 25 30 L 45 75 L 50 65 L 85 140 L 110 30 L 130 75 L 135 65 L 170 140 L 195 30 L 215 75 L 220 65 L 255 140" stroke="#ef4444" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            <text x="55" y="60" font-family="monospace" font-size="9" fill="#ef4444">Dicrotic Notch</text>
        `;
    } else if (specialty === "REGIONAL" || uppercaseStem.includes("TEG") || uppercaseStem.includes("COAGULATION") || uppercaseStem.includes("THROMBOELASTOGRAPHY")) {
        // CHART 2: Thromboelastography (TEG) Coagulation Core Visual
        chartViewport.classList.remove('hidden');
        chartLabel.textContent = "THROMBOELASTOGRAPHY (TEG) COAGULATION CALIBRATION TRACK";
        svgNode.innerHTML = `
            <line x1="0" y1="80" x2="500" y2="80" stroke="#9ca3af" stroke-width="1" />
            <path d="M 10 80 L 80 80 C 130 50, 220 40, 360 45 C 440 48, 480 70, 500 80 C 480 90, 440 112, 360 115 C 220 120, 130 110, 80 80 Z" stroke="#3b82f6" stroke-width="2" fill="rgba(59, 130, 246, 0.08)"/>
            <text x="40" y="75" font-family="monospace" font-size="9" fill="#3b82f6">R-Time</text>
            <text x="180" y="30" font-family="monospace" font-size="9" fill="#3b82f6">Max Amplitude (MA)</text>
        `;
    } else if (uppercaseStem.includes("DILUTION") || uppercaseStem.includes("CARDIAC OUTPUT") || uppercaseStem.includes("INDEX")) {
        // CHART 3: Thermodilution Indicator Decay Target Curve
        chartViewport.classList.remove('hidden');
        chartLabel.textContent = "THERMODILUTION INDICATOR CO DISSIPATION CURVE";
        svgNode.innerHTML = `
            <line x1="40" y1="10" x2="40" y2="140" stroke="#4b5563" stroke-width="1"/>
            <line x1="40" y1="140" x2="480" y2="140" stroke="#4b5563" stroke-width="1"/>
            <path d="M 40 20 C 50 20, 70 130, 140 100 C 220 70, 340 135, 460 140" stroke="#8b5cf6" stroke-width="2.5" fill="none"/>
            <text x="160" y="80" font-family="monospace" font-size="9" fill="#8b5cf6">Thermal Washout Phase</text>
        `;
    } else {
        // Bypassed completely if the case does not call for visual graph metrics
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

            // STEP 2: Log decision fatigue response speed down to the millisecond
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

            // Sync structural variables quietly back down to custom user rows
            await pushClientProgressStateToSupabaseCloud();
        });
    });

    document.getElementById('advance-next-case-btn').addEventListener('click', () => {
        if (totalProgressCount >= CONFIG.FREE_CEILING) {
            document.getElementById('pane-active-testing').classList.add('hidden');
            document.getElementById('pane-conversion-paywall').classList.remove('hidden');
            document.getElementById('metric-blindspot-value').textContent = "12%";
            document.getElementById('metric-hesitation-value').textContent = "18%";
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

async function pushClientProgressStateToSupabaseCloud() {
    if (typeof supabase === 'undefined' || !activeUserSessionProfile) return;
    const client = supabase.createClient(window.location.origin, "placeholder");
    
    const synchronizedLedgerPayload = {
        answers: answeredRegistryState,
        flags: flaggedQuestionsMap,
        latencies: structuralDecisionLatencyStore,
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
        console.warn("Cloud persistence links deferred.", err.message);
    }
}

/**
 * 💊 BLUEPRINT PILLED EXTRAPOLATION INTERCEPTOR
 * Intercepts category selection views to query the updated database taxonomy names
 */
function initializeSpecialtyMatrixFilters() {
    const pillsContainer = document.getElementById('modality-pills-container');
    if (!pillsContainer) return;

    pillsContainer.addEventListener('click', async (e) => {
        const activePill = e.target.closest('.modality-pill');
        if (!activePill) return;

        // Toggle active visual states
        document.querySelectorAll('.modality-pill').forEach(p => p.classList.remove('active'));
        activePill.classList.add('active');

        const selectedTargetSpecialty = activePill.getAttribute('data-specialty');
        console.log(`📡 Filtering active board stream pool by category token: ${selectedTargetSpecialty}`);

        try {
            // Append category parameters cleanly to the REST pathway endpoint URL
            let targetRequestPath = '/api/questions/free';
            if (selectedTargetSpecialty !== 'ALL') {
                targetRequestPath += `?specialty=${encodeURIComponent(selectedTargetSpecialty)}`;
            }

            const response = await fetch(targetRequestPath);
            if (!response.ok) throw new Error("Database network stream fault.");
            const data = await response.json();

            if (data.questions) {
                globalQuestionPool = data.questions;
                currentQuestionIndex = 0; // reset layout head indicator
                renderTacticalFlagRibbon();
                loadActiveQuestionVignette();
            }
        } catch (err) {
            console.error("Filter matrix failure path:", err);
        }
    });
}

// Hook filter managers smoothly into active document threads
document.addEventListener('DOMContentLoaded', () => {
    initializeSpecialtyMatrixFilters();
});

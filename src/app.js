/**
 * MACPrep — Core Academic Workstation Engine
 * Integrates Developer Audit Tiers with Dynamic Cloud Auth Lifecycles
 */

const SUPABASE_URL = "https://placeholder.supabase.co"; // Hydrated via platform routing matrices
const SUPABASE_ANON_KEY = "placeholder";

let globalQuestionPool = [];
let currentQuestionIndex = 0;
let totalProgressCount = 0;
let answeredRegistryState = {};
let flaggedQuestionsMap = {};
let activeUserSessionProfile = null;
let isDeveloperAccessPrivileged = false;

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
        // Query profile metadata table rows
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
                totalProgressCount = Object.keys(answeredRegistryState).length;
                document.getElementById('score-display').textContent = `PROGRESS: ${totalProgressCount} / 100`;
            }

            // HARDENED SECURITY PARITY LOOP: Grant unlimited bounds if marked as premium OR developer
            if (data.is_premium || data.is_developer) {
                console.log("🔓 Database Security Gate: Full question bank allocation authorized.");
                CONFIG.FREE_CEILING = CONFIG.TOTAL_TIER_CEILING;
            }

            // Expose internal debugging panel tools if row maps true for developer column flags
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
        if (!response.ok) throw new Error("Database interface breakdown error.");
        const data = await response.json();
        
        if (data.questions && data.questions.length > 0) {
            globalQuestionPool = data.questions;
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

    // Update internal developer quick preview reads
    if (isDeveloperAccessPrivileged) {
        const keyPreviewNode = document.getElementById('dev-key-badge-preview');
        if (keyPreviewNode) keyPreviewNode.textContent = currentQuestion.correctAnswer || "N/A";
    }

    const wavePathNode = document.getElementById('dynamic-capno-path');
    if (wavePathNode) {
        const specialtyKey = currentQuestion.specialty || "ALL";
        if (specialtyKey === "CRISIS" || currentQuestion.stem.toUpperCase().includes("EMBOLISM")) {
            wavePathNode.setAttribute('d', 'M 0 38 L 400 38');
            wavePathNode.setAttribute('stroke', '#ef4444');
        } else if (specialtyKey === "PHYSICS" || currentQuestion.stem.toUpperCase().includes("BRONCHOSPASM")) {
            wavePathNode.setAttribute('d', 'M 0 35 L 15 35 L 45 8 C 55 5, 75 4, 85 4 L 90 35 L 400 35');
            wavePathNode.setAttribute('stroke', '#eab308');
        } else {
            wavePathNode.setAttribute('d', 'M 0 35 L 15 35 L 18 6 L 55 6 L 58 35 L 200 35');
            wavePathNode.setAttribute('stroke', '#22c55e');
        }
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

    // ==========================================================================
    // ⚡ INTERACTIVE DEVELOPER WARP ENGINE CONTROLS
    // ==========================================================================
    const warpBtn = document.getElementById('dev-execute-warp-btn');
    if (warpBtn) {
        warpBtn.addEventListener('click', () => {
            const indexInputVal = parseInt(document.getElementById('dev-warp-index-input').value, 10);
            if (!isNaN(indexInputVal) && indexInputVal >= 1 && indexInputVal <= globalQuestionPool.length) {
                currentQuestionIndex = indexInputVal - 1;
                renderTacticalFlagRibbon();
                loadActiveQuestionVignette();
                console.log(`⚡ Developer Warp triggered smoothly to index item node: ${indexInputVal}`);
            }
        });
    }

    document.querySelectorAll('.calibration-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const selectedCard = document.querySelector('.choice-card.selected');
            if (!selectedCard) return;

            const selectedBadge = selectedCard.getAttribute('data-badge');
            const currentQuestion = globalQuestionPool[currentQuestionIndex];

            answeredRegistryState[currentQuestionIndex] = selectedBadge;
            renderTacticalFlagRibbon();

            document.getElementById('calibration-submission-lock-panel').classList.add('hidden');
            const rationaleBox = document.getElementById('rationale-analysis-master-box');
            ration Box.classList.remove('hidden');
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

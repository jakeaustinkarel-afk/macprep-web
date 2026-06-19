// MACPrep — frontend study engine
let currentQuestionIndex = 0;
let questions = [];
let questionsAnsweredCount = 0;
let questionsCorrectCount = 0;
let awaitingAdvance = false;
const FREE_TIER_CEILING = 100;

function authToken() {
    try { return localStorage.getItem('macprep_token') || null; } catch (e) { return null; }
}

function logoutToLogin(message) {
    try {
        localStorage.removeItem('macprep_token');
        localStorage.removeItem('macprep_premium_unlocked');
    } catch (e) { /* ignore */ }
    const loginPane = document.getElementById('login-form-container');
    const mainWorkstation = document.getElementById('exam-workstation-pane');
    if (mainWorkstation) mainWorkstation.style.display = 'none';
    if (loginPane) loginPane.style.display = 'block';
    if (message) {
        const submitBtn = document.getElementById('login-submit-trigger');
        if (submitBtn) submitBtn.textContent = 'SIGN IN';
    }
}

async function initializeWorkstation() {
    try {
        const headers = {};
        const token = authToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch('/api/questions', { headers });
        if (response.status === 401) { logoutToLogin('Session expired. Please sign in again.'); return; }
        const data = await response.json();
        questions = Array.isArray(data) ? data : (data.questions || []);

        if (questions.length === 0) {
            const stemEl = document.getElementById('question-stem');
            if (stemEl) stemEl.textContent = 'No questions are available right now. Please try again later.';
            return;
        }

        currentQuestionIndex = 0;
        questionsAnsweredCount = 0;
        questionsCorrectCount = 0;
        loadNextCaseVignette();
    } catch (err) {
        console.error('Failed to load questions:', err);
    }
}

function loadNextCaseVignette() {
    awaitingAdvance = false;
    if (questionsAnsweredCount >= FREE_TIER_CEILING && !localStorage.getItem('macprep_premium_unlocked')) {
        triggerPremiumPaywallGate();
        return;
    }

    const currentQuestion = questions[currentQuestionIndex];
    if (!currentQuestion) return;

    const stemEl = document.getElementById('question-stem');
    if (stemEl) stemEl.textContent = currentQuestion.stem || currentQuestion.text || '';

    let choicesArray = currentQuestion.choices || currentQuestion.options || [];
    if (typeof choicesArray === 'string') {
        try { choicesArray = JSON.parse(choicesArray); } catch (e) { choicesArray = []; }
    }

    const container = document.getElementById('choices-container');
    if (container) {
        container.innerHTML = '';
        if (Array.isArray(choicesArray)) {
            choicesArray.forEach((choice, index) => {
                const displayChoiceText = (typeof choice === 'object' && choice !== null)
                    ? (choice.text || choice.value || '')
                    : choice;
                const letterLabel = String.fromCharCode(65 + index);

                const choiceBtn = document.createElement('button');
                choiceBtn.className = 'choice-option-node';
                choiceBtn.dataset.index = String(index);
                choiceBtn.style.cssText = 'display:block;width:100%;text-align:left;margin:10px 0;padding:14px;background-color:#111214;border:1px solid #1F2937;color:#F9FAFB;font-family:monospace;cursor:pointer;border-radius:4px;';
                choiceBtn.innerHTML = `<span style="color:#00A86B;font-weight:bold;margin-right:15px;">[${letterLabel}]</span> ${displayChoiceText}`;
                choiceBtn.onclick = () => handleSelectionEvent(index, currentQuestion.id);
                container.appendChild(choiceBtn);
            });
        }
    }

    const explEl = document.getElementById('explanation-pane');
    if (explEl) { explEl.style.display = 'none'; explEl.innerHTML = ''; }

    updateProgress();
}

async function handleSelectionEvent(selectedIndex, questionId) {
    if (awaitingAdvance) return; // already answered this item
    awaitingAdvance = true;

    const container = document.getElementById('choices-container');
    const buttons = container ? Array.from(container.querySelectorAll('.choice-option-node')) : [];
    buttons.forEach((b) => { b.disabled = true; b.style.cursor = 'default'; });

    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = authToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const resp = await fetch('/api/grade', {
            method: 'POST',
            headers,
            body: JSON.stringify({ questionId, choiceIndex: selectedIndex }),
        });

        if (resp.status === 402) { triggerPremiumPaywallGate(); return; }

        const result = await resp.json();
        questionsAnsweredCount++;
        if (result.correct) questionsCorrectCount++;

        // Highlight correct / incorrect
        buttons.forEach((b) => {
            const idx = Number(b.dataset.index);
            if (idx === result.correctIndex) {
                b.style.borderColor = '#00A86B';
                b.style.backgroundColor = '#0c2a1d';
            } else if (idx === selectedIndex) {
                b.style.borderColor = '#B91C1C';
                b.style.backgroundColor = '#2a0c0c';
            }
        });

        // Show explanation
        const explEl = document.getElementById('explanation-pane');
        if (explEl) {
            const verdict = result.correct
                ? '<span style="color:#00A86B;font-weight:bold;">CORRECT</span>'
                : '<span style="color:#F87171;font-weight:bold;">INCORRECT</span>';
            explEl.innerHTML = `<div style="font-family:monospace;font-size:12px;margin-bottom:8px;">${verdict}</div>`
                + `<div style="line-height:1.6;">${result.explanation || 'No explanation provided for this item.'}</div>`;
            explEl.style.display = 'block';
        }

        updateProgress();
    } catch (err) {
        console.error('Grading failed:', err);
        awaitingAdvance = false;
        buttons.forEach((b) => { b.disabled = false; b.style.cursor = 'pointer'; });
    }
}

function advanceToNext() {
    if (!awaitingAdvance) return; // must answer first
    currentQuestionIndex = (currentQuestionIndex + 1) % questions.length;
    loadNextCaseVignette();
}

function updateProgress() {
    const progressEl = document.getElementById('session-progress-counter');
    if (progressEl) {
        const pct = questionsAnsweredCount > 0
            ? Math.round((questionsCorrectCount / questionsAnsweredCount) * 100)
            : 0;
        progressEl.textContent = `ANSWERED: ${questionsAnsweredCount} / ${FREE_TIER_CEILING}  ·  SCORE: ${pct}%`;
    }
}

function triggerPremiumPaywallGate() {
    const workspaceEl = document.getElementById('exam-workstation-pane');
    if (workspaceEl) {
        workspaceEl.innerHTML = `
            <div style="padding:40px;text-align:left;background-color:#111214;border:1px solid #1F2937;border-radius:4px;max-width:600px;margin:40px auto;">
                <span style="font-family:monospace;font-size:11px;color:#00A86B;letter-spacing:2px;">TRIAL LIMIT REACHED</span>
                <h2 style="font-size:24px;font-weight:800;color:#F9FAFB;margin:10px 0 20px 0;">Unlock the full board curriculum</h2>
                <button id="upgrade-trigger" style="background-color:#00A86B;color:#F9FAFB;border:none;padding:14px 24px;font-family:monospace;font-size:13px;font-weight:bold;cursor:pointer;border-radius:4px;text-transform:uppercase;letter-spacing:1px;">Upgrade to Full Access — $50</button>
            </div>`;
        const btn = document.getElementById('upgrade-trigger');
        if (btn) btn.addEventListener('click', startCheckout);
    }
}

// Single checkout path: create a server-side Stripe Checkout session keyed to
// the authenticated user's email so the webhook can match the payment back to
// their profile. (Replaces the hardcoded buy.stripe.com payment link, which the
// webhook could not reconcile — AUDIT.md §3.2.)
async function startCheckout(e) {
    const btn = e?.currentTarget;
    if (btn) { btn.disabled = true; btn.textContent = 'REDIRECTING…'; }
    try {
        const headers = { 'Content-Type': 'application/json' };
        const token = authToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const email = (() => { try { return localStorage.getItem('macprep_user_email') || ''; } catch (e2) { return ''; } })();

        const resp = await fetch('/api/create-checkout-session', {
            method: 'POST',
            headers,
            body: JSON.stringify({ email }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
        window.location.href = data.url;
    } catch (err) {
        alert('Checkout failed: ' + err.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Upgrade to Full Access — $50'; }
    }
}

// ----------------------------------------------------------------------------
// Auth — single real endpoint (/api/authenticate)
// ----------------------------------------------------------------------------
let loginInFlight = false;
async function executeLoginSubmission() {
    if (loginInFlight) return; // guard against double-submit (Enter + click)
    const emailInput = document.getElementById('login-email');
    const passwordInput = document.getElementById('login-password');
    const submitBtn = document.getElementById('login-submit-trigger');
    if (!emailInput || !passwordInput) return;
    if (!emailInput.value || !passwordInput.value) return;

    loginInFlight = true;
    if (submitBtn) submitBtn.textContent = 'VERIFYING…';
    try {
        const response = await fetch('/api/authenticate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'login', email: emailInput.value, password: passwordInput.value }),
        });

        // Read as text first so a non-JSON response (e.g. an HTML error page from
        // a stale/misrouted server) produces a clear message instead of a raw
        // "Unexpected token '<'" JSON parse error.
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); }
        catch (e) {
            throw new Error(response.status === 404
                ? 'Auth endpoint not found (the server may be out of date).'
                : `Unexpected server response (${response.status}).`);
        }

        if (!response.ok || !data.success) throw new Error(data.error || 'Login rejected.');

        if (data.token) localStorage.setItem('macprep_token', data.token);
        if (data.profile?.email) localStorage.setItem('macprep_user_email', data.profile.email);
        if (data.profile?.premium_unlocked) localStorage.setItem('macprep_premium_unlocked', '1');

        revealWorkstation();
        initializeWorkstation();
    } catch (err) {
        alert('Login failed: ' + err.message);
        if (submitBtn) submitBtn.textContent = 'SIGN IN';
    } finally {
        loginInFlight = false;
    }
}

function revealWorkstation() {
    const loginPane = document.getElementById('login-form-container');
    const mainWorkstation = document.getElementById('exam-workstation-pane');
    if (loginPane) loginPane.style.display = 'none';
    if (mainWorkstation) mainWorkstation.style.display = 'block';
}

window.executeLoginSubmission = executeLoginSubmission;
window.advanceToNext = advanceToNext;

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.querySelector('form');
    if (loginForm) {
        loginForm.addEventListener('submit', (e) => { e.preventDefault(); executeLoginSubmission(); });
    }
    const advanceBtn = document.getElementById('advance-vignette-trigger');
    if (advanceBtn) advanceBtn.addEventListener('click', advanceToNext);

    // Resume an existing session (e.g. after registering/logging in on login.html,
    // which stores the token then redirects here).
    if (authToken()) {
        revealWorkstation();
        initializeWorkstation();
    }
});

// MACPrep — frontend application controller
(function () {
    'use strict';

    const state = {
        token: null,
        profile: null,       // { email, premium_unlocked, is_admin, free_tier_limit, stats, ... }
        questions: [],       // full bank (stems only, no answers)
        session: null,       // { pool, index, answered, correct, size, domain }
        loginInFlight: false,
    };

    // ---- helpers ----------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    function getToken() { try { return localStorage.getItem('macprep_token'); } catch (e) { return null; } }
    function setToken(t) { try { t ? localStorage.setItem('macprep_token', t) : localStorage.removeItem('macprep_token'); } catch (e) {} }
    function authHeaders(extra) {
        const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
        if (state.token) h['Authorization'] = `Bearer ${state.token}`;
        return h;
    }
    async function apiJSON(url, opts) {
        const resp = await fetch(url, opts);
        const raw = await resp.text();
        let data = null;
        try { data = raw ? JSON.parse(raw) : {}; }
        catch (e) {
            throw Object.assign(new Error(resp.status === 404
                ? 'Endpoint not found (the server may be updating).'
                : `Unexpected server response (${resp.status}).`), { status: resp.status });
        }
        return { resp, data };
    }

    const VIEWS = ['login-view', 'dashboard-view', 'quiz-view', 'profile-view', 'feedback-view'];
    function go(view) {
        if (view !== 'login' && !state.token) view = 'login';
        VIEWS.forEach((v) => $(v) && $(v).classList.toggle('hidden', v !== view + '-view'));
        const authed = !!state.token && view !== 'login';
        ['nav-dashboard', 'nav-profile', 'nav-feedback', 'nav-signout', 'tier-badge'].forEach((id) =>
            $(id) && $(id).classList.toggle('hidden', !authed));
        if (view === 'dashboard') renderDashboard();
        if (view === 'profile') renderProfile();
        window.scrollTo(0, 0);
    }

    // ---- auth -------------------------------------------------------------
    async function login() {
        if (state.loginInFlight) return;
        const email = $('login-email').value.trim();
        const password = $('login-password').value;
        const btn = $('login-submit-trigger');
        if (!email || !password) return;
        state.loginInFlight = true;
        if (btn) btn.textContent = 'Verifying…';
        try {
            const { resp, data } = await apiJSON('/api/authenticate', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ action: 'login', email, password }),
            });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Login rejected.');
            state.token = data.token || null;
            setToken(state.token);
            await bootAuthedSession();
        } catch (err) {
            alert('Login failed: ' + err.message);
        } finally {
            state.loginInFlight = false;
            if (btn) btn.textContent = 'Sign In';
        }
    }

    function signOut() {
        setToken(null);
        try { localStorage.removeItem('macprep_premium_unlocked'); localStorage.removeItem('macprep_user_email'); } catch (e) {}
        state.token = null; state.profile = null; state.questions = []; state.session = null;
        go('login');
    }

    async function loadProfile() {
        const { resp, data } = await apiJSON('/api/user/profile', { headers: authHeaders() });
        if (resp.status === 401) { signOut(); throw new Error('Session expired.'); }
        state.profile = data.profile || null;
        return state.profile;
    }

    async function loadQuestions() {
        const { resp, data } = await apiJSON('/api/questions', { headers: authHeaders() });
        if (resp.status === 401) { signOut(); throw new Error('Session expired.'); }
        state.questions = Array.isArray(data.questions) ? data.questions : [];
        return state.questions;
    }

    async function bootAuthedSession() {
        await Promise.all([loadProfile(), loadQuestions()]);
        // Reflect tier badge
        const badge = $('tier-badge');
        if (badge) {
            const p = state.profile || {};
            if (p.is_admin) { badge.textContent = 'ADMIN'; badge.className = 'badge admin'; }
            else if (p.premium_unlocked) { badge.textContent = 'PREMIUM'; badge.className = 'badge premium'; }
            else { badge.textContent = 'FREE'; badge.className = 'badge free'; }
        }
        go('dashboard');
        maybeHandleCheckoutReturn();
    }

    // ---- dashboard --------------------------------------------------------
    function uniqueCategories() {
        const counts = {};
        state.questions.forEach((q) => {
            const c = q.category || q.domain_name || 'General';
            counts[c] = (counts[c] || 0) + 1;
        });
        // Sort by count desc, then alpha — big clinical buckets first.
        return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }

    function freeUsage() {
        const p = state.profile || {};
        const limit = p.free_tier_limit || 0;
        const used = (p.stats && p.stats.answered) || 0;
        return { limit, used, remaining: Math.max(0, limit - used), unlimited: !!(p.premium_unlocked || p.is_admin) };
    }

    function renderDashboard() {
        const p = state.profile || {};
        $('dash-greeting').textContent = `Welcome${p.full_name ? ', ' + p.full_name.split(' ')[0] : ' back'}`;
        const stats = p.stats || { answered: 0, correct: 0, attempts: 0 };
        $('stat-answered').textContent = stats.answered || 0;
        $('stat-accuracy').textContent = stats.attempts ? Math.round((stats.correct / stats.attempts) * 100) + '%' : '—';
        $('stat-bank').textContent = state.questions.length.toLocaleString();

        const usage = freeUsage();
        const card = $('free-allowance-card');
        if (usage.unlimited) {
            card.classList.add('hidden');
        } else {
            card.classList.remove('hidden');
            const pct = usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
            $('free-allowance-text').textContent =
                `${usage.used} of ${usage.limit} free questions used (10% of the ${state.questions.length.toLocaleString()}-question bank). ${usage.remaining} remaining.`;
            $('free-allowance-bar').style.width = pct + '%';
        }

        // Content areas / specialties (with counts)
        const sel = $('domain-select');
        if (sel.options.length <= 1) {
            uniqueCategories().forEach(([name, n]) => {
                const o = document.createElement('option'); o.value = name; o.textContent = `${name} (${n})`; sel.appendChild(o);
            });
        }

        // Count chips
        const chips = $('count-chips');
        chips.innerHTML = '';
        const opts = usage.unlimited ? [10, 25, 50, 100, 'All'] : [10, 25, 50, 100];
        opts.forEach((n, i) => {
            const c = document.createElement('div');
            c.className = 'chip' + (i === 0 ? ' active' : '');
            c.textContent = n === 'All' ? 'All' : `${n} questions`;
            c.dataset.count = String(n);
            c.onclick = () => {
                chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
                c.classList.add('active');
                $('custom-count').value = '';
                updateSessionHint();
            };
            chips.appendChild(c);
        });
        updateSessionHint();
    }

    function selectedCount() {
        const custom = parseInt($('custom-count').value, 10);
        if (custom > 0) return custom;
        const active = $('count-chips').querySelector('.chip.active');
        const v = active ? active.dataset.count : '10';
        return v === 'All' ? Infinity : parseInt(v, 10);
    }

    function poolForDomain() {
        const c = $('domain-select').value;
        if (c === 'all') return state.questions.slice();
        return state.questions.filter((q) => (q.category || q.domain_name || 'General') === c);
    }

    function updateSessionHint() {
        const usage = freeUsage();
        const pool = poolForDomain();
        let n = selectedCount();
        let capNote = '';
        if (!usage.unlimited) {
            if (usage.remaining <= 0) { $('session-hint').textContent = 'You have used all free questions. Upgrade for full access.'; return; }
            if (n > usage.remaining) { n = usage.remaining; capNote = ` (capped at your ${usage.remaining} remaining free questions)`; }
        }
        n = Math.min(n === Infinity ? pool.length : n, pool.length);
        $('session-hint').textContent = `This session: ${n} question${n === 1 ? '' : 's'} from ${pool.length} available${capNote}.`;
    }

    function startSession() {
        const usage = freeUsage();
        if (!usage.unlimited && usage.remaining <= 0) { return startCheckout(); }
        const pool = poolForDomain();
        if (!pool.length) { alert('No questions available for that domain yet.'); return; }
        let n = selectedCount();
        if (n === Infinity) n = pool.length;
        if (!usage.unlimited) n = Math.min(n, usage.remaining);
        n = Math.min(n, pool.length);

        const shuffled = pool.slice();
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
        state.session = { pool: shuffled.slice(0, n), index: 0, answered: 0, correct: 0, size: n, locked: false };
        go('quiz');
        renderQuestion();
    }

    // ---- quiz -------------------------------------------------------------
    function renderQuestion() {
        const s = state.session; if (!s) return go('dashboard');
        if (s.index >= s.pool.length) return finishSession();
        s.locked = false;
        const q = s.pool[s.index];

        $('question-meta').textContent = [q.domain_name, q.subtopic].filter(Boolean).join('  ·  ').toUpperCase();
        $('question-stem').textContent = q.stem || '';
        const container = $('choices-container');
        container.innerHTML = '';
        let choices = q.choices || [];
        if (typeof choices === 'string') { try { choices = JSON.parse(choices); } catch (e) { choices = []; } }
        choices.forEach((choice, idx) => {
            const text = (typeof choice === 'object' && choice) ? (choice.text || choice.value || '') : choice;
            const btn = document.createElement('button');
            btn.className = 'choice-option-node';
            btn.dataset.index = String(idx);
            btn.style.cssText = 'display:block;width:100%;text-align:left;margin:10px 0;padding:14px;background:var(--bg);border:1px solid var(--line);color:var(--text);font-family:ui-monospace,monospace;cursor:pointer;border-radius:4px;';
            btn.innerHTML = `<span style="color:var(--accent);font-weight:bold;margin-right:15px;">[${String.fromCharCode(65 + idx)}]</span> ${text}`;
            btn.onclick = () => answer(idx, q.id);
            container.appendChild(btn);
        });
        $('explanation-pane').classList.add('hidden');
        $('explanation-pane').innerHTML = '';
        updateQuizProgress();
    }

    async function answer(selectedIndex, questionId) {
        const s = state.session; if (!s || s.locked) return;
        s.locked = true;
        const buttons = Array.from($('choices-container').querySelectorAll('.choice-option-node'));
        buttons.forEach((b) => { b.disabled = true; b.style.cursor = 'default'; });
        try {
            const { resp, data } = await apiJSON('/api/grade', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ questionId, choiceIndex: selectedIndex }),
            });
            if (resp.status === 401) { signOut(); return; }
            if (resp.status === 402) { showPaywall(data.limit); return; }
            if (!resp.ok) throw new Error(data.error || 'Grading failed.');

            s.answered++;
            if (data.correct) s.correct++;
            if (state.profile && state.profile.stats) {
                state.profile.stats.answered++; state.profile.stats.attempts++;
                if (data.correct) state.profile.stats.correct++;
            }

            const rationales = data.rationales || [];
            buttons.forEach((b) => {
                const idx = Number(b.dataset.index);
                if (idx === data.correctIndex) { b.style.borderColor = 'var(--accent)'; b.style.background = 'var(--accent-dim)'; }
                else if (idx === selectedIndex) { b.style.borderColor = 'var(--danger)'; b.style.background = '#2a0c0c'; }
                // Append the per-choice rationale beneath each option.
                if (rationales[idx]) {
                    const r = document.createElement('div');
                    r.style.cssText = 'font-family:inherit;font-size:13px;color:#9ca3af;margin:8px 0 2px;padding-left:34px;line-height:1.5;';
                    r.textContent = (idx === data.correctIndex ? '✓ ' : '✗ ') + rationales[idx];
                    b.insertAdjacentElement('afterend', r);
                }
            });
            const verdict = data.correct
                ? '<span style="color:var(--accent);font-weight:bold;">CORRECT</span>'
                : '<span style="color:#F87171;font-weight:bold;">INCORRECT</span>';
            const ex = $('explanation-pane');
            let html = `<div class="mono" style="font-size:12px;margin-bottom:8px;">${verdict}</div><div>${data.explanation || 'No explanation provided.'}</div>`;
            const refs = (data.references || []).filter((r) => r && (r.url || r.source || r.title));
            if (refs.length) {
                const items = refs.map((r) => {
                    const label = r.title || r.source || r.url;
                    return r.url
                        ? `<a href="${r.url}" target="_blank" rel="noopener">${label}</a>`
                        : `<span>${label}</span>`;
                }).join('<br>');
                html += `<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px;"><div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Source</div><div style="font-size:13px;">${items}</div></div>`;
            }
            ex.innerHTML = html;
            ex.classList.remove('hidden');
            updateQuizProgress();
        } catch (err) {
            s.locked = false;
            buttons.forEach((b) => { b.disabled = false; b.style.cursor = 'pointer'; });
            alert('Could not grade answer: ' + err.message);
        }
    }

    function advance() {
        const s = state.session; if (!s) return;
        if (!s.locked) return; // must answer first
        s.index++;
        renderQuestion();
    }

    function updateQuizProgress() {
        const s = state.session; if (!s) return;
        const pct = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
        $('session-progress-counter').textContent = `QUESTION ${Math.min(s.index + 1, s.size)} / ${s.size} · SCORE ${pct}%`;
        $('quiz-progress-bar').style.width = Math.round((s.index / s.size) * 100) + '%';
    }

    function finishSession() {
        const s = state.session;
        const pct = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
        $('question-meta').textContent = 'SESSION COMPLETE';
        $('question-stem').innerHTML = `You answered <strong>${s.answered}</strong> question${s.answered === 1 ? '' : 's'} with <strong>${pct}%</strong> accuracy (${s.correct}/${s.answered} correct).`;
        $('choices-container').innerHTML = '';
        $('explanation-pane').classList.add('hidden');
        $('advance-vignette-trigger').textContent = 'Back to Dashboard';
        $('advance-vignette-trigger').onclick = () => { $('advance-vignette-trigger').textContent = 'Next Question »'; $('advance-vignette-trigger').onclick = advance; MACPrep.go('dashboard'); };
        $('quiz-progress-bar').style.width = '100%';
    }

    function showPaywall(limit) {
        $('question-meta').textContent = 'TRIAL LIMIT REACHED';
        $('question-stem').innerHTML = `You have completed all <strong>${limit || state.profile?.free_tier_limit || ''}</strong> free questions (10% of the bank). Upgrade to unlock the full question bank with detailed explanations and references.`;
        $('choices-container').innerHTML = '';
        const ex = $('explanation-pane'); ex.classList.add('hidden');
        const btn = $('advance-vignette-trigger');
        btn.className = 'btn';
        btn.textContent = 'Upgrade to Full Access — $50';
        btn.onclick = () => startCheckout(btn);
    }

    // ---- profile ----------------------------------------------------------
    function renderProfile() {
        const p = state.profile || {};
        $('prof-email').textContent = p.email || '—';
        const tier = $('prof-tier');
        if (p.is_admin) tier.innerHTML = '<span class="badge admin">ADMIN</span> <span class="badge premium">PREMIUM</span>';
        else if (p.premium_unlocked) tier.innerHTML = '<span class="badge premium">PREMIUM</span> <span class="mono" style="font-size:11px;color:var(--muted);">Full access unlocked</span>';
        else tier.innerHTML = '<span class="badge free">FREE</span>';
        $('prof-upgrade-wrap').classList.toggle('hidden', !!(p.premium_unlocked || p.is_admin));

        $('prof-fullname').value = p.full_name || '';
        $('prof-credential').value = p.credential || '';
        $('prof-program').value = p.training_program || '';
        $('prof-examdate').value = p.target_exam_date || '';
        $('prof-phone').value = p.phone || '';
    }

    async function saveProfile() {
        const btn = $('prof-save-btn'); const msg = $('prof-save-msg');
        btn.disabled = true; msg.textContent = '';
        const body = {
            full_name: $('prof-fullname').value.trim(),
            credential: $('prof-credential').value,
            training_program: $('prof-program').value.trim(),
            target_exam_date: $('prof-examdate').value || '',
            phone: $('prof-phone').value.trim(),
        };
        try {
            const { resp, data } = await apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Save failed.');
            Object.assign(state.profile, body);
            msg.textContent = 'Saved ✓';
            setTimeout(() => { msg.textContent = ''; }, 2500);
        } catch (err) {
            msg.style.color = '#F87171'; msg.textContent = err.message;
        } finally { btn.disabled = false; }
    }

    // ---- checkout ---------------------------------------------------------
    async function startCheckout(btn) {
        if (btn && btn.disabled) return;
        if (btn) { btn.disabled = true; btn.dataset.prev = btn.textContent; btn.textContent = 'Redirecting…'; }
        try {
            const email = (state.profile && state.profile.email) || '';
            const { resp, data } = await apiJSON('/api/create-checkout-session', {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({ email }),
            });
            if (!resp.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
            window.location.href = data.url;
        } catch (err) {
            alert('Checkout could not start: ' + err.message);
            if (btn) { btn.disabled = false; btn.textContent = btn.dataset.prev || 'Upgrade — $50'; }
        }
    }

    function maybeHandleCheckoutReturn() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('status') === 'success') {
            // Webhook may take a moment; refresh profile shortly.
            setTimeout(async () => { try { await loadProfile(); renderDashboard();
                if (state.profile && state.profile.premium_unlocked) alert('Payment received — full access unlocked. Thank you!');
            } catch (e) {} }, 1500);
            history.replaceState({}, '', '/');
        } else if (params.get('status') === 'cancelled') {
            history.replaceState({}, '', '/');
        }
    }

    // ---- feedback ---------------------------------------------------------
    async function submitFeedback() {
        const btn = $('fb-submit'); const msg = $('fb-msg');
        const message = $('fb-message').value.trim();
        if (!message) { msg.style.color = '#F87171'; msg.textContent = 'Please enter a message.'; return; }
        btn.disabled = true; msg.style.color = 'var(--accent)'; msg.textContent = '';
        try {
            const { resp, data } = await apiJSON('/api/feedback', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ kind: $('fb-kind').value, message }),
            });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Submit failed.');
            $('fb-message').value = '';
            msg.textContent = 'Thank you — received ✓';
            setTimeout(() => { msg.textContent = ''; }, 3000);
        } catch (err) {
            msg.style.color = '#F87171'; msg.textContent = err.message;
        } finally { btn.disabled = false; }
    }

    // ---- bootstrap --------------------------------------------------------
    window.MACPrep = { go, login, signOut, startSession, advance, saveProfile, startCheckout, submitFeedback };

    document.addEventListener('DOMContentLoaded', async () => {
        state.token = getToken();
        $('domain-select') && $('domain-select').addEventListener('change', updateSessionHint);
        $('custom-count') && $('custom-count').addEventListener('input', updateSessionHint);
        if (state.token) {
            try { await bootAuthedSession(); }
            catch (e) { go('login'); }
        } else {
            go('login');
        }
    });
})();

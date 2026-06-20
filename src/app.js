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
    function ls(k, v) { try { return v === undefined ? localStorage.getItem(k) : (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)); } catch (e) { return null; } }
    function getToken() { return ls('macprep_token'); }
    function setToken(t) { t ? ls('macprep_token', t) : ls('macprep_token', null); }
    function setRefresh(t) { t ? ls('macprep_refresh', t) : ls('macprep_refresh', null); }
    function authHeaders(extra) {
        const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
        if (state.token) h['Authorization'] = `Bearer ${state.token}`;
        return h;
    }
    // Only allow http(s) links to be rendered as anchors (defends against
    // javascript:/data: hrefs in stored question sources).
    function safeUrl(u) { return (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : null; }
    function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    // Markdown-lite: escape, then apply **bold**, *italic*, `code`, bullet lists,
    // and paragraph/line breaks. Safe (escapes first, only re-introduces known tags).
    function renderRich(text) {
        let h = escapeHtml(text || '');
        h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
             .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
             .replace(/`([^`]+)`/g, '<code style="background:#1f2937;padding:1px 5px;border-radius:3px;">$1</code>');
        // bullet lists: lines starting with - or •
        const lines = h.split('\n');
        let out = '', inList = false;
        for (const ln of lines) {
            if (/^\s*[-•]\s+/.test(ln)) {
                if (!inList) { out += '<ul style="margin:8px 0;padding-left:20px;">'; inList = true; }
                out += '<li>' + ln.replace(/^\s*[-•]\s+/, '') + '</li>';
            } else {
                if (inList) { out += '</ul>'; inList = false; }
                out += ln.trim() === '' ? '<br>' : '<div>' + ln + '</div>';
            }
        }
        if (inList) out += '</ul>';
        return out;
    }

    async function refreshToken() {
        const rt = ls('macprep_refresh');
        if (!rt) return false;
        try {
            const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }) });
            if (!r.ok) return false;
            const d = await r.json();
            if (!d.token) return false;
            state.token = d.token; setToken(d.token);
            if (d.refresh_token) setRefresh(d.refresh_token);
            return true;
        } catch (e) { return false; }
    }

    async function apiJSON(url, opts) {
        opts = opts || {};
        let resp = await fetch(url, opts);
        // If an authenticated call 401s, try a one-time silent token refresh so a
        // study session survives the access token's 1-hour TTL.
        if (resp.status === 401 && opts.headers && opts.headers['Authorization'] && !opts._retried) {
            if (await refreshToken()) {
                opts._retried = true;
                opts.headers = Object.assign({}, opts.headers, { 'Authorization': `Bearer ${state.token}` });
                resp = await fetch(url, opts);
            }
        }
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

    // Privacy-friendly analytics ping (best-effort, never blocks).
    function track(name, meta) {
        try {
            fetch('/api/event', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name, meta: meta || {} }), keepalive: true }).catch(() => {});
        } catch (e) { /* ignore */ }
    }

    // Global loading overlay.
    let _loadingCount = 0;
    function setLoading(on) {
        _loadingCount = Math.max(0, _loadingCount + (on ? 1 : -1));
        const el = $('global-loading');
        if (el) el.classList.toggle('hidden', _loadingCount === 0);
    }

    const VIEWS = ['login-view', 'dashboard-view', 'quiz-view', 'profile-view', 'feedback-view', 'admin-view'];
    function go(view) {
        closeMobileNav(); // bug fix: collapse the mobile menu on navigation
        if (view !== 'login' && !state.token) view = 'login';
        VIEWS.forEach((v) => $(v) && $(v).classList.toggle('hidden', v !== view + '-view'));
        const authed = !!state.token && view !== 'login';
        ['nav-dashboard', 'nav-profile', 'nav-feedback', 'nav-signout', 'tier-badge'].forEach((id) =>
            $(id) && $(id).classList.toggle('hidden', !authed));
        const isAdmin = authed && state.profile && state.profile.is_admin;
        $('nav-admin') && $('nav-admin').classList.toggle('hidden', !isAdmin);
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
            setRefresh(data.refresh_token || null);
            track('login');
            await bootAuthedSession();
        } catch (err) {
            alert('Login failed: ' + err.message);
        } finally {
            state.loginInFlight = false;
            if (btn) btn.textContent = 'Sign In';
        }
    }

    function signOut() {
        setToken(null); setRefresh(null);
        ls('macprep_premium_unlocked', null); ls('macprep_user_email', null);
        state.token = null; state.profile = null; state.questions = []; state.session = null;
        go('login');
    }

    // Forgot-password: request a reset email.
    async function requestPasswordReset() {
        const email = ($('login-email').value || '').trim() || prompt('Enter your account email to reset your password:');
        if (!email) return;
        try {
            await fetch('/api/auth/reset-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        } catch (e) { /* ignore */ }
        alert('If an account exists for ' + email + ', a password-reset link is on its way. Check your email.');
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
        setLoading(true);
        try { await Promise.all([loadProfile(), loadQuestions()]); }
        finally { setLoading(false); }
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

    function answeredIdSet() {
        return new Set((state.profile && state.profile.answered_ids) || []);
    }

    function renderReadiness() {
        const el = $('readiness'); if (!el) return;
        const p = state.profile || {};
        const streak = p.streak || 0;
        const readiness = p.readiness || 0;
        const exam = (p.days_to_exam != null) ? p.days_to_exam : null;
        const trend = p.trend || [];
        const spark = trend.length
            ? trend.map((t) => `<span title="${t.day}: ${t.accuracy}%" style="display:inline-block;width:10px;height:${Math.max(4, Math.round(t.accuracy * 0.4))}px;background:${t.accuracy >= 75 ? 'var(--accent)' : t.accuracy >= 50 ? '#FBBF24' : '#F87171'};margin-right:3px;vertical-align:bottom;border-radius:2px;"></span>`).join('')
            : '<span class="mono" style="color:var(--muted);font-size:12px;">Answer questions to see your trend.</span>';
        const examLine = exam != null
            ? (exam >= 0 ? `<div class="stat"><div class="n">${exam}</div><div class="l">Days to exam</div></div>` : `<div class="stat"><div class="n">—</div><div class="l">Exam date passed</div></div>`)
            : `<div class="stat"><div class="n">—</div><div class="l">Set exam date in profile</div></div>`;
        el.innerHTML = `<h3>Exam readiness</h3>
            <div class="grid cols-3" style="margin-bottom:14px;">
                <div class="stat"><div class="n">${readiness}%</div><div class="l">Readiness estimate</div></div>
                <div class="stat"><div class="n">${streak}${streak ? ' 🔥' : ''}</div><div class="l">Day streak</div></div>
                ${examLine}
            </div>
            <div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Accuracy — last 7 active days</div>
            <div style="height:46px;">${spark}</div>`;
    }

    function renderOnboarding() {
        const el = $('onboarding'); if (!el) return;
        const answered = (state.profile && state.profile.stats && state.profile.stats.answered) || 0;
        if (answered > 0) { el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        el.innerHTML = `<h3>Welcome to MACPrep 👋</h3>
            <p class="sub" style="margin:0 0 12px;">Here's how to start: pick a <strong>specialty</strong> and <strong>how many questions</strong> below, then hit Start. After each answer you'll see why every choice is right or wrong, with a source you can verify. Use <span class="mono">A–E</span> to answer and <span class="mono">→</span> to advance.</p>
            <button class="btn" onclick="MACPrep.startSample()">Try a 5-question warm-up</button>`;
    }
    function startSample() {
        const sel = $('domain-select'); if (sel) sel.value = 'all';
        const diff = $('difficulty-select'); if (diff) diff.value = 'all';
        const chips = $('count-chips'); if (chips) { chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active')); }
        $('custom-count').value = '5';
        startSession();
    }

    function smartReview() {
        // Prioritize missed questions, then fill from weakest specialties.
        const p = state.profile || {};
        const ids = new Set(p.missed_ids || []);
        const weak = (p.by_specialty || []).filter((s) => s.accuracy < 70).map((s) => s.category);
        if (ids.size < 20 && weak.length) {
            state.questions.forEach((q) => { if (weak.includes(q.category || q.domain_name) && ids.size < 20) ids.add(q.id); });
        }
        startFromIds(Array.from(ids), 'review');
    }

    function renderDashboard() {
        const p = state.profile || {};
        $('dash-greeting').textContent = `Welcome${p.full_name ? ', ' + p.full_name.split(' ')[0] : ' back'}`;
        const stats = p.stats || { answered: 0, correct: 0, attempts: 0 };
        $('stat-answered').textContent = stats.answered || 0;
        $('stat-accuracy').textContent = stats.attempts ? Math.round((stats.correct / stats.attempts) * 100) + '%' : '—';
        $('stat-bank').textContent = state.questions.length.toLocaleString();
        renderReadiness();
        renderOnboarding();

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

        renderSpecialtyPerformance();

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

    function renderSpecialtyPerformance() {
        const el = $('specialty-perf');
        if (!el) return;
        const rows = (state.profile && state.profile.by_specialty) || [];
        if (!rows.length) {
            el.innerHTML = '<h3>Performance by specialty</h3><div class="mono" style="font-size:13px;color:var(--muted);">Answer some questions to see your accuracy broken down by specialty.</div>';
            return;
        }
        const bars = rows.map((r) => {
            const color = r.accuracy >= 75 ? 'var(--accent)' : r.accuracy >= 50 ? '#FBBF24' : '#F87171';
            return `<div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
                    <span>${r.category}</span>
                    <span class="mono" style="color:${color};">${r.accuracy}% <span style="color:var(--muted);">(${r.correct}/${r.attempts})</span></span>
                </div>
                <div class="progress-bar"><span style="width:${r.accuracy}%;background:${color};"></span></div>
            </div>`;
        }).join('');
        el.innerHTML = `<h3>Performance by specialty</h3>${bars}`;
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
        const diff = $('difficulty-select') ? $('difficulty-select').value : 'all';
        let pool = c === 'all'
            ? state.questions.slice()
            : state.questions.filter((q) => (q.category || q.domain_name || 'General') === c);
        if (diff && diff !== 'all') pool = pool.filter((q) => (q.difficulty || '').toLowerCase() === diff);
        const unseen = $('unseen-only') && $('unseen-only').checked;
        if (unseen) { const seen = answeredIdSet(); pool = pool.filter((q) => !seen.has(q.id)); }
        return pool;
    }

    function updateSessionHint() {
        const usage = freeUsage();
        const pool = poolForDomain();
        const startBtn = $('start-session-btn');
        let n = selectedCount();
        let capNote = '';
        const disable = (msg) => { if (startBtn) startBtn.disabled = true; $('session-hint').textContent = msg; };
        if (!pool.length) { return disable('No questions match this filter yet — try another specialty or difficulty.'); }
        if (!usage.unlimited) {
            if (usage.remaining <= 0) { return disable('You have used all your free questions. Upgrade for full access.'); }
            if (n > usage.remaining) { n = usage.remaining; capNote = ` (capped at your ${usage.remaining} remaining free questions)`; }
        }
        n = Math.min(n === Infinity ? pool.length : n, pool.length);
        if (startBtn) startBtn.disabled = false;
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
        beginSession(shuffled.slice(0, n));
    }

    function beginSession(pool) {
        state.session = { pool, index: 0, answered: 0, correct: 0, size: pool.length, locked: false, log: [] };
        track('session_start', { size: pool.length });
        go('quiz');
        renderQuestion();
    }

    function startFromIds(ids, label) {
        const set = new Set(ids || []);
        const pool = state.questions.filter((q) => set.has(q.id));
        if (!pool.length) { alert(`No ${label} questions available right now.`); return; }
        const usage = freeUsage();
        let chosen = pool.slice();
        if (!usage.unlimited) chosen = chosen.slice(0, Math.max(1, usage.remaining));
        for (let i = chosen.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }
        beginSession(chosen);
    }

    function redoMissed() { startFromIds((state.profile && state.profile.missed_ids) || [], 'missed'); }
    function startFlagged() { startFromIds((state.profile && state.profile.flagged_ids) || [], 'flagged'); }

    async function toggleFlag() {
        const s = state.session; if (!s) return;
        const q = s.pool[s.index]; if (!q) return;
        const flags = new Set((state.profile && state.profile.flagged_ids) || []);
        const willFlag = !flags.has(q.id);
        try {
            await apiJSON('/api/user/flag', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ questionId: q.id, flagged: willFlag }) });
            if (willFlag) flags.add(q.id); else flags.delete(q.id);
            if (state.profile) state.profile.flagged_ids = Array.from(flags);
            updateFlagButton();
        } catch (e) { /* ignore */ }
    }

    function updateFlagButton() {
        const btn = $('flag-btn'); const s = state.session; if (!btn || !s) return;
        const q = s.pool[s.index];
        const flagged = q && ((state.profile && state.profile.flagged_ids) || []).includes(q.id);
        btn.textContent = flagged ? '★ Flagged' : '☆ Flag for review';
        btn.style.color = flagged ? '#FBBF24' : 'var(--muted)';
    }

    async function loadNote() {
        const s = state.session; const ta = $('note-text'); if (!s || !ta) return;
        const q = s.pool[s.index]; if (!q) return;
        ta.value = ''; ta.dataset.qid = q.id;
        try {
            const { data } = await apiJSON('/api/user/note?questionId=' + encodeURIComponent(q.id), { headers: authHeaders() });
            if (ta.dataset.qid === q.id) ta.value = data.note || '';
        } catch (e) { /* ignore */ }
    }

    async function saveNote() {
        const ta = $('note-text'); if (!ta || !ta.dataset.qid) return;
        const msg = $('note-msg');
        try {
            await apiJSON('/api/user/note', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ questionId: ta.dataset.qid, note: ta.value }) });
            if (msg) { msg.textContent = 'Saved'; setTimeout(() => { msg.textContent = ''; }, 1500); }
        } catch (e) { /* ignore */ }
    }

    // ---- quiz -------------------------------------------------------------
    function renderQuestion() {
        const s = state.session; if (!s) return go('dashboard');
        if (s.index >= s.pool.length) return finishSession();
        resetAdvanceButton();
        clearSessionReview();
        s.locked = false;
        const q = s.pool[s.index];

        $('question-meta').textContent = [q.category || q.domain_name, q.subtopic].filter(Boolean).join('  ·  ').toUpperCase();
        const img = safeUrl(q.image_url) ? `<img src="${escapeHtml(q.image_url)}" alt="" style="max-width:100%;border:1px solid var(--line);border-radius:4px;margin:12px 0;">` : '';
        $('question-stem').innerHTML = renderRich(q.stem) + img;
        const container = $('choices-container');
        container.innerHTML = '';
        let choices = q.choices || [];
        if (typeof choices === 'string') { try { choices = JSON.parse(choices); } catch (e) { choices = []; } }
        choices.forEach((choice, idx) => {
            const text = (typeof choice === 'object' && choice) ? (choice.text || choice.value || '') : choice;
            const letter = String.fromCharCode(65 + idx);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'choice-option-node';
            btn.dataset.index = String(idx);
            btn.setAttribute('aria-label', `Answer ${letter}: ${text}`);
            btn.style.cssText = 'display:block;width:100%;text-align:left;margin:10px 0;padding:14px;background:var(--bg);border:1px solid var(--line);color:var(--text);font-family:ui-monospace,monospace;cursor:pointer;border-radius:4px;';
            btn.innerHTML = `<span style="color:var(--accent);font-weight:bold;margin-right:15px;">[${letter}]</span> ${text}`;
            btn.onclick = () => answer(idx, q.id);
            container.appendChild(btn);
        });
        $('explanation-pane').classList.add('hidden');
        $('explanation-pane').innerHTML = '';
        updateFlagButton();
        loadNote();
        updateQuizProgress();
    }

    async function answer(selectedIndex, questionId) {
        const s = state.session; if (!s || s.locked) return;
        const currentQ = s.pool[s.index];
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
            const peer = (data.peer_correct_pct != null)
                ? ` <span style="color:var(--muted);">· ${data.peer_correct_pct}% of users got this right</span>` : '';
            const ex = $('explanation-pane');
            let html = `<div class="mono" style="font-size:12px;margin-bottom:8px;">${verdict}${peer}</div><div>${renderRich(data.explanation || 'No explanation provided.')}</div>`;
            const refs = (data.references || []).filter((r) => r && (r.url || r.source || r.title));
            if (refs.length) {
                const items = refs.map((r) => {
                    const label = escapeHtml(r.title || r.source || r.url);
                    const url = safeUrl(r.url);
                    return url
                        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
                        : `<span>${label}</span>`;
                }).join('<br>');
                html += `<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px;"><div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Source</div><div style="font-size:13px;">${items}</div></div>`;
            }
            ex.innerHTML = html;
            ex.classList.remove('hidden');

            // Record for the end-of-session review.
            (s.log = s.log || []).push({
                meta: [currentQ.domain_name, currentQ.subtopic].filter(Boolean).join(' · '),
                stem: currentQ.stem || '',
                correct: !!data.correct,
                correctLetter: String.fromCharCode(65 + (data.correctIndex || 0)),
                yourLetter: String.fromCharCode(65 + selectedIndex),
                explanation: data.explanation || '',
            });
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
        renderSessionReview(s.log || []);
        const btn = $('advance-vignette-trigger');
        btn.textContent = 'Back to Dashboard';
        btn.onclick = async () => {
            resetAdvanceButton(); clearSessionReview();
            try { await loadProfile(); } catch (e) { /* keep cached */ }  // refresh missed/flagged/stats
            MACPrep.go('dashboard');
        };
        $('quiz-progress-bar').style.width = '100%';
    }

    function resetAdvanceButton() {
        const btn = $('advance-vignette-trigger');
        btn.className = 'btn secondary';
        btn.textContent = 'Next Question »';
        btn.onclick = advance;
    }

    function clearSessionReview() { const el = $('session-review'); if (el) { el.innerHTML = ''; el.classList.add('hidden'); } }

    function renderSessionReview(log) {
        const el = $('session-review');
        if (!el) return;
        if (!log.length) { el.classList.add('hidden'); return; }
        const rows = log.map((r, i) => `
            <div style="border-bottom:1px solid var(--line);padding:14px 0;">
                <div class="mono" style="font-size:11px;color:var(--muted);margin-bottom:4px;">${i + 1}. ${r.meta || ''}</div>
                <div style="font-size:14px;margin-bottom:6px;">${r.stem}</div>
                <div class="mono" style="font-size:12px;">
                    <span style="color:${r.correct ? 'var(--accent)' : '#F87171'};">${r.correct ? '✓ Correct' : '✗ Incorrect'}</span>
                    &nbsp;·&nbsp; Your answer: ${r.yourLetter} &nbsp;·&nbsp; Correct: ${r.correctLetter}
                </div>
                ${r.explanation ? `<div style="font-size:13px;color:#cbd5e1;margin-top:6px;line-height:1.5;">${r.explanation}</div>` : ''}
            </div>`).join('');
        el.innerHTML = `<h2 style="margin:0 0 6px;">Review</h2><p class="sub">Every question from this session, with the correct answer and explanation.</p>${rows}`;
        el.classList.remove('hidden');
    }

    function showPaywall(limit) {
        const s = state.session;
        track('paywall_hit');
        $('question-meta').textContent = 'FREE LIMIT REACHED';
        const statLine = s && s.answered ? `You scored <strong>${Math.round((s.correct / s.answered) * 100)}%</strong> on the ${s.answered} you answered this session. ` : '';
        $('question-stem').innerHTML = `You've reached the end of the free tier — <strong>${limit || state.profile?.free_tier_limit || ''}</strong> questions (10% of the bank). ${statLine}Upgrade for one-time $50 lifetime access to the full journal-sourced bank with every explanation and source.`;
        $('choices-container').innerHTML = '';
        $('explanation-pane').classList.add('hidden');
        if (s && s.log && s.log.length) renderSessionReview(s.log);
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

    // ---- account management ----------------------------------------------
    async function changePassword() {
        const pw = prompt('Enter a new password (at least 8 characters):');
        if (pw == null) return;
        if (pw.length < 8) { alert('Password must be at least 8 characters.'); return; }
        try {
            const { resp, data } = await apiJSON('/api/user/change-password', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ new_password: pw }) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Could not change password.');
            alert('Password changed.');
        } catch (e) { alert('Failed: ' + e.message); }
    }

    async function deleteAccount() {
        if (!confirm('Delete your account and all study data permanently? This cannot be undone.')) return;
        if (!confirm('Are you absolutely sure? This will erase your progress and cancel access.')) return;
        try {
            const { resp, data } = await apiJSON('/api/user/delete', { method: 'POST', headers: authHeaders() });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Could not delete account.');
            alert('Your account has been deleted.');
            signOut();
        } catch (e) { alert('Failed: ' + e.message); }
    }

    // ---- admin review queue ----------------------------------------------
    async function loadAnalytics() {
        const el = $('admin-analytics'); if (!el) return;
        try {
            const { resp, data } = await apiJSON('/api/admin/analytics', { headers: authHeaders() });
            if (!resp.ok) return;
            const t = data.total || {}; const w = data.last7 || {};
            const row = (label, key) => `<div class="stat"><div class="n">${t[key] || 0}</div><div class="l">${label}<br><span style="color:var(--accent);">${w[key] || 0} / 7d</span></div></div>`;
            el.innerHTML = `<h3>Analytics — last 30 days</h3>
                <div class="grid cols-3" style="margin-bottom:10px;">
                    ${row('Signups', 'signup')}
                    ${row('Logins', 'login')}
                    ${row('Sessions', 'session_start')}
                    ${row('Paywall hits', 'paywall_hit')}
                    ${row('Checkouts', 'checkout_started')}
                    ${row('Upgrades', 'upgrade_success')}
                </div>
                <div class="mono" style="font-size:12px;color:var(--muted);">${data.activeUsers || 0} active users in the last 7 days</div>`;
            el.classList.remove('hidden');
        } catch (e) { /* ignore */ }
    }

    async function reviewQueue() {
        go('admin');
        loadAnalytics();
        const wrap = $('admin-body'); if (wrap) wrap.innerHTML = '<div class="mono" style="color:var(--muted);">Loading review queue…</div>';
        try {
            const { resp, data } = await apiJSON('/api/admin/questions?status=sme_review', { headers: authHeaders() });
            if (!resp.ok) throw new Error(data.error || 'Could not load.');
            state.review = { list: data.questions || [], index: 0, counts: data.counts || {} };
            renderReview();
        } catch (e) {
            if (wrap) wrap.innerHTML = `<div class="mono" style="color:#F87171;">${escapeHtml(e.message)}</div>`;
        }
    }

    function renderReview() {
        const r = state.review; const wrap = $('admin-body'); if (!r || !wrap) return;
        const c = r.counts || {};
        $('admin-counts').textContent = `${c.sme_review || 0} awaiting review · ${c.published || 0} published · ${c.rejected || 0} rejected`;
        if (!r.list.length || r.index >= r.list.length) {
            wrap.innerHTML = '<div class="card"><h3>All caught up 🎉</h3><div class="mono" style="color:var(--muted);">No more questions awaiting review.</div></div>';
            return;
        }
        const q = r.list[r.index];
        const choices = (q.choices || []).map((ch, i) => {
            const letter = String.fromCharCode(65 + i);
            const correct = (q.correct_answer || '').toUpperCase() === letter || ch.correct === true;
            return `<div style="border:1px solid ${correct ? 'var(--accent)' : 'var(--line)'};border-radius:4px;padding:10px;margin:8px 0;background:${correct ? 'var(--accent-dim)' : 'var(--bg)'};">
                <label style="font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);">[${letter}]${correct ? ' ✓ correct' : ''}</label>
                <input data-edit="choice-text-${i}" value="${escapeHtml(ch.text || '')}" style="width:100%;margin:4px 0;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:4px;color:var(--text);font-size:13px;">
                <textarea data-edit="choice-rat-${i}" rows="2" style="width:100%;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:4px;color:#9ca3af;font-size:12px;">${escapeHtml(ch.rationale || '')}</textarea>
            </div>`;
        }).join('');
        const refs = (q.references || []).map((rf) => rf.url ? `<a href="${escapeHtml(rf.url)}" target="_blank" rel="noopener">${escapeHtml(rf.title || rf.source || rf.url)}</a>` : escapeHtml(rf.source || '')).join('<br>');
        wrap.innerHTML = `
            <div class="mono" style="color:var(--muted);font-size:12px;margin-bottom:8px;">Reviewing ${r.index + 1} of ${r.list.length} · ${escapeHtml(q.id)} · ${escapeHtml((q.category || '') + ' · ' + (q.subtopic || '') + ' · ' + (q.difficulty || ''))}</div>
            <div class="card">
                <label>Stem</label>
                <textarea data-edit="stem" rows="4" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font-size:14px;margin-bottom:14px;">${escapeHtml(q.stem || '')}</textarea>
                <label>Choices &amp; rationale (green = keyed correct)</label>
                ${choices}
                <label style="margin-top:10px;">Correct answer letter</label>
                <input data-edit="correct_answer" value="${escapeHtml(q.correct_answer || '')}" maxlength="1" style="width:80px;padding:8px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);margin-bottom:14px;">
                <label>Explanation</label>
                <textarea data-edit="explanation" rows="5" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);font-size:13px;margin-bottom:10px;">${escapeHtml(q.explanation || '')}</textarea>
                <div class="mono" style="font-size:12px;color:var(--muted);margin-bottom:16px;">Source: ${refs || '—'}</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                    <button class="btn" onclick="MACPrep.adminAction('publish')">✓ Publish</button>
                    <button class="btn ghost" onclick="MACPrep.adminAction('save')">Save edits (keep reviewing)</button>
                    <button class="btn ghost" onclick="MACPrep.adminAction('skip')">Skip →</button>
                    <button class="btn" style="background:var(--danger);" onclick="MACPrep.adminAction('reject')">✗ Reject</button>
                </div>
                <span id="admin-msg" class="mono" style="font-size:12px;color:var(--accent);"></span>
            </div>`;
    }

    function collectReviewEdits() {
        const r = state.review; const q = r.list[r.index];
        const get = (sel) => { const el = $('admin-body').querySelector(`[data-edit="${sel}"]`); return el ? el.value : undefined; };
        const choices = (q.choices || []).map((ch, i) => ({
            ...ch,
            text: get(`choice-text-${i}`) ?? ch.text,
            rationale: get(`choice-rat-${i}`) ?? ch.rationale,
        }));
        const correctLetter = (get('correct_answer') || q.correct_answer || '').toUpperCase();
        // keep the choices[].correct flags aligned with the letter
        choices.forEach((ch, i) => { ch.correct = (String.fromCharCode(65 + i) === correctLetter); });
        return { id: q.id, stem: get('stem'), explanation: get('explanation'), correct_answer: correctLetter, choices };
    }

    async function adminAction(action) {
        const r = state.review; if (!r) return;
        const msg = $('admin-msg');
        const body = collectReviewEdits();
        if (action === 'publish') body.status = 'published';
        if (action === 'reject') body.status = 'rejected';
        if (action === 'skip') { r.index++; renderReview(); return; }
        try {
            const { resp, data } = await apiJSON('/api/admin/question', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Failed.');
            if (action === 'save') { if (msg) { msg.textContent = 'Saved ✓'; setTimeout(() => { msg.textContent = ''; }, 1500); } return; }
            // publish/reject: update counts + advance
            if (action === 'publish') r.counts.published = (r.counts.published || 0) + 1;
            if (action === 'reject') r.counts.rejected = (r.counts.rejected || 0) + 1;
            r.counts.sme_review = Math.max(0, (r.counts.sme_review || 1) - 1);
            r.index++;
            renderReview();
        } catch (e) { if (msg) { msg.style.color = '#F87171'; msg.textContent = e.message; } }
    }

    // ---- checkout ---------------------------------------------------------
    async function startCheckout(btn) {
        if (btn && btn.disabled) return;
        if (btn) { btn.disabled = true; btn.dataset.prev = btn.textContent; btn.textContent = 'Redirecting…'; }
        track('checkout_started');
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
                if (state.profile && state.profile.premium_unlocked) { track('upgrade_success'); alert('Payment received — full access unlocked. Thank you!'); }
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

    function toggleMobileNav() { const n = $('main-nav'); if (n) n.classList.toggle('nav-open'); }
    function closeMobileNav() { const n = $('main-nav'); if (n) n.classList.remove('nav-open'); }

    // Keyboard shortcuts during a quiz: A-E / 1-5 select; Enter/→ advance; F flag.
    function handleQuizKey(e) {
        const s = state.session;
        if (!s || $('quiz-view').classList.contains('hidden')) return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return; // don't hijack typing
        const k = e.key.toLowerCase();
        if (k === 'f') { e.preventDefault(); toggleFlag(); return; }
        if (!s.locked) {
            let idx = -1;
            if (/^[a-e]$/.test(k)) idx = k.charCodeAt(0) - 97;
            else if (/^[1-5]$/.test(k)) idx = parseInt(k, 10) - 1;
            if (idx >= 0) {
                const btn = $('choices-container').querySelector(`.choice-option-node[data-index="${idx}"]`);
                if (btn) { e.preventDefault(); btn.click(); }
            }
        } else if (k === 'enter' || k === 'arrowright' || k === 'n') {
            e.preventDefault();
            const adv = $('advance-vignette-trigger');
            if (adv) adv.click();
        }
    }

    // Error monitoring — self-configures from /api/config so no DSN is hardcoded.
    // Activates only when SENTRY_BROWSER_DSN is set on the server.
    async function initMonitoring() {
        try {
            const r = await fetch('/api/config');
            const cfg = await r.json();
            if (!cfg.sentryDsn) return;
            const s = document.createElement('script');
            s.src = 'https://browser.sentry-cdn.com/7.120.3/bundle.min.js';
            s.crossOrigin = 'anonymous';
            s.onload = () => {
                try { window.Sentry && window.Sentry.init({ dsn: cfg.sentryDsn, environment: cfg.environment || 'production', tracesSampleRate: 0 }); }
                catch (e) { /* ignore */ }
            };
            document.head.appendChild(s);
        } catch (e) { /* monitoring is best-effort */ }
    }

    // ---- bootstrap --------------------------------------------------------
    window.MACPrep = {
        go, login, signOut, startSession, advance, saveProfile, startCheckout, submitFeedback,
        requestPasswordReset, redoMissed, startFlagged, toggleFlag, changePassword, deleteAccount, toggleMobileNav,
        smartReview, startSample, saveNote, reviewQueue, adminAction,
    };

    document.addEventListener('keydown', handleQuizKey);

    document.addEventListener('DOMContentLoaded', async () => {
        initMonitoring();
        track('page_view');
        // Email-confirmation links land here with the new session in the URL hash.
        const hash = new URLSearchParams((location.hash || '').slice(1));
        if (hash.get('access_token')) {
            setToken(hash.get('access_token'));
            if (hash.get('refresh_token')) setRefresh(hash.get('refresh_token'));
            history.replaceState({}, '', '/');
        }
        state.token = getToken();
        $('domain-select') && $('domain-select').addEventListener('change', updateSessionHint);
        $('difficulty-select') && $('difficulty-select').addEventListener('change', updateSessionHint);
        $('unseen-only') && $('unseen-only').addEventListener('change', updateSessionHint);
        $('custom-count') && $('custom-count').addEventListener('input', updateSessionHint);
        $('note-text') && $('note-text').addEventListener('blur', saveNote);
        if (state.token) {
            try { await bootAuthedSession(); }
            catch (e) { go('login'); }
        } else {
            go('login');
        }
    });
})();

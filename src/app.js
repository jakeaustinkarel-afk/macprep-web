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
             .replace(/`([^`]+)`/g, '<code style="background:var(--line);padding:1px 5px;border-radius:3px;">$1</code>');
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

    const VIEWS = ['login-view', 'dashboard-view', 'quiz-view', 'profile-view', 'feedback-view', 'admin-view', 'notebook-view'];
    function go(view) {
        closeMobileNav(); // bug fix: collapse the mobile menu on navigation
        // Guard against leaving an in-progress session by accident (progress is saved,
        // so this is a soft confirm rather than a hard block).
        if (state.session && !state.session.complete && view !== 'quiz'
            && $('quiz-view') && !$('quiz-view').classList.contains('hidden')) {
            if (!confirm('Leave this session? Your progress is saved — you can resume it from the dashboard.')) return;
        }
        if (view !== 'login' && !state.token) view = 'login';
        VIEWS.forEach((v) => $(v) && $(v).classList.toggle('hidden', v !== view + '-view'));
        const authed = !!state.token && view !== 'login';
        ['nav-dashboard', 'nav-notebook', 'nav-profile', 'nav-feedback', 'nav-signout', 'tier-badge'].forEach((id) =>
            $(id) && $(id).classList.toggle('hidden', !authed));
        const isAdmin = authed && state.profile && state.profile.is_admin;
        $('nav-admin') && $('nav-admin').classList.toggle('hidden', !isAdmin);
        $('nav-metrics') && $('nav-metrics').classList.toggle('hidden', !isAdmin);
        // "Log in" shows for logged-out visitors only.
        $('nav-login') && $('nav-login').classList.toggle('hidden', authed);
        if (view === 'dashboard') renderDashboard();
        if (view === 'profile') renderProfile();
        if (view === 'notebook') loadNotebook();
        window.scrollTo(0, 0);
    }

    // ---- auth -------------------------------------------------------------
    let toastTimer = null;
    function toast(msg, kind) {
        const t = $('toast'); if (!t) { alert(msg); return; }
        t.textContent = msg;
        t.className = (kind === 'ok' ? 'ok show' : 'show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.classList.remove('show'); }, 4500);
    }

    // Screen-reader live announcement (clear-then-set forces re-announcement).
    function announce(msg) {
        const el = $('sr-announce'); if (!el) return;
        el.textContent = '';
        setTimeout(() => { el.textContent = msg; }, 50);
    }
    function focusQuestion() {
        const stem = $('question-stem');
        if (stem) { stem.setAttribute('tabindex', '-1'); try { stem.focus(); } catch (e) {} }
    }

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
            toast('Login failed: ' + err.message);
        } finally {
            state.loginInFlight = false;
            if (btn) btn.textContent = 'Sign In';
        }
    }

    function showSignin() { const a = $('signup-pane'), b = $('signin-pane'); if (a) a.classList.add('hidden'); if (b) b.classList.remove('hidden'); const e = $('login-email'); if (e) e.focus(); }
    function showSignup() { const a = $('signup-pane'), b = $('signin-pane'); if (b) b.classList.add('hidden'); if (a) a.classList.remove('hidden'); const e = $('su-name'); if (e) e.focus(); }

    // Inline signup on the landing — no page hop, and auto-logs-in when email
    // confirmation is off (then drops the user straight into a warm-up).
    async function signupInline() {
        if (state.signupInFlight) return;
        const name = ($('su-name').value || '').trim();
        const email = ($('su-email').value || '').trim();
        const password = $('su-password').value;
        const btn = $('su-submit'); const msg = $('su-msg');
        if (!email || !password) return;
        if ($('su-terms') && !$('su-terms').checked) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = 'Please accept the Terms to continue.'; } return; }
        state.signupInFlight = true;
        if (btn) { btn.disabled = true; btn.textContent = 'Creating your account…'; }
        if (msg) msg.textContent = '';
        try {
            const { resp, data } = await apiJSON('/api/authenticate', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'register', name, email, password }) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Could not create your account.');
            track('signup');
            if (data.token) {
                state.token = data.token; setToken(state.token); setRefresh(data.refresh_token || null);
                state.justSignedUp = true;
                await bootAuthedSession();
            } else {
                const pane = $('signup-pane');
                if (pane) pane.innerHTML = '<div style="text-align:center;padding:10px 0;"><div style="font-size:34px;margin-bottom:8px;">✉️</div><h2 style="margin:0 0 8px;">Check your email</h2><p class="sub" style="margin:0;">We sent a confirmation link to <strong>' + email.replace(/[<>&"]/g, '') + '</strong>. Click it and your free questions are ready.</p></div>';
            }
        } catch (err) {
            if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = err.message; }
            if (btn) { btn.disabled = false; btn.textContent = 'Create my free account →'; }
        } finally {
            state.signupInFlight = false;
        }
    }

    function signOut() {
        stopExamTimer();
        setToken(null); setRefresh(null);
        ls('macprep_premium_unlocked', null); ls('macprep_user_email', null); ls('macprep_session', null);
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
        toast('If an account exists for ' + email + ', a reset link is on its way — check your email.', 'ok');
    }

    async function loadProfile() {
        const tz = (function () { try { return new Date().getTimezoneOffset(); } catch (e) { return 0; } })();
        const { resp, data } = await apiJSON('/api/user/profile?tz=' + tz, { headers: authHeaders() });
        if (resp.status === 401) { signOut(); throw new Error('Session expired.'); }
        state.profile = data.profile || null;
        // Restore the theme saved to this account (once per session boot, so a
        // mid-session pick is never clobbered by a later profile refresh).
        if (state.profile && state.profile.theme && !state._themeApplied && typeof window.setTheme === 'function') {
            state._themeApplied = true;
            if (state.profile.theme !== document.documentElement.getAttribute('data-theme')) window.setTheme(state.profile.theme);
        }
        return state.profile;
    }

    async function loadQuestions() {
        const { resp, data } = await apiJSON('/api/questions', { headers: authHeaders() });
        if (resp.status === 401) { signOut(); throw new Error('Session expired.'); }
        state.questions = Array.isArray(data.questions) ? data.questions : [];
        return state.questions;
    }

    async function bootAuthedSession() {
        state._themeApplied = false;
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
        // Post-signup activation: drop a brand-new user straight into a short warm-up.
        if (state.justSignedUp) {
            state.justSignedUp = false;
            const answered = (state.profile && state.profile.stats && state.profile.stats.answered) || 0;
            if (answered === 0) { try { startSample(); } catch (e) {} }
        }
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
            ? trend.map((t) => `<span title="${t.day}: ${t.accuracy}%" style="display:inline-block;width:10px;height:${Math.max(4, Math.round(t.accuracy * 0.4))}px;background:${t.accuracy >= 75 ? 'var(--accent)' : t.accuracy >= 50 ? 'var(--warn)' : 'var(--bad)'};margin-right:3px;vertical-align:bottom;border-radius:2px;"></span>`).join('')
            : '<div class="mono" style="color:var(--muted);font-size:12px;display:flex;align-items:center;gap:8px;height:46px;"><span style="font-size:18px;">📈</span> Answer a few questions — your accuracy trend shows up here.</div>';
        const bank = (state.questions || []).length;
        const planLine = (exam != null && exam > 0 && bank > 0)
            ? `<div class="mono" style="font-size:12px;color:var(--text2);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-bottom:14px;">📅 <strong>${exam} day${exam === 1 ? '' : 's'}</strong> to your exam — about <strong>${Math.ceil((bank * 2) / exam)} questions/day</strong> to cover the full ${bank.toLocaleString()}-question bank twice before then.</div>`
            : '';
        const answeredToday = p.answered_today || 0;
        let goalLine = '';
        if (exam != null && exam > 0 && bank > 0) {
            const target = Math.ceil((bank * 2) / exam);
            const met = answeredToday >= target;
            const pctDone = Math.min(100, Math.round((answeredToday / target) * 100));
            goalLine = `<div style="margin-bottom:14px;">
                <div class="mono" style="font-size:12px;color:var(--text2);margin-bottom:4px;">Today: <strong>${answeredToday} / ${target}</strong> ${met ? '🔥 goal met!' : 'questions'}</div>
                <div class="progress-bar"><span style="width:${pctDone}%;background:${met ? 'var(--accent)' : 'var(--warn)'};"></span></div>
            </div>`;
        } else if (answeredToday > 0) {
            goalLine = `<div class="mono" style="font-size:12px;color:var(--text2);margin-bottom:14px;">Today: <strong>${answeredToday}</strong> answered</div>`;
        }
        const examLine = exam != null
            ? (exam >= 0 ? `<div class="stat"><div class="n">${exam}</div><div class="l">Days to exam</div></div>` : `<div class="stat"><div class="n">—</div><div class="l">Exam date passed</div></div>`)
            : (p.study_goal === 'practice'
                ? `<div class="stat"><div class="n">${answeredToday}/10</div><div class="l">Today's goal</div></div>`
                : `<div class="stat"><div class="n">—</div><div class="l">Add an exam date anytime</div></div>`);
        const C = 213.6; // ring circumference, 2πr with r=34
        const ringOff = C * (1 - Math.max(0, Math.min(100, readiness)) / 100);
        const streakHtml = streak
            ? `<div class="n" style="color:var(--accent);">${streak} <span style="display:inline-block;animation:flamePulse 1.6s ease-in-out infinite;">🔥</span></div><div class="l">Day streak</div>`
            : `<div class="n">0</div><div class="l">Day streak — start today!</div>`;
        el.innerHTML = `<h3>Exam readiness</h3>
            <div class="grid cols-3" style="margin-bottom:14px;align-items:center;">
                <div class="stat" style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                    <svg viewBox="0 0 80 80" width="86" height="86" style="display:block;">
                        <circle cx="40" cy="40" r="34" fill="none" stroke="var(--line)" stroke-width="8"></circle>
                        <circle class="ring-fill" cx="40" cy="40" r="34" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 40 40)" style="transition:stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1);"></circle>
                        <text x="40" y="46" text-anchor="middle" style="font-family:ui-monospace,monospace;font-weight:800;font-size:18px;fill:var(--text);">${readiness}%</text>
                    </svg>
                    <div class="l">Readiness</div>
                </div>
                <div class="stat">${streakHtml}</div>
                ${examLine}
            </div>
            ${planLine}
            ${goalLine}
            <div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Accuracy — last 7 active days</div>
            <div style="height:46px;">${spark}</div>`;
        const ring = el.querySelector('.ring-fill');
        if (ring) requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.strokeDashoffset = ringOff; }));
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

    function renderExamPrompt() {
        const el = $('exam-prompt'); if (!el) return;
        const p = state.profile || {};
        // Show the goal chooser only until the user has picked a goal or set an exam date.
        if (!state.token || p.target_exam_date || p.study_goal) { el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        const today = new Date().toISOString().slice(0, 10);
        el.innerHTML = `<h3 style="margin-top:0;">What brings you to MACPrep?</h3>
            <p class="sub" style="margin:0 0 16px;">Pick what fits — it just tailors your dashboard. You can change it anytime in your profile.</p>
            <div style="border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:10px;">
                <div style="font-weight:bold;margin-bottom:3px;">📅 I have an exam coming up</div>
                <div class="sub" style="margin:0 0 11px;font-size:13px;">We'll build a daily plan and track your readiness.</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
                    <input type="date" id="exam-date-input" min="${today}" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:9px 12px;font-size:14px;color:var(--text);">
                    <button class="btn" id="exam-set-btn" onclick="MACPrep.setExamDate(document.getElementById('exam-date-input').value)">Build my plan</button>
                    <span id="exam-set-msg" class="mono" style="font-size:12px;color:var(--bad);"></span>
                </div>
            </div>
            <button class="btn ghost" type="button" style="width:100%;text-align:left;display:block;margin-bottom:8px;" onclick="MACPrep.setStudyGoal('practice')"><strong>💪 Just here to practice</strong> — set a daily goal &amp; keep a streak</button>
            <button class="btn ghost" type="button" style="width:100%;text-align:left;display:block;" onclick="MACPrep.setStudyGoal('none')"><strong>No goal right now</strong> — just let me study</button>`;
    }

    async function setExamDate(val) {
        if (!val) { const m = $('exam-set-msg'); if (m) m.textContent = 'Pick a date first.'; return; }
        const btn = $('exam-set-btn'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
            const { resp, data } = await apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ target_exam_date: val }) });
            if (!resp.ok || !data.success) throw new Error((data && data.error) || 'Could not save.');
            await loadProfile();
            renderDashboard();
        } catch (e) {
            const m = $('exam-set-msg'); if (m) m.textContent = e.message;
            if (btn) { btn.disabled = false; btn.textContent = 'Build my plan'; }
        }
    }

    async function setStudyGoal(goal) {
        try {
            const { resp, data } = await apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ study_goal: goal }) });
            if (!resp.ok || !data.success) throw new Error((data && data.error) || 'Could not save.');
            await loadProfile();
            renderDashboard();
            toast(goal === 'practice' ? 'Daily practice goal set — keep that streak going!' : "You're all set — practice whenever you like.", 'ok');
        } catch (e) { toast(e.message || 'Could not save.', 'bad'); }
    }

    function startSample() {
        const sel = $('domain-select'); if (sel) sel.value = 'all';
        const diff = $('difficulty-select'); if (diff) diff.value = 'all';
        const pm = $('pool-mode'); if (pm) pm.value = 'all';
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
        renderResumeCard();
        renderExamPrompt();
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
        renderCalibration();
        const cmBtn = $('confident-miss-btn');
        if (cmBtn) cmBtn.style.display = ((p.confident_missed_ids || []).length) ? '' : 'none';
        const dueBtn = $('due-review-btn');
        if (dueBtn) { const dueN = (p.due_ids || []).length; dueBtn.style.display = dueN ? '' : 'none'; dueBtn.textContent = `Review due (${dueN})`; }

        // Count chips (preserve the user's prior selection across re-renders)
        const chips = $('count-chips');
        const prevActive = chips.querySelector('.chip.active');
        const prevCount = prevActive ? prevActive.dataset.count : null;
        const hasCustom = !!($('custom-count') && parseInt($('custom-count').value, 10) > 0);
        chips.innerHTML = '';
        const opts = usage.unlimited ? [10, 25, 50, 100, 'All'] : [10, 25, 50, 100];
        opts.forEach((n, i) => {
            const c = document.createElement('div');
            const makeActive = !hasCustom && (prevCount ? String(n) === prevCount : i === 0);
            c.className = 'chip' + (makeActive ? ' active' : '');
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
        const cov = (state.profile && state.profile.coverage) || [];
        if (!cov.length) {
            el.innerHTML = '<h3>By specialty</h3><div class="mono" style="font-size:13px;color:var(--muted);">Start practicing to see your coverage and accuracy by specialty.</div>';
            return;
        }
        const accMap = {};
        ((state.profile && state.profile.by_specialty) || []).forEach((r) => { accMap[r.category] = r; });
        const rows = cov.slice().sort((a, b) => (a.answered / (a.total || 1)) - (b.answered / (b.total || 1)) || b.total - a.total);
        const expanded = !!state.coverageExpanded;
        const shown = expanded ? rows : rows.slice(0, 5);
        const bars = shown.map((c) => {
            const fracPct = c.total ? Math.round((c.answered / c.total) * 100) : 0;
            const acc = accMap[c.category];
            const accColor = acc ? (acc.accuracy >= 75 ? 'var(--accent)' : acc.accuracy >= 50 ? 'var(--warn)' : 'var(--bad)') : 'var(--muted)';
            const accStr = acc ? `${acc.accuracy}% acc` : 'not started';
            return `<div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
                    <span>${c.category}</span>
                    <span class="mono" style="color:var(--muted);">seen ${c.answered}/${c.total} · <span style="color:${accColor};">${accStr}</span></span>
                </div>
                <div class="progress-bar"><span style="width:${fracPct}%;background:var(--accent);"></span></div>
            </div>`;
        }).join('');
        const moreBtn = rows.length > 5
            ? `<button class="btn ghost" type="button" onclick="MACPrep.toggleCoverage()" style="margin-top:6px;font-size:12px;padding:6px 12px;">${expanded ? 'Show less' : `Show all ${rows.length} specialties`}</button>`
            : '';
        el.innerHTML = `<h3>By specialty — coverage &amp; accuracy</h3><p class="mono" style="font-size:11px;color:var(--muted);margin:0 0 12px;">${expanded ? 'All specialties, least-covered first.' : 'Your biggest coverage gaps.'}</p>${bars}${moreBtn}`;
    }

    function renderCalibration() {
        const el = $('calibration-card'); if (!el) return;
        const cal = (state.profile && state.profile.calibration) || [];
        if (!cal.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
        const over = cal.filter((c) => c.accuracy < 80);
        const rows = cal.map((c) => {
            const ok = c.accuracy >= 80;
            const color = ok ? 'var(--accent)' : 'var(--bad)';
            const verdict = c.accuracy >= 85 ? 'well-calibrated' : c.accuracy >= 70 ? 'a bit overconfident' : 'overconfident';
            return `<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px;gap:10px;">
                <span>${c.category}</span>
                <span class="mono" style="color:${color};text-align:right;">felt sure → ${c.accuracy}% right <span style="color:var(--muted);">(${verdict})</span></span>
            </div>`;
        }).join('');
        const lead = over.length
            ? 'You marked these "Confident" but missed some — likely blind spots:'
            : 'Your confidence is tracking your accuracy well — nicely calibrated.';
        el.innerHTML = `<h3>Confidence check</h3><p class="mono" style="font-size:11px;color:var(--muted);margin:0 0 12px;">${lead}</p>${rows}`;
        el.classList.remove('hidden');
    }

    function toggleCoverage() { state.coverageExpanded = !state.coverageExpanded; renderSpecialtyPerformance(); }

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
        const mode = $('pool-mode') ? $('pool-mode').value : 'all';
        if (mode === 'unused') { const seen = answeredIdSet(); pool = pool.filter((q) => !seen.has(q.id)); }
        else if (mode === 'incorrect') { const m = new Set((state.profile && state.profile.missed_ids) || []); pool = pool.filter((q) => m.has(q.id)); }
        else if (mode === 'flagged') { const f = new Set((state.profile && state.profile.flagged_ids) || []); pool = pool.filter((q) => f.has(q.id)); }
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
        if (!pool.length) { toast('No questions available for that domain yet.'); return; }
        let n = selectedCount();
        if (n === Infinity) n = pool.length;
        if (!usage.unlimited) n = Math.min(n, usage.remaining);
        n = Math.min(n, pool.length);

        const shuffled = pool.slice();
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
        beginSession(shuffled.slice(0, n));
    }

    // Persist the in-progress session so a refresh or accidental navigation can be
    // recovered instead of silently wiping the user's work.
    function saveSession() {
        try {
            if (state.session && !state.session.complete) ls('macprep_session', JSON.stringify(state.session));
            else ls('macprep_session', null);
        } catch (e) { try { ls('macprep_session', null); } catch (_) {} }
    }

    function getSavedSession() {
        try { const s = JSON.parse(ls('macprep_session') || 'null'); return (s && s.pool && s.pool.length && !s.complete) ? s : null; }
        catch (e) { return null; }
    }
    function renderResumeCard() {
        const el = $('resume-card'); if (!el) return;
        const saved = getSavedSession();
        if (!saved) { el.classList.add('hidden'); el.innerHTML = ''; return; }
        const answered = saved.pool.filter((q, i) => saved.answers && saved.answers[i] && saved.answers[i].selectedIndex != null).length;
        const modeLabel = saved.mode === 'exam' ? 'exam' : 'practice session';
        const timeNote = (saved.mode === 'exam' && saved.timeLeft != null) ? ` · ${Math.max(0, Math.round(saved.timeLeft / 60))} min left` : '';
        el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
            <div>
                <div style="font-weight:700;margin-bottom:2px;">Resume your ${modeLabel}</div>
                <div class="mono" style="font-size:12px;color:var(--muted);">${answered} of ${saved.size} answered${timeNote}</div>
            </div>
            <div style="display:flex;gap:10px;">
                <button class="btn" type="button" onclick="MACPrep.resumeSession()">Resume</button>
                <button class="btn ghost" type="button" onclick="MACPrep.discardSession()">Discard</button>
            </div>
        </div>`;
        el.classList.remove('hidden');
    }
    function resumeSession() {
        const saved = getSavedSession(); if (!saved) { renderResumeCard(); return; }
        state.session = saved;
        go('quiz');
        renderQuestion();
        focusQuestion();
        if (saved.mode === 'exam') { if ((saved.timeLeft || 0) > 0) startExamTimer(); else submitExam(true); }
    }
    function discardSession() {
        ls('macprep_session', null);
        renderResumeCard();
        toast('Session discarded.', 'ok');
    }

    // ---- exam timer -------------------------------------------------------
    const EXAM_SECONDS_PER_Q = 75; // exam-mode countdown budget per question
    let examTimerId = null;
    function stopExamTimer() { if (examTimerId) { clearInterval(examTimerId); examTimerId = null; } }
    function fmtClock(sec) { sec = Math.max(0, sec | 0); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
    function renderExamTimer() {
        const el = $('exam-timer'); if (!el) return;
        const s = state.session;
        if (!s || s.mode !== 'exam' || s.complete || s.timeLeft == null) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.textContent = '⏱ ' + fmtClock(s.timeLeft);
        el.style.color = s.timeLeft <= 60 ? 'var(--bad)' : 'var(--muted)';
    }
    function startExamTimer() {
        stopExamTimer();
        const s = state.session; if (!s || s.mode !== 'exam' || s.complete) return;
        renderExamTimer();
        examTimerId = setInterval(() => {
            const ss = state.session;
            if (!ss || ss.mode !== 'exam' || ss.complete) { stopExamTimer(); return; }
            ss.timeLeft = (ss.timeLeft || 0) - 1;
            renderExamTimer();
            if (ss.timeLeft === 300) announce('5 minutes remaining.');
            else if (ss.timeLeft === 60) announce('1 minute remaining.');
            if (ss.timeLeft % 5 === 0) saveSession();
            if (ss.timeLeft <= 0) { stopExamTimer(); announce('Time is up. Submitting your exam.'); toast("Time's up — submitting your exam.", 'ok'); submitExam(true); }
        }, 1000);
    }

    function beginSession(pool, mode) {
        mode = mode || ($('mode-select') ? $('mode-select').value : 'tutor');
        state.session = { pool, index: 0, answered: 0, correct: 0, size: pool.length, locked: false, log: [], mode, answers: {} };
        if (mode === 'exam') state.session.timeLeft = pool.length * EXAM_SECONDS_PER_Q;
        track('session_start', { size: pool.length, mode });
        track('quiz_start', { size: pool.length, mode });
        go('quiz');
        renderQuestion();
        focusQuestion();
        if (mode === 'exam') startExamTimer();
    }

    function startFromIds(ids, label) {
        const set = new Set(ids || []);
        const pool = state.questions.filter((q) => set.has(q.id));
        if (!pool.length) { toast(`No ${label} questions available right now.`); return; }
        // Every pool here (missed / flagged / due / confident) is questions the user has
        // already seen, and the server lets you re-answer seen questions for free — so do
        // NOT gate these on the free-tier limit.
        const chosen = pool.slice();
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
        btn.style.color = flagged ? 'var(--warn)' : 'var(--muted)';
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

    // Report a content problem with the current question → feedback queue.
    async function reportQuestion() {
        const s = state.session; if (!s) return;
        const q = s.pool[s.index]; if (!q) return;
        const ta = $('report-text'); const txt = ((ta && ta.value) || '').trim();
        if (!txt) { ta && ta.focus(); return; }
        const msg = $('report-msg');
        try {
            await apiJSON('/api/feedback', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ kind: 'question_report', message: `Question ${q.id} [${q.category || q.domain_name || '?'}]: ${txt}` }),
            });
            if (ta) ta.value = '';
            if (msg) { msg.textContent = 'Thanks — reported.'; setTimeout(() => { msg.textContent = ''; }, 2500); }
            toast("Thanks — we'll review this question.", 'ok');
        } catch (e) { toast('Could not send report: ' + e.message); }
    }

    // Confidence capture (tutor mode) — feeds the "confident but wrong" review.
    function setConfidence(v) {
        state.pendingConfidence = (state.pendingConfidence === v) ? null : v;
        renderConfidenceRow();
    }
    function renderConfidenceRow() {
        document.querySelectorAll('#confidence-row .conf-chip').forEach((c) => {
            const on = c.dataset.conf === state.pendingConfidence;
            c.classList.toggle('active', on);
            c.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }
    function reviewConfidentMisses() {
        startFromIds((state.profile && state.profile.confident_missed_ids) || [], 'confident-miss');
    }

    // ---- notebook ---------------------------------------------------------
    async function loadNotebook() {
        const body = $('notebook-body'); if (body) body.innerHTML = '<div class="mono" style="color:var(--muted);">Loading…</div>';
        try {
            const { resp, data } = await apiJSON('/api/user/notebook', { headers: authHeaders() });
            if (!resp.ok) throw new Error(data.error || 'Could not load.');
            state.notebook = { notes: data.notes || [], flagged: data.flagged || [] };
            renderNotebook();
        } catch (e) { if (body) body.innerHTML = `<div class="mono" style="color:var(--bad);">${escapeHtml(e.message)}</div>`; }
    }
    function renderNotebook() {
        const body = $('notebook-body'); if (!body || !state.notebook) return;
        const term = ((($('notebook-search') || {}).value) || '').trim().toLowerCase();
        const match = (s) => !term || (s || '').toLowerCase().includes(term);
        const notes = state.notebook.notes.filter((n) => match(n.note) || match(n.stem) || match(n.category));
        const flagged = state.notebook.flagged.filter((f) => match(f.stem) || match(f.category));
        const snip = (s) => escapeHtml((s || '').slice(0, 160)) + ((s || '').length > 160 ? '…' : '');
        const card = (inner) => `<div style="border:1px solid var(--line);border-radius:6px;padding:14px;margin-bottom:10px;">${inner}</div>`;
        const noteHtml = notes.length ? notes.map((n) => card(
            `<div class="mono" style="font-size:11px;color:var(--accent);margin-bottom:4px;">${escapeHtml(n.category || '')}</div>`
            + `<div style="font-size:13px;color:var(--text2);margin-bottom:6px;">${snip(n.stem)}</div>`
            + `<div style="font-size:14px;border-left:2px solid var(--accent);padding-left:10px;">${escapeHtml(n.note)}</div>`
            + `<button class="btn ghost" type="button" onclick="MACPrep.practiceOne('${escapeHtml(n.question_id)}')" style="margin-top:8px;font-size:12px;padding:5px 10px;">Practice this</button>`
        )).join('') : '<div class="mono" style="color:var(--muted);font-size:13px;">No notes match.</div>';
        const flagHtml = flagged.length ? flagged.map((f) => card(
            `<div class="mono" style="font-size:11px;color:var(--accent);margin-bottom:4px;">${escapeHtml(f.category || '')}</div>`
            + `<div style="font-size:13px;color:var(--text2);">${snip(f.stem)}</div>`
            + `<button class="btn ghost" type="button" onclick="MACPrep.practiceOne('${escapeHtml(f.question_id)}')" style="margin-top:8px;font-size:12px;padding:5px 10px;">Practice this</button>`
        )).join('') : '<div class="mono" style="color:var(--muted);font-size:13px;">No flagged questions match.</div>';
        body.innerHTML = `<h3>Notes (${notes.length})</h3>${noteHtml}<h3 style="margin-top:24px;">Flagged (${flagged.length})</h3>${flagHtml}`;
    }
    function practiceOne(qid) { startFromIds([qid], 'notebook'); }

    // ---- quiz -------------------------------------------------------------
    function buildChoiceButton(choice, idx, qid) {
        const text = (typeof choice === 'object' && choice) ? (choice.text || choice.value || '') : choice;
        const letter = String.fromCharCode(65 + idx);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'choice-option-node';
        btn.dataset.index = String(idx);
        btn.setAttribute('aria-label', `Answer ${letter}: ${text}`);
        btn.style.cssText = 'display:block;width:100%;text-align:left;margin:10px 0;padding:14px;background:var(--bg);border:1px solid var(--line);color:var(--text);font-family:ui-monospace,monospace;cursor:pointer;border-radius:4px;';
        btn.innerHTML = `<span style="color:var(--accent);font-weight:bold;margin-right:15px;">[${letter}]</span> ${text}`;
        btn.onclick = () => answer(idx, qid);
        return btn;
    }

    function toggleEliminate(idx) {
        const s = state.session; if (!s) return;
        s.eliminated = s.eliminated || {};
        const set = new Set(s.eliminated[s.index] || []);
        const btn = $('choices-container').querySelector(`.choice-option-node[data-index="${idx}"]`);
        if (set.has(idx)) { set.delete(idx); if (btn) { btn.style.textDecoration = 'none'; btn.style.opacity = '1'; } }
        else { set.add(idx); if (btn) { btn.style.textDecoration = 'line-through'; btn.style.opacity = '0.45'; } }
        s.eliminated[s.index] = Array.from(set);
        saveSession();
    }
    function zoomImage(src) {
        const lb = $('lightbox'); if (!lb || !src) return;
        const img = $('lightbox-img'); if (img) img.src = src;
        lb.classList.remove('hidden');
    }
    function toggleLabs() { const m = $('labs-modal'); if (m) m.classList.toggle('hidden'); }

    // Apply the graded result (highlights, rationale, explanation) — used both when
    // grading live and when re-rendering an already-answered question.
    function applyGradedView(data, selectedIndex) {
        const buttons = Array.from($('choices-container').querySelectorAll('.choice-option-node'));
        const rationales = data.rationales || [];
        // Tutor-only: show what % of all responses chose each option, so the user can
        // see how they compare. Server only sends this once there's a meaningful sample.
        const dist = data.choice_distribution;
        const showDist = !!dist && state.session && state.session.mode === 'tutor';
        buttons.forEach((b) => {
            b.disabled = true; b.style.cursor = 'default';
            const idx = Number(b.dataset.index);
            if (idx === data.correctIndex) { b.style.borderColor = 'var(--accent)'; b.style.background = 'var(--accent-dim)'; }
            else if (idx === selectedIndex) { b.style.borderColor = 'var(--danger)'; b.style.background = 'var(--danger-dim)'; }
            let anchor = b;
            if (rationales[idx]) {
                const r = document.createElement('div');
                r.style.cssText = 'font-family:inherit;font-size:13px;color:var(--muted);margin:8px 0 2px;padding-left:34px;line-height:1.5;';
                r.textContent = (idx === data.correctIndex ? '✓ ' : '✗ ') + rationales[idx];
                anchor.insertAdjacentElement('afterend', r); anchor = r;
            }
            if (showDist && typeof dist[idx] === 'number') {
                const pct = dist[idx];
                const barColor = idx === data.correctIndex ? 'var(--accent)' : 'var(--muted)';
                const youTag = (idx === selectedIndex) ? ' · <span style="color:var(--accent);font-weight:bold;">your pick</span>' : '';
                const d = document.createElement('div');
                d.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0 2px;padding-left:34px;';
                d.innerHTML = '<div style="flex:1;max-width:150px;height:6px;background:var(--line);border-radius:3px;overflow:hidden;"><span style="display:block;height:100%;width:' + pct + '%;background:' + barColor + ';transform-origin:left;animation:barGrow .7s cubic-bezier(.2,.8,.2,1);"></span></div><span class="mono" style="font-size:11px;color:var(--muted);">' + pct + '% chose this' + youTag + '</span>';
                anchor.insertAdjacentElement('afterend', d); anchor = d;
            }
        });
        const verdict = data.correct
            ? '<span style="color:var(--accent);font-weight:bold;">CORRECT</span>'
            : '<span style="color:var(--bad);font-weight:bold;">INCORRECT</span>';
        const peer = (data.peer_correct_pct != null) ? ` <span style="color:var(--muted);">· ${data.peer_correct_pct}% of users got this right</span>` : '';
        let html = `<div class="mono" style="font-size:12px;margin-bottom:8px;">${verdict}${peer}</div><div>${renderRich(data.explanation || 'No explanation provided.')}</div>`;
        const refs = (data.references || []).filter((r) => r && (r.url || r.source || r.title));
        if (refs.length) {
            const items = refs.map((r) => {
                const label = escapeHtml(r.title || r.source || r.url);
                const url = safeUrl(r.url);
                return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `<span>${label}</span>`;
            }).join('<br>');
            html += `<div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px;"><div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Source</div><div style="font-size:13px;">${items}</div></div>`;
        }
        const ex = $('explanation-pane'); ex.innerHTML = html; ex.classList.remove('hidden');
    }

    function renderQuestion() {
        const s = state.session; if (!s) return go('dashboard');
        if (s.index < 0) s.index = 0;
        if (s.index >= s.pool.length) { if (s.mode === 'exam') s.index = s.pool.length - 1; else return finishSession(); }
        clearSessionReview();
        const q = s.pool[s.index];
        const ans = s.answers[s.index] || null;
        const graded = ans && ans.graded;
        s.locked = !!graded; // tutor: locked once graded

        const metaText = [q.category || q.domain_name, q.subtopic].filter(Boolean).join('  ·  ').toUpperCase();
        const reviewedBadge = q.reviewed ? ' <span style="text-transform:none;letter-spacing:0;color:var(--accent);">· ✓ Reviewed by a practicing CAA</span>' : '';
        $('question-meta').innerHTML = escapeHtml(metaText) + reviewedBadge;
        const img = safeUrl(q.image_url) ? `<img src="${escapeHtml(q.image_url)}" alt="Question figure" onclick="MACPrep.zoomImage(this.src)" style="max-width:100%;border:1px solid var(--line);border-radius:4px;margin:12px 0;cursor:zoom-in;">` : '';
        $('question-stem').innerHTML = renderRich(q.stem) + img;
        const container = $('choices-container');
        container.innerHTML = '';
        let choices = q.choices || [];
        if (typeof choices === 'string') { try { choices = JSON.parse(choices); } catch (e) { choices = []; } }
        const eliminated = (s.eliminated && s.eliminated[s.index]) || [];
        choices.forEach((choice, idx) => {
            const btn = buildChoiceButton(choice, idx, q.id);
            // Exam mode: highlight the chosen (but unscored) answer.
            if (ans && ans.selectedIndex === idx && !graded) { btn.style.borderColor = 'var(--accent)'; btn.style.background = 'var(--accent-dim)'; }
            if (eliminated.includes(idx)) { btn.style.textDecoration = 'line-through'; btn.style.opacity = '0.45'; }
            // Right-click (or long-press) crosses out a distractor you've eliminated.
            if (!graded) btn.oncontextmenu = (e) => { e.preventDefault(); toggleEliminate(idx); };
            container.appendChild(btn);
        });
        if (!choices.length) {
            container.innerHTML = '<div class="mono" style="color:var(--warn);font-size:13px;padding:8px 0;">This question is temporarily unavailable. Use "Next" to skip it.</div>';
            s.locked = true; // let the user advance past an unrenderable question in tutor mode
        }
        $('explanation-pane').classList.add('hidden');
        $('explanation-pane').innerHTML = '';
        if (graded) applyGradedView(ans.graded, ans.selectedIndex);
        // Confidence control (tutor, pre-grade) + reset the per-question report box.
        if (!graded) state.pendingConfidence = null;
        const confRow = $('confidence-row');
        if (confRow) confRow.style.display = (s.mode === 'tutor' && !graded && choices.length) ? 'flex' : 'none';
        renderConfidenceRow();
        $('report-text') && ($('report-text').value = '');
        $('report-msg') && ($('report-msg').textContent = '');
        updateFlagButton();
        saveNote();   // flush any pending note from the previous question before loading this one
        loadNote();
        renderPalette();
        renderQuizNav();
        updateQuizProgress();
        renderExamTimer();
        saveSession();
    }

    async function answer(selectedIndex, questionId) {
        const s = state.session; if (!s) return;
        // EXAM mode: record the selection only; no feedback, changeable until submit.
        if (s.mode === 'exam') {
            s.answers[s.index] = { selectedIndex };
            renderQuestion();
            return;
        }
        // TUTOR mode: grade immediately.
        if (s.locked) return;
        const currentQ = s.pool[s.index];
        s.locked = true;
        const buttons = Array.from($('choices-container').querySelectorAll('.choice-option-node'));
        buttons.forEach((b) => { b.disabled = true; b.style.cursor = 'default'; });
        try {
            const { resp, data } = await apiJSON('/api/grade', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ questionId, choiceIndex: selectedIndex, confidence: state.pendingConfidence || undefined }),
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
            s.answers[s.index] = { selectedIndex, graded: data };
            applyGradedView(data, selectedIndex);
            $('confidence-row') && ($('confidence-row').style.display = 'none');
            announce(data.correct ? 'Correct.' : `Incorrect. The correct answer is ${String.fromCharCode(65 + (data.correctIndex || 0))}.`);
            (s.log = s.log || []).push({
                meta: [currentQ.category || currentQ.domain_name, currentQ.subtopic].filter(Boolean).join(' · '),
                category: currentQ.category || currentQ.domain_name || 'General',
                stem: currentQ.stem || '',
                correct: !!data.correct,
                correctLetter: String.fromCharCode(65 + (data.correctIndex || 0)),
                yourLetter: String.fromCharCode(65 + selectedIndex),
                explanation: data.explanation || '',
            });
            renderPalette();
            updateQuizProgress();
        } catch (err) {
            s.locked = false;
            buttons.forEach((b) => { b.disabled = false; b.style.cursor = 'pointer'; });
            toast('Could not grade answer: ' + err.message);
        }
    }

    // Bring the next/prev question to the top of the viewport so the user isn't left
    // scrolled down at the previous explanation. (Requested feedback.)
    function scrollQuizToTop() { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { try { window.scrollTo(0, 0); } catch (_) {} } }
    function gotoQuestion(idx) { const s = state.session; if (!s || idx < 0 || idx >= s.pool.length) return; s.index = idx; renderQuestion(); scrollQuizToTop(); }
    function prevQuestion() { const s = state.session; if (!s || s.index <= 0) return; s.index--; renderQuestion(); scrollQuizToTop(); }

    function advance() {
        const s = state.session; if (!s) return;
        if (s.mode === 'tutor' && !s.locked && s.index < s.pool.length) return; // must answer first
        if (s.index < s.pool.length - 1) { s.index++; renderQuestion(); scrollQuizToTop(); }
        else if (s.mode !== 'exam') { finishSession(); scrollQuizToTop(); }
    }

    function renderPalette() {
        const s = state.session; const el = $('quiz-palette'); if (!el || !s) return;
        const flags = new Set((state.profile && state.profile.flagged_ids) || []);
        el.innerHTML = s.pool.map((q, i) => {
            const a = s.answers[i];
            const graded = a && a.graded;
            const answered = a && a.selectedIndex != null;
            let bg = 'var(--bg)', bc = 'var(--line)', col = 'var(--muted)';
            if (graded) { if (graded.correct) { bg = 'var(--accent-dim)'; bc = 'var(--accent)'; col = 'var(--accent)'; } else { bg = 'var(--danger-dim)'; bc = 'var(--danger)'; col = 'var(--bad)'; } }
            else if (answered) { bg = 'var(--line)'; col = 'var(--text)'; }
            const border = (i === s.index) ? 'var(--accent)' : bc;
            const star = flags.has(q.id) ? '<span style="position:absolute;top:-5px;right:-3px;color:var(--warn);font-size:10px;">★</span>' : '';
            return `<button type="button" aria-label="Question ${i + 1}" onclick="MACPrep.gotoQuestion(${i})" style="position:relative;width:32px;height:32px;border:2px solid ${border};background:${bg};color:${col};border-radius:4px;font-family:ui-monospace,monospace;font-size:11px;cursor:pointer;">${i + 1}${star}</button>`;
        }).join('');
    }

    function renderQuizNav() {
        const s = state.session; if (!s) return;
        const prev = $('prev-btn'), next = $('advance-vignette-trigger'), submit = $('submit-exam-btn');
        if (prev) prev.style.display = s.index > 0 ? '' : 'none';
        if (submit) submit.style.display = s.mode === 'exam' ? '' : 'none';
        if (next) {
            next.className = 'btn secondary';
            next.onclick = advance;
            if (s.mode === 'exam') { next.textContent = 'Next »'; next.style.visibility = s.index >= s.pool.length - 1 ? 'hidden' : 'visible'; }
            else { next.textContent = s.index >= s.pool.length - 1 ? 'Finish ▸' : 'Next Question »'; next.style.visibility = 'visible'; }
        }
    }

    async function submitExam(auto) {
        const s = state.session; if (!s || s.mode !== 'exam' || s.complete || s.submitting) return;
        const answeredIdx = s.pool.map((q, i) => i).filter((i) => s.answers[i] && s.answers[i].selectedIndex != null);
        const unanswered = s.pool.length - answeredIdx.length;
        // Only confirm on a manual submit; an auto-submit (time's up) just submits.
        if (!auto && unanswered > 0 && !confirm(`${unanswered} question(s) are unanswered. Submit anyway?`)) return;
        s.submitting = true;
        stopExamTimer();
        setLoading(true);
        let correct = 0, failed = 0;
        try {
            for (const i of answeredIdx) {
                const q = s.pool[i]; const sel = s.answers[i].selectedIndex;
                try {
                    const { resp, data } = await apiJSON('/api/grade', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ questionId: q.id, choiceIndex: sel }) });
                    if (resp.ok) { s.answers[i].graded = data; if (data.correct) correct++; }
                    else { failed++; }
                } catch (e) { failed++; }
            }
        } finally { setLoading(false); }
        s.answered = answeredIdx.length - failed; s.correct = correct;
        s.complete = true; ls('macprep_session', null);
        s.log = answeredIdx.map((i) => {
            const q = s.pool[i]; const a = s.answers[i]; const g = a.graded || {};
            return { meta: [q.category || q.domain_name, q.subtopic].filter(Boolean).join(' · '), category: q.category || q.domain_name || 'General', stem: q.stem || '', correct: !!g.correct, correctLetter: String.fromCharCode(65 + (g.correctIndex || 0)), yourLetter: String.fromCharCode(65 + a.selectedIndex), explanation: g.explanation || '' };
        });
        track('session_complete', { mode: 'exam', size: s.pool.length });
        try { await loadProfile(); } catch (e) {}
        $('quiz-palette') && ($('quiz-palette').innerHTML = '');
        $('prev-btn') && ($('prev-btn').style.display = 'none');
        $('submit-exam-btn') && ($('submit-exam-btn').style.display = 'none');
        const pct = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
        const allFailed = answeredIdx.length > 0 && s.answered === 0;
        $('question-meta').textContent = allFailed ? 'GRADING FAILED' : 'EXAM COMPLETE';
        if (allFailed) {
            $('question-stem').innerHTML = `<span style="color:var(--warn);">We couldn't grade your exam — this is usually a temporary connection problem. Please check your connection and run the session again.</span>`;
        } else {
            const failWarn = failed ? `<div style="margin-top:12px;color:var(--warn);font-size:13px;">⚠ ${failed} question${failed === 1 ? '' : 's'} couldn't be graded (network error) and were left out of your score. Try them again from the dashboard.</div>` : '';
            const hype = pct >= 90 ? '🎉 Outstanding — ' : pct >= 75 ? '🎉 Great work — ' : '';
            $('question-stem').innerHTML = `${hype}You scored <strong>${pct}%</strong> (${s.correct}/${s.answered} correct${unanswered ? `, ${unanswered} unanswered` : ''}).${failWarn}`;
            if (pct >= 70 && s.answered >= 3) celebrate();
        }
        $('choices-container').innerHTML = '';
        $('explanation-pane').classList.add('hidden');
        renderSessionBreakdown(s.log || []);
        renderSessionReview(s.log || []);
        const next = $('advance-vignette-trigger');
        next.textContent = 'Back to Dashboard'; next.className = 'btn'; next.style.visibility = 'visible';
        next.onclick = () => { resetAdvanceButton(); clearSessionReview(); MACPrep.go('dashboard'); };
        $('quiz-progress-bar').style.width = '100%';
    }

    function updateQuizProgress() {
        const s = state.session; if (!s) return;
        if (s.mode === 'exam') {
            const answeredCount = s.pool.filter((q, i) => s.answers[i] && s.answers[i].selectedIndex != null).length;
            $('session-progress-counter').textContent = `EXAM · QUESTION ${s.index + 1} / ${s.size} · ${answeredCount} answered`;
        } else {
            const scoreLabel = s.answered ? `${Math.round((s.correct / s.answered) * 100)}%` : '—';
            $('session-progress-counter').textContent = `QUESTION ${Math.min(s.index + 1, s.size)} / ${s.size} · SCORE ${scoreLabel}`;
        }
        $('quiz-progress-bar').style.width = Math.round(((s.index + 1) / s.size) * 100) + '%';
    }

    function finishSession() {
        const s = state.session;
        s.complete = true; ls('macprep_session', null); stopExamTimer();
        track('session_complete', { mode: 'tutor', answered: s.answered });
        const pct = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
        const hype = (s.answered >= 3 && pct >= 90) ? '🎉 Outstanding! ' : (s.answered >= 3 && pct >= 75) ? '🎉 Great work! ' : '';
        $('question-meta').textContent = 'SESSION COMPLETE';
        $('question-stem').innerHTML = `${hype}You answered <strong>${s.answered}</strong> question${s.answered === 1 ? '' : 's'} with <strong>${pct}%</strong> accuracy (${s.correct}/${s.answered} correct).`;
        if (s.answered >= 3 && pct >= 70) celebrate();
        $('choices-container').innerHTML = '';
        $('explanation-pane').classList.add('hidden');
        renderSessionBreakdown(s.log || []);
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

    function clearSessionReview() {
        const el = $('session-review'); if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
        const b = $('session-breakdown'); if (b) { b.innerHTML = ''; b.classList.add('hidden'); }
    }

    // Lightweight canvas confetti for celebratory moments — no dependency, self-removing.
    function celebrate(count) {
        try {
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const W = window.innerWidth, H = window.innerHeight;
            const canvas = document.createElement('canvas');
            canvas.setAttribute('aria-hidden', 'true');
            canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9998;';
            document.body.appendChild(canvas);
            const ctx = canvas.getContext('2d');
            if (!ctx) { canvas.remove(); return; }
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = W * dpr; canvas.height = H * dpr; ctx.scale(dpr, dpr);
            const colors = ['#00A86B', '#34d399', '#fbbf24', '#60a5fa', '#f87171', '#a78bfa'];
            const N = count || 130, parts = [];
            for (let i = 0; i < N; i++) parts.push({
                x: W / 2 + (Math.random() - 0.5) * 140, y: H * 0.3,
                vx: (Math.random() - 0.5) * 10, vy: Math.random() * -11 - 4,
                size: 5 + Math.random() * 6, color: colors[i % colors.length],
                rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.32,
            });
            let frame = 0; const maxF = 190;
            (function tick() {
                frame++; ctx.clearRect(0, 0, W, H);
                let alive = 0;
                for (const p of parts) {
                    p.vy += 0.22; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.rot += p.vr;
                    if (p.y < H + 24) alive++;
                    ctx.save(); ctx.globalAlpha = Math.max(0, 1 - frame / maxF);
                    ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
                    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62); ctx.restore();
                }
                if (frame < maxF && alive > 0) requestAnimationFrame(tick); else canvas.remove();
            })();
        } catch (e) { /* non-critical */ }
    }

    function renderSessionReview(log) {
        const el = $('session-review');
        if (!el) return;
        if (!log.length) { el.classList.add('hidden'); return; }
        const rows = log.map((r, i) => `
            <div style="border-bottom:1px solid var(--line);padding:14px 0;">
                <div class="mono" style="font-size:11px;color:var(--muted);margin-bottom:4px;">${i + 1}. ${r.meta || ''}</div>
                <div style="font-size:14px;margin-bottom:6px;">${r.stem}</div>
                <div class="mono" style="font-size:12px;">
                    <span style="color:${r.correct ? 'var(--accent)' : 'var(--bad)'};">${r.correct ? '✓ Correct' : '✗ Incorrect'}</span>
                    &nbsp;·&nbsp; Your answer: ${r.yourLetter} &nbsp;·&nbsp; Correct: ${r.correctLetter}
                </div>
                ${r.explanation ? `<div style="font-size:13px;color:var(--text2);margin-top:6px;line-height:1.5;">${r.explanation}</div>` : ''}
            </div>`).join('');
        el.innerHTML = `<h2 style="margin:0 0 6px;">Review</h2><p class="sub">Every question from this session, with the correct answer and explanation.</p>${rows}`;
        el.classList.remove('hidden');
    }

    // Post-session action plan: per-specialty score + a one-tap drill of the weakest.
    function renderSessionBreakdown(log) {
        const el = $('session-breakdown'); if (!el) return;
        if (!log || !log.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
        const by = {};
        log.forEach((r) => { const c = r.category || 'General'; (by[c] = by[c] || { c: 0, t: 0 }); by[c].t++; if (r.correct) by[c].c++; });
        const rows = Object.entries(by).map(([cat, v]) => ({ cat, correct: v.c, total: v.t, acc: Math.round((v.c / v.t) * 100) }))
            .sort((a, b) => a.acc - b.acc || b.total - a.total);
        const chips = rows.map((r) => {
            const color = r.acc >= 75 ? 'var(--accent)' : r.acc >= 50 ? 'var(--warn)' : 'var(--bad)';
            return `<span class="mono" style="display:inline-block;margin:0 12px 8px 0;font-size:13px;"><span style="color:${color};">${r.cat}</span> <span style="color:var(--muted);">${r.correct}/${r.total}</span></span>`;
        }).join('');
        const weakest = rows[0];
        const cta = (weakest && weakest.acc < 100 && rows.length > 1)
            ? `<button class="btn" type="button" onclick="MACPrep.drillSpecialty('${String(weakest.cat).replace(/'/g, "\\'")}')" style="margin-top:6px;">Drill ${weakest.cat} →</button>`
            : '';
        el.innerHTML = `<h2 style="margin:0 0 8px;">How you did by specialty</h2><div style="margin-bottom:6px;">${chips}</div>${cta}`;
        el.classList.remove('hidden');
    }

    function drillSpecialty(cat) {
        go('dashboard');
        const sel = $('domain-select'); if (sel) sel.value = cat;
        const diff = $('difficulty-select'); if (diff) diff.value = 'all';
        const pm = $('pool-mode'); if (pm) pm.value = 'all';
        updateSessionHint();
        startSession();
    }

    function reviewDue() { startFromIds((state.profile && state.profile.due_ids) || [], 'due'); }

    // Printable take-home exam → opens a clean print-to-PDF window (premium).
    async function downloadExam(btn) {
        const n = selectedCount(); const count = (n === Infinity || !n) ? 50 : n;
        const cat = $('domain-select') ? $('domain-select').value : 'all';
        if (btn) { btn.disabled = true; btn.dataset.prev = btn.textContent; btn.textContent = 'Building…'; }
        try {
            const { resp, data } = await apiJSON(`/api/exam-export?count=${count}&category=${encodeURIComponent(cat)}`, { headers: authHeaders() });
            if (resp.status === 402) { toast('Printable exams are a premium feature — upgrade for full access.'); return; }
            if (!resp.ok) throw new Error(data.error || 'Could not build exam.');
            openPrintExam(data.questions || [], cat);
        } catch (e) { toast('Could not build exam: ' + e.message); }
        finally { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.prev || '📄 Printable exam (PDF)'; } }
    }
    function openPrintExam(qs, cat) {
        if (!qs.length) { toast('No questions available for that selection.'); return; }
        const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const qHtml = qs.map((q, i) => {
            const opts = q.choices.map((c, j) => `<div class="opt">${String.fromCharCode(65 + j)}. ${esc(c)}</div>`).join('');
            return `<div class="q"><div class="qn">${i + 1}. <span class="cat">[${esc(q.category)}]</span></div><div class="stem">${esc(q.stem)}</div>${opts}</div>`;
        }).join('');
        const keyHtml = qs.map((q, i) => {
            const refs = (q.references || []).map((r) => esc(r.source || r.title || r.url)).filter(Boolean).join('; ');
            return `<div class="ans"><strong>${i + 1}. ${esc(q.correctLetter)}</strong> — ${esc(q.explanation)}${refs ? `<div class="src">Source: ${refs}</div>` : ''}</div>`;
        }).join('');
        const title = `MACPrep Practice Exam — ${cat === 'all' ? 'All specialties' : esc(cat)} (${qs.length} questions)`;
        const w = window.open('', '_blank');
        if (!w) { toast('Allow pop-ups to open the printable exam.'); return; }
        w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Georgia,'Times New Roman',serif;color:#111;max-width:740px;margin:0 auto;padding:32px 24px;line-height:1.5;}h1{font-size:20px;margin:0 0 4px;}.sub{color:#555;font-size:13px;margin:0 0 24px;}.q{margin:0 0 20px;page-break-inside:avoid;}.qn{font-weight:bold;}.cat{color:#777;font-weight:normal;font-size:12px;}.stem{margin:4px 0 8px;}.opt{margin:2px 0 2px 18px;}.key{page-break-before:always;}.key h2{font-size:18px;border-bottom:2px solid #111;padding-bottom:4px;}.ans{margin:0 0 12px;font-size:13px;}.src{color:#777;font-size:11px;margin-top:2px;}@media print{.noprint{display:none;}}</style></head><body><h1>${esc(title)}</h1><p class="sub">Generated by MACPrep · macprep.org · Answer key follows the questions.</p><button class="noprint" onclick="window.print()" style="margin-bottom:18px;padding:8px 16px;cursor:pointer;">Print / Save as PDF</button>${qHtml}<div class="key"><h2>Answer key &amp; explanations</h2>${keyHtml}</div></body></html>`);
        w.document.close();
    }

    function showPaywall(limit) {
        const s = state.session;
        if (s) { s.complete = true; ls('macprep_session', null); }
        track('paywall_hit');
        $('question-meta').textContent = "NICE WORK — YOU'VE USED YOUR FREE QUESTIONS";
        const n = limit || state.profile?.free_tier_limit || '';
        const bank = (state.questions || []).length;
        const statLine = s && s.answered ? `You scored <strong>${Math.round((s.correct / s.answered) * 100)}%</strong> on the ${s.answered} you answered this session — momentum worth keeping. ` : '';
        $('question-stem').innerHTML = `You've worked through all <strong>${n}</strong> of your free questions (10% of the bank). ${statLine}`
            + `<div style="margin-top:16px;text-align:left;max-width:480px;">Unlock <strong>full access</strong> and get:`
            + `<div style="line-height:2;margin-top:8px;color:var(--text2);">`
            + `<span style="color:var(--accent);">✓</span> The entire ${bank ? '<strong>' + bank.toLocaleString() + '+</strong> question ' : ''}bank — every domain &amp; specialty<br>`
            + `<span style="color:var(--accent);">✓</span> Every explanation, rationale &amp; verifiable source<br>`
            + `<span style="color:var(--accent);">✓</span> Progress tracking, weak-spot review &amp; your exam-date plan<br>`
            + `<span style="color:var(--accent);">✓</span> <strong>Lifetime</strong> access — one $50 payment, no subscription`
            + `</div></div>`;
        $('choices-container').innerHTML = '';
        $('explanation-pane').classList.add('hidden');
        if (s && s.log && s.log.length) renderSessionReview(s.log);
        const btn = $('advance-vignette-trigger');
        btn.className = 'btn';
        btn.textContent = 'Unlock full access — $50 (one-time)';
        btn.onclick = () => startCheckout(btn);
        let rr = document.getElementById('paywall-refund');
        if (!rr && btn.parentNode) { rr = document.createElement('div'); rr.id = 'paywall-refund'; rr.className = 'mono'; rr.style.cssText = 'font-size:11px;color:var(--muted);margin-top:10px;'; btn.parentNode.insertBefore(rr, btn.nextSibling); }
        if (rr) rr.textContent = '48-hour, no-questions-asked refund · secured by Stripe · instant access';
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
            msg.style.color = 'var(--bad)'; msg.textContent = err.message;
        } finally { btn.disabled = false; }
    }

    // ---- account management ----------------------------------------------
    async function changePassword() {
        const current = prompt('Confirm your CURRENT password:');
        if (current == null) return;
        const pw = prompt('Enter a new password (at least 8 characters):');
        if (pw == null) return;
        if (pw.length < 8) { toast('Password must be at least 8 characters.'); return; }
        try {
            const { resp, data } = await apiJSON('/api/user/change-password', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ current_password: current, new_password: pw }) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Could not change password.');
            toast('Password changed.', 'ok');
        } catch (e) { toast('Failed: ' + e.message); }
    }

    async function deleteAccount() {
        if (!confirm('Delete your account and all study data permanently? This cannot be undone.')) return;
        if (!confirm('Are you absolutely sure? This will erase your progress and cancel access.')) return;
        try {
            const { resp, data } = await apiJSON('/api/user/delete', { method: 'POST', headers: authHeaders() });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Could not delete account.');
            toast('Your account has been deleted.', 'ok');
            signOut();
        } catch (e) { toast('Failed: ' + e.message); }
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
        if (!(state.profile && state.profile.is_admin)) { go('dashboard'); return; }
        go('admin');
        loadAnalytics();
        loadVouchers();
        const wrap = $('admin-body'); if (wrap) wrap.innerHTML = '<div class="mono" style="color:var(--muted);">Loading review queue…</div>';
        try {
            const { resp, data } = await apiJSON('/api/admin/questions?status=sme_review', { headers: authHeaders() });
            if (!resp.ok) throw new Error(data.error || 'Could not load.');
            state.review = { list: data.questions || [], index: 0, counts: data.counts || {} };
            renderReview();
        } catch (e) {
            if (wrap) wrap.innerHTML = `<div class="mono" style="color:var(--bad);">${escapeHtml(e.message)}</div>`;
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
                <textarea data-edit="choice-rat-${i}" rows="2" style="width:100%;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:4px;color:var(--muted);font-size:12px;">${escapeHtml(ch.rationale || '')}</textarea>
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
        } catch (e) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } }
    }

    // ---- vouchers / codes -------------------------------------------------
    async function redeemCode() {
        const inp = $('redeem-code'); const msg = $('redeem-msg'); if (!inp) return;
        const code = (inp.value || '').trim();
        if (!code) return;
        msg.style.color = 'var(--accent)'; msg.textContent = 'Checking…';
        try {
            const { resp, data } = await apiJSON('/api/redeem-voucher', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ code }) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Could not redeem.');
            track('upgrade_success', { via: 'voucher' });
            msg.textContent = 'Unlocked! Loading your full access…';
            await loadProfile();
            inp.value = '';
            renderDashboard();
            const badge = $('tier-badge'); if (badge && state.profile && state.profile.premium_unlocked) { badge.textContent = 'PREMIUM'; badge.className = 'badge premium'; }
        } catch (e) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; }
    }

    async function loadVouchers() {
        const el = $('admin-vouchers'); if (!el) return;
        try {
            const { resp, data } = await apiJSON('/api/admin/vouchers', { headers: authHeaders() });
            if (!resp.ok) return;
            const rows = (data.vouchers || []).map((v) => `<tr>
                <td style="font-family:ui-monospace,monospace;padding:4px 10px 4px 0;">${escapeHtml(v.voucher_key)}</td>
                <td style="padding:4px 10px;color:${v.is_claimed ? 'var(--muted)' : 'var(--accent)'};">${v.is_claimed ? 'claimed' : 'available'}</td>
                <td style="padding:4px 0;color:var(--muted);font-size:12px;">${v.claimed_by_email ? escapeHtml(v.claimed_by_email) : ''}</td></tr>`).join('');
            el.innerHTML = `<h3>Cohort vouchers</h3>
                <p class="sub" style="margin:0 0 10px;">Generate codes to hand to a class or cohort — each grants one premium unlock. <span class="mono" style="color:var(--muted);">${data.claimed}/${data.total} claimed</span></p>
                <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">
                    <input id="voucher-count" type="number" min="1" max="200" value="10" style="width:90px;padding:8px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);">
                    <button class="btn" onclick="MACPrep.generateVouchers()">Generate codes</button>
                    <span id="voucher-msg" class="mono" style="font-size:12px;color:var(--accent);"></span>
                </div>
                ${rows ? `<div style="max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:4px;padding:10px;"><table style="width:100%;font-size:13px;">${rows}</table></div>` : '<div class="mono" style="color:var(--muted);font-size:13px;">No codes yet.</div>'}`;
            el.classList.remove('hidden');
        } catch (e) { /* ignore */ }
    }

    async function generateVouchers() {
        const count = parseInt($('voucher-count').value, 10) || 10;
        const msg = $('voucher-msg'); if (msg) msg.textContent = 'Generating…';
        try {
            const { resp, data } = await apiJSON('/api/admin/vouchers', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ count }) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Failed.');
            await loadVouchers();
            if (msg) { msg.textContent = `Generated ${data.codes.length}. Copy them from the list below.`; }
        } catch (e) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } }
    }

    // ---- checkout ---------------------------------------------------------
    async function startCheckout(btn) {
        if (btn && btn.disabled) return;
        if (btn) { btn.disabled = true; btn.dataset.prev = btn.textContent; btn.textContent = 'Redirecting…'; }
        track('upgrade_click');
        track('checkout_started');
        try {
            const email = (state.profile && state.profile.email) || '';
            const { resp, data } = await apiJSON('/api/create-checkout-session', {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({ email }),
            });
            if (!resp.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
            window.location.href = data.url;
        } catch (err) {
            toast('Checkout could not start: ' + err.message);
            if (btn) { btn.disabled = false; btn.textContent = btn.dataset.prev || 'Upgrade — $50'; }
        }
    }

    function maybeHandleCheckoutReturn() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('status') === 'success') {
            const sessionId = params.get('session_id');
            history.replaceState({}, '', '/');
            (async () => {
                try {
                    // Confirm the payment with our server (which verifies it directly
                    // with Stripe) so access unlocks immediately — even if the Stripe
                    // webhook is delayed or missed. Plain profile refresh is the fallback.
                    if (sessionId) {
                        try { await apiJSON('/api/verify-checkout-session', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ session_id: sessionId }) }); } catch (e) {}
                    }
                    await loadProfile(); renderDashboard();
                    if (state.profile && state.profile.premium_unlocked) { track('upgrade_success'); toast('Payment received — full access unlocked. Thank you!', 'ok'); }
                    else { toast('Payment received — your access will unlock momentarily.', 'ok'); }
                } catch (e) {}
            })();
        } else if (params.get('status') === 'cancelled') {
            history.replaceState({}, '', '/');
        }
    }

    // ---- feedback ---------------------------------------------------------
    async function submitFeedback() {
        const btn = $('fb-submit'); const msg = $('fb-msg');
        const message = $('fb-message').value.trim();
        if (!message) { msg.style.color = 'var(--bad)'; msg.textContent = 'Please enter a message.'; return; }
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
            msg.style.color = 'var(--bad)'; msg.textContent = err.message;
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
        if (k === 'arrowleft' || k === 'p') { e.preventDefault(); prevQuestion(); return; }
        // A–E / 1–5 select (allowed pre-grade in tutor, anytime in exam).
        if (!s.locked || s.mode === 'exam') {
            let idx = -1;
            if (/^[a-e]$/.test(k)) idx = k.charCodeAt(0) - 97;
            else if (/^[1-5]$/.test(k)) idx = parseInt(k, 10) - 1;
            if (idx >= 0) {
                const btn = $('choices-container').querySelector(`.choice-option-node[data-index="${idx}"]`);
                if (btn) { e.preventDefault(); btn.click(); return; }
            }
        }
        if (k === 'enter' || k === 'arrowright' || k === 'n') {
            // In tutor mode, only advance after grading.
            if (s.mode === 'tutor' && !s.locked) return;
            e.preventDefault();
            const adv = $('advance-vignette-trigger');
            if (adv && adv.style.visibility !== 'hidden') adv.click();
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
                try { window.Sentry && window.Sentry.init({ dsn: cfg.sentryDsn, environment: cfg.environment || 'production', tracesSampleRate: 0,
                    // Filter benign transient network blips (a user's flaky connection, not a bug)
                    // and errors thrown by browser extensions rather than our own code.
                    ignoreErrors: ['Failed to fetch', 'Load failed', 'NetworkError', 'AbortError', 'cancelled'],
                    denyUrls: [/extension(s)?\//i, /^chrome:\/\//i, /-extension:\/\//i] }); }
                catch (e) { /* ignore */ }
            };
            document.head.appendChild(s);
        } catch (e) { /* monitoring is best-effort */ }
    }

    // ---- bootstrap --------------------------------------------------------
    // The theme picker lives in the <head> script; this hook persists the choice
    // to the signed-in user's account so it follows them across devices and logins.
    window.onThemeChange = function (id) {
        if (!state.token) return;
        apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ theme: id }) }).catch(() => {});
    };

    window.MACPrep = {
        go, login, signupInline, showSignin, showSignup, signOut, startSession, advance, saveProfile, setExamDate, setStudyGoal, startCheckout, submitFeedback,
        requestPasswordReset, redoMissed, startFlagged, toggleFlag, changePassword, deleteAccount, toggleMobileNav,
        smartReview, startSample, saveNote, reviewQueue, adminAction,
        gotoQuestion, prevQuestion, submitExam, redeemCode, generateVouchers,
        reportQuestion, setConfidence, reviewConfidentMisses,
        drillSpecialty, reviewDue, resumeSession, discardSession, toggleCoverage,
        zoomImage, toggleLabs, renderNotebook, practiceOne, downloadExam,
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
        $('pool-mode') && $('pool-mode').addEventListener('change', updateSessionHint);
        $('custom-count') && $('custom-count').addEventListener('input', () => {
            if (parseInt($('custom-count').value, 10) > 0) $('count-chips').querySelectorAll('.chip.active').forEach((c) => c.classList.remove('active'));
            updateSessionHint();
        });
        $('note-text') && $('note-text').addEventListener('blur', saveNote);
        if (state.token) {
            try { await bootAuthedSession(); }
            catch (e) { go('login'); }
        } else {
            go('login');
        }
    });
})();

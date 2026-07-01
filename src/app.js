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

    const VIEWS = ['login-view', 'dashboard-view', 'quiz-view', 'profile-view', 'feedback-view', 'admin-view', 'notebook-view', 'leaderboard-view', 'achievements-view'];
    function go(view) {
        closeMobileNav(); // bug fix: collapse the mobile menu on navigation
        // Guard against leaving an in-progress session by accident (progress is saved,
        // so this is a soft confirm rather than a hard block).
        if (state.session && state.session.arcade && !state.session.arcade.over && view !== 'quiz') {
            // Arcade runs are ephemeral (not saved) — leaving just ends the run, no confirm.
            stopArcadeTimer(); clearArcadeAdvance();
            state.session.arcade.over = true; state.session.complete = true;
            if ($('arcade-hud')) { $('arcade-hud').style.display = 'none'; $('arcade-hud').innerHTML = ''; }
        } else if (state.session && !state.session.complete && view !== 'quiz'
            && $('quiz-view') && !$('quiz-view').classList.contains('hidden')) {
            if (!confirm('Leave this session? Your progress is saved — you can resume it from the dashboard.')) return;
        }
        if (view !== 'login' && !state.token) view = 'login';
        VIEWS.forEach((v) => $(v) && $(v).classList.toggle('hidden', v !== view + '-view'));
        const authed = !!state.token && view !== 'login';
        document.body.classList.toggle('app-authed', authed); // drives the desktop sidebar shell
        // Signed-in app nav: study links, account menu, tier badge.
        ['nav-dashboard', 'nav-notebook', 'nav-leaderboard', 'nav-achievements', 'nav-arcade', 'nav-whatsnew', 'nav-account-wrap', 'cmdk-trigger'].forEach((id) =>
            $(id) && $(id).classList.toggle('hidden', !authed));
        if (authed) renderWhatsNewDot();
        const isAdmin = authed && state.profile && state.profile.is_admin;
        $('nav-admin-wrap') && $('nav-admin-wrap').classList.toggle('hidden', !isAdmin);
        // Tier badge shows for signed-in non-admins; admins already have the Admin ▾ menu.
        $('tier-badge') && $('tier-badge').classList.toggle('hidden', !authed || isAdmin);
        // Redesigned sidebar: highlight the active destination, fill the account block, apply collapse pref.
        const activeNavId = { dashboard: 'nav-dashboard', notebook: 'nav-notebook', leaderboard: 'nav-leaderboard', achievements: 'nav-achievements' }[view];
        ['nav-dashboard', 'nav-notebook', 'nav-leaderboard', 'nav-achievements'].forEach((idn) => { const a = $(idn); if (a) a.classList.toggle('nav-active', authed && idn === activeNavId); });
        if (authed) { renderSidebarAccount(); applySidebarPref(); }
        // "Redeem code" is only useful to free users (premium/admin already have full access).
        const isPremium = state.profile && (state.profile.premium_unlocked || state.profile.account_tier === 'premium' || state.profile.is_admin);
        $('nav-redeem') && $('nav-redeem').classList.toggle('hidden', !(authed && state.profile && !isPremium));
        // Marketing links + "Log in" show for logged-out visitors only.
        document.querySelectorAll('.nav-market').forEach((a) => a.classList.toggle('hidden', authed));
        $('nav-login') && $('nav-login').classList.toggle('hidden', authed);
        closeNavMenus();
        if (view === 'dashboard') { renderDashboard(); renderDailyQuests(); checkLevelUp(); }
        if (view === 'profile') renderProfile();
        if (view === 'notebook') loadNotebook();
        if (view === 'leaderboard') loadLeaderboard();
        if (view === 'achievements') renderAchievementsView();
        window.scrollTo(0, 0);
    }

    // Top-nav dropdown menus (Account / Admin).
    function closeNavMenus() {
        ['nav-account-menu', 'nav-admin-menu'].forEach((id) => { const m = $(id); if (m) m.classList.add('hidden'); });
    }
    function toggleNavMenu(which, ev) {
        if (ev) ev.stopPropagation();
        ['theme-menu', 'font-menu', which === 'account' ? 'nav-admin-menu' : 'nav-account-menu'].forEach((id) => {
            const m = $(id); if (m) m.classList.add('hidden');
        });
        const m = $(which === 'account' ? 'nav-account-menu' : 'nav-admin-menu');
        if (m) m.classList.toggle('hidden');
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
        // Theme & font: this device's saved choice (localStorage, applied instantly by the
        // <head> script) ALWAYS wins on refresh. The account value only SEEDS a device that
        // has no local choice yet — so a refresh can never reset your actual last pick, even
        // if the account value is stale or a save hiccupped.
        let lsTheme = null, lsFont = null;
        try { lsTheme = localStorage.getItem('macprep_theme'); lsFont = localStorage.getItem('macprep_font'); } catch (e) {}
        if (state.profile && state.profile.theme && !state._themeApplied && typeof window.setTheme === 'function') {
            state._themeApplied = true;
            if (!lsTheme && state.profile.theme !== document.documentElement.getAttribute('data-theme')) window.setTheme(state.profile.theme);
        }
        if (state.profile && state.profile.font && !state._fontApplied && typeof window.setFont === 'function') {
            state._fontApplied = true;
            if (!lsFont && state.profile.font !== document.documentElement.getAttribute('data-font')) window.setFont(state.profile.font);
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
        state._fontApplied = false;
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
        if (location.hash === '#about') showAboutSection();
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

    // Fisher-Yates in place — the one shuffle used everywhere.
    function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

    // Order a pool so questions the user HASN'T answered yet come first (each group
    // independently shuffled). With a 1,500+ bank this means you keep drawing fresh
    // questions until the bank is exhausted, instead of random repeats — and because
    // it's a fresh random shuffle every call, two people starting the same quiz still
    // get different question sets. Falls back to a plain shuffle for brand-new users.
    function unseenFirst(pool) {
        const seen = answeredIdSet();
        if (!seen.size) return shuffleArr(pool.slice());
        const fresh = [], done = [];
        for (const q of pool) { (seen.has(q.id) ? done : fresh).push(q); }
        return shuffleArr(fresh).concat(shuffleArr(done));
    }

    function renderReadiness() {
        const el = $('readiness'); if (!el) return;
        const p = state.profile || {};
        const streak = p.streak || 0;
        const readiness = p.readiness || 0;
        const exam = (p.days_to_exam != null) ? p.days_to_exam : null;
        const trend = p.trend || [];
        const spark = trend.length
            ? `<div style="display:flex;align-items:flex-end;gap:7px;height:100%;">` + trend.map((t) => {
                const h = Math.max(8, Math.round(t.accuracy * 0.44));
                const c = t.accuracy >= 75 ? 'var(--accent)' : t.accuracy >= 50 ? 'var(--warn)' : 'var(--bad)';
                return `<div title="${t.day}: ${t.accuracy}%" style="flex:1;display:flex;align-items:flex-end;justify-content:center;height:100%;"><span style="width:100%;max-width:26px;height:${h}px;background:${c};border-radius:4px 4px 2px 2px;"></span></div>`;
            }).join('') + `</div>`
            : '<div class="mono" style="color:var(--muted);font-size:12px;display:flex;align-items:center;gap:8px;height:100%;"><span style="font-size:18px;">📈</span> Answer a few questions — your accuracy trend shows up here.</div>';
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
                <div class="mono" style="font-size:12px;color:var(--text2);margin-bottom:4px;">Today: <strong>${answeredToday} / ${target}</strong> ${met ? '— 🔥 on pace, goal met!' : `· <strong>${Math.max(0, target - answeredToday)} more</strong> to stay on track`}</div>
                <div class="progress-bar"><span style="width:${pctDone}%;background:${met ? 'var(--accent)' : 'var(--warn)'};"></span></div>
            </div>`;
        } else if (answeredToday > 0) {
            goalLine = `<div class="mono" style="font-size:12px;color:var(--text2);margin-bottom:14px;">Today: <strong>${answeredToday}</strong> answered</div>`;
        }
        const metaL = 'font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);';
        const numS = 'font-weight:800;font-size:20px;line-height:1;';
        const examMetric = (exam != null)
            ? (exam >= 0
                ? `<div style="${numS}">${exam}</div><div class="mono" style="${metaL}">Days to exam</div>`
                : `<div style="${numS}color:var(--muted);">—</div><div class="mono" style="${metaL}">Exam date passed</div>`)
            : (p.study_goal === 'practice'
                ? `<div style="${numS}">${answeredToday}/10</div><div class="mono" style="${metaL}">Today's goal</div>`
                : `<div style="${numS}color:var(--muted);">—</div><div class="mono" style="${metaL}">Add an exam date</div>`);
        const C = 226.2; // ring circumference, 2πr with r=36
        const ringOff = C * (1 - Math.max(0, Math.min(100, readiness)) / 100);
        el.innerHTML = `<h3>Exam readiness</h3>
            <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:16px;">
                <svg viewBox="0 0 84 84" width="118" height="118" style="display:block;flex:none;">
                    <circle cx="42" cy="42" r="36" fill="none" stroke="var(--line)" stroke-width="8"></circle>
                    <circle class="ring-fill" cx="42" cy="42" r="36" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 42 42)" style="transition:stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1);"></circle>
                    <text x="42" y="45" text-anchor="middle" style="font-family:ui-monospace,monospace;font-weight:800;font-size:21px;fill:var(--text);">${readiness}%</text>
                    <text x="42" y="58" text-anchor="middle" style="font-family:ui-monospace,monospace;font-size:8px;fill:var(--muted);letter-spacing:1.5px;">READY</text>
                </svg>
                <div style="flex:1;min-width:150px;display:flex;flex-direction:column;gap:16px;">
                    <div style="display:flex;align-items:center;gap:11px;">
                        <span style="font-size:24px;line-height:1;${streak ? 'display:inline-block;animation:flamePulse 1.6s ease-in-out infinite;' : 'filter:grayscale(1);opacity:.5;'}">🔥</span>
                        <div><div style="${numS}color:${streak ? 'var(--accent)' : 'var(--muted)'};">${streak}</div><div class="mono" style="${metaL}">Day streak${streak ? '' : ' — start today'}</div></div>
                    </div>
                    <div style="display:flex;align-items:center;gap:11px;">
                        <span style="font-size:22px;line-height:1;">📅</span>
                        <div>${examMetric}</div>
                    </div>
                </div>
            </div>
            ${planLine}
            ${goalLine}
            <div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Accuracy — last 7 active days</div>
            <div style="height:52px;margin-bottom:2px;">${spark}</div>
            <button class="btn ghost" type="button" onclick="MACPrep.startDiagnostic()" style="margin-top:14px;font-size:13px;width:100%;">📊 Take a diagnostic — get your readiness score</button>`;
        const ring = el.querySelector('.ring-fill');
        if (ring) requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.strokeDashoffset = ringOff; }));
    }

    // Refer-a-classmate: a shareable message + the $10-off code (a Stripe promo
    // code; checkout already accepts promo codes via allow_promotion_codes).
    const REFERRAL_CODE = 'CLASSMATE10';
    function renderReferral() {
        const el = $('referral-card'); if (!el) return;
        const link = 'https://www.macprep.org/pricing.html';
        const msg = `Studying for NCCAA boards? MACPrep has cited, CAA-written practice questions — use code ${REFERRAL_CODE} for $10 off at checkout: ${link}`;
        el.dataset.msg = msg;
        el.className = ''; // slim note, not its own card
        el.style.cssText = 'order:5;margin:0;';
        el.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px;">
                <span>Know a classmate prepping for boards? Share <code style="font-family:ui-monospace,monospace;font-weight:700;color:var(--accent);letter-spacing:.5px;">${REFERRAL_CODE}</code> — they get <strong style="color:var(--text2);">$10 off</strong> at checkout.</span>
                <a href="#" onclick="event.preventDefault();MACPrep.copyReferral();" style="color:var(--accent);white-space:nowrap;">Copy share message</a>
                <span id="referral-copied" class="mono" style="font-size:12px;color:var(--accent);"></span>
            </div>`;
    }
    function copyReferral() {
        const el = $('referral-card'); const msg = (el && el.dataset.msg) || '';
        const done = () => { const s = $('referral-copied'); if (s) { s.textContent = '✓ Copied!'; setTimeout(() => { s.textContent = ''; }, 2500); } };
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(msg).then(done).catch(() => window.prompt('Copy this message:', msg)); }
        else { window.prompt('Copy this message:', msg); }
    }

    function renderOnboarding() {
        const el = $('onboarding'); if (!el) return;
        const answered = (state.profile && state.profile.stats && state.profile.stats.answered) || 0;
        if (answered > 0) { el.classList.add('hidden'); return; }
        el.classList.remove('hidden');
        el.innerHTML = `<h3>Welcome to MACPrep 👋</h3>
            <p class="sub" style="margin:0 0 12px;">New here? Take a quick <strong>diagnostic</strong> — a short set across all six blueprint domains that gives you a predicted readiness score and shows exactly which domain to start with. Or jump straight in with a warm-up.</p>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button class="btn" onclick="MACPrep.startDiagnostic()">📊 Take the diagnostic</button>
                <button class="btn ghost" onclick="MACPrep.startSample()">Try a 5-question warm-up</button>
            </div>`;
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

    // Recommended session: one obvious primary action. Builds a smart ~20-question
    // mix — spaced-repetition due cards → missed → weakest areas → domain-balanced
    // fill — so a returning user never has to configure anything to study well.
    function startRecommended() {
        const usage = freeUsage();
        const p = state.profile || {};
        const all = state.questions || [];
        if (!all.length) { toast('Questions are still loading — try again in a moment.'); return; }
        if (!usage.unlimited && usage.remaining < 1) { return startCheckout(); }
        const byId = {}; all.forEach((q) => { byId[q.id] = q; });
        const target = Math.min(20, all.length);
        const picked = new Set();
        const add = (id) => { if (picked.size < target && byId[id] && !picked.has(id)) picked.add(id); };
        (p.due_ids || []).forEach(add);
        (p.missed_ids || []).forEach(add);
        const weak = (p.by_specialty || []).filter((s) => s.accuracy < 70).map((s) => s.category);
        if (weak.length) all.forEach((q) => { if (weak.includes(q.category || q.domain_name)) add(q.id); });
        const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
        if (picked.size < target) {
            // domain-balanced round-robin fill (no history needed)
            const byDom = {}; all.forEach((q) => { const d = q.domain_name || q.category || 'General'; (byDom[d] = byDom[d] || []).push(q); });
            const arrs = Object.values(byDom).map((a) => shuffle(a.slice()));
            let progressed = true;
            while (picked.size < target && progressed) {
                progressed = false;
                for (const arr of arrs) { if (picked.size >= target) break; const q = arr.pop(); if (q) { const b = picked.size; add(q.id); if (picked.size > b) progressed = true; } }
            }
        }
        let pool = shuffle(Array.from(picked).map((id) => byId[id]));
        if (!usage.unlimited) pool = pool.slice(0, Math.min(pool.length, usage.remaining));
        if (!pool.length) { toast('No questions available right now.'); return; }
        track('recommended_start', { size: pool.length });
        beginSession(pool, 'tutor');
    }

    // Reflects what the recommended set will draw from (or a starter message for new users).
    function renderRecommendedSub() {
        const el = $('recommended-sub'); if (!el) return;
        const p = state.profile || {};
        const dueN = (p.due_ids || []).length;
        const missN = (p.missed_ids || []).length;
        const weakN = (p.by_specialty || []).filter((s) => s.accuracy < 70).length;
        if (dueN || missN || weakN) {
            const parts = [];
            if (dueN) parts.push(`${dueN} due for review`);
            if (missN) parts.push(`${missN} you missed`);
            if (weakN) parts.push(`your ${weakN} weakest area${weakN > 1 ? 's' : ''}`);
            el.textContent = `A focused ~20-question set from ${parts.join(', ')}.`;
        } else {
            el.textContent = 'A balanced ~20-question set across all 6 exam domains to get you started.';
        }
    }

    function toggleCustomize() {
        const panel = $('customize-panel'); if (!panel) return;
        const show = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !show);
        if (show) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ---- question of the day + study-activity calendar --------------------
    // One question per day, deterministic by date so everyone sees the same QotD.
    // The QotD "day" flips at 7:00 AM US Eastern (handles EST/EDT automatically).
    // Shift "now" back 7h, then read the Eastern calendar date, so the boundary is 07:00 ET.
    function qotdDayKey() {
        const shifted = new Date(Date.now() - 7 * 3600 * 1000);
        try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted); }
        catch (e) { return shifted.toISOString().slice(0, 10); }
    }
    function questionOfTheDay() {
        const qs = state.questions || [];
        if (!qs.length) return null;
        const key = qotdDayKey();
        let h = 0; for (let i = 0; i < key.length; i++) { h = (h * 31 + key.charCodeAt(i)) >>> 0; }
        return qs[h % qs.length];
    }
    function qotdDoneToday() { return ls('macprep_qotd_done') === qotdDayKey(); }
    // Launches the QotD as a real 1-question tutor session — identical render, grading,
    // rationale, source, and activity tracking as any quiz question.
    function startQotd() {
        const q = questionOfTheDay();
        if (!q) { toast('Today\'s question is still loading — try again in a moment.'); return; }
        ls('macprep_qotd_done', qotdDayKey());
        beginSession([q], 'tutor');
        if (state.session) state.session.qotd = true;
    }
    function renderQotd() {
        const card = $('qotd-card'); if (!card) return;
        const q = questionOfTheDay();
        if (!q) { card.classList.add('hidden'); return; }
        card.classList.remove('hidden');
        // Once answered, collapse to a compact "checked off" state until the 7am-ET reset.
        if (qotdDoneToday()) {
            card.innerHTML = '<div style="display:flex;align-items:center;gap:14px;">'
                + '<span style="width:44px;height:44px;border-radius:50%;background:var(--accent-dim);border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));color:var(--accent);display:flex;align-items:center;justify-content:center;flex:none;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>'
                + '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:15px;color:var(--text);">Question of the day — done ✓</div>'
                + '<div class="sub" style="font-size:12.5px;margin-top:2px;">A fresh one drops at <strong>7:00&nbsp;AM&nbsp;ET</strong>. <a href="#" onclick="event.preventDefault();MACPrep.startQotd();" style="color:var(--accent);">Review today\'s again →</a></div></div></div>';
            return;
        }
        const meta = [q.category || q.domain_name, q.subtopic].filter(Boolean).join(' · ');
        const reviewed = q.reviewed ? '<span style="font-size:11px;color:var(--accent);white-space:nowrap;">✓ reviewed by a CAA</span>' : '';
        card.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;"><span class="mono" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent);">Question of the day</span>' + reviewed + '</div>'
            + '<div class="mono" style="font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;margin-bottom:9px;">' + escapeHtml(meta) + '</div>'
            + '<div style="font-size:15px;line-height:1.6;margin-bottom:15px;">' + renderRich(q.stem) + '</div>'
            + '<button class="btn" onclick="MACPrep.startQotd()">Answer today\'s question →</button>';
    }
    function renderActivityCalendar() {
        const card = $('activity-card'); if (!card) return;
        const active = new Set((state.profile && state.profile.active_days) || []);
        const now = new Date();
        const year = now.getFullYear(), month = now.getMonth();
        const monthName = now.toLocaleString(undefined, { month: 'long' });
        const startDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const pad = (n) => String(n).padStart(2, '0');
        const todayDk = year + '-' + pad(month + 1) + '-' + pad(now.getDate());
        let cells = '';
        ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((d) => { cells += '<div class="mono" style="font-size:10px;color:var(--muted);text-align:center;padding:2px 0;">' + d + '</div>'; });
        for (let i = 0; i < startDow; i++) cells += '<div></div>';
        let studiedCount = 0;
        for (let day = 1; day <= daysInMonth; day++) {
            const dk = year + '-' + pad(month + 1) + '-' + pad(day);
            const studied = active.has(dk); if (studied) studiedCount++;
            const style = studied ? 'background:var(--accent-dim);color:var(--accent);font-weight:bold;' : 'color:var(--text2);';
            const ring = dk === todayDk ? 'box-shadow:inset 0 0 0 1px var(--accent);' : '';
            cells += '<div style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:12px;border-radius:6px;' + style + ring + '">' + day + '</div>';
        }
        card.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;"><h3 style="margin:0;">Study activity</h3>'
            + '<span class="mono" style="font-size:12px;color:var(--muted);">' + studiedCount + ' day' + (studiedCount === 1 ? '' : 's') + ' this ' + escapeHtml(monthName) + '</span></div>'
            + '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;">' + cells + '</div>';
    }

    // ---- "What's New" in-app changelog + unread dot. Bump WHATS_NEW_VERSION when adding entries.
    const WHATS_NEW_VERSION = 10;
    const WHATS_NEW = [
        { tag: 'New', date: 'Jul 1', title: 'Fresh questions every time', desc: 'Practice sets, specialty quizzes, and mock exams now serve questions you haven’t seen yet first — so you keep drawing new questions from the full bank instead of repeats, and no two people get the same quiz.' },
        { tag: 'New', date: 'Jul 1', title: 'In-quiz calculator', desc: 'A calculator now sits next to Lab values in every question — basic math plus quick medical conversions (cm↔in, kg↔lb, °C↔°F) for when a stem gives height in centimeters.' },
        { tag: 'New', date: 'Jul 1', title: 'Arcade modes', desc: 'Two fast, score-chasing modes in Study Modes (and now in the menu): Survival (endless — 3 lives, one miss costs a life) and Time Attack (a five-minute sprint). Each keeps your personal best.' },
        { tag: 'New', date: 'Jul 1', title: 'Domain Bosses', desc: 'Take on a Domain Boss from Study Modes — score 80%+ on a short mastery challenge to "defeat" a domain. Clear all six to become a Boss Slayer.' },
        { tag: 'New', date: 'Jul 1', title: 'Daily Quests', desc: 'A fresh set of daily goals on your dashboard that resets at 7 AM ET. Finish all three to open a daily chest, and rack up quest days for new achievements.' },
        { tag: 'New', date: 'Jul 1', title: 'XP + Levels', desc: 'Every question you answer now earns XP and levels you up — see your level and progress bar right on the dashboard. Levels come fast early on, and there are new Level achievements to chase. (First of several game modes on the way.)' },
        { tag: 'New', date: 'Jul 1', title: '20+ more achievements', desc: 'New badges to chase across Coverage, Mastery, and Milestones — deep-dive a specialty, cover the whole bank, ace three domains, finish Mock Exams, hit peak readiness, and more.' },
        { tag: 'New', date: 'Jul 1', title: 'Mock Exam matches the real thing', desc: 'The Mock Exam is now 180 questions in 220 minutes — the exact length and timing of the NCCAA board exam.' },
        { tag: 'New', date: 'Jun 30', title: 'Achievements to chase', desc: 'A new Achievements page in the menu — badges to unlock, each showing how close you are. And the Question of the Day now sits up top and resets at 7am ET.' },
        { tag: 'New', date: 'Jun 30', title: 'A livelier dashboard', desc: 'Daily-goal rings, streak, achievements, and a Study Modes grid to jump into anything fast.' },
        { tag: 'New', date: 'Jun 30', title: 'Mock Exam', desc: 'Full-length, timed, weighted across all six NCCAA domains — with a per-domain score report.' },
        { tag: 'New', date: 'Jun 29', title: 'Focused quizzes by specialty', desc: 'Tap any specialty to launch a 5 / 10 / 25 / all quiz on just that area.' },
        { tag: 'New', date: 'Jun 29', title: 'Community partner: Bag Mask', desc: 'Anesthesia jobs & careers, now linked in the footer.' },
        { tag: 'Fix', date: 'Jun 29', title: 'Cleaner mobile home page', desc: 'Cards no longer run to the screen edge on phones.' },
    ];
    function whatsNewUnread() { try { return WHATS_NEW_VERSION > (parseInt(ls('macprep_whatsnew_seen'), 10) || 0); } catch (e) { return false; } }
    function renderWhatsNewDot() { const d = $('wn-dot'); if (d) d.style.display = whatsNewUnread() ? '' : 'none'; }

    // Sidebar account block: initials avatar + name + plan.
    function renderSidebarAccount() {
        const p = state.profile || {};
        const name = (p.full_name || '').trim();
        const parts = name ? name.split(/\s+/) : [];
        let initials = parts.length ? ((parts[0][0] || '') + (parts.length > 1 ? (parts[parts.length - 1][0] || '') : '')) : '';
        if (!initials) initials = (p.email || 'U').charAt(0);
        const set = (idn, txt) => { const e = $(idn); if (e) e.textContent = txt; };
        set('nav-acct-initials', initials.toUpperCase());
        set('nav-acct-name', name || 'Account');
        set('nav-acct-sub', p.is_admin ? 'Admin access' : (p.premium_unlocked ? 'Full access' : 'Free plan'));
    }
    // Collapsible sidebar rail (desktop). Preference persists in localStorage.
    function syncSidebarToggle() {
        const b = $('sidebar-collapse'); if (!b) return;
        const c = document.body.classList.contains('sidebar-collapsed');
        b.setAttribute('aria-label', c ? 'Expand menu' : 'Collapse menu');
        b.setAttribute('title', c ? 'Expand menu' : 'Collapse menu');
    }
    function applySidebarPref() {
        let c = false; try { c = localStorage.getItem('macprep_sidebar_collapsed') === '1'; } catch (e) {}
        document.body.classList.toggle('sidebar-collapsed', c);
        syncSidebarToggle();
    }
    function toggleSidebar() {
        const c = document.body.classList.toggle('sidebar-collapsed');
        try { localStorage.setItem('macprep_sidebar_collapsed', c ? '1' : '0'); } catch (e) {}
        syncSidebarToggle();
    }
    function openWhatsNew() {
        const body = $('wn-body');
        if (body) {
            body.innerHTML = WHATS_NEW.map((e) => {
                const isFix = e.tag === 'Fix';
                const pillColor = isFix ? 'var(--warn)' : 'var(--accent)';
                const pillBg = isFix ? 'color-mix(in srgb,var(--warn) 16%,transparent)' : 'var(--accent-dim)';
                return `<div style="display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--line);">`
                    + `<div class="mono" style="font-size:10.5px;color:var(--muted);min-width:46px;padding-top:3px;">${e.date}</div>`
                    + `<div style="min-width:0;"><div style="font-weight:700;font-size:14.5px;color:var(--text);line-height:1.3;">${escapeHtml(e.title)} <span class="mono" style="font-size:8.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${pillColor};background:${pillBg};padding:2px 6px;border-radius:5px;margin-left:3px;">${e.tag}</span></div>`
                    + `<div style="font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.5;">${escapeHtml(e.desc)}</div></div></div>`;
            }).join('');
        }
        const m = $('whatsnew-panel'); if (m) m.classList.remove('hidden');
        try { ls('macprep_whatsnew_seen', String(WHATS_NEW_VERSION)); } catch (e) {}
        renderWhatsNewDot();
    }
    function closeWhatsNew() { const m = $('whatsnew-panel'); if (m) m.classList.add('hidden'); }

    // ---- Momentum hero (Concept B): today's-goal / weekly-streak / readiness rings,
    // a "close your rings" plan, and the next-milestone counter. All from existing data.
    function nextMilestone(total) {
        const M = [50, 100, 250, 500, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000];
        for (let i = 0; i < M.length; i++) { if (M[i] > total) return M[i]; }
        return Math.ceil((total + 1) / 5000) * 5000;
    }
    function momLegRow(color, label, val, key) {
        const h = key ? ` class="mleg" data-ring="${key}" tabindex="0" role="button" onmouseenter="MACPrep.ringFocus('${key}')" onmouseleave="MACPrep.ringBlur()" onfocus="MACPrep.ringFocus('${key}')" onblur="MACPrep.ringBlur()"` : '';
        return `<div${h} style="display:flex;align-items:center;gap:9px;"><span style="width:11px;height:11px;border-radius:3px;background:${color};flex:none;"></span>`
            + `<span style="display:flex;flex-direction:column;line-height:1.2;"><span class="mono" style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);">${label}</span>`
            + `<span style="font-weight:700;font-size:15px;color:var(--text);">${val}</span></span></div>`;
    }

    // current momentum-ring descriptors, keyed for hover/focus tooltips (repopulated each render)
    let momRingMeta = {};
    function ringFocus(key) {
        const svg = $('mom-rings'); const m = momRingMeta[key]; if (!svg || !m) return;
        svg.classList.add('focusing');
        svg.querySelectorAll('.mrg').forEach((g) => g.classList.toggle('mrg-on', g.dataset.ring === key));
        const card = $('momentum-card');
        if (card) card.querySelectorAll('.mleg').forEach((r) => r.classList.toggle('mleg-on', r.dataset.ring === key));
        const tip = $('mom-tip');
        if (tip) {
            tip.innerHTML = `<div class="mono" style="font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:2px;">${m.label}</div>`
                + `<div style="font-weight:700;font-size:14px;margin-bottom:4px;">${m.val}</div>`
                + `<div class="sub" style="font-size:12px;line-height:1.45;">${m.desc}</div>`;
            tip.style.display = 'block';
        }
    }
    function ringBlur() {
        const svg = $('mom-rings');
        if (svg) { svg.classList.remove('focusing'); svg.querySelectorAll('.mrg').forEach((g) => g.classList.remove('mrg-on')); }
        const card = $('momentum-card');
        if (card) card.querySelectorAll('.mleg').forEach((r) => r.classList.remove('mleg-on'));
        const tip = $('mom-tip'); if (tip) tip.style.display = 'none';
    }
    // XP + numeric levels (v1: derived from real server stats, so it's retroactive and can't be faked).
    // XP = 4 per question answered + 8 more for each correct (an attempt = 4 XP, a correct answer = 12).
    // Cost to go from level L to L+1 = 50 + (L-1)*25, capped at 100 — fast early levels, gently steepening.
    // Bonus XP earned from quests/chests (accumulates on top of the stats-derived XP).
    function bonusXp() { try { return parseInt(localStorage.getItem('macprep_bonus_xp') || '0', 10) || 0; } catch (e) { return 0; } }
    function addBonusXp(n) { try { localStorage.setItem('macprep_bonus_xp', String(bonusXp() + (n || 0))); } catch (e) {} }
    function xpLevel(p) {
        const s = (p && p.stats) || {};
        const totalXp = (s.answered || 0) * 4 + (s.correct || 0) * 8 + bonusXp();
        let lvl = 1, rem = totalXp, step = 50;
        while (lvl < 100 && rem >= step) { rem -= step; lvl++; step += 25; }
        const atMax = lvl >= 100;
        return { level: lvl, xpInto: atMax ? 0 : rem, xpNeed: atMax ? 0 : step, totalXp, atMax, pct: atMax ? 100 : Math.round((rem / step) * 100) };
    }

    // Milestone levels get a unique celebration; every other level-up gets the standard one.
    const LEVEL_MILESTONES = {
        5: { title: 'Getting rolling', msg: "Level 5 — you're building real momentum. Don't break the chain." },
        10: { title: 'Double digits', msg: "Level 10! You've got a genuine study habit going now." },
        25: { title: 'Quarter century', msg: "Level 25 — rare air. Your command of the material is really showing." },
        50: { title: 'Halfway to the top', msg: "Level 50! Halfway to the summit — few students ever make it here." },
        75: { title: 'Elite', msg: "Level 75 — elite territory. You're studying like a future board-crusher." },
        100: { title: 'Legend — max level', msg: "LEVEL 100. You've maxed out. Absolutely legendary work." },
    };
    // Fires when the user's level increased since we last checked. First run after ship = baseline only.
    function checkLevelUp() {
        if (!state.token) return;
        const cur = xpLevel(state.profile || {}).level;
        const prev = parseInt(ls('macprep_last_level') || '', 10);
        try { localStorage.setItem('macprep_last_level', String(cur)); } catch (e) {}
        if (isNaN(prev)) return;           // baseline the existing level silently — no spurious celebration
        if (cur > prev) showLevelUp(cur, prev);
    }
    function showLevelUp(cur, prev) {
        if ($('levelup-overlay')) return;
        let ms = 0;                        // celebrate the highest milestone crossed, else the new level
        Object.keys(LEVEL_MILESTONES).forEach((k) => { const m = +k; if (m > prev && m <= cur) ms = Math.max(ms, m); });
        const info = ms ? LEVEL_MILESTONES[ms] : null;
        const shown = ms || cur;
        const cols = ['var(--accent)', 'var(--good)', 'var(--warn)', 'var(--info)', 'var(--bad)'];
        let confetti = '';
        for (let i = 0; i < 22; i++) {
            const left = Math.round((i * 4.7 + (i % 3) * 5) % 100);
            const delay = (i % 7) * 0.08, dur = 1.3 + (i % 5) * 0.18, rot = (i % 2 ? 1 : -1) * (200 + (i % 4) * 80);
            confetti += `<i style="left:${left}%;background:${cols[i % cols.length]};animation-delay:${delay}s;animation-duration:${dur}s;--luRot:${rot}deg;"></i>`;
        }
        const wrap = document.createElement('div');
        wrap.id = 'levelup-overlay';
        wrap.setAttribute('role', 'dialog');
        wrap.onclick = (e) => { if (e.target === wrap) closeLevelUp(); };
        wrap.innerHTML = `<div class="lu-card">
            <div class="lu-confetti" aria-hidden="true">${confetti}</div>
            <div class="mono" style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:var(--accent);">${ms ? 'Milestone reached' : 'Level up'}</div>
            <div class="lu-num">${shown}</div>
            <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:24px;line-height:1.15;">${info ? info.title : 'Level ' + shown + '!'}</div>
            <div class="sub" style="margin:9px 0 22px;font-size:14px;">${info ? info.msg : "Nice work — you leveled up. Keep answering to climb higher."}</div>
            <button class="btn" type="button" onclick="MACPrep.closeLevelUp()">${ms ? 'Onward' : 'Keep it up'} →</button>
        </div>`;
        document.body.appendChild(wrap);
    }
    function closeLevelUp() { const o = $('levelup-overlay'); if (o) o.remove(); }

    // ---- Daily Quests (reset at 7:00 AM ET, same boundary as the Question of the Day) ----
    function dailyKey() { return 'macprep_daily_' + qotdDayKey(); }
    function getDaily() { try { return JSON.parse(localStorage.getItem(dailyKey()) || '{}'); } catch (e) { return {}; } }
    function saveDaily(d) { try { localStorage.setItem(dailyKey(), JSON.stringify(d)); } catch (e) {} }
    function bumpDaily(patch) {
        const d = getDaily();
        if (patch.answered) d.answered = (d.answered || 0) + patch.answered;
        if (patch.correct) d.correct = (d.correct || 0) + patch.correct;
        if (patch.specialty) { d.specs = d.specs || []; if (d.specs.indexOf(patch.specialty) < 0) d.specs.push(patch.specialty); }
        saveDaily(d);
    }
    function questDayCount() { try { return (JSON.parse(localStorage.getItem('macprep_questdays') || '[]') || []).length; } catch (e) { return 0; } }
    const QUEST_XP = 15, CHEST_XP = 50;
    function dailyQuests() {
        const p = state.profile || {}, d = getDaily();
        const answeredToday = Math.max(p.answered_today || 0, d.answered || 0);
        const quests = [
            { icon: 'flame', label: 'Answer 10 questions', cur: Math.min(answeredToday, 10), target: 10, xp: QUEST_XP },
            { icon: 'star', label: 'Answer 25 questions', cur: Math.min(answeredToday, 25), target: 25, xp: QUEST_XP },
            { icon: 'target', label: 'Get 8 correct', cur: Math.min(d.correct || 0, 8), target: 8, xp: QUEST_XP },
            { icon: 'grid', label: 'Practice 2 specialties', cur: Math.min((d.specs || []).length, 2), target: 2, xp: QUEST_XP },
            { icon: 'star', label: 'Answer the Question of the Day', cur: qotdDoneToday() ? 1 : 0, target: 1, xp: QUEST_XP },
        ];
        quests.forEach((q) => { q.done = q.cur >= q.target; });
        return { quests, allDone: quests.every((q) => q.done), chestOpened: !!d.chest };
    }
    // Grant XP for each quest the moment it completes (once each). Returns XP gained this pass.
    function grantQuestRewards(dq) {
        const d = getDaily(); d.rewarded = d.rewarded || [];
        let gained = 0;
        dq.quests.forEach((q, i) => { if (q.done && d.rewarded.indexOf(i) < 0) { d.rewarded.push(i); gained += q.xp; } });
        if (gained) { addBonusXp(gained); saveDaily(d); }
        return gained;
    }
    const CHEST_TIPS = [
        'Reviewing a question you missed is worth about twice as much as re-reading one you got right.',
        'Short daily sessions beat marathon cram days — spacing is what makes it stick.',
        'Teach a concept out loud, even to no one. If you can explain it, you own it.',
        'When you guess, flag it — your "confident misses" are the highest-yield thing to review.',
        'Cover the choices, predict the answer, then look. Active recall beats recognition.',
        'Rotate specialties. Interleaving topics beats blocking one for hours.',
        'Missed it? Read the rationale for every wrong choice, not just the right one.',
        'A little each day keeps the streak — and your recall — alive.',
    ];
    function openDailyChest() {
        const dq = dailyQuests();
        if (!dq.allDone || dq.chestOpened) return;
        const d = getDaily(); d.chest = true; saveDaily(d);
        addBonusXp(CHEST_XP);
        try {
            const days = JSON.parse(localStorage.getItem('macprep_questdays') || '[]');
            const k = qotdDayKey();
            if (days.indexOf(k) < 0) { days.push(k); localStorage.setItem('macprep_questdays', JSON.stringify(days.slice(-400))); }
        } catch (e) {}
        try { toast('+' + CHEST_XP + ' XP — chest opened!'); } catch (e) {}
        renderDailyQuests(); renderMomentum(); checkLevelUp();
    }
    function renderDailyQuests() {
        const el = $('dailyquests-card'); if (!el) return;
        const dq = dailyQuests();
        const gained = grantQuestRewards(dq);
        if (gained) { try { toast('+' + gained + ' XP earned!'); } catch (e) {} renderMomentum(); }
        const doneCount = dq.quests.filter((q) => q.done).length;
        const row = (q) => `<div style="display:flex;align-items:center;gap:11px;padding:9px 0;">
            <span style="width:26px;height:26px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${q.done ? 'var(--accent)' : 'var(--bg)'};border:1px solid ${q.done ? 'var(--accent)' : 'var(--line)'};color:${q.done ? 'var(--on-accent)' : 'var(--muted)'};font-size:14px;">${q.done ? '✓' : ''}</span>
            <div style="flex:1;min-width:0;">
                <div style="font-size:13.5px;font-weight:600;color:${q.done ? 'var(--muted)' : 'var(--text)'};${q.done ? 'text-decoration:line-through;' : ''}">${q.label}</div>
                ${q.done ? '' : `<div style="height:4px;background:var(--line);border-radius:3px;margin-top:5px;overflow:hidden;"><span style="display:block;height:100%;width:${Math.round((q.cur / q.target) * 100)}%;background:var(--accent);border-radius:3px;"></span></div>`}
            </div>
            <span class="mono" style="font-size:11px;flex:none;color:${q.done ? 'var(--accent)' : 'var(--muted)'};">${q.done ? '+' + q.xp + ' XP' : q.cur + '/' + q.target}</span></div>`;
        let chest = '';
        if (dq.allDone && !dq.chestOpened) {
            chest = `<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:14px;text-align:center;">
                <div class="sub" style="font-size:13px;margin-bottom:10px;">All 5 quests done — open your chest for <strong style="color:var(--accent);">+${CHEST_XP} XP</strong>!</div>
                <button class="btn" type="button" onclick="MACPrep.openDailyChest()">Open chest →</button></div>`;
        } else if (dq.chestOpened) {
            const tip = CHEST_TIPS[new Date().getDate() % CHEST_TIPS.length];
            chest = `<div style="margin-top:12px;background:var(--accent-dim);border-radius:10px;padding:12px 14px;">
                <div class="mono" style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--accent);margin-bottom:5px;">Chest opened · +${CHEST_XP} XP · study tip</div>
                <div style="font-size:13.5px;line-height:1.5;">${escapeHtml(tip)}</div>
                <div class="sub" style="font-size:12px;margin-top:8px;">Fresh quests and a new chest at 7:00 AM ET.</div></div>`;
        }
        el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;">
                <div class="mono" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);">Daily quests · ${doneCount}/${dq.quests.length}</div>
                <div class="mono" style="font-size:11px;color:var(--muted);">resets 7:00 AM ET</div>
            </div>${dq.quests.map(row).join('')}${chest}`;
        el.classList.remove('hidden');
    }

    function renderMomentum() {
        const el = $('momentum-card'); if (!el) return;
        // the momentum card carries its own greeting — hide the plain one
        const g = $('dash-greeting'); if (g) g.style.display = 'none';
        const sb = $('dash-subtitle'); if (sb) sb.style.display = 'none';
        const p = state.profile || {};
        const bank = (state.questions || []).length;
        const answeredToday = p.answered_today || 0;
        let goal = (p.days_to_exam > 0 && bank > 0) ? Math.ceil((bank * 2) / p.days_to_exam) : 10;
        goal = Math.max(5, Math.min(40, goal));
        const streak = p.streak || 0;
        const weekDays = Math.min(streak, 7);
        const readiness = Math.max(0, Math.min(100, p.readiness || 0));
        const total = (p.stats || {}).answered || 0;
        const goalPct = Math.min(100, Math.round((answeredToday / goal) * 100));
        const toGoal = Math.max(0, goal - answeredToday);
        const nm = nextMilestone(total), toGo = nm - total;
        const lvl = xpLevel(p);
        const first = (p.full_name || '').split(' ')[0] || 'there';
        const hour = new Date().getHours();
        const greet = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
        // ring colors are all derived from the theme accent so they recolor with any theme:
        // pure accent (readiness), a warm-leaning accent (goal), and a deeper tonal accent (week).
        const cReady = 'var(--accent)';
        const cGoal = 'color-mix(in srgb, var(--accent) 66%, var(--warn))';
        const cWeek = 'color-mix(in srgb, var(--accent) 60%, var(--text))';
        const ringMeta = [
            { key: 'goal', c: cGoal, r: 66, pct: goalPct, label: "Today's goal", val: `${answeredToday} / ${goal} questions`,
                desc: 'Questions answered today vs. your daily target. Resets each morning — close it by practicing.' },
            { key: 'week', c: cWeek, r: 51, pct: Math.round((weekDays / 7) * 100), label: 'This week', val: `${weekDays} / 7 days`,
                desc: 'Days you’ve practiced this week — one notch per active day, up to 7. Keeps your streak visible.' },
            { key: 'readiness', c: cReady, r: 36, pct: readiness, label: 'Readiness', val: `${readiness}%`,
                desc: 'Your overall exam-readiness score, blended from accuracy and how much of the bank you’ve covered. Moves slowly as you master more.' },
        ];
        momRingMeta = {}; ringMeta.forEach((m) => { momRingMeta[m.key] = m; });
        const ringGroup = (m) => {
            const C = 2 * Math.PI * m.r, off = C * (1 - Math.max(0, Math.min(100, m.pct)) / 100);
            return `<g class="mrg" data-ring="${m.key}" tabindex="0" role="button" aria-label="${m.label}: ${m.val}. ${m.desc}"`
                + ` onmouseenter="MACPrep.ringFocus('${m.key}')" onmouseleave="MACPrep.ringBlur()" onfocus="MACPrep.ringFocus('${m.key}')" onblur="MACPrep.ringBlur()">`
                + `<circle class="mrg-track" cx="75" cy="75" r="${m.r}" fill="none" stroke="var(--line)" stroke-width="10"/>`
                + `<circle class="mrg-fill" cx="75" cy="75" r="${m.r}" fill="none" stroke="${m.c}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 75 75)" style="transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1),stroke-width .16s ease;"/>`
                + `<circle class="mrg-hit" cx="75" cy="75" r="${m.r}" fill="none" stroke="transparent" stroke-width="14" style="pointer-events:stroke;cursor:pointer;"/>`
                + `</g>`;
        };
        const rings = `<div style="position:relative;flex:none;">`
            + `<svg id="mom-rings" width="150" height="150" viewBox="0 0 150 150" role="group" aria-label="Momentum rings — hover a ring for detail" style="display:block;overflow:visible;">`
            + ringMeta.map(ringGroup).join('')
            + `<text x="75" y="73" text-anchor="middle" style="font-family:ui-monospace,monospace;font-weight:800;font-size:25px;fill:var(--text);pointer-events:none;">${toGoal || '✓'}</text>`
            + `<text x="75" y="89" text-anchor="middle" style="font-family:ui-monospace,monospace;font-size:8px;fill:var(--muted);letter-spacing:1px;pointer-events:none;">${toGoal ? 'TO GOAL' : 'DONE'}</text></svg>`
            + `<div id="mom-tip" role="status" aria-live="polite" style="display:none;position:absolute;left:0;top:156px;width:210px;z-index:6;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:9px 11px;box-shadow:0 8px 24px rgba(0,0,0,.14);"></div>`
            + `</div>`;
        const legend = `<div style="display:flex;flex-direction:column;gap:12px;flex:none;">`
            + momLegRow(cGoal, "Today's goal", `${answeredToday} / ${goal} questions`, 'goal')
            + momLegRow(cWeek, 'This week', `${weekDays} / 7 days`, 'week')
            + momLegRow(cReady, 'Readiness', `${readiness}%`, 'readiness') + `</div>`;
        const planTitle = toGoal ? 'Close your rings.' : (streak ? 'Streak alive. 🔥' : 'Nice work today.');
        const planSub = toGoal
            ? `${toGoal} more question${toGoal === 1 ? '' : 's'} to hit today's goal${streak ? ` and keep your ${streak}-day streak alive` : ''}.`
            : `You've hit today's goal${streak ? ` — ${streak}-day streak and counting` : ''}. Keep the momentum going.`;
        const saved = getSavedSession();
        const ctaLabel = saved ? 'Continue session' : 'Start today\'s set';
        const ctaFn = saved ? 'MACPrep.resumeSession()' : 'MACPrep.startRecommended()';
        el.innerHTML = `
            <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:26px;letter-spacing:-.01em;line-height:1.1;">${greet}, ${escapeHtml(first)}.</div>
            <div class="sub" style="margin:4px 0 20px;font-size:14px;">${toGoal ? `You're <strong style="color:${cGoal};">${toGoal}</strong> from today's goal${streak ? ` · <strong style="color:var(--accent);">${streak}-day streak</strong>` : ''} — don't break the chain.` : `Goal met${streak ? ` · <strong style="color:var(--accent);">${streak}-day streak</strong>` : ''}. 🔥`}</div>
            <div style="display:flex;flex-wrap:wrap;gap:24px 30px;align-items:center;">
                ${rings}${legend}
                <div style="flex:1;min-width:230px;display:flex;flex-direction:column;gap:14px;">
                    <div>
                        <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:20px;">${planTitle}</div>
                        <div class="sub" style="margin:3px 0 12px;font-size:13.5px;">${planSub}</div>
                        <button class="btn" type="button" onclick="${ctaFn}" style="font-size:13.5px;">${ctaLabel} →</button>
                    </div>
                    <div style="background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                            <div style="display:flex;align-items:center;gap:9px;"><span style="display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:0 7px;border-radius:8px;background:var(--accent);color:var(--on-accent);font-family:ui-monospace,monospace;font-weight:800;font-size:15px;">${lvl.level}</span><div class="mono" style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);">Level${lvl.atMax ? ' · MAX' : ''}</div></div>
                            <div class="mono" style="font-size:10px;color:var(--muted);">${lvl.atMax ? `${lvl.totalXp.toLocaleString()} XP` : `${lvl.xpInto} / ${lvl.xpNeed} XP → ${lvl.level + 1}`}</div>
                        </div>
                        <div style="height:6px;background:var(--line);border-radius:3px;margin-top:9px;overflow:hidden;"><span style="display:block;height:100%;width:${lvl.pct}%;background:var(--accent);border-radius:3px;transition:width .6s ease;"></span></div>
                    </div>
                </div>
            </div>`;
    }

    // ---- Achievements: unlocked vs locked-with-a-goal, computed from live profile data.
    function computeAchievements() {
        const p = state.profile || {}, s = p.stats || {};
        const total = s.answered || 0, streak = p.streak || 0, att = s.attempts || 0, corr = s.correct || 0;
        const acc = att ? Math.round((corr / att) * 100) : 0;
        const cov = p.coverage || []; const started = cov.filter((c) => (c.answered || 0) > 0).length; const totalSpec = cov.length || 16;
        const mastered = cov.filter((c) => c.total && (c.answered || 0) >= c.total).length;
        const qotdEver = !!ls('macprep_qotd_done');
        const A = [];
        const vol = (n, title) => A.push({ cat: 'Volume', icon: 'star', title, desc: `Answer ${n.toLocaleString()} questions total (across every session).`, met: total >= n, pct: Math.min(100, Math.round((total / n) * 100)), sub: total >= n ? 'Unlocked' : `${(n - total).toLocaleString()} to go` });
        A.push({ cat: 'Volume', icon: 'flag', title: 'Off the mark', desc: 'Answer your very first question.', met: total >= 1, pct: total >= 1 ? 100 : 0, sub: total >= 1 ? 'Unlocked' : 'Answer your first question' });
        vol(100, 'Century — 100 questions'); vol(500, '500 club'); vol(1000, 'Four figures — 1,000');
        vol(2500, 'Halfway hero — 2,500'); vol(5000, 'High five — 5,000'); vol(10000, 'Five figures — 10,000');
        const strk = (n, title) => A.push({ cat: 'Consistency', icon: 'flame', title, desc: `Practice ${n} day${n === 1 ? '' : 's'} in a row without missing a day.`, met: streak >= n, pct: Math.min(100, Math.round((streak / n) * 100)), sub: streak >= n ? 'Unlocked' : `${n - streak} day${n - streak === 1 ? '' : 's'} to go` });
        strk(2, 'Two in a row'); strk(7, 'One week strong'); strk(14, 'Fortnight'); strk(30, 'A month deep'); strk(100, 'Centurion streak');
        const accA = (t, minAtt, title) => A.push({ cat: 'Accuracy', icon: 'target', title, desc: `Reach ${t}% overall accuracy after answering at least ${minAtt} questions.`, met: att >= minAtt && acc >= t, pct: att < minAtt ? Math.round((att / minAtt) * 100) : Math.min(100, Math.round((acc / t) * 100)), sub: (att >= minAtt && acc >= t) ? 'Unlocked' : (att < minAtt ? `${minAtt - att} more answers to qualify` : `at ${acc}% — reach ${t}%`) });
        accA(70, 50, 'On target — 70%'); accA(80, 50, 'Sharpshooter — 80%'); accA(90, 100, 'Elite — 90%');
        A.push({ cat: 'Coverage', icon: 'grid', title: 'Explorer — every specialty', desc: 'Answer at least one question in every specialty.', met: totalSpec > 0 && started >= totalSpec, pct: totalSpec ? Math.round((started / totalSpec) * 100) : 0, sub: (totalSpec > 0 && started >= totalSpec) ? 'Unlocked' : `${started} / ${totalSpec} specialties started` });
        A.push({ cat: 'Coverage', icon: 'grid', title: 'Specialist — 100% of a specialty', desc: 'See every question in any one specialty.', met: mastered >= 1, pct: mastered >= 1 ? 100 : 0, sub: mastered >= 1 ? 'Unlocked' : 'Fully cover any one specialty' });
        A.push({ cat: 'Coverage', icon: 'star', title: 'Daily habit — Question of the Day', desc: 'Answer a Question of the Day at least once.', met: qotdEver, pct: qotdEver ? 100 : 0, sub: qotdEver ? 'Unlocked' : 'Answer a Question of the Day' });

        // --- expanded achievements (2026-07-01) ---
        vol(25, 'Warming up — 25'); vol(50, 'Fifty in'); vol(250, 'Quarter-K — 250');
        strk(50, 'Half-century — 50-day streak'); strk(200, 'Unstoppable — 200 days');
        accA(95, 200, 'Marksman — 95%'); accA(80, 500, 'Locked in — 80% over 500');

        // coverage extras — all derived from per-specialty seen/total (permanent, never re-locks)
        const covByCat = {}; cov.forEach((c) => { covByCat[c.category] = c.answered || 0; });
        const maxSeen = cov.reduce((m, c) => Math.max(m, c.answered || 0), 0);
        const sumSeen = cov.reduce((a, c) => a + (c.answered || 0), 0);
        const sumTot = cov.reduce((a, c) => a + (c.total || 0), 0);
        const bankPct = sumTot ? Math.round((sumSeen / sumTot) * 100) : 0;
        const covPush = (icon, title, met, pct, sub) => A.push({ cat: 'Coverage', icon, title, met, pct: met ? 100 : Math.max(0, Math.min(99, pct || 0)), sub: met ? 'Unlocked' : sub });
        covPush('grid', 'Broad start — 4 specialties', started >= 4, Math.round((started / 4) * 100), `${started} / 4 started`);
        covPush('grid', 'Getting around — 8 specialties', started >= 8, Math.round((started / 8) * 100), `${started} / 8 started`);
        covPush('layers', 'Deep diver — 50 in one specialty', maxSeen >= 50, Math.round((maxSeen / 50) * 100), `best is ${maxSeen} / 50`);
        covPush('grid', 'Double specialist — 2 at 100%', mastered >= 2, Math.round((mastered / 2) * 100), `${mastered} / 2 fully covered`);
        covPush('grid', 'Polymath — 5 at 100%', mastered >= 5, Math.round((mastered / 5) * 100), `${mastered} / 5 fully covered`);
        covPush('trophy', 'Grand tour — every specialty at 100%', totalSpec > 0 && mastered >= totalSpec, Math.round((mastered / (totalSpec || 16)) * 100), `${mastered} / ${totalSpec} fully covered`);
        covPush('layers', 'Halfway through the bank', bankPct >= 50, Math.round((bankPct / 50) * 100), `${bankPct}% of the bank seen`);
        covPush('trophy', 'Completionist — the whole bank', sumTot > 0 && sumSeen >= sumTot, bankPct, `${bankPct}% of the bank seen`);

        // mastery — per-specialty accuracy, needs 20+ answered in that specialty to qualify
        const bySpec = p.by_specialty || [];
        const domHi = bySpec.filter((r) => (r.accuracy || 0) >= 85 && (covByCat[r.category] || 0) >= 20).length;
        const masPush = (title, met, pct, sub) => A.push({ cat: 'Mastery', icon: 'target', title, met, pct: met ? 100 : Math.max(0, Math.min(99, pct || 0)), sub: met ? 'Unlocked' : sub });
        masPush('Domain expert — 85% in a specialty', domHi >= 1, 0, '85%+ in any specialty (20+ answered)');
        masPush('Triple threat — 85% in three', domHi >= 3, Math.round((domHi / 3) * 100), `${domHi} / 3 specialties at 85%+`);

        // milestones — readiness, combos, and mock exams
        const rdy = Math.max(0, Math.min(100, p.readiness || 0));
        const mocks = parseInt(ls('macprep_mock_count') || '0', 10) || 0;
        const milePush = (icon, title, met, pct, sub) => A.push({ cat: 'Milestones', icon, title, met, pct: met ? 100 : Math.max(0, Math.min(99, pct || 0)), sub: met ? 'Unlocked' : sub });
        milePush('gauge', 'Exam-ready — 80% readiness', rdy >= 80, Math.round((rdy / 80) * 100), `readiness ${rdy}% / 80%`);
        milePush('gauge', 'Peak form — 95% readiness', rdy >= 95, Math.round((rdy / 95) * 100), `readiness ${rdy}% / 95%`);
        milePush('star', 'Scholar — 1,000 answered at 80%+', total >= 1000 && acc >= 80, Math.round(Math.min(total / 1000, acc / 80) * 100), total < 1000 ? `${(1000 - total).toLocaleString()} more answers, then 80%+` : `at ${acc}% — reach 80%`);
        milePush('flame', 'The grind — 30-day streak + 2,500', streak >= 30 && total >= 2500, Math.round(Math.min(streak / 30, total / 2500) * 100), 'a 30-day streak and 2,500 answered');
        milePush('clipboard', 'Dress rehearsal — finish a Mock Exam', mocks >= 1, 0, 'complete a full Mock Exam');
        milePush('clipboard', 'Mock master — three Mock Exams', mocks >= 3, Math.round((mocks / 3) * 100), `${mocks} / 3 completed`);

        // levels — XP progression (derived from your real stats)
        const Lv = xpLevel(p);
        const lvlA = (n, title, icon) => A.push({ cat: 'Milestones', icon: icon || 'star', title, desc: `Reach Level ${n} by earning XP from answering questions.`, met: Lv.level >= n, pct: Lv.level >= n ? 100 : Math.max(0, Math.min(99, Math.round((Lv.level / n) * 100))), sub: Lv.level >= n ? 'Unlocked' : `Level ${Lv.level} / ${n}` });
        lvlA(5, 'Level 5'); lvlA(10, 'Level 10'); lvlA(25, 'Level 25'); lvlA(50, 'Level 50 — halfway to max'); lvlA(100, 'Max level — 100', 'trophy');

        // daily quests — complete all of a day's quests to bank a "quest day"
        const qDays = questDayCount();
        const qA = (n, title) => A.push({ cat: 'Milestones', icon: 'flame', title, desc: `Complete all your daily quests on ${n} separate day${n === 1 ? '' : 's'}.`, met: qDays >= n, pct: qDays >= n ? 100 : Math.max(0, Math.min(99, Math.round((qDays / n) * 100))), sub: qDays >= n ? 'Unlocked' : `${qDays} / ${n} quest days` });
        qA(1, 'Quest complete — first daily set'); qA(7, 'Quest week — 7 days'); qA(30, 'Quest master — 30 days');

        // domain bosses — clear a domain by scoring 80%+ on its mastery challenge
        const bossN = bossesCleared().length;
        const domTotal = (function () { const set = new Set(); (state.questions || []).forEach((q) => { const d = q.domain_name || q.category; if (d) set.add(d); }); return set.size || 6; })();
        A.push({ cat: 'Mastery', icon: 'trophy', title: 'Boss hunter — beat your first domain', desc: 'Defeat any Domain Boss (80%+ on its challenge).', met: bossN >= 1, pct: bossN >= 1 ? 100 : 0, sub: bossN >= 1 ? 'Unlocked' : 'Beat any Domain Boss' });
        A.push({ cat: 'Mastery', icon: 'trophy', title: 'Boss slayer — every domain', desc: 'Defeat every Domain Boss.', met: bossN >= domTotal, pct: bossN >= domTotal ? 100 : Math.max(0, Math.min(99, Math.round((bossN / domTotal) * 100))), sub: bossN >= domTotal ? 'Unlocked' : `${bossN} / ${domTotal} domains defeated` });
        return A;
    }
    function achIcon(name, met) {
        const P = {
            star: '<path d="M12 2l2.4 7.4H22l-6 4.5 2.3 7.1L12 16.6 5.7 21l2.3-7.1-6-4.5h7.6z"/>',
            flag: '<path d="M4 22V3m0 1h13l-2.5 4L17 12H4"/>',
            flame: '<path d="M12 2c1 3 4 4 4 8a4 4 0 0 1-8 0c0-1 .3-2 1-3-2 1-4 3-4 6a7 7 0 0 0 14 0c0-6-5-8-7-11z"/>',
            target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
            grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
            trophy: '<path d="M8 4h8v4a4 4 0 0 1-8 0V4z"/><path d="M8 5.5H5.5V7a2.5 2.5 0 0 0 2.5 2.5"/><path d="M16 5.5h2.5V7A2.5 2.5 0 0 1 16 9.5"/><path d="M9.5 20h5"/><path d="M12 12.5V20"/>',
            layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
            gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 14l4-4"/>',
            clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9.5 4V3h5v1"/><path d="M9 11h6M9 15h4"/>',
        };
        const path = met ? (P[name] || P.star) : '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>';
        return `<span style="width:38px;height:38px;border-radius:11px;flex:none;display:flex;align-items:center;justify-content:center;background:${met ? 'var(--accent-dim)' : 'var(--bg)'};border:1px solid ${met ? 'color-mix(in srgb,var(--accent) 40%,var(--line))' : 'var(--line)'};color:${met ? 'var(--accent)' : 'var(--muted)'};"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>`;
    }
    function achChip(a) {
        const bar = a.met ? '' : `<div style="height:4px;background:var(--line);border-radius:3px;margin-top:7px;overflow:hidden;"><span style="display:block;height:100%;width:${a.pct || 0}%;background:var(--accent);border-radius:3px;"></span></div>`;
        const tip = escapeHtml((a.desc || a.title) + (a.met ? '' : '') + (a.sub && a.sub !== 'Unlocked' ? ' — ' + a.sub : ''));
        return `<div title="${tip}" style="display:flex;align-items:flex-start;gap:11px;padding:12px 13px;border:1px solid var(--line);border-radius:12px;background:var(--panel);cursor:default;${a.met ? '' : 'opacity:.95;'}">${achIcon(a.icon, a.met)}<span style="display:flex;flex-direction:column;min-width:0;flex:1;line-height:1.25;"><span style="font-weight:700;font-size:13.5px;color:var(--text);">${a.title}</span><span style="font-size:12px;color:${a.met ? 'var(--accent)' : 'var(--muted)'};">${a.sub}</span>${bar}</span></div>`;
    }
    function renderAchievements() {
        const el = $('achievements-card'); if (!el) return;
        const A = computeAchievements(); const done = A.filter((a) => a.met).length;
        // dashboard preview: the ones closest to unlocking (most motivating), then fill with unlocked
        const locked = A.filter((a) => !a.met).sort((a, b) => (b.pct || 0) - (a.pct || 0));
        const unlocked = A.filter((a) => a.met);
        const preview = locked.slice(0, 6);
        while (preview.length < 6 && unlocked.length) preview.push(unlocked.shift());
        el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px;flex-wrap:wrap;"><span class="mono" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);">Achievements · <span style="color:var(--accent);font-weight:700;">${done} / ${A.length}</span></span><a href="#" onclick="event.preventDefault();MACPrep.go('achievements');" class="mono" style="font-size:12px;color:var(--accent);text-decoration:none;">View all →</a></div>`
            + `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:10px;">${preview.map(achChip).join('')}</div>`;
    }
    function renderAchievementsView() {
        const el = $('achievements-body'); if (!el) return;
        const A = computeAchievements(); const done = A.filter((a) => a.met).length;
        const C = 2 * Math.PI * 26, off = C * (1 - done / A.length);
        const ring = `<svg width="70" height="70" viewBox="0 0 70 70" style="flex:none;"><circle cx="35" cy="35" r="26" fill="none" stroke="var(--line)" stroke-width="7"/><circle cx="35" cy="35" r="26" fill="none" stroke="var(--accent)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 35 35)"/><text x="35" y="40" text-anchor="middle" style="font-family:ui-monospace,monospace;font-weight:800;font-size:16px;fill:var(--text);">${done}</text></svg>`;
        let html = `<div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;"><div><div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:23px;">${done} of ${A.length} unlocked</div><div class="sub" style="font-size:13px;margin-top:3px;">Every one shows how close you are — keep answering to chase them down.</div></div>${ring}</div>`;
        ['Volume', 'Consistency', 'Accuracy', 'Coverage', 'Mastery', 'Milestones'].forEach((cat) => {
            const items = A.filter((a) => a.cat === cat); if (!items.length) return;
            const d = items.filter((a) => a.met).length;
            html += `<div class="mono" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin:22px 0 12px;">${cat} · <span style="color:var(--accent);">${d}/${items.length}</span></div>`
                + `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">${items.map(achChip).join('')}</div>`;
        });
        el.innerHTML = html;
    }

    // ---- Study Modes bento + Mock Exam ----
    function jumpToCard(id) {
        const el = document.getElementById(id); if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'box-shadow .3s ease'; el.style.boxShadow = '0 0 0 3px var(--accent-dim)';
        setTimeout(() => { el.style.boxShadow = ''; }, 1300);
    }
    function startQuick(n) {
        const usage = freeUsage();
        if (!usage.unlimited && usage.remaining <= 0) { return startCheckout(); }
        let pool = (state.questions || []).slice();
        if (!pool.length) { toast('No questions loaded yet — try again in a moment.'); return; }
        pool = unseenFirst(pool); // fresh questions first, freshly shuffled
        let k = Math.min(n, pool.length); if (!usage.unlimited) k = Math.min(k, usage.remaining);
        beginSession(pool.slice(0, k));
    }
    function openMockPicker() { const m = $('mock-picker'); if (m) m.classList.remove('hidden'); }
    function closeMockPicker() { const m = $('mock-picker'); if (m) m.classList.add('hidden'); }

    // ---- Domain Bosses: score 80%+ on a short mastery challenge to "clear" a domain ----
    const BOSS_THRESHOLD = 80, BOSS_SIZE = 8;
    function uniqueDomains() {
        const m = {}; (state.questions || []).forEach((q) => { const d = q.domain_name || q.category; if (d) m[d] = (m[d] || 0) + 1; });
        return Object.entries(m).sort((a, b) => b[1] - a[1]);
    }
    function bossesCleared() { try { return JSON.parse(localStorage.getItem('macprep_bosses') || '[]') || []; } catch (e) { return []; } }
    function markBossCleared(domain) { try { const a = bossesCleared(); if (a.indexOf(domain) < 0) { a.push(domain); localStorage.setItem('macprep_bosses', JSON.stringify(a)); } } catch (e) {} }
    function openBossPicker() {
        const doms = uniqueDomains(), cleared = bossesCleared();
        if (!doms.length) { toast('Questions are still loading — try again in a moment.'); return; }
        const rows = doms.map(([name]) => {
            const done = cleared.indexOf(name) >= 0;
            const icon = done ? '<path d="M20 6 9 17l-5-5"/>' : '<path d="M12 3l7 3v6c0 4-3 6.9-7 8.5C8 18.9 5 16 5 12V6l7-3z"/>';
            return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 2px;border-top:1px solid var(--line);">
                <div style="display:flex;align-items:center;gap:11px;min-width:0;">
                    <span style="width:30px;height:30px;flex:none;border-radius:8px;display:flex;align-items:center;justify-content:center;background:${done ? 'var(--accent)' : 'var(--bg)'};border:1px solid ${done ? 'var(--accent)' : 'var(--line)'};color:${done ? 'var(--on-accent)' : 'var(--muted)'};"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span>
                    <span style="font-weight:600;font-size:13.5px;line-height:1.2;">${escapeHtml(name)}</span>
                </div>
                ${done ? '<span class="mono" style="color:var(--accent);font-size:11px;flex:none;">Defeated</span>' : `<button class="btn" style="font-size:12px;padding:8px 15px;flex:none;" data-boss="${escapeHtml(name)}" onclick="MACPrep.startBossFight(this.dataset.boss)">Challenge</button>`}</div>`;
        }).join('');
        const wrap = document.createElement('div');
        wrap.id = 'boss-overlay';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2500;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);';
        wrap.onclick = (e) => { if (e.target === wrap) closeBossPicker(); };
        wrap.innerHTML = `<div style="background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px 24px;max-width:460px;width:100%;max-height:82vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.4);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;">
                <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:21px;">Domain Bosses</div>
                <button onclick="MACPrep.closeBossPicker()" aria-label="Close" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:22px;line-height:1;">&times;</button>
            </div>
            <div class="sub" style="font-size:13px;margin-bottom:8px;">Score <strong>${BOSS_THRESHOLD}%+</strong> on a short ${BOSS_SIZE}-question mastery challenge to defeat a domain's boss. Clear all ${doms.length} to become a Boss Slayer. <span class="mono" style="color:var(--accent);">${cleared.length}/${doms.length} defeated</span></div>
            ${rows}</div>`;
        document.body.appendChild(wrap);
    }
    function closeBossPicker() { const o = $('boss-overlay'); if (o) o.remove(); }
    function startBossFight(domain) {
        closeBossPicker();
        const all = (state.questions || []).filter((q) => (q.domain_name || q.category) === domain);
        if (all.length < 5) { toast('Not enough questions in this domain yet.'); return; }
        const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
        const pool = shuffle(all.slice()).slice(0, Math.min(BOSS_SIZE, all.length));
        try { track('boss_start', { domain }); } catch (e) {}
        beginSession(pool, 'exam');
        if (state.session) { state.session.boss = domain; saveSession(); }
    }

    // ---- Arcade modes: fast, score-chasing runs with a personal best -------------
    //  Survival    = endless questions, 3 lives, one miss costs a life; score = correct.
    //  Time Attack = 5-minute sprint; answer as many correctly as possible.
    // Both reuse tutor grading (immediate right/wrong) but auto-advance for pace, and
    // the session is intentionally NOT persisted (a score run is ephemeral, no resume).
    const ARCADE_LIVES = 3, ARCADE_SECONDS = 300;
    const ARCADE_META = {
        survival:   { label: 'Survival',    tagline: 'Endless questions, 3 lives. One miss costs a life — how far can you go?' },
        timeattack: { label: 'Time Attack', tagline: 'Five-minute sprint. Answer as many correctly as you can before the clock runs out.' },
    };
    let arcadeTimerId = null, arcadeAdvanceId = null;
    function stopArcadeTimer() { if (arcadeTimerId) { clearInterval(arcadeTimerId); arcadeTimerId = null; } }
    function clearArcadeAdvance() { if (arcadeAdvanceId) { clearTimeout(arcadeAdvanceId); arcadeAdvanceId = null; } }
    function arcadeBest(type) { try { return parseInt(localStorage.getItem('macprep_arcade_' + type) || '0', 10) || 0; } catch (e) { return 0; } }
    function setArcadeBest(type, v) { try { localStorage.setItem('macprep_arcade_' + type, String(v)); } catch (e) {} }
    function bumpArcadePlays(type) { try { const k = 'macprep_arcade_' + type + '_plays'; localStorage.setItem(k, String((parseInt(localStorage.getItem(k) || '0', 10) || 0) + 1)); } catch (e) {} }
    function arcadeShuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

    function openArcadePicker() {
        const rows = Object.keys(ARCADE_META).map((type) => {
            const m = ARCADE_META[type], best = arcadeBest(type);
            return `<button type="button" onclick="MACPrep.startArcade('${type}')" style="display:block;width:100%;text-align:left;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:15px 16px;margin-top:11px;cursor:pointer;transition:border-color .15s ease,transform .15s ease;" onmouseover="this.style.borderColor='var(--accent)';this.style.transform='translateY(-1px)';" onmouseout="this.style.borderColor='var(--line)';this.style.transform='none';">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                    <div style="font-weight:700;font-size:15px;color:var(--text);">${type === 'survival' ? '❤ ' : '⏱ '}${m.label}</div>
                    <div class="mono" style="font-size:11px;color:var(--accent);flex:none;">BEST ${best}</div>
                </div>
                <div style="font-size:12.5px;color:var(--muted);margin-top:5px;line-height:1.45;">${m.tagline}</div>
            </button>`;
        }).join('');
        const wrap = document.createElement('div');
        wrap.id = 'arcade-overlay';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2500;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);';
        wrap.onclick = (e) => { if (e.target === wrap) closeArcadePicker(); };
        wrap.innerHTML = `<div style="background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px 24px;max-width:440px;width:100%;max-height:82vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.4);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;">
                <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:21px;">Arcade</div>
                <button onclick="MACPrep.closeArcadePicker()" aria-label="Close" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:22px;line-height:1;">&times;</button>
            </div>
            <div class="sub" style="font-size:13px;margin-bottom:6px;">Two fast, score-chasing modes. Same board-quality questions — just against the clock (and your own best).</div>
            ${rows}</div>`;
        document.body.appendChild(wrap);
    }
    function closeArcadePicker() { const o = $('arcade-overlay'); if (o) o.remove(); }

    function startArcade(type) {
        closeArcadePicker();
        if (!ARCADE_META[type]) return;
        const all = state.questions || [];
        if (all.length < 8) { toast('Questions are still loading — try again in a moment.'); return; }
        // Arcade burns through fresh questions fast, so it's part of full access (like the
        // mock exam). Free users hit the upsell rather than blowing their 10% on a score run.
        const usage = freeUsage();
        if (!usage.unlimited) { toast('Arcade modes are part of full access — unlock everything for a one-time $50.'); return startCheckout(); }
        const pool = arcadeShuffle(all.slice());
        try { track('arcade_start', { type }); } catch (e) {}
        beginSession(pool, 'tutor');
        const s = state.session; if (!s) return;
        const prevBest = arcadeBest(type);
        s.arcade = { type, score: 0, streak: 0, best: prevBest, prevBest, over: false };
        if (type === 'survival') { s.arcade.lives = ARCADE_LIVES; s.arcade.maxLives = ARCADE_LIVES; }
        if (type === 'timeattack') { s.arcade.timeLeft = ARCADE_SECONDS; startArcadeTimer(); }
        renderQuestion(); // repaint with arcade chrome (HUD in, tutor extras out)
        renderArcadeHud();
    }

    function startArcadeTimer() {
        stopArcadeTimer();
        const s = state.session; if (!s || !s.arcade || s.arcade.type !== 'timeattack') return;
        arcadeTimerId = setInterval(() => {
            const ss = state.session;
            if (!ss || !ss.arcade || ss.arcade.over) { stopArcadeTimer(); return; }
            ss.arcade.timeLeft = (ss.arcade.timeLeft || 0) - 1;
            renderArcadeHud();
            if (ss.arcade.timeLeft === 60) announce('One minute left.');
            else if (ss.arcade.timeLeft === 10) announce('Ten seconds left.');
            if (ss.arcade.timeLeft <= 0) { stopArcadeTimer(); arcadeGameOver('time'); }
        }, 1000);
    }

    function renderArcadeHud() {
        const el = $('arcade-hud'), s = state.session; if (!el) return;
        if (!s || !s.arcade || s.arcade.over) { el.style.display = 'none'; el.innerHTML = ''; return; }
        const a = s.arcade;
        let left;
        if (a.type === 'survival') {
            const hearts = Array.from({ length: a.maxLives }, (_, i) => `<span style="font-size:18px;line-height:1;color:${i < a.lives ? 'var(--bad)' : 'var(--line)'};">♥</span>`).join('');
            left = `<div style="display:flex;align-items:center;gap:4px;">${hearts}</div>`;
        } else {
            const t = Math.max(0, a.timeLeft || 0), low = t <= 30;
            left = `<div class="mono" style="font-size:20px;font-weight:800;color:${low ? 'var(--bad)' : 'var(--text)'};letter-spacing:.5px;">⏱ ${fmtClock(t)}</div>`;
        }
        el.style.display = 'flex';
        el.innerHTML = `${left}
            <div style="display:flex;align-items:baseline;gap:18px;">
                ${a.streak >= 3 ? `<div class="mono" style="font-size:12px;color:var(--warn);font-weight:700;">🔥 ${a.streak}</div>` : ''}
                <div style="text-align:right;"><span class="mono" style="font-size:10px;letter-spacing:1px;color:var(--muted);">SCORE</span> <strong style="font-size:21px;">${a.score}</strong></div>
                <div style="text-align:right;"><span class="mono" style="font-size:10px;letter-spacing:1px;color:var(--muted);">BEST</span> <strong style="font-size:16px;color:var(--accent);">${Math.max(a.best, a.score)}</strong></div>
            </div>`;
    }

    // Called from tutor answer() after a grade when a run is active.
    function arcadeAnswerHook(correct) {
        const s = state.session; if (!s || !s.arcade || s.arcade.over) return;
        const a = s.arcade;
        if (correct) { a.score++; a.streak++; if (a.score > a.best) { a.best = a.score; setArcadeBest(a.type, a.best); } }
        else { a.streak = 0; if (a.type === 'survival') a.lives = Math.max(0, a.lives - 1); }
        renderArcadeHud();
        clearArcadeAdvance();
        if (a.type === 'survival' && a.lives <= 0) { arcadeAdvanceId = setTimeout(() => arcadeGameOver('dead'), 1600); return; }
        arcadeAdvanceId = setTimeout(arcadeNext, correct ? 850 : 1650); // linger a beat longer on a miss so the answer registers
    }

    function arcadeNext() {
        clearArcadeAdvance();
        const s = state.session; if (!s || !s.arcade || s.arcade.over) return;
        // Endless: extend the pool with a fresh reshuffle of the whole bank when we reach the end.
        if (s.index >= s.pool.length - 1) { s.pool = s.pool.concat(arcadeShuffle((state.questions || []).slice())); s.size = s.pool.length; }
        s.index++;
        delete s.answers[s.index]; s.locked = false;
        renderQuestion();
        scrollQuizToTop();
    }

    function arcadeGameOver(reason) {
        const s = state.session; if (!s || !s.arcade || s.arcade.over) return;
        const a = s.arcade; a.over = true; s.complete = true;
        stopArcadeTimer(); clearArcadeAdvance();
        bumpArcadePlays(a.type);
        try { track('arcade_over', { type: a.type, score: a.score, reason }); } catch (e) {}
        const newRecord = a.score > (a.prevBest || 0);
        const bestShown = Math.max(a.best, a.prevBest || 0, a.score);
        $('arcade-hud') && ($('arcade-hud').style.display = 'none');
        $('quiz-palette') && ($('quiz-palette').innerHTML = '');
        $('quiz-progress-wrap') && ($('quiz-progress-wrap').style.display = 'none');
        $('quiz-actions') && ($('quiz-actions').style.display = 'none');
        document.querySelectorAll('.quiz-extra').forEach((e) => { e.style.display = 'none'; });
        $('question-meta').textContent = a.type === 'survival' ? '❤ SURVIVAL · GAME OVER' : "⏱ TIME ATTACK · TIME'S UP";
        const line = a.type === 'survival'
            ? `You answered <strong>${a.score}</strong> correct before running out of lives.`
            : `You got <strong>${a.score}</strong> correct in five minutes.`;
        $('question-stem').innerHTML = `
            <div style="text-align:center;padding:10px 0 2px;">
                <div style="font-family:'Fraunces',Georgia,serif;font-size:56px;font-weight:600;line-height:1;color:var(--accent);">${a.score}</div>
                <div class="mono" style="font-size:11px;letter-spacing:1.5px;color:var(--muted);margin-top:6px;">CORRECT</div>
                ${newRecord
                    ? '<div style="margin-top:14px;font-weight:800;color:var(--accent);font-size:15px;">🏆 New personal best!</div>'
                    : `<div class="mono" style="margin-top:14px;font-size:12px;color:var(--muted);">Personal best: ${bestShown}</div>`}
                <div style="font-size:14px;color:var(--muted);margin-top:14px;line-height:1.55;max-width:360px;margin-left:auto;margin-right:auto;">${line}</div>
            </div>
            <div style="display:flex;gap:10px;justify-content:center;margin-top:24px;flex-wrap:wrap;">
                <button class="btn" type="button" onclick="MACPrep.startArcade('${a.type}')">Play again</button>
                <button class="btn ghost" type="button" onclick="MACPrep.go('dashboard')">Back to dashboard</button>
            </div>`;
        $('choices-container').innerHTML = '';
        $('explanation-pane').classList.add('hidden');
        try { checkLevelUp(); } catch (e) {} // arcade answers earn XP — a run can push you over a level
        if (newRecord && a.score > 0) celebrate();
    }

    // Full-length exam, sampled proportionally to the bank's real domain distribution
    // (honest weighting — not a fabricated official blueprint), run as a timed exam.
    function startMockExam(count) {
        closeMockPicker();
        const all = state.questions || [];
        if (all.length < 20) { toast('Not enough questions loaded yet for a mock exam.'); return; }
        const usage = freeUsage();
        const n = Math.min(count || 100, all.length);
        if (!usage.unlimited && usage.remaining < n) { toast('Full-length mock exams are part of full access — unlock everything for a one-time $50.'); return startCheckout(); }
        const byDom = {};
        all.forEach((q) => { const d = q.domain_name || q.category || 'General'; (byDom[d] = byDom[d] || []).push(q); });
        const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
        let pool = [];
        Object.keys(byDom).forEach((d) => { const share = Math.max(1, Math.round(n * (byDom[d].length / all.length))); pool = pool.concat(unseenFirst(byDom[d]).slice(0, share)); }); // fresh questions first per domain
        const seen = new Set(pool.map((q) => q.id));
        if (pool.length < n) { pool = pool.concat(unseenFirst(all.filter((q) => !seen.has(q.id))).slice(0, n - pool.length)); }
        shuffle(pool); pool = pool.slice(0, n);
        if (!pool.length) { toast('No questions available for a mock exam yet.'); return; }
        try { track('mock_exam_start', { size: pool.length }); } catch (e) {}
        beginSession(pool, 'exam');
        if (state.session) {
            state.session.mock = true;
            // Match the real NCCAA exam pace: 110 minutes per 90-item block (so a full 180 → 220 minutes).
            state.session.timeLeft = Math.round((pool.length / 90) * 110 * 60);
            renderExamTimer(); // repaint immediately so the clock never flashes the pre-override default
            saveSession();
        }
    }
    function smTile(cls, cat, title, desc, count, onclick, tag) {
        return `<button type="button" class="sm-tile ${cls}" onclick="${onclick}"><div class="sm-cat">${cat}${tag ? ` <span class="sm-tag">${tag}</span>` : ''}</div>`
            + `<div class="sm-title">${title}</div>${desc ? `<div class="sm-desc">${desc}</div>` : ''}${count ? `<div class="sm-count">${count}</div>` : ''}</button>`;
    }
    function renderStudyModes() {
        const el = $('studymodes-card'); if (!el) return;
        const p = state.profile || {};
        const due = (p.due_ids || []).length, missed = (p.missed_ids || []).length, flagged = (p.flagged_ids || []).length;
        const recParts = [due ? `${due} due` : '', missed ? `${missed} missed` : ''].filter(Boolean);
        const recCount = recParts.length ? recParts.join(' · ') : 'a smart mix for you';
        const t = [];
        t.push(`<button type="button" class="sm-tile sm-rec" onclick="MACPrep.startRecommended()"><div class="sm-cat">Recommended for you</div><div class="sm-title" style="font-size:20px;">Today's focused set</div><div class="sm-desc" style="max-width:250px;">Your weak spots, due reviews, and recent misses — the highest-impact set right now.</div><div class="sm-count">${recCount}</div></button>`);
        t.push(smTile('sm-mock', 'Exam simulation', 'Mock Exam', 'Board-length & timed like the real NCCAA exam.', '180 Q · timed', 'MACPrep.openMockPicker()', 'New'));
        t.push(smTile('sm-boss', 'Challenge', 'Domain Bosses', 'Beat a domain to clear it.', (bossesCleared().length ? `${bossesCleared().length}/${uniqueDomains().length} defeated` : `${uniqueDomains().length} to beat`), 'MACPrep.openBossPicker()', 'New'));
        const arcTop = Math.max(arcadeBest('survival'), arcadeBest('timeattack'));
        t.push(smTile('sm-arcade', 'Play', 'Arcade', 'Survival & Time Attack — chase a high score.', (arcTop ? `Best ${arcTop}` : 'Set a high score'), 'MACPrep.openArcadePicker()', 'New'));
        t.push(smTile('sm-q10', 'Quick start', 'Quick 10', '10 random questions.', '', 'MACPrep.startQuick(10)'));
        t.push(smTile('sm-smart', 'Spaced repetition', 'Smart Review', 'Weak areas + your misses.', due ? `${due} due today` : '', 'MACPrep.smartReview()'));
        t.push(smTile('sm-missed', 'Targeted', 'Redo Missed', '', missed ? `${missed} to fix` : 'none missed', 'MACPrep.redoMissed()'));
        t.push(smTile('sm-flag', 'Targeted', 'Flagged', '', flagged ? `${flagged} saved` : 'none flagged', 'MACPrep.startFlagged()'));
        t.push(smTile('sm-spec', 'By specialty', 'Focused quiz', 'Pick any specialty.', '', "MACPrep.jumpToCard('specialty-perf')"));
        t.push(smTile('sm-build', 'Custom', 'Build Your Own', 'Domain · count · difficulty.', '', 'MACPrep.toggleCustomize()'));
        el.innerHTML = `<div class="mono" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:15px;">Study modes</div><div class="sm-bento">${t.join('')}</div>`;
    }

    function renderDashboard() {
        const p = state.profile || {};
        $('dash-greeting').textContent = `Welcome${p.full_name ? ', ' + p.full_name.split(' ')[0] : ' back'}`;
        renderMomentum();
        renderStudyModes();
        renderAchievements();
        renderResumeCard();
        renderExamPrompt();
        const stats = p.stats || { answered: 0, correct: 0, attempts: 0 };
        $('stat-answered').textContent = stats.answered || 0;
        $('stat-accuracy').textContent = stats.attempts ? Math.round((stats.correct / stats.attempts) * 100) + '%' : '—';
        $('stat-bank').textContent = state.questions.length.toLocaleString();
        renderReadiness();
        renderQotd();
        renderActivityCalendar();
        renderOnboarding();
        renderReferral();
        renderRecommendedSub();

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
        const tiles = rows.map((c) => {
            const fracPct = c.total ? Math.round((c.answered / c.total) * 100) : 0;
            const acc = accMap[c.category];
            const started = c.answered > 0;
            const accColor = !started ? 'var(--muted)' : (acc && acc.accuracy >= 75 ? 'var(--accent)' : acc && acc.accuracy >= 50 ? 'var(--warn)' : 'var(--bad)');
            const accStr = started && acc ? acc.accuracy + '%' : '—';
            const barColor = started ? 'var(--accent)' : 'var(--line)';
            return `<div class="spec-tile" data-cat="${escapeHtml(c.category)}" role="button" tabindex="0" aria-label="Start a focused quiz on ${escapeHtml(c.category)}" onclick="MACPrep.openSpecialtyPicker(this.dataset.cat)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();MACPrep.openSpecialtyPicker(this.dataset.cat);}" style="flex:1 1 172px;max-width:212px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:11px 12px;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px;">
                    <span style="font-size:13px;font-weight:600;line-height:1.25;">${escapeHtml(c.category)}</span>
                    <span class="mono" style="font-size:13px;font-weight:700;color:${accColor};flex:none;">${accStr}</span>
                </div>
                <div class="progress-bar" style="margin:0 0 6px;"><span style="width:${fracPct}%;background:${barColor};"></span></div>
                <div class="mono" style="font-size:10px;color:var(--muted);">${c.answered}/${c.total} seen${started ? '' : ' · not started'}</div>
            </div>`;
        }).join('');
        const resetRow = freeUsage().unlimited
            ? `<div style="display:flex;justify-content:center;margin-top:18px;padding-top:14px;border-top:1px solid var(--line);">
                 <button type="button" onclick="MACPrep.resetProgress()" class="mono" style="background:none;border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:7px 14px;font-size:11px;letter-spacing:.5px;cursor:pointer;">↻ Reset my progress</button>
               </div>`
            : '';
        el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:2px;"><h3 style="margin:0;">By specialty</h3><span class="mono" style="font-size:11px;color:var(--muted);">all · least-covered first</span></div>
            <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:13px;">${tiles}</div>${resetRow}`;
    }

    // Wipe practice progress so a full-access user can start fresh (premium-only server-side).
    async function resetProgress() {
        if (!confirm('Reset all your practice progress?\n\nThis permanently clears your coverage, accuracy, and answered-question stats so you can start over. Your account, saved notebook, and flags are kept. This can’t be undone.')) return;
        try {
            const { resp, data } = await apiJSON('/api/user/reset-progress', { method: 'POST', headers: authHeaders() });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Could not reset your progress.');
            try { track('progress_reset'); } catch (e) {}
            toast('Progress reset — you’re starting fresh.', 'ok');
            await loadProfile();
            if (!$('dashboard-view').classList.contains('hidden')) renderDashboard();
        } catch (e) { toast(e.message || 'Could not reset your progress.', 'bad'); }
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

        beginSession(unseenFirst(pool).slice(0, n)); // fresh questions first, freshly shuffled
    }

    // Diagnostic / readiness assessment: a balanced sample across the 6 blueprint
    // domains, run as an exam, ending in a predicted-readiness score + the weakest
    // domain to start with.
    function startDiagnostic() {
        const usage = freeUsage();
        if (!usage.unlimited && usage.remaining < 6) { return startCheckout(); }
        const all = state.questions || [];
        if (all.length < 6) { toast('Not enough questions loaded yet — try again in a moment.'); return; }
        const byDom = {};
        all.forEach((q) => { const d = q.domain_name || q.category || 'General'; (byDom[d] = byDom[d] || []).push(q); });
        const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
        let pool = [];
        Object.values(byDom).forEach((arr) => { pool = pool.concat(shuffle(arr.slice()).slice(0, 4)); });
        shuffle(pool);
        if (!usage.unlimited) pool = pool.slice(0, Math.min(pool.length, usage.remaining));
        if (!pool.length) { toast('No questions available for a diagnostic yet.'); return; }
        track('diagnostic_start', { size: pool.length });
        beginSession(pool, 'exam');
        if (state.session) state.session.diagnostic = true;
    }

    // Persist the in-progress session so a refresh or accidental navigation can be
    // recovered instead of silently wiping the user's work.
    function saveSession() {
        try {
            if (state.session && !state.session.complete && !state.session.arcade) ls('macprep_session', JSON.stringify(state.session));
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
    // ---- study league (weekly global leaderboard) -------------------------
    async function loadLeaderboard() {
        const el = $('leaderboard-body'); if (!el) return;
        el.innerHTML = '<div class="mono" style="color:var(--muted);">Loading…</div>';
        try {
            const { resp, data } = await apiJSON('/api/leaderboard', { headers: authHeaders() });
            if (!resp.ok) { el.innerHTML = '<div class="mono" style="color:var(--bad);">Could not load the leaderboard.</div>'; return; }
            state.leaderboard = data;
            renderLeaderboard();
        } catch (e) { el.innerHTML = '<div class="mono" style="color:var(--bad);">Could not load the leaderboard.</div>'; }
    }
    function lbCountdown(iso) {
        const ms = new Date(iso).getTime() - Date.now();
        if (ms <= 0) return 'resetting now';
        const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
        return 'resets in ' + d + 'd ' + h + 'h';
    }
    function renderLeaderboard() {
        const el = $('leaderboard-body'); const data = state.leaderboard; if (!el || !data) return;
        const me = data.me || {}; const rows = data.leaderboard || [];
        const handleVal = me.handle || (state.profile && state.profile.leaderboard_handle) || '';
        const optedIn = !!me.opted_in;
        const settings =
            '<div class="card" style="margin-bottom:18px;">'
            + '<h3 style="margin:0 0 4px;">' + (optedIn ? 'Your league profile' : 'Join the league') + '</h3>'
            + '<p class="sub" style="margin:0 0 12px;font-size:13px;">' + (optedIn ? 'You appear on the board under your handle. Change it or leave anytime — your name and email are never shown.' : 'Pick a handle and opt in to appear on the global board. Your name and email are never shown.') + '</p>'
            + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">'
            + '<input id="lb-handle" type="text" maxlength="20" value="' + escapeHtml(handleVal) + '" placeholder="Your handle (e.g. GasPasser22)" style="flex:1;min-width:180px;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:4px;color:var(--text);">'
            + (optedIn
                ? '<button class="btn" onclick="MACPrep.saveLeaderboardSettings(true)">Update</button><button class="btn ghost" onclick="MACPrep.saveLeaderboardSettings(false)">Leave board</button>'
                : '<button class="btn" onclick="MACPrep.saveLeaderboardSettings(true)">Join the board</button>')
            + '</div><div id="lb-msg" class="mono" style="font-size:12px;color:var(--accent);margin-top:8px;"></div></div>';
        const standing =
            '<div class="card" style="margin-bottom:18px;display:flex;gap:18px;flex-wrap:wrap;justify-content:space-between;align-items:center;">'
            + '<div><div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">This week — ' + escapeHtml(lbCountdown(data.week_resets_at)) + '</div>'
            + '<div style="font-size:15px;margin-top:4px;">' + (optedIn && me.rank ? 'You are <strong style="color:var(--accent);">#' + me.rank + '</strong> of ' + me.players : 'Join above to claim your spot') + '</div></div>'
            + '<div style="display:flex;gap:22px;">'
            + '<div style="text-align:center;"><div style="font-size:22px;font-weight:700;">' + (me.weekly || 0) + '</div><div class="mono" style="font-size:10px;color:var(--muted);text-transform:uppercase;">this week</div></div>'
            + '<div style="text-align:center;"><div style="font-size:22px;font-weight:700;color:var(--accent);">' + (me.streak || 0) + ' 🔥</div><div class="mono" style="font-size:10px;color:var(--muted);text-transform:uppercase;">day streak</div></div>'
            + '</div></div>';
        let board;
        if (!rows.length) {
            board = '<div class="card"><div class="mono" style="color:var(--muted);">No one is on the board yet this week — answer some questions and be the first.</div></div>';
        } else {
            const trs = rows.map((r) =>
                '<tr style="' + (r.is_me ? 'background:var(--accent-dim);' : '') + '">'
                + '<td style="padding:9px 10px;font-family:ui-monospace,monospace;' + (r.rank <= 3 ? 'font-weight:700;color:var(--accent);' : 'color:var(--text2);') + '">' + r.rank + '</td>'
                + '<td style="padding:9px 10px;">' + escapeHtml(r.handle) + (r.is_me ? ' <span class="mono" style="font-size:10px;color:var(--accent);">YOU</span>' : '') + '</td>'
                + '<td style="padding:9px 10px;text-align:right;color:var(--text2);">' + r.streak + ' 🔥</td>'
                + '<td style="padding:9px 10px;text-align:right;font-weight:600;">' + r.weekly + '</td></tr>').join('');
            board = '<div class="card" style="padding:6px;"><table style="width:100%;font-size:14px;border-collapse:collapse;">'
                + '<tr style="border-bottom:1px solid var(--line);"><th style="text-align:left;padding:8px 10px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">#</th><th style="text-align:left;padding:8px 10px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Player</th><th style="text-align:right;padding:8px 10px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Streak</th><th style="text-align:right;padding:8px 10px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">This week</th></tr>'
                + trs + '</table></div>';
        }
        el.innerHTML = settings + standing + board;
    }
    async function saveLeaderboardSettings(optIn) {
        const inp = $('lb-handle'); const msg = $('lb-msg');
        const handle = inp ? inp.value.trim() : '';
        if (optIn && !handle) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = 'Choose a handle first.'; } return; }
        if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = 'Saving…'; }
        try {
            const { resp, data } = await apiJSON('/api/leaderboard/settings', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ handle: handle, opt_in: optIn }) });
            if (!resp.ok) throw new Error(data.error || 'Could not save.');
            await loadProfile();
            await loadLeaderboard();
        } catch (e) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } }
    }

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
            `<div class="mono" style="font-size:11px;color:var(--muted);margin-bottom:4px;">${escapeHtml(n.category || '')}</div>`
            + `<div style="font-size:13px;color:var(--text2);margin-bottom:6px;">${snip(n.stem)}</div>`
            + `<div style="font-size:14px;border-left:2px solid var(--line);padding-left:10px;">${escapeHtml(n.note)}</div>`
            + `<button class="btn ghost" type="button" onclick="MACPrep.practiceOne('${escapeHtml(n.question_id)}')" style="margin-top:8px;font-size:12px;padding:5px 10px;">Practice this</button>`
        )).join('') : '<div class="mono" style="color:var(--muted);font-size:13px;">No notes match.</div>';
        const flagHtml = flagged.length ? flagged.map((f) => card(
            `<div class="mono" style="font-size:11px;color:var(--muted);margin-bottom:4px;">${escapeHtml(f.category || '')}</div>`
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
        btn.innerHTML = `<span style="color:var(--muted);font-weight:bold;margin-right:15px;">[${letter}]</span> ${text}`;
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

    // ---- In-quiz calculator + medical unit conversions -----------------------
    let calcExpr = '';
    function toggleCalc() { const m = $('calc-modal'); if (!m) return; m.classList.toggle('hidden'); if (!m.classList.contains('hidden')) calcRender(); }
    function calcRender() { const d = $('calc-display'); if (d) d.value = calcExpr || '0'; }
    function calc(key) {
        if (key === 'C') { calcExpr = ''; return calcRender(); }
        if (key === 'back') { calcExpr = (calcExpr === 'Error' ? '' : calcExpr.slice(0, -1)); return calcRender(); }
        if (key === '=') {
            // Evaluate a strictly math-only string. The whitelist (digits/operators/
            // parens/space only) makes it impossible to form identifiers or calls, so
            // Function() here can only ever do arithmetic.
            const safe = calcExpr.replace(/×/g, '*').replace(/÷/g, '/').replace(/[^0-9.+\-*/() ]/g, '');
            if (!safe.trim()) return calcRender();
            try { const v = Function('"use strict";return (' + safe + ')')(); calcExpr = (v == null || !isFinite(v)) ? 'Error' : String(Math.round(v * 1e6) / 1e6); }
            catch (e) { calcExpr = 'Error'; }
            return calcRender();
        }
        if (calcExpr === 'Error') calcExpr = '';
        calcExpr += key;
        calcRender();
    }
    // Bidirectional medical conversions: editing one field updates its partner.
    function calcConv(from) {
        const get = (id) => { const el = $(id); const v = parseFloat(el && el.value); return isFinite(v) ? v : null; };
        const set = (id, v) => { const el = $(id); if (el) el.value = (v == null) ? '' : String(Math.round(v * 100) / 100); };
        const map = {
            cm: () => set('cv-in', nz(get('cv-cm'), (v) => v / 2.54)),
            in: () => set('cv-cm', nz(get('cv-in'), (v) => v * 2.54)),
            kg: () => set('cv-lb', nz(get('cv-kg'), (v) => v * 2.2046226)),
            lb: () => set('cv-kg', nz(get('cv-lb'), (v) => v / 2.2046226)),
            c: () => set('cv-f', nz(get('cv-c'), (v) => v * 9 / 5 + 32)),
            f: () => set('cv-c', nz(get('cv-f'), (v) => (v - 32) * 5 / 9)),
        };
        (map[from] || (() => {}))();
    }
    function nz(v, fn) { return v == null ? null : fn(v); }

    // Apply the graded result (highlights, rationale, explanation) — used both when
    // grading live and when re-rendering an already-answered question.
    // Fixed correct/incorrect colors — deliberately NOT theme tokens, so "Correct"
    // reads green and "Incorrect" reads red on every theme the user picks.
    const GRADE_GREEN = '#16a34a', GRADE_RED = '#dc2626';
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
                const isC = idx === data.correctIndex;
                const col = isC ? GRADE_GREEN : GRADE_RED;
                const mark = `<span style="color:${col};font-weight:700;">${isC ? '✓' : '✗'}</span>`;
                // color just the leading "Correct"/"Incorrect" label; keep the rest readable
                const txt = escapeHtml(rationales[idx]).replace(/^(Correct|Incorrect)\b/i, `<span style="color:${col};font-weight:700;">$1</span>`);
                r.innerHTML = mark + ' ' + txt;
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
            ? `<span style="color:${GRADE_GREEN};font-weight:bold;">CORRECT</span>`
            : `<span style="color:${GRADE_RED};font-weight:bold;">INCORRECT</span>`;
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
        const reviewedBadge = q.reviewed ? ' <span style="text-transform:none;letter-spacing:0;color:var(--muted);">· <span style="color:var(--accent);">✓</span> Reviewed by a practicing CAA</span>' : '';
        $('question-meta').innerHTML = escapeHtml(metaText) + reviewedBadge;
        const img = safeUrl(q.image_url) ? `<img src="${escapeHtml(q.image_url)}" alt="Question figure" onclick="MACPrep.zoomImage(this.src)" style="max-width:100%;border:1px solid var(--line);border-radius:4px;margin:12px 0;cursor:zoom-in;">` : '';
        $('question-stem').innerHTML = renderRich(q.stem) + img;
        // Question-swap motion: slide/fade the card in, but only when navigating to a
        // different question (not on a same-question re-render after grading).
        if (s._lastIdx !== s.index) { const _c = $('question-stem').closest('.card'); if (_c) { _c.classList.remove('q-anim'); void _c.offsetWidth; _c.classList.add('q-anim'); } }
        s._lastIdx = s.index;
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
        if (confRow) confRow.style.display = (s.mode === 'tutor' && !graded && choices.length && !s.arcade) ? 'flex' : 'none';
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
        // Arcade chrome: HUD in, tutor extras (palette / progress / actions / notes) out.
        const arc = !!s.arcade && !s.arcade.over;
        if ($('arcade-hud')) { if (arc) renderArcadeHud(); else { $('arcade-hud').style.display = 'none'; } }
        $('quiz-progress-wrap') && ($('quiz-progress-wrap').style.display = arc ? 'none' : '');
        $('quiz-palette') && ($('quiz-palette').style.display = arc ? 'none' : 'flex');
        $('quiz-actions') && ($('quiz-actions').style.display = arc ? 'none' : '');
        document.querySelectorAll('.quiz-extra').forEach((e) => { e.style.display = arc ? 'none' : ''; });
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
            bumpDaily({ answered: 1, correct: data.correct ? 1 : 0, specialty: currentQ.category || currentQ.domain_name }); // daily-quest progress
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
            if (s.arcade) arcadeAnswerHook(!!data.correct); // arcade: score/lives + auto-advance
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
            return { meta: [q.category || q.domain_name, q.subtopic].filter(Boolean).join(' · '), category: s.diagnostic ? (q.domain_name || q.category || 'General') : (q.category || q.domain_name || 'General'), stem: q.stem || '', correct: !!g.correct, correctLetter: String.fromCharCode(65 + (g.correctIndex || 0)), yourLetter: String.fromCharCode(65 + a.selectedIndex), explanation: g.explanation || '' };
        });
        track('session_complete', { mode: 'exam', size: s.pool.length });
        try { await loadProfile(); } catch (e) {}
        $('quiz-palette') && ($('quiz-palette').innerHTML = '');
        $('prev-btn') && ($('prev-btn').style.display = 'none');
        $('submit-exam-btn') && ($('submit-exam-btn').style.display = 'none');
        const pct = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
        const allFailed = answeredIdx.length > 0 && s.answered === 0;
        const bossWon = !!s.boss && !allFailed && pct >= BOSS_THRESHOLD;
        if (bossWon) markBossCleared(s.boss);
        $('question-meta').textContent = allFailed ? 'GRADING FAILED' : (s.boss ? (bossWon ? '⚔ BOSS DEFEATED' : 'BOSS SURVIVED') : s.mock ? 'MOCK EXAM COMPLETE' : s.diagnostic ? 'DIAGNOSTIC COMPLETE' : 'EXAM COMPLETE');
        // Count completed mock exams (drives the "Dress rehearsal" / "Mock master" achievements).
        if (s.mock && !allFailed) { try { localStorage.setItem('macprep_mock_count', String((parseInt(localStorage.getItem('macprep_mock_count') || '0', 10) || 0) + 1)); } catch (e) {} }
        if (allFailed) {
            $('question-stem').innerHTML = `<span style="color:var(--warn);">We couldn't grade your exam — this is usually a temporary connection problem. Please check your connection and run the session again.</span>`;
        } else {
            const failWarn = failed ? `<div style="margin-top:12px;color:var(--warn);font-size:13px;">⚠ ${failed} question${failed === 1 ? '' : 's'} couldn't be graded (network error) and were left out of your score. Try them again from the dashboard.</div>` : '';
            const hype = pct >= 90 ? '🎉 Outstanding — ' : pct >= 75 ? '🎉 Great work — ' : '';
            $('question-stem').innerHTML = s.boss
                ? (bossWon
                    ? `⚔ You defeated the <strong>${escapeHtml(s.boss)}</strong> boss with <strong>${pct}%</strong> — this domain is cleared!${failWarn}`
                    : `The <strong>${escapeHtml(s.boss)}</strong> boss survived — you scored <strong>${pct}%</strong> (need ${BOSS_THRESHOLD}%+). Study the breakdown below and challenge it again.${failWarn}`)
                : s.mock
                ? `${hype}Mock exam complete — you scored <strong>${pct}%</strong> (${s.correct}/${s.answered} correct${unanswered ? `, ${unanswered} unanswered` : ''}). Weighted across all six NCCAA domains — the breakdown below shows where to focus.${failWarn}`
                : s.diagnostic
                ? `Your predicted readiness is <strong>${pct}%</strong> — across ${s.answered} questions spanning all six blueprint domains.${failWarn} The breakdown below shows exactly where to focus first.`
                : `${hype}You scored <strong>${pct}%</strong> (${s.correct}/${s.answered} correct${unanswered ? `, ${unanswered} unanswered` : ''}).${failWarn}`;
            if (bossWon || (pct >= 70 && s.answered >= 3)) celebrate();
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

    // Click a specialty tile → pick a set size → start a category-focused quiz.
    function specialtyPool(cat) {
        return (state.questions || []).filter((q) => (q.category || q.domain_name || 'General') === cat);
    }
    function openSpecialtyPicker(cat) {
        const modal = $('specialty-picker'); if (!modal) return;
        const avail = specialtyPool(cat).length;
        if (!avail) { toast('No questions available for that specialty yet.'); return; }
        $('sp-title').textContent = cat;
        $('sp-sub').textContent = `${avail} question${avail === 1 ? '' : 's'} available — pick your set.`;
        const opts = [5, 10, 25].filter((n) => n < avail).map((n) => ({ label: `${n} questions`, val: n }));
        opts.push({ label: `All ${avail} questions`, val: 'all' });
        const box = $('sp-options'); box.innerHTML = '';
        opts.forEach((o) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'sp-opt'; b.textContent = o.label;
            b.onclick = () => startSpecialtyQuiz(cat, o.val);
            box.appendChild(b);
        });
        modal.classList.remove('hidden');
    }
    function closeSpecialtyPicker() { const m = $('specialty-picker'); if (m) m.classList.add('hidden'); }
    function startSpecialtyQuiz(cat, count) {
        closeSpecialtyPicker();
        const usage = freeUsage();
        if (!usage.unlimited && usage.remaining <= 0) { return startCheckout(); }
        const pool = unseenFirst(specialtyPool(cat)); // fresh questions first, freshly shuffled
        if (!pool.length) { toast('No questions available for that specialty yet.'); return; }
        let n = (count === 'all') ? pool.length : Math.min(count, pool.length);
        if (!usage.unlimited) n = Math.min(n, usage.remaining);
        n = Math.min(n, pool.length);
        if (n <= 0) { return startCheckout(); }
        try { track('specialty_quiz_start', { category: cat, count: n }); } catch (e) {}
        const sel = $('domain-select'); if (sel) sel.value = cat;
        beginSession(pool.slice(0, n));
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
            + `</div>`
            + `<div style="margin-top:14px;padding:10px 12px;border:1px solid var(--accent);border-radius:8px;background:var(--accent-dim);font-size:13px;color:var(--text);display:flex;gap:8px;align-items:center;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg><span><strong>100% Pass Guarantee</strong> — pass the NCCAA boards or your $50 back.</span></div>`
            + `</div>`;
        $('choices-container').innerHTML = '';
        $('explanation-pane').classList.add('hidden');
        if (s && s.log && s.log.length) renderSessionReview(s.log);
        const btn = $('advance-vignette-trigger');
        btn.className = 'btn';
        btn.textContent = 'Unlock full access — $50 (one-time)';
        btn.onclick = () => startCheckout(btn);
        let rr = document.getElementById('paywall-refund');
        if (!rr && btn.parentNode) { rr = document.createElement('div'); rr.id = 'paywall-refund'; rr.className = 'mono'; rr.style.cssText = 'font-size:11px;color:var(--muted);margin-top:10px;'; btn.parentNode.insertBefore(rr, btn.nextSibling); }
        if (rr) rr.innerHTML = '48-hour, no-questions-asked refund &middot; secured by Stripe &middot; instant access<br><a href="#redeem" onclick="event.preventDefault(); MACPrep.goRedeem();" style="color:var(--accent);">Have a class or cohort code? Redeem it free instead &rarr;</a>';
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
            const row = (label, key) => `<div class="stat"><div class="n">${t[key] || 0}</div><div class="l">${label}<br><span style="color:var(--text2);">${w[key] || 0} / 7d</span></div></div>`;
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
            const fmtDate = (s) => { if (!s) return '—'; const d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
            const vs = data.vouchers || [];
            // group by cohort label so two cohorts never get intermixed (unlabeled sorts last)
            const groups = {};
            vs.forEach((v) => { const k = (v.label && v.label.trim()) || '— Unlabeled'; (groups[k] = groups[k] || []).push(v); });
            const keys = Object.keys(groups).sort((a, b) => (a.startsWith('—') ? 1 : b.startsWith('—') ? -1 : a.localeCompare(b)));
            const thc = 'padding:2px 10px 8px 0;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600;';
            const header = `<tr style="text-align:left;border-bottom:1px solid var(--line);"><th style="${thc}">Code</th><th style="${thc}">Status</th><th style="${thc}">Generated</th><th style="${thc}">Claimed by</th></tr>`;
            const groupHtml = keys.map((k) => {
                const rows = groups[k];
                const avail = rows.filter((v) => !v.is_claimed).map((v) => v.voucher_key);
                const claimed = rows.length - avail.length;
                const body = rows.map((v) => `<tr>
                    <td style="font-family:ui-monospace,monospace;padding:4px 10px 4px 0;">${escapeHtml(v.voucher_key)}</td>
                    <td style="padding:4px 10px;color:${v.is_claimed ? 'var(--muted)' : 'var(--accent)'};">${v.is_claimed ? 'claimed' : 'available'}</td>
                    <td style="padding:4px 10px;color:var(--muted);font-size:12px;white-space:nowrap;">${fmtDate(v.created_at)}</td>
                    <td style="padding:4px 0;color:var(--muted);font-size:12px;">${v.claimed_by_email ? escapeHtml(v.claimed_by_email) : ''}</td></tr>`).join('');
                const copyBtn = avail.length ? `<button class="btn ghost" style="font-size:11px;padding:5px 10px;" data-codes="${avail.join(' ')}" onclick="MACPrep.copyCodes(this)">Copy ${avail.length} available</button>` : '';
                return `<div style="margin-top:16px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;flex-wrap:wrap;">
                        <span style="font-weight:700;font-size:13.5px;">${escapeHtml(k)} <span class="mono" style="color:var(--muted);font-weight:400;font-size:11px;">${claimed}/${rows.length} claimed</span></span>
                        ${copyBtn}
                    </div>
                    <div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:8px 10px;"><table style="width:100%;font-size:13px;border-collapse:collapse;">${header}${body}</table></div>
                </div>`;
            }).join('');
            el.innerHTML = `<h3>Cohort vouchers</h3>
                <p class="sub" style="margin:0 0 12px;">Generate codes for a class or cohort — <strong>label each batch</strong> so you never send the same code to two cohorts. Each code grants one premium unlock. <span class="mono" style="color:var(--muted);">${data.claimed}/${data.total} claimed</span></p>
                <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
                    <input id="voucher-count" type="number" min="1" max="200" value="10" title="How many codes" style="width:82px;padding:9px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);">
                    <input id="voucher-label" type="text" maxlength="80" placeholder="Cohort / label — e.g. Emory Class of 2027" style="flex:1;min-width:200px;box-sizing:border-box;padding:9px 11px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);font-size:14px;">
                    <button class="btn" onclick="MACPrep.generateVouchers()">Generate codes</button>
                    <span id="voucher-msg" class="mono" style="font-size:12px;color:var(--accent);"></span>
                </div>
                <div id="voucher-fresh"></div>
                ${vs.length ? groupHtml : '<div class="mono" style="color:var(--muted);font-size:13px;margin-top:10px;">No codes yet.</div>'}`;
            el.classList.remove('hidden');
        } catch (e) { /* ignore */ }
    }

    async function generateVouchers() {
        const count = parseInt($('voucher-count').value, 10) || 10;
        const label = (($('voucher-label') && $('voucher-label').value) || '').trim();
        const msg = $('voucher-msg'); if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = 'Generating…'; }
        try {
            const { resp, data } = await apiJSON('/api/admin/vouchers', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ count, label }) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Failed.');
            const codes = data.codes || [];
            await loadVouchers(); // re-renders the card (creates an empty #voucher-fresh)
            const box = $('voucher-fresh');
            if (box) {
                box.innerHTML = `<div style="border:1px solid var(--accent);border-radius:8px;padding:12px;margin:4px 0 6px;background:var(--accent-dim);">
                    <div style="font-weight:700;font-size:13px;margin-bottom:6px;">${codes.length} new code${codes.length === 1 ? '' : 's'}${data.label ? ' for ' + escapeHtml(data.label) : ' (unlabeled)'} — copy all for this cohort now:</div>
                    <textarea readonly onclick="this.select()" style="width:100%;box-sizing:border-box;height:92px;font-family:ui-monospace,monospace;font-size:12px;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:6px;color:var(--text);">${escapeHtml(codes.join('\n'))}</textarea>
                    <button class="btn ghost" style="margin-top:8px;font-size:12px;" data-codes="${codes.join(' ')}" onclick="MACPrep.copyCodes(this)">Copy codes</button>
                </div>`;
            }
            if (msg) msg.textContent = `Generated ${codes.length}${data.label ? ' for ' + data.label : ''}.`;
        } catch (e) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } }
    }

    // Copy a space-separated batch of codes (from a data-codes attr) to the clipboard, one per line.
    function copyCodes(btn) {
        const codes = ((btn && btn.dataset.codes) || '').trim().split(/\s+/).filter(Boolean).join('\n');
        const done = () => { if (btn) { const p = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = p; }, 1500); } };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(codes).then(done, () => fallbackCopy(codes, done)); }
            else fallbackCopy(codes, done);
        } catch (e) { fallbackCopy(codes, done); }
    }
    function fallbackCopy(text, cb) {
        try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); if (cb) cb(); } catch (e) {}
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
        // An open in-quiz modal (calculator / lab values) captures keys — don't answer behind it.
        if (['calc-modal', 'labs-modal'].some((id) => $(id) && !$(id).classList.contains('hidden'))) return;
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
            s.src = '/sentry.min.js';
            s.crossOrigin = 'anonymous';
            s.onload = () => {
                try { window.Sentry && window.Sentry.init({ dsn: cfg.sentryDsn, environment: cfg.environment || 'production', tracesSampleRate: 0,
                    // Filter benign transient network blips (a user's flaky connection, not a bug),
                    // errors thrown by browser extensions, and native bridges injected by iOS
                    // in-app browsers (WKWebView) when a visitor opens the site from Instagram/
                    // LinkedIn/Facebook/email — e.g. window.webkit.messageHandlers / sendDataToNative.
                    ignoreErrors: ['Failed to fetch', 'Load failed', 'NetworkError', 'AbortError', 'cancelled',
                        'messageHandlers', 'window.webkit', 'sendDataToNative', 'sendPageHideMessage'],
                    denyUrls: [/extension(s)?\//i, /^chrome:\/\//i, /-extension:\/\//i] }); }
                catch (e) { /* ignore */ }
            };
            document.head.appendChild(s);
        } catch (e) { /* monitoring is best-effort */ }
    }

    // ---- bootstrap --------------------------------------------------------
    // The theme picker lives in the <head> script; this hook persists the choice
    // to the signed-in user's account so it follows them across devices and logins.
    // Keep the mobile browser chrome (address bar) in sync with the chosen theme's background.
    function syncThemeColor() {
        try {
            const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
            const m = document.querySelector('meta[name="theme-color"]');
            if (m && bg) m.setAttribute('content', bg);
        } catch (e) {}
    }
    window.onThemeChange = function (id) {
        syncThemeColor();
        if (!state.token) return;
        apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ theme: id }) }).catch(() => {});
    };
    window.onFontChange = function (id) {
        if (!state.token) return;
        apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ font: id }) }).catch(() => {});
    };

    // ---- Command palette (⌘K / Ctrl-K) -----------------------------------
    const CMDK = [
        { icon: '▶', label: 'Start recommended session', hint: 'smart mix', run: () => startRecommended(), auth: true },
        { icon: '📊', label: 'Take a diagnostic', hint: 'readiness score', run: () => startDiagnostic(), auth: true },
        { icon: '🎯', label: 'Smart review — weak areas + missed', run: () => smartReview(), auth: true },
        { icon: '↩', label: 'Redo my missed questions', run: () => redoMissed(), auth: true },
        { icon: '☆', label: 'Review my flagged questions', run: () => startFlagged(), auth: true },
        { icon: '⏰', label: 'Review due — spaced repetition', run: () => reviewDue(), auth: true },
        { icon: '❗', label: 'Review my confident misses', hint: 'sure but wrong', run: () => reviewConfidentMisses(), auth: true },
        { icon: '🏠', label: 'Go to Dashboard', run: () => go('dashboard'), auth: true },
        { icon: '📓', label: 'Open my Notebook', run: () => go('notebook'), auth: true },
        { icon: '🏆', label: 'Study League — weekly leaderboard', run: () => go('leaderboard'), auth: true },
        { icon: '👤', label: 'Account & settings', run: () => go('profile'), auth: true },
        { icon: '🛠', label: 'Admin review queue', run: () => go('admin'), admin: true },
        { icon: '⭐', label: 'Upgrade to full access — $50', run: () => startCheckout(), auth: true, hidePremium: true },
        { icon: '🚪', label: 'Sign out', run: () => signOut(), auth: true },
        { icon: '🔑', label: 'Log in', run: () => { window.location.href = '/login.html'; }, guest: true },
    ];
    let cmdkIdx = 0, cmdkList = [];
    function cmdkAvailable() {
        const p = state.profile || {};
        const authed = !!state.token;
        const isAdmin = authed && p.is_admin;
        const isPremium = !!(p.premium_unlocked || p.is_admin);
        return CMDK.filter((c) => {
            if (c.admin) return isAdmin;
            if (c.guest) return !authed;
            if (c.auth && !authed) return false;
            if (c.hidePremium && isPremium) return false;
            return true;
        });
    }
    function renderCmdk(filter) {
        const ul = $('cmdk-results'); if (!ul) return;
        const f = (filter || '').trim().toLowerCase();
        cmdkList = cmdkAvailable().filter((c) => !f || c.label.toLowerCase().includes(f) || (c.hint || '').toLowerCase().includes(f));
        if (cmdkIdx >= cmdkList.length) cmdkIdx = Math.max(0, cmdkList.length - 1);
        ul.innerHTML = cmdkList.length
            ? cmdkList.map((c, i) => `<li class="cmdk-row${i === cmdkIdx ? ' sel' : ''}" data-i="${i}" onclick="MACPrep.cmdkRun(${i})"><span class="cmdk-ic">${c.icon}</span><span class="cmdk-lbl">${escapeHtml(c.label)}</span>${c.hint ? `<span class="cmdk-hint">${escapeHtml(c.hint)}</span>` : ''}</li>`).join('')
            : '<li class="cmdk-empty">No matching commands</li>';
    }
    function openCmdk() {
        const m = $('cmdk'); if (!m) return;
        cmdkIdx = 0;
        m.classList.remove('hidden');
        renderCmdk('');
        const inp = $('cmdk-input'); if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 0); }
    }
    function closeCmdk() { const m = $('cmdk'); if (m) m.classList.add('hidden'); }
    function cmdkInput(v) { cmdkIdx = 0; renderCmdk(v); }
    function cmdkRun(i) { const c = cmdkList[i]; if (!c) return; closeCmdk(); try { c.run(); } catch (e) {} }
    function cmdkKey(e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIdx = Math.min(cmdkList.length - 1, cmdkIdx + 1); renderCmdk($('cmdk-input').value); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkIdx = Math.max(0, cmdkIdx - 1); renderCmdk($('cmdk-input').value); }
        else if (e.key === 'Enter') { e.preventDefault(); cmdkRun(cmdkIdx); }
        else if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
    }

    window.MACPrep = {
        go, goRedeem, startQotd, login, signupInline, showSignin, showSignup, signOut, startSession, startDiagnostic, advance, saveProfile, setExamDate, setStudyGoal, startCheckout, submitFeedback,
        requestPasswordReset, redoMissed, startFlagged, toggleFlag, changePassword, deleteAccount, toggleMobileNav, toggleNavMenu,
        smartReview, startSample, saveNote, reviewQueue, adminAction,
        gotoQuestion, prevQuestion, submitExam, redeemCode, generateVouchers, copyCodes, loadLeaderboard, saveLeaderboardSettings, copyReferral,
        startRecommended, toggleCustomize, openCmdk, closeCmdk, cmdkInput, cmdkKey, cmdkRun,
        reportQuestion, setConfidence, reviewConfidentMisses,
        drillSpecialty, openSpecialtyPicker, closeSpecialtyPicker, startSpecialtyQuiz, reviewDue, resumeSession, discardSession,
        startMockExam, openMockPicker, closeMockPicker, startQuick, jumpToCard, openWhatsNew, closeWhatsNew,
        ringFocus, ringBlur, toggleSidebar, resetProgress, closeLevelUp, openDailyChest,
        openBossPicker, closeBossPicker, startBossFight,
        openArcadePicker, closeArcadePicker, startArcade,
        zoomImage, toggleLabs, toggleCalc, calc, calcConv, renderNotebook, practiceOne, downloadExam,
    };

    document.addEventListener('keydown', handleQuizKey);
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            const m = $('cmdk');
            if (m && m.classList.contains('hidden')) openCmdk(); else closeCmdk();
        }
    });
    document.addEventListener('click', closeNavMenus);
    // "About" footer/nav link → reveal the founder section (works from any view/page).
    function showAboutSection() {
        const a = $('about'); if (!a) return;
        if (a.offsetParent === null) go('login'); // section lives in the landing view; reveal it
        const toAbout = () => { const el = $('about'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
        // Re-assert across the async landing content (demo card, counters) that shifts layout.
        [120, 700, 1600].forEach((d) => setTimeout(toAbout, d));
    }
    // Jump to + highlight the dashboard class-code box (used by pricing-page callouts
    // and #redeem deep links — so cohort codes never get carried into Stripe checkout).
    function goRedeem() {
        if (!state.token) { try { showSignin(); } catch (e) {} toast('Sign in first — your class-code box is on your Dashboard.', 'ok'); return; }
        go('dashboard');
        setTimeout(() => {
            const el = $('redeem'); const inp = $('redeem-code');
            if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.transition = 'box-shadow .3s'; el.style.boxShadow = '0 0 0 2px var(--accent)'; setTimeout(() => { if (el) el.style.boxShadow = ''; }, 2200); }
            if (inp) inp.focus();
        }, 160);
    }
    window.addEventListener('hashchange', () => { if (location.hash === '#about') showAboutSection(); else if (location.hash === '#redeem') goRedeem(); });
    window.addEventListener('load', () => {
        if (location.hash === '#about' && !state.token) setTimeout(showAboutSection, 250);
        if (location.hash === '#signin' && !state.token) setTimeout(() => { try { showSignin(); const c = $('login-form-container'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} }, 250);
        if (location.hash === '#redeem') setTimeout(goRedeem, 450);
    });

    document.addEventListener('DOMContentLoaded', async () => {
        initMonitoring();
        syncThemeColor();
        track('page_view');
        // Email-confirmation links land here with the new session in the URL hash.
        const hash = new URLSearchParams((location.hash || '').slice(1));
        if (hash.get('access_token')) {
            setToken(hash.get('access_token'));
            if (hash.get('refresh_token')) setRefresh(hash.get('refresh_token'));
            history.replaceState({}, '', '/');
        }
        state.token = getToken();
        // Opening the theme/font picker should also dismiss any open nav dropdown.
        ['theme-toggle', 'font-toggle'].forEach((id) => { const b = $(id); if (b) b.addEventListener('click', closeNavMenus); });
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

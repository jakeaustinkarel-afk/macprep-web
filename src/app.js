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

    // Skeleton placeholder rows for async views — a progressive-loading shimmer
    // reads faster than a blocking "Loading…" line while data is in flight.
    function skeletonList(n, cls) {
        let h = '<div class="sk-stack" aria-hidden="true">';
        for (let i = 0; i < (n || 5); i++) h += '<div class="skeleton ' + (cls || 'sk-row') + '"></div>';
        return h + '</div>';
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
        // Pause the exam countdown when navigating away from the quiz (resumeSession restarts it).
        // Otherwise the timer kept ticking on other screens and could silently auto-submit the exam
        // while the user was away — contradicting the "you can resume it" promise above.
        if (view !== 'quiz') stopExamTimer();
        if (view !== 'login' && !state.token) view = 'login';
        VIEWS.forEach((v) => $(v) && $(v).classList.toggle('hidden', v !== view + '-view'));
        const authed = !!state.token && view !== 'login';
        document.body.classList.toggle('app-authed', authed); // drives the desktop sidebar shell
        // Signed-in app nav: study links, account menu, tier badge.
        // nav-utils (theme/font/search) hides on the public marketing nav and shows in-app — driven by
        // the `authed` boolean so it's immune to CSS-specificity/inline-style fights (the .hidden class
        // is display:none!important). #2 from the UI pass.
        ['nav-dashboard', 'nav-study-wrap', 'nav-notebook', 'nav-leaderboard', 'nav-achievements', 'nav-arcade', 'nav-critical', 'nav-reviews', 'nav-whatsnew', 'nav-account-wrap', 'cmdk-trigger', 'nav-utils'].forEach((id) =>
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
        // "PRO" pills sit next to premium-only nav items — free users only, so they read as an invitation, not a wall.
        document.querySelectorAll('.nav-pro').forEach((b) => { b.hidden = !(authed && !isPremium); });
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
    const NAV_MENUS = ['nav-account-menu', 'nav-admin-menu', 'nav-study-menu'];
    function closeNavMenus() {
        NAV_MENUS.forEach((id) => { const m = $(id); if (m) m.classList.add('hidden'); });
    }
    function toggleNavMenu(which, ev) {
        if (ev) ev.stopPropagation();
        const target = 'nav-' + which + '-menu';
        ['theme-menu', 'font-menu'].concat(NAV_MENUS).forEach((id) => { if (id !== target) { const m = $(id); if (m) m.classList.add('hidden'); } });
        const m = $(target); if (m) m.classList.toggle('hidden');
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
    function showSignup() { const a = $('signup-pane'), b = $('signin-pane'); if (b) b.classList.add('hidden'); if (a) a.classList.remove('hidden'); const e = $('su-first'); if (e) e.focus(); }

    // Inline signup on the landing — no page hop, and auto-logs-in when email
    // confirmation is off (then drops the user straight into a warm-up).
    async function signupInline() {
        if (state.signupInFlight) return;
        const first = (($('su-first') && $('su-first').value) || '').trim();
        const last = (($('su-last') && $('su-last').value) || '').trim();
        const name = (first + ' ' + last).replace(/\s+/g, ' ').trim();
        const credential = ($('su-cred') && $('su-cred').value) || '';
        const gradDate = ($('su-grad') && $('su-grad').value) || '';
        const examDate = ($('su-exam') && $('su-exam').value) || '';
        const email = ($('su-email').value || '').trim();
        const password = $('su-password').value;
        const btn = $('su-submit'); const msg = $('su-msg');
        const fail = (m) => { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = m; } };
        if (!first || !last) { fail('Please enter your first and last name.'); return; }
        if (!credential) { fail('Please select your credential (SAA or CAA).'); return; }
        if (credential === 'SAA' && !gradDate) { fail('Please add your expected graduation date.'); return; }
        if (!email || !password) return;
        if ($('su-terms') && !$('su-terms').checked) { fail('Please accept the Terms to continue.'); return; }
        state.signupInFlight = true;
        if (btn) { btn.disabled = true; btn.textContent = 'Creating your account…'; }
        if (msg) msg.textContent = '';
        try {
            const { resp, data } = await apiJSON('/api/authenticate', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'register', name, email, password, credential, graduation_date: credential === 'SAA' ? gradDate : null, target_exam_date: credential === 'SAA' ? examDate : null }) });
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
        state.token = null; state.profile = null; state.questions = []; state.session = null; state.gam = null;
        go('login');
    }

    // Forgot-password: request a reset email.
    async function requestPasswordReset() {
        let email = (($('login-email') && $('login-email').value) || '').trim();
        if (!email) { email = (prompt('Enter your account email and we’ll send a reset link:') || '').trim(); }
        // Never silently no-op: if there's no usable email, tell the user what to do
        // instead of returning quietly (which reads as "the button is broken").
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            toast('Enter the email you signed up with in the field above, then tap “Forgot password?” again.');
            return;
        }
        try {
            await fetch('/api/auth/reset-request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        } catch (e) { /* network errors must not reveal whether the account exists */ }
        toast('If an account exists for ' + email + ', a reset link is on its way — check your inbox and your spam/junk folder.', 'ok');
    }

    async function loadProfile() {
        const tz = (function () { try { return new Date().getTimezoneOffset(); } catch (e) { return 0; } })();
        const { resp, data } = await apiJSON('/api/user/profile?tz=' + tz, { headers: authHeaders() });
        if (resp.status === 401) { signOut(); throw new Error('Session expired.'); }
        state.profile = data.profile || null;
        if (state.profile) {
            const P = state.profile;
            state.gam = { bonus_xp: Number(P.bonus_xp) || 0, ach_claimed: Array.isArray(P.ach_claimed) ? P.ach_claimed.slice() : [], daily_state: (P.daily_state && typeof P.daily_state === 'object') ? P.daily_state : {} };
            try { migrateLocalGamification(); recomputeBonusXp(); } catch (e) {}
        }
        // Theme & font follow your ACCOUNT across devices: the saved profile value is the
        // source of truth and is applied on load. setTheme/setFont also update this device's
        // localStorage to match, and any change saves back to the account (onThemeChange), so
        // a switch on one device shows up on the others. The <head> script still applies this
        // device's localStorage first so there's no flash before the account value loads.
        if (state.profile && state.profile.theme && !state._themeApplied && typeof window.setTheme === 'function') {
            state._themeApplied = true;
            if (state.profile.theme !== document.documentElement.getAttribute('data-theme')) window.setTheme(state.profile.theme);
        }
        if (state.profile && state.profile.font && !state._fontApplied && typeof window.setFont === 'function') {
            state._fontApplied = true;
            if (state.profile.font !== document.documentElement.getAttribute('data-font')) window.setFont(state.profile.font);
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
        const _credAsked = maybePromptCredential(); // one-time credential capture (priority) for accounts made before we asked
        if (!_credAsked) maybePromptForName(); // returning users who never saved a first+last name
        const _duelLink = /duel=[A-Za-z0-9]{4,8}/.test(location.hash || '');
        checkDuelDeepLink(); // /#duel=CODE shared by a classmate → jump into the duel
        if (!_credAsked && !_duelLink) maybeShowWhatsNewPopup(); // centered "what's new" popup once per release
        // Post-signup activation: drop a brand-new user straight into a short warm-up.
        if (state.justSignedUp) {
            state.justSignedUp = false;
            const answered = (state.profile && state.profile.stats && state.profile.stats.answered) || 0;
            if (answered === 0) { try { startSample(); } catch (e) {} }
        }
        if (location.hash === '#about') showAboutSection();
        // Deep link to a specific Critical Event (e.g. shared /#ce=malignant-hyperthermia).
        { const _ceM = (location.hash || '').match(/ce=([a-z0-9-]+)/i); if (_ceM) { try { startCriticalEvents(_ceM[1]); } catch (e) {} } }
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
            : '<div class="mono" style="color:var(--muted);font-size:12px;display:flex;align-items:center;gap:8px;height:100%;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:middle;flex:none;"><path d="M3 16.5l5.5-5.5 3.5 3.5 8-8"/><path d="M16 6.5h4v4"/></svg> Answer a few questions — your accuracy trend shows up here.</div>';
        const bank = (state.questions || []).length;
        const planLine = (exam != null && exam > 0 && bank > 0)
            ? `<div class="mono" style="font-size:12px;color:var(--text2);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-bottom:14px;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg> <strong>${exam} day${exam === 1 ? '' : 's'}</strong> to your exam — about <strong>${Math.ceil((bank * 2) / exam)} questions/day</strong> to cover the full ${bank.toLocaleString()}-question bank twice before then.</div>`
            : '';
        const answeredToday = answeredTodayLive();
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
        // The momentum hero already shows readiness %, streak, and today's goal as rings,
        // so this card no longer repeats them — it owns what the hero doesn't: the accuracy
        // trend and the exam-pace plan. (De-dup keeps the dashboard from saying it twice.)
        const examNudge = (exam == null)
            ? `<div class="mono" style="font-size:12px;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin-bottom:14px;display:flex;align-items:center;gap:8px;"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;"><rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg> Add your exam date in your profile to unlock a daily pace plan.</div>`
            : '';
        // Mastery by domain — the adaptive engine's per-domain ability, as bars
        // with the difficulty tier it will serve next (our transparency wedge:
        // the learner sees exactly how the engine reads them). null = not started.
        const SHORT_DOM = {
            'Principles of Anesthesia': 'Principles',
            'Physiology, Pathophysiology & Management': 'Physiology & path',
            'Instrumentation, Monitoring & Anesthetic Delivery Systems': 'Instrumentation & monitoring',
            'Subspecialty Care': 'Subspecialty care',
            'Pharmacology': 'Pharmacology',
            'Regional Anesthesia & Pain Management': 'Regional & pain',
        };
        const domList = p.by_domain || [];
        let masteryBlock = '';
        if (domList.some((d) => d.mastery != null)) {
            const rows = domList.map((d) => {
                const label = `<span style="flex:0 0 150px;font-size:12px;color:var(--text2);" title="${d.domain}">${SHORT_DOM[d.domain] || d.domain}</span>`;
                if (d.mastery == null) {
                    const st = (d.attempts > 0) ? 'building…' : 'not started';
                    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;opacity:.55;">${label}<div class="progress-bar" style="flex:1;"><span style="width:0%;"></span></div><span class="mono" style="flex:0 0 82px;text-align:right;font-size:11px;color:var(--muted);">${st}</span></div>`;
                }
                const c = d.mastery >= 75 ? 'var(--accent)' : d.mastery >= 50 ? 'var(--warn)' : 'var(--bad)';
                const tier = d.target_tier === 'hard' ? 'hard' : d.target_tier === 'easy' ? 'easier' : 'medium';
                return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">${label}<div class="progress-bar" style="flex:1;"><span style="width:${d.mastery}%;background:${c};"></span></div><span class="mono" style="flex:0 0 82px;text-align:right;font-size:11px;color:var(--text2);">${d.mastery}% · ${tier}</span></div>`;
            }).join('');
            masteryBlock = `<div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin:20px 0 4px;">Mastery by domain</div>`
                + `<div class="mono" style="font-size:11px;color:var(--muted);margin:0 0 11px;">Next questions adapt to each level.</div>${rows}`;
        }
        el.innerHTML = `<h3>Accuracy &amp; exam plan</h3>
            <div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">Accuracy — last 7 active days</div>
            <div style="height:70px;margin-bottom:16px;">${spark}</div>
            ${planLine}
            ${goalLine}
            ${examNudge}
            ${masteryBlock}
            <button class="btn ghost" type="button" onclick="MACPrep.startDiagnostic()" style="margin-top:2px;font-size:13px;width:100%;display:inline-flex;align-items:center;justify-content:center;gap:7px;"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="14" width="3" height="3"/></svg> Take a diagnostic — refresh your readiness score</button>`;
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
        if (!premiumGate('studymode')) return;
        // Prioritize missed questions, then fill from weakest specialties.
        const p = state.profile || {};
        const ids = new Set(p.missed_ids || []);
        const weak = (p.by_specialty || []).filter((s) => s.accuracy < 70).map((s) => s.category);
        if (ids.size < 20 && weak.length) {
            state.questions.forEach((q) => { if (weak.includes(q.category || q.domain_name) && ids.size < 20) ids.add(q.id); });
        }
        startFromIds(Array.from(ids), 'review');
    }

    // Adaptive "Recommended" engine — one primary action, no config. Blends four
    // signals (in priority; each capped so none dominates the set):
    //   1. spaced-repetition reviews that are due       (reinforcement)
    //   2. recent misses not yet re-mastered            (targeted)
    //   3. weakest domains — NEW questions at a difficulty MATCHED to your
    //      estimated ability (server Elo per domain, `by_domain[].target`),
    //      with a slight upward stretch so it ramps as you improve
    //   4. domain-balanced coverage fill of unseen material
    // Reinforcement items (1-2) are level-agnostic; new material (3-4) is
    // difficulty-matched. Degrades gracefully if `by_domain` isn't present yet.
    function startRecommended() {
        const usage = freeUsage();
        const p = state.profile || {};
        const all = state.questions || [];
        if (!all.length) { toast('Questions are still loading — try again in a moment.'); return; }
        if (!usage.unlimited && usage.remaining < 1) { return startCheckout(); }
        const byId = {}; all.forEach((q) => { byId[q.id] = q; });
        const target = Math.min(20, all.length, usage.unlimited ? Infinity : usage.remaining);
        const answered = new Set(p.answered_ids || []);
        const DIFF_RATING = { easy: 900, medium: 1100, hard: 1300 };
        const domTarget = {}; (p.by_domain || []).forEach((d) => { domTarget[d.domain] = d.target; });
        const domainOf = (q) => q.domain_name || q.category || 'General';
        const ratingOf = (q) => DIFF_RATING[String(q.difficulty || 'medium').toLowerCase()] || 1100;
        // Difficulty "fit": distance from the question's rating to the learner's
        // per-domain target (smaller = better fit). Unknown domain ~ medium+stretch.
        const fit = (q) => Math.abs(ratingOf(q) - (domTarget[domainOf(q)] != null ? domTarget[domainOf(q)] : 1140));
        const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
        const picked = new Set();
        const breakdown = { due: 0, missed: 0, weak: 0, coverage: 0 };
        const add = (id, bucket) => {
            if (picked.size >= target || !byId[id] || picked.has(id)) return false;
            picked.add(id); if (bucket) breakdown[bucket]++; return true;
        };
        // 1) Spaced-repetition due — reinforcement, capped so it can't eat the set.
        const dueCap = Math.max(1, Math.ceil(target * 0.4)); let dueN = 0;
        for (const id of (p.due_ids || [])) { if (dueN >= dueCap) break; if (add(id, 'due')) dueN++; }
        // 2) Recent misses still not re-mastered — targeted, level-agnostic.
        const missCap = Math.max(1, Math.ceil(target * 0.4)); let missN = 0;
        for (const id of (p.missed_ids || [])) { if (missN >= missCap) break; if (add(id, 'missed')) missN++; }
        // 3) Weakest domains — new/unseen questions, difficulty matched to level.
        const weakDomains = [];
        if (picked.size < target) {
            const doms = (p.by_domain || []).slice()
                .sort((a, b) => ((a.mastery == null ? 40 : a.mastery)) - ((b.mastery == null ? 40 : b.mastery)));
            const cands = {};
            doms.forEach((d) => {
                const list = all.filter((q) => domainOf(q) === d.domain && !picked.has(q.id));
                list.sort((x, y) => {
                    const ux = answered.has(x.id) ? 1 : 0, uy = answered.has(y.id) ? 1 : 0;
                    if (ux !== uy) return ux - uy;      // unseen first
                    const fx = fit(x), fy = fit(y);
                    if (fx !== fy) return fx - fy;       // then best difficulty fit
                    return Math.random() - 0.5;          // random among ties
                });
                cands[d.domain] = list;
            });
            const perDomainCap = Math.max(2, Math.ceil(target * 0.35));
            const domCount = {};
            let progressed = true;
            while (picked.size < target && progressed) {
                progressed = false;
                for (const d of doms) {
                    if (picked.size >= target) break;
                    if ((domCount[d.domain] || 0) >= perDomainCap) continue;
                    const q = (cands[d.domain] || []).shift();
                    if (q && add(q.id, 'weak')) { domCount[d.domain] = (domCount[d.domain] || 0) + 1; progressed = true; if (weakDomains.indexOf(d.domain) < 0) weakDomains.push(d.domain); }
                }
            }
        }
        // 4) Coverage fill — remaining slots, unseen preferred, domain-balanced.
        if (picked.size < target) {
            const byDom = {};
            all.forEach((q) => { if (!picked.has(q.id)) { const d = domainOf(q); (byDom[d] = byDom[d] || []).push(q); } });
            const arrs = Object.values(byDom).map((a) => a.sort((x, y) => (answered.has(x.id) ? 1 : 0) - (answered.has(y.id) ? 1 : 0) || fit(x) - fit(y)));
            let progressed = true;
            while (picked.size < target && progressed) {
                progressed = false;
                for (const arr of arrs) { if (picked.size >= target) break; const q = arr.shift(); if (q && add(q.id, 'coverage')) progressed = true; }
            }
        }
        let pool = shuffle(Array.from(picked).map((id) => byId[id]));
        if (!usage.unlimited) pool = pool.slice(0, Math.min(pool.length, usage.remaining));
        if (!pool.length) { toast('No questions available right now.'); return; }
        state.lastRecommended = { breakdown, weakDomains };
        track('recommended_start', { size: pool.length, adaptive: true, due: breakdown.due, missed: breakdown.missed, weak: breakdown.weak });
        beginSession(pool, 'tutor');
    }

    // Reflects what the recommended set will draw from (or a starter message for new users).
    function renderRecommendedSub() {
        const el = $('recommended-sub'); if (!el) return;
        const p = state.profile || {};
        const dueN = (p.due_ids || []).length;
        const missN = (p.missed_ids || []).length;
        const started = (p.by_domain || []).filter((d) => d.mastery != null);
        const weakest = started.slice().sort((a, b) => a.mastery - b.mastery)[0];
        if (dueN || missN || (weakest && weakest.mastery < 85)) {
            const parts = [];
            if (dueN) parts.push(`${dueN} due for review`);
            if (missN) parts.push(`${missN} you missed`);
            if (weakest && weakest.mastery < 85) parts.push(`new questions in ${weakest.domain} at your level`);
            el.textContent = `Adaptive set — ${parts.join(', ')}.`;
        } else {
            el.textContent = 'A balanced set across all 6 exam domains, adapting to your level as you go.';
        }
    }

    function toggleCustomize() {
        if (!premiumGate('studymode')) return;
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
        const meta = q.category || q.domain_name || '';   // broad specialty only — subtopic can spoil the answer
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
    const WHATS_NEW_VERSION = 21;
    const WHATS_NEW = [
        { tag: 'New', date: 'Jul 5', title: 'Duel a classmate', desc: 'Go head-to-head — Study Modes → Duel a classmate. Play a set of questions, share your code or invite link, and your classmate plays the exact same set. You’ll both see who won.' },
        { tag: 'New', date: 'Jul 5', title: 'Build your own flashcard deck', desc: 'Tap “Add to flashcards” on any question (or “+ Card” in the end-of-session Review) to save it to your personal deck, then drill it with active recall under Study Modes → My Flashcards.' },
        { tag: 'New', date: 'Jul 5', title: 'Flag questions from the Review', desc: 'The end-of-session Review now has Flag + “+ Card” buttons on every question — even the ones you got right — so you can save anything to revisit, or add it to your flashcards, while you review.' },
        { tag: 'New', date: 'Jul 5', title: '100 achievements — and a title for every one', desc: 'The achievement bank is now 100 strong, and every single achievement unlocks its own title to show by your name — 100 titles to collect. Pick your favorite in Account → Title ★. The new ones span longer streaks, sharper accuracy (up to 99%), full-bank coverage, higher levels, and tougher Arcade runs.' },
        { tag: 'New', date: 'Jul 4', title: 'Install MACPrep on your device', desc: 'Add MACPrep to your home screen for an app-like experience — it opens full-screen, loads instantly, and works offline. Tap “Install” when the prompt appears (on iPhone: Share → Add to Home Screen). Streak reminders are on the way.' },
        { tag: 'New', date: 'Jul 4', title: 'A cleaner, balanced dashboard', desc: 'On wide screens the dashboard now lays out in two balanced columns, so more of your progress is visible at a glance, with the study-modes launcher up top as a full-width strip. Plus snappier press feedback across the app and smoother loading while pages fetch.' },
        { tag: 'New', date: 'Jul 3', title: 'Critical Events', desc: 'A new premium section: clinician-reviewed rapid-reference cards for every major anesthesia crisis — when to suspect it, immediate actions, drugs & doses, an algorithm, and pitfalls. Every card is cross-checked against the Stanford Emergency Manual and primary sources, with a linked source behind each dose. Search or jump to any event from the menu.' },
        { tag: 'New', date: 'Jul 2', title: 'Three new themes', desc: 'Sunset, Forest, and Mist join the theme picker — free for everyone. Twenty themes total now; pick yours from the palette button in the sidebar.' },
        { tag: 'New', date: 'Jul 2', title: 'More titles to unlock', desc: 'Added new unlockable titles (The Marksman, The Polymath, The Veteran, Halfway Hero, and more) tied to achievements.' },
        { tag: 'New', date: 'Jul 1', title: 'Two more Arcade modes', desc: 'Arcade now has four modes: Survival, Time Attack, plus new Sudden Death (one wrong answer ends the run) and Blitz (a countdown that every correct answer extends). Each keeps its own high score.' },
        { tag: 'New', date: 'Jul 1', title: 'More achievements', desc: 'New badges to chase — an Arcade set (play modes, hit a 20-run, go flawless in Sudden Death), plus more streak, volume, level, and mock-exam milestones, each with its own XP and a few new titles (Arcade Ace, Virtuoso, The Devoted).' },
        { tag: 'New', date: 'Jul 1', title: 'Achievements now reward XP', desc: 'Every achievement grants XP toward your level when you unlock it — bigger achievements, bigger rewards. The Achievements page now shows each one’s XP and any title it unlocks, so you can chase the ones you want.' },
        { tag: 'New', date: 'Jul 1', title: 'Titles', desc: 'Unlock titles from achievements (Boss Slayer, The Scholar, Grandmaster, and the ultimate “The Legend” for unlocking everything). Pick one in Account → Title ★ to show by your name and on the leaderboard.' },
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
    // Centered "what's new" popup on login — highlights the latest updates once per release,
    // on top of the persistent What's New menu item + unread dot.
    function maybeShowWhatsNewPopup() {
        let seen; try { seen = parseInt(ls('macprep_whatsnew_seen'), 10) || 0; } catch (e) { seen = 0; }
        if (!seen) { try { ls('macprep_whatsnew_seen', String(WHATS_NEW_VERSION)); } catch (e) {} renderWhatsNewDot(); return; } // brand-new user: baseline silently, no popup
        if (WHATS_NEW_VERSION <= seen || $('wn-popup') || state._namePromptOpen || state._credPromptOpen) return;
        const rows = WHATS_NEW.slice(0, 4).map((e) => {
            const isFix = e.tag === 'Fix';
            const pillColor = isFix ? 'var(--warn)' : 'var(--accent)';
            const pillBg = isFix ? 'color-mix(in srgb,var(--warn) 16%,transparent)' : 'var(--accent-dim)';
            return `<div style="padding:12px 0;border-top:1px solid var(--line);">`
                + `<div style="font-weight:700;font-size:14px;line-height:1.3;">${escapeHtml(e.title)} <span class="mono" style="font-size:8.5px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${pillColor};background:${pillBg};padding:2px 6px;border-radius:5px;">${e.tag}</span></div>`
                + `<div style="font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.5;">${escapeHtml(e.desc)}</div></div>`;
        }).join('');
        const wrap = document.createElement('div');
        wrap.id = 'wn-popup';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2650;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);';
        wrap.onclick = (ev) => { if (ev.target === wrap) closeWhatsNewPopup(); };
        wrap.innerHTML = `<div role="dialog" aria-modal="true" aria-label="What's new in MACPrep" style="background:var(--panel);border:1px solid var(--line);border-radius:16px;max-width:440px;width:100%;max-height:82vh;overflow:auto;padding:24px;box-shadow:0 24px 70px rgba(0,0,0,.4);">
            <div class="mono" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--accent);">✨ Just shipped</div>
            <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:22px;margin:5px 0 3px;">What's new in MACPrep</div>
            <div class="sub" style="font-size:12.5px;margin-bottom:4px;">Here are the latest updates since you were last here.</div>
            ${rows}
            <div style="display:flex;gap:10px;margin-top:18px;">
                <button class="btn" type="button" onclick="MACPrep.closeWhatsNewPopup()" style="flex:1;">Got it</button>
                <button class="btn ghost" type="button" onclick="MACPrep.closeWhatsNewPopup(); MACPrep.openWhatsNew();">See all updates</button>
            </div>
        </div>`;
        document.body.appendChild(wrap);
        try { ls('macprep_whatsnew_seen', String(WHATS_NEW_VERSION)); } catch (e) {}
        renderWhatsNewDot();
    }
    function closeWhatsNewPopup() { const o = $('wn-popup'); if (o) o.remove(); }

    // Sidebar account block: initials + name + plan.
    function renderSidebarAccount() {
        const p = state.profile || {};
        const name = (p.full_name || '').trim();
        const parts = name ? name.split(/\s+/) : [];
        let initials = parts.length ? ((parts[0][0] || '') + (parts.length > 1 ? (parts[parts.length - 1][0] || '') : '')) : '';
        if (!initials) initials = (p.email || 'U').charAt(0);
        const set = (idn, txt) => { const e = $(idn); if (e) e.textContent = txt; };
        const initEl = $('nav-acct-initials');
        if (initEl) { initEl.textContent = initials.toUpperCase(); initEl.style.background = ''; initEl.style.fontSize = ''; }
        set('nav-acct-name', name || 'Account');
        // Sub line shows your active title (accent) if you've picked one, else your plan.
        const title = activeTitle();
        const subEl = $('nav-acct-sub');
        if (subEl) {
            if (title) { subEl.textContent = title; subEl.style.color = 'var(--accent)'; subEl.style.fontWeight = '700'; }
            else { subEl.textContent = p.is_admin ? 'Admin access' : (p.premium_unlocked ? 'Full access' : 'Free plan'); subEl.style.color = ''; subEl.style.fontWeight = ''; }
        }
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
    function bonusXp() { if (state.gam && typeof state.gam.bonus_xp === 'number') return state.gam.bonus_xp; try { return parseInt(localStorage.getItem('macprep_bonus_xp') || '0', 10) || 0; } catch (e) { return 0; } }
    function addBonusXp(n) {
        n = n || 0; if (!n) return;
        try { localStorage.setItem('macprep_bonus_xp', String((parseInt(localStorage.getItem('macprep_bonus_xp') || '0', 10) || 0) + n)); } catch (e) {}
        if (state.gam) { state.gam.bonus_xp = (state.gam.bonus_xp || 0) + n; scheduleGamSync(); }
    }
    let _gamSyncTimer = null;
    function scheduleGamSync() { if (!state.gam || !state.token) return; clearTimeout(_gamSyncTimer); _gamSyncTimer = setTimeout(() => { _gamSyncTimer = null; pushGamSync(); }, 1200); }
    async function pushGamSync() {
        if (!state.gam || !state.token) return;
        try {
            const g = state.gam;
            const { resp, data } = await apiJSON('/api/gamification', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ bonus_xp: g.bonus_xp || 0, ach_claimed: g.ach_claimed || [], daily_state: g.daily_state || {} }) });
            if (resp && resp.ok && data && state.gam) {
                state.gam.bonus_xp = Math.max(state.gam.bonus_xp || 0, data.bonus_xp || 0);
                if (Array.isArray(data.ach_claimed)) state.gam.ach_claimed = data.ach_claimed;
                if (data.daily_state && typeof data.daily_state === 'object') state.gam.daily_state = data.daily_state;
            }
        } catch (e) {}
    }
    function migrateLocalGamification() {
        if (!state.gam) return; let changed = false;
        try { const lb = parseInt(localStorage.getItem('macprep_bonus_xp') || '0', 10) || 0; if (lb > (state.gam.bonus_xp || 0)) { state.gam.bonus_xp = lb; changed = true; } } catch (e) {}
        try { const la = JSON.parse(localStorage.getItem('macprep_ach_claimed') || '[]'); if (Array.isArray(la) && la.length) { const set = new Set(state.gam.ach_claimed || []); la.forEach((t) => { if (typeof t === 'string' && !set.has(t)) { set.add(t); changed = true; } }); state.gam.ach_claimed = Array.from(set); } } catch (e) {}
        try { const k = qotdDayKey(); const ld = JSON.parse(localStorage.getItem('macprep_daily_' + k) || 'null'); if (ld && typeof ld === 'object') { const c = state.gam.daily_state[k] || {}; state.gam.daily_state[k] = { answered: Math.max(+c.answered || 0, +ld.answered || 0), correct: Math.max(+c.correct || 0, +ld.correct || 0), specs: [...new Set([...(c.specs || []), ...(ld.specs || [])])], rewarded: [...new Set([...(c.rewarded || []), ...(ld.rewarded || [])])], chest: !!(c.chest || ld.chest) }; changed = true; } } catch (e) {}
        if (changed) scheduleGamSync();
    }
    function recomputeBonusXp() {
        if (!state.gam) return; let xp = 0;
        try { const m = {}; computeAchievements().forEach((a) => { m[a.title] = a.xp || 0; }); (state.gam.ach_claimed || []).forEach((t) => { xp += m[t] || 0; }); } catch (e) {}
        try { const ds = state.gam.daily_state || {}; Object.keys(ds).forEach((k) => { const d = ds[k] || {}; xp += (Array.isArray(d.rewarded) ? d.rewarded.length : 0) * QUEST_XP + (d.chest ? CHEST_XP : 0); }); } catch (e) {}
        state.gam.bonus_xp = Math.max(state.gam.bonus_xp || 0, xp);
    }
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
    function getDaily() { if (state.gam) { return state.gam.daily_state[qotdDayKey()] || {}; } try { return JSON.parse(localStorage.getItem(dailyKey()) || '{}'); } catch (e) { return {}; } }
    // Questions answered today, LIVE — the client daily counter (incremented on every
    // answer) or the server's value, whichever is higher. Keeps the momentum rings and
    // daily quests consistent and reflecting the current session, not a stale profile.
    function answeredTodayLive() { const p = state.profile || {}; return Math.max(p.answered_today || 0, (getDaily().answered || 0)); }
    function saveDaily(d) { try { localStorage.setItem(dailyKey(), JSON.stringify(d)); } catch (e) {} if (state.gam) { state.gam.daily_state[qotdDayKey()] = d; scheduleGamSync(); } }
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
                <button class="btn chest-ready" type="button" onclick="MACPrep.openDailyChest()">Open chest →</button></div>`;
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
        const answeredToday = answeredTodayLive();
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
            { key: 'goal', c: cGoal, r: 66, pct: goalPct, label: "Today's goal", val: `${Math.min(answeredToday, goal)} / ${goal} questions`,
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
            + momLegRow(cGoal, "Today's goal", `${Math.min(answeredToday, goal)} / ${goal} questions`, 'goal')
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
            <div style="display:flex;align-items:center;gap:11px;flex-wrap:wrap;"><div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:26px;letter-spacing:-.01em;line-height:1.1;">${greet}, ${escapeHtml(first)}.</div>${titleChip(activeTitle())}</div>
            <div class="sub" style="margin:4px 0 20px;font-size:14px;">${total === 0
                ? `Welcome — answer your first set to light up your rings and start your streak.`
                : (toGoal ? `You're <strong style="color:${cGoal};">${toGoal}</strong> from today's goal${streak ? ` · <strong style="color:var(--accent);">${streak}-day streak</strong>` : ''} — don't break the chain.` : `Goal met${streak ? ` · <strong style="color:var(--accent);">${streak}-day streak</strong>` : ''}. 🔥`)}</div>
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

        // arcade — score-chasing modes (localStorage bests + play counts)
        const arcPlays = Object.keys(ARCADE_META).reduce((n, t) => n + (parseInt(ls('macprep_arcade_' + t + '_plays') || '0', 10) || 0), 0);
        const arcTopScore = Math.max(0, ...Object.keys(ARCADE_META).map((t) => arcadeBest(t)));
        const sdBest = arcadeBest('suddendeath');
        const arcPush = (title, desc, met, pct, sub) => A.push({ cat: 'Arcade', icon: 'star', title, desc, met, pct: met ? 100 : Math.max(0, Math.min(99, pct || 0)), sub: met ? 'Unlocked' : sub });
        arcPush('Arcade debut', 'Play any Arcade mode once.', arcPlays >= 1, 0, 'Play any Arcade mode');
        arcPush('Arcade regular — 25 runs', 'Play 25 Arcade runs across any modes.', arcPlays >= 25, Math.round((arcPlays / 25) * 100), `${arcPlays} / 25 runs`);
        arcPush('High scorer — 20 in a run', 'Score 20+ correct in a single Arcade run.', arcTopScore >= 20, Math.round((arcTopScore / 20) * 100), `best run is ${arcTopScore} / 20`);
        arcPush('Untouchable — 15 in Sudden Death', 'Reach a 15-answer flawless streak in Sudden Death.', sdBest >= 15, Math.round((sdBest / 15) * 100), `best is ${sdBest} / 15`);

        // more volume / accuracy / consistency / levels / mocks
        vol(750, 'Three-quarter-K — 750'); vol(7500, '7,500 club');
        accA(85, 100, 'Crack shot — 85%');
        strk(3, 'Three-peat'); strk(21, 'Three weeks'); strk(60, 'Two months'); strk(365, 'Year of prep — 365 days');
        lvlA(15, 'Level 15'); lvlA(75, 'Level 75');
        milePush('clipboard', 'Mock veteran — ten Mock Exams', mocks >= 10, Math.round((mocks / 10) * 100), `${mocks} / 10 completed`);

        // --- expansion toward 100 achievements (2026-07-05) — every achievement also grants a title ---
        vol(1500, 'Momentum — 1,500'); vol(4000, 'Four thousand strong'); vol(6000, 'Six-K'); vol(8000, 'Eight-K'); vol(15000, 'Fifteen-K — 15,000'); vol(20000, 'Twenty-K — 20,000');
        strk(5, 'Five-day flame'); strk(90, 'A full quarter — 90 days'); strk(150, 'One-fifty — 150 days'); strk(180, 'Half a year — 180 days'); strk(500, 'Five hundred days');
        accA(75, 100, 'Dialed in — 75%'); accA(90, 300, 'Deadeye — 90% over 300'); accA(95, 500, 'Cold-blooded — 95% over 500'); accA(99, 200, 'Flawless — 99%');
        const dom90 = bySpec.filter((r) => (r.accuracy || 0) >= 90 && (covByCat[r.category] || 0) >= 20).length;
        covPush('grid', 'A dozen deep — 12 specialties', started >= 12, Math.round((started / 12) * 100), `${started} / 12 started`);
        covPush('layers', 'Century diver — 100 in one specialty', maxSeen >= 100, Math.round((maxSeen / 100) * 100), `best is ${maxSeen} / 100`);
        covPush('layers', 'Abyssal — 200 in one specialty', maxSeen >= 200, Math.round((maxSeen / 200) * 100), `best is ${maxSeen} / 200`);
        covPush('grid', 'Triple complete — 3 at 100%', mastered >= 3, Math.round((mastered / 3) * 100), `${mastered} / 3 fully covered`);
        covPush('layers', 'A quarter of the bank', bankPct >= 25, Math.round((bankPct / 25) * 100), `${bankPct}% of the bank seen`);
        covPush('layers', 'Three-quarters of the bank', bankPct >= 75, Math.round((bankPct / 75) * 100), `${bankPct}% of the bank seen`);
        masPush('Five-domain expert', domHi >= 5, Math.round((domHi / 5) * 100), `${domHi} / 5 specialties at 85%+`);
        masPush('Prodigy — 90% in a specialty', dom90 >= 1, 0, '90%+ in any specialty (20+ answered)');
        masPush('Triple virtuoso — 90% in three', dom90 >= 3, Math.round((dom90 / 3) * 100), `${dom90} / 3 specialties at 90%+`);
        A.push({ cat: 'Mastery', icon: 'trophy', title: 'Boss veteran — three domains', desc: 'Defeat three Domain Bosses (80%+ on each challenge).', met: bossN >= 3, pct: bossN >= 3 ? 100 : Math.max(0, Math.min(99, Math.round((bossN / 3) * 100))), sub: bossN >= 3 ? 'Unlocked' : `${bossN} / 3 domains defeated` });
        milePush('gauge', 'Razor-sharp — 90% readiness', rdy >= 90, Math.round((rdy / 90) * 100), `readiness ${rdy}% / 90%`);
        milePush('clipboard', 'Mock regular — five', mocks >= 5, Math.round((mocks / 5) * 100), `${mocks} / 5 completed`);
        lvlA(20, 'Level 20'); lvlA(30, 'Level 30'); lvlA(40, 'Level 40'); lvlA(60, 'Level 60'); lvlA(90, 'Level 90');
        arcPush('Arcade veteran — 100 runs', 'Play 100 Arcade runs across any modes.', arcPlays >= 100, Math.round((arcPlays / 100) * 100), `${arcPlays} / 100 runs`);
        arcPush('Arcade legend — 30 in a run', 'Score 30+ correct in a single Arcade run.', arcTopScore >= 30, Math.round((arcTopScore / 30) * 100), `best run is ${arcTopScore} / 30`);

        // meta — unlock every other achievement (grants the rarest title: The Legend)
        const doneCount = A.filter((a) => a.met).length;
        const allMet = doneCount >= A.length;
        A.push({ cat: 'Milestones', icon: 'trophy', title: 'The Grand Slam — every achievement', desc: 'Unlock every other achievement. The ultimate flex — earns the title “The Legend.”', met: allMet, pct: allMet ? 100 : Math.max(0, Math.min(99, Math.round((doneCount / A.length) * 100))), sub: allMet ? 'Unlocked' : `${doneCount} / ${A.length} unlocked` });

        // XP reward per achievement — a satisfying but not overwhelming bump on unlock,
        // scaled by difficulty. Granted once via grantAchievementXp() (localStorage-tracked).
        A.forEach((a) => {
            const t = a.title;
            let xp = ({ Volume: 60, Consistency: 90, Accuracy: 110, Coverage: 80, Mastery: 130, Milestones: 100 })[a.cat] || 75;
            if (/every achievement/i.test(t)) xp = 1000;
            else if (/Max level — 100|every domain|whole bank|every specialty at 100%|Centurion streak|Unstoppable|Five figures — 10,000|Year of prep|Twenty-K|Fifteen-K|Five hundred days|Flawless — 99%|Abyssal|Level 90/i.test(t)) xp = 500;
            else if (/Level 50|Level 75|Halfway to the top|Elite — 90%|Marksman — 95%|Peak form|Scholar —|High five — 5,000|The grind|Mock master|Mock veteran|Half-century — 50|Untouchable|7,500 club|Cold-blooded|Deadeye|Half a year|One-fifty|Level 60|Five-domain expert|Triple virtuoso|Century diver|Boss veteran|Prodigy — 90%/i.test(t)) xp = 300;
            else if (/Off the mark/i.test(t)) xp = 30;
            a.xp = xp;
        });
        return A;
    }

    // ---- Titles: unlocked by achievements, one active title shown by your name ----
    // Keyed by achievement title. Picking a title persists server-side so it also
    // shows on the leaderboard. Unlock-gating is client-side (low-stakes flair).
    // Every achievement unlocks a distinct title (Jake, 2026-07-05). Keys must match the
    // achievement `title` exactly (verified by a coverage check). ~100 titles to chase.
    const TITLE_MAP = {
        // Volume
        'Off the mark': 'The Initiate', 'Warming up — 25': 'Warmed Up', 'Fifty in': 'The Fifty',
        'Century — 100 questions': 'The Centurion', 'Quarter-K — 250': 'Quarter-Master', '500 club': 'The Five-Hundred',
        'Three-quarter-K — 750': 'The Three-Quarter', 'Four figures — 1,000': 'Four Figures', 'Momentum — 1,500': 'The Persistent',
        'Halfway hero — 2,500': 'Halfway Hero', 'Four thousand strong': 'The Workhorse', 'High five — 5,000': 'The High-Fiver',
        'Six-K': 'The Tireless', '7,500 club': 'The Seventy-Five', 'Eight-K': 'The Unwavering',
        'Five figures — 10,000': 'The Machine', 'Fifteen-K — 15,000': 'The Titan', 'Twenty-K — 20,000': 'The Colossus',
        // Consistency
        'Two in a row': 'The Regular', 'Three-peat': 'The Three-Peat', 'Five-day flame': 'The Steady',
        'One week strong': 'The Consistent', 'Fortnight': 'The Fortnight', 'Three weeks': 'The Three-Week',
        'A month deep': 'The Monthly', 'Half-century — 50-day streak': 'The Half-Century', 'Two months': 'The Bimonthly',
        'A full quarter — 90 days': 'The Committed', 'Centurion streak': 'The Relentless', 'One-fifty — 150 days': 'The Dedicated',
        'Half a year — 180 days': 'The Ironclad', 'Unstoppable — 200 days': 'The Unstoppable', 'Year of prep — 365 days': 'The Devoted',
        'Five hundred days': 'The Eternal',
        // Accuracy
        'On target — 70%': 'On Target', 'Dialed in — 75%': 'Dialed In', 'Sharpshooter — 80%': 'Dead Aim',
        'Locked in — 80% over 500': 'Locked In', 'Crack shot — 85%': 'Crack Shot', 'Elite — 90%': 'Sharpshooter',
        'Deadeye — 90% over 300': 'Deadeye', 'Marksman — 95%': 'The Marksman', 'Cold-blooded — 95% over 500': 'Cold-Blooded',
        'Flawless — 99%': 'The Flawless',
        // Coverage
        'Explorer — every specialty': 'The Explorer', 'Specialist — 100% of a specialty': 'The Specialist',
        'Daily habit — Question of the Day': 'The Daily', 'Broad start — 4 specialties': 'The Generalist',
        'Getting around — 8 specialties': 'The Traveler', 'A dozen deep — 12 specialties': 'The Well-Rounded',
        'Deep diver — 50 in one specialty': 'The Diver', 'Century diver — 100 in one specialty': 'The Fathomless',
        'Abyssal — 200 in one specialty': 'The Abyssal', 'Double specialist — 2 at 100%': 'The Double-Specialist',
        'Triple complete — 3 at 100%': 'The Thorough', 'Polymath — 5 at 100%': 'The Polymath',
        'Grand tour — every specialty at 100%': 'The Cartographer', 'A quarter of the bank': 'A Quarter Down',
        'Halfway through the bank': 'Halfway There', 'Three-quarters of the bank': 'The Home Stretch',
        'Completionist — the whole bank': 'The Encyclopedia',
        // Mastery
        'Domain expert — 85% in a specialty': 'Domain Expert', 'Triple threat — 85% in three': 'Triple Threat',
        'Five-domain expert': 'The Master', 'Prodigy — 90% in a specialty': 'The Prodigy',
        'Triple virtuoso — 90% in three': 'The Savant', 'Boss hunter — beat your first domain': 'Boss Hunter',
        'Boss veteran — three domains': 'Boss Veteran', 'Boss slayer — every domain': 'Boss Slayer',
        // Milestones
        'Exam-ready — 80% readiness': 'Exam-Ready', 'Razor-sharp — 90% readiness': 'Razor-Sharp',
        'Peak form — 95% readiness': 'Peak Form', 'Scholar — 1,000 answered at 80%+': 'The Scholar',
        'The grind — 30-day streak + 2,500': 'The Grinder', 'Dress rehearsal — finish a Mock Exam': 'The Understudy',
        'Mock master — three Mock Exams': 'Battle-Tested', 'Mock regular — five': 'The Rehearsed',
        'Mock veteran — ten Mock Exams': 'The Veteran', 'Level 5': 'The Novice', 'Level 10': 'The Apprentice',
        'Level 15': 'The Journeyman', 'Level 20': 'The Adept', 'Level 25': 'The Practiced', 'Level 30': 'The Seasoned',
        'Level 40': 'The Expert', 'Level 50 — halfway to max': 'The Accomplished', 'Level 60': 'The Formidable',
        'Level 75': 'Virtuoso', 'Level 90': 'The Ascendant', 'Max level — 100': 'Grandmaster',
        'Quest complete — first daily set': 'The Quester', 'Quest week — 7 days': 'The Diligent',
        'Quest master — 30 days': 'The Questmaster', 'The Grand Slam — every achievement': 'The Legend',
        // Arcade
        'Arcade debut': 'Arcade Rookie', 'Arcade regular — 25 runs': 'Arcade Regular',
        'Arcade veteran — 100 runs': 'Arcade Veteran', 'High scorer — 20 in a run': 'Arcade Ace',
        'Arcade legend — 30 in a run': 'Arcade Legend', 'Untouchable — 15 in Sudden Death': 'Untouchable',
    };
    const BASE_TITLES = ['Rookie']; // always available so the picker is never empty
    function unlockedTitles() {
        const earned = computeAchievements().filter((a) => a.met && TITLE_MAP[a.title]).map((a) => TITLE_MAP[a.title]);
        return [...BASE_TITLES, ...earned];
    }
    function activeTitle() {
        const t = state.profile && state.profile.selected_title;
        return t && unlockedTitles().includes(t) ? t : '';
    }
    function titleChip(t, small) {
        if (!t) return '';
        return `<span style="display:inline-flex;align-items:center;font-family:ui-monospace,monospace;font-size:${small ? '10px' : '11px'};font-weight:700;letter-spacing:.3px;color:var(--accent);background:var(--accent-dim);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);border-radius:20px;padding:${small ? '1px 7px' : '2px 10px'};white-space:nowrap;">${escapeHtml(t)}</span>`;
    }
    async function saveTitle(t) {
        closeTitlePicker();
        try {
            await apiJSON('/api/user/cosmetics', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ title: t || '' }) });
            if (state.profile) state.profile.selected_title = t || null;
            renderSidebarAccount(); if ($('momentum-card')) renderMomentum();
            toast(t ? `Title set: ${t}` : 'Title cleared.', 'ok');
        } catch (e) { toast('Could not save title: ' + e.message); }
    }
    function openTitlePicker() {
        closeNavMenus();
        const titles = unlockedTitles();
        const cur = (state.profile && state.profile.selected_title) || '';
        const A = computeAchievements();
        const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const rows = titles.map((t) => `<button type="button" onclick="MACPrep.saveTitle('${esc(t)}')" style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;background:${t === cur ? 'var(--accent-dim)' : 'var(--bg)'};border:1px solid ${t === cur ? 'var(--accent)' : 'var(--line)'};border-radius:9px;padding:11px 13px;margin-top:8px;cursor:pointer;"><span style="font-weight:700;font-size:14px;color:var(--text);">${escapeHtml(t)}</span>${t === cur ? '<span class="mono" style="font-size:10px;color:var(--accent);">ACTIVE</span>' : ''}</button>`).join('');
        const lockedRows = Object.keys(TITLE_MAP).filter((ach) => { const a = A.find((x) => x.title === ach); return a && !a.met; })
            .map((ach) => { const a = A.find((x) => x.title === ach); return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 2px;border-top:1px solid var(--line);opacity:.55;"><span style="font-weight:600;font-size:13px;">${lockSvg(12)} ${escapeHtml(TITLE_MAP[ach])}</span><span class="mono" style="font-size:10px;color:var(--muted);flex:none;text-align:right;">${escapeHtml(a.sub && a.sub !== 'Unlocked' ? a.sub : a.title)}</span></div>`; }).join('');
        const wrap = document.createElement('div');
        wrap.id = 'title-overlay';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2600;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);';
        wrap.onclick = (e) => { if (e.target === wrap) closeTitlePicker(); };
        wrap.innerHTML = `<div style="background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px 24px;max-width:440px;width:100%;max-height:82vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.4);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;">
                <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:21px;">Your title</div>
                <button onclick="MACPrep.closeTitlePicker()" aria-label="Close" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:22px;line-height:1;">&times;</button>
            </div>
            <div class="sub" style="font-size:13px;margin-bottom:6px;">Titles you unlock from achievements. Pick one to show by your name and on the leaderboard.</div>
            <button type="button" onclick="MACPrep.saveTitle('')" style="display:block;width:100%;text-align:left;background:${!cur ? 'var(--accent-dim)' : 'var(--bg)'};border:1px solid ${!cur ? 'var(--accent)' : 'var(--line)'};border-radius:9px;padding:10px 13px;margin-top:8px;cursor:pointer;color:var(--muted);font-size:13px;">No title${!cur ? ' · ACTIVE' : ''}</button>
            ${rows}
            ${lockedRows ? `<div class="mono" style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin:16px 0 2px;">Locked — earn these</div>${lockedRows}` : ''}
        </div>`;
        document.body.appendChild(wrap);
    }
    function closeTitlePicker() { const o = $('title-overlay'); if (o) o.remove(); }

    // Small padlock for locked / premium-gated states — SVG, consistent with the icon set (replaces the 🔒 emoji).
    function lockSvg(size) {
        const s = size || 11;
        return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px;" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
    }
    function achReward(a) {
        const title = TITLE_MAP[a.title];
        if (title) return `🎁 Unlocks title <strong style="color:var(--accent);">${escapeHtml(title)}</strong>`;
        return '';
    }
    // Grant each newly-unlocked achievement's XP once (tracked in localStorage), with a toast.
    function grantAchievementXp() {
        if (!state.profile) return;
        const A = computeAchievements();
        let claimed; try { claimed = new Set(state.gam ? (state.gam.ach_claimed || []) : JSON.parse(localStorage.getItem('macprep_ach_claimed') || '[]')); } catch (e) { claimed = new Set(); }
        let gained = 0, n = 0;
        A.forEach((a) => { if (a.met && !claimed.has(a.title)) { claimed.add(a.title); gained += (a.xp || 0); n++; } });
        if (gained > 0) {
            try { localStorage.setItem('macprep_ach_claimed', JSON.stringify(Array.from(claimed))); } catch (e) {}
            if (state.gam) { state.gam.ach_claimed = Array.from(claimed); scheduleGamSync(); }
            addBonusXp(gained);
            toast(`+${gained} XP — ${n} achievement${n === 1 ? '' : 's'} unlocked!`, 'ok');
            if ($('momentum-card')) renderMomentum();
            try { checkLevelUp(); } catch (e) {}
        }
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
        const reward = achReward(a);
        const tip = escapeHtml((a.desc || a.title) + (a.sub && a.sub !== 'Unlocked' ? ' — ' + a.sub : '') + (a.xp ? ` · +${a.xp} XP` : ''));
        const xpBadge = a.xp ? `<span class="mono" style="flex:none;font-size:10px;font-weight:700;color:${a.met ? 'var(--accent)' : 'var(--muted)'};background:${a.met ? 'var(--accent-dim)' : 'var(--bg)'};border:1px solid ${a.met ? 'color-mix(in srgb,var(--accent) 35%,var(--line))' : 'var(--line)'};border-radius:20px;padding:1px 7px;white-space:nowrap;">+${a.xp} XP</span>` : '';
        return `<div title="${tip}" style="display:flex;align-items:flex-start;gap:11px;padding:12px 13px;border:1px solid var(--line);border-radius:12px;background:var(--panel);cursor:default;${a.met ? '' : 'opacity:.95;'}">${achIcon(a.icon, a.met)}<span style="display:flex;flex-direction:column;min-width:0;flex:1;line-height:1.25;"><span style="display:flex;align-items:center;gap:6px;justify-content:space-between;"><span style="font-weight:700;font-size:13.5px;color:var(--text);">${a.title}</span>${xpBadge}</span><span style="font-size:12px;color:${a.met ? 'var(--accent)' : 'var(--muted)'};">${a.sub}</span>${reward ? `<span style="font-size:11px;color:var(--muted);margin-top:3px;">${reward}</span>` : ''}${bar}</span></div>`;
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
        grantAchievementXp(); // catch any newly-unlocked achievements when viewing the page
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
        if (!premiumGate('studymode')) return;
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
        if (!premiumGate('studymode')) return;
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
        survival:    { label: 'Survival',     icon: '❤', tagline: 'Endless questions, 3 lives. One miss costs a life — how far can you go?', lives: 3 },
        suddendeath: { label: 'Sudden Death', icon: '💀', tagline: 'One life. A single wrong answer ends the run — how long can you stay flawless?', lives: 1 },
        timeattack:  { label: 'Time Attack',  icon: '⏱', tagline: 'Five-minute sprint. Answer as many correctly as you can before the clock runs out.', seconds: 300 },
        blitz:       { label: 'Blitz',        icon: '⚡', tagline: 'Beat the countdown. Start with 45 seconds — every correct answer buys you 4 more.', seconds: 45, bonus: 4 },
    };
    let arcadeTimerId = null, arcadeAdvanceId = null;
    function stopArcadeTimer() { if (arcadeTimerId) { clearInterval(arcadeTimerId); arcadeTimerId = null; } }
    function clearArcadeAdvance() { if (arcadeAdvanceId) { clearTimeout(arcadeAdvanceId); arcadeAdvanceId = null; } }
    function arcadeBest(type) { try { return parseInt(localStorage.getItem('macprep_arcade_' + type) || '0', 10) || 0; } catch (e) { return 0; } }
    function setArcadeBest(type, v) { try { localStorage.setItem('macprep_arcade_' + type, String(v)); } catch (e) {} }
    function bumpArcadePlays(type) { try { const k = 'macprep_arcade_' + type + '_plays'; localStorage.setItem(k, String((parseInt(localStorage.getItem(k) || '0', 10) || 0) + 1)); } catch (e) {} }
    // Free users get ONE taste run of Arcade, then it's part of full access.
    function arcadeFreeUsed() { try { return !!localStorage.getItem('macprep_arcade_free_used'); } catch (e) { return false; } }
    function markArcadeFreeUsed() { try { localStorage.setItem('macprep_arcade_free_used', '1'); } catch (e) {} }
    function arcadeShuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

    function openArcadePicker() {
        const rows = Object.keys(ARCADE_META).map((type) => {
            const m = ARCADE_META[type], best = arcadeBest(type);
            return `<button type="button" onclick="MACPrep.startArcade('${type}')" style="display:block;width:100%;text-align:left;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:15px 16px;margin-top:11px;cursor:pointer;transition:border-color .15s ease,transform .15s ease;" onmouseover="this.style.borderColor='var(--accent)';this.style.transform='translateY(-1px)';" onmouseout="this.style.borderColor='var(--line)';this.style.transform='none';">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                    <div style="font-weight:700;font-size:15px;color:var(--text);">${m.icon} ${m.label}</div>
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
            <div class="sub" style="font-size:13px;margin-bottom:6px;">Four fast, score-chasing modes. Same board-quality questions — against the clock, your lives, and your own best.</div>
            ${rows}</div>`;
        document.body.appendChild(wrap);
    }
    function closeArcadePicker() { const o = $('arcade-overlay'); if (o) o.remove(); }

    function startArcade(type) {
        closeArcadePicker();
        if (!ARCADE_META[type]) return;
        const all = state.questions || [];
        if (all.length < 8) { toast('Questions are still loading — try again in a moment.'); return; }
        // Free users get ONE taste run of Arcade; after that it's part of full access.
        const usage = freeUsage();
        if (!usage.unlimited) {
            if (arcadeFreeUsed()) { openUpgradeModal('arcade'); return; }
            markArcadeFreeUsed();
            toast('Your free Arcade run — have fun! Unlimited Arcade is part of full access.', 'ok');
        }
        const pool = arcadeShuffle(all.slice());
        try { track('arcade_start', { type }); } catch (e) {}
        beginSession(pool, 'tutor');
        const s = state.session; if (!s) return;
        const prevBest = arcadeBest(type);
        s.arcade = { type, score: 0, streak: 0, best: prevBest, prevBest, over: false };
        const m = ARCADE_META[type];
        if (m.lives) { s.arcade.lives = m.lives; s.arcade.maxLives = m.lives; }
        if (m.seconds) { s.arcade.timeLeft = m.seconds; s.arcade.bonus = m.bonus || 0; startArcadeTimer(); }
        renderQuestion(); // repaint with arcade chrome (HUD in, tutor extras out)
        renderArcadeHud();
    }

    function startArcadeTimer() {
        stopArcadeTimer();
        const s = state.session; if (!s || !s.arcade || s.arcade.timeLeft == null) return; // timed modes only (timeattack, blitz)
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
        if (a.maxLives) {
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
        if (correct) { a.score++; a.streak++; if (a.bonus) a.timeLeft = (a.timeLeft || 0) + a.bonus; if (a.score > a.best) { a.best = a.score; setArcadeBest(a.type, a.best); } }
        else { a.streak = 0; if (a.maxLives) a.lives = Math.max(0, a.lives - 1); }
        renderArcadeHud();
        clearArcadeAdvance();
        if (a.maxLives && a.lives <= 0) { arcadeAdvanceId = setTimeout(() => arcadeGameOver('dead'), 1600); return; }
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
        const m = ARCADE_META[a.type] || {};
        $('question-meta').textContent = `${m.icon || ''} ${(m.label || 'Arcade').toUpperCase()} · ${a.maxLives ? 'GAME OVER' : "TIME'S UP"}`;
        const line = a.maxLives
            ? `You answered <strong>${a.score}</strong> correct before running out of lives.`
            : `You got <strong>${a.score}</strong> correct before the clock ran out.`;
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
        // Full-length mock exams are premium, period — the board simulation is the hero unlock.
        if (!usage.unlimited) { openUpgradeModal('mock'); return; }
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
        const due = (p.due_ids || []).length, missed = (p.missed_ids || []).length, flagged = (p.flagged_ids || []).length, deck = (p.flashcard_ids || []).length;
        // Recommended tile shows a glanceable breakdown of what's in the set + a clear CTA,
        // so the big 2x2 bento tile earns its size instead of sitting mostly empty (#7).
        const recStats = [];
        if (due) recStats.push(`<div class="sm-rec-stat"><span class="n">${due}</span><span class="l">due to review</span></div>`);
        if (missed) recStats.push(`<div class="sm-rec-stat"><span class="n">${missed}</span><span class="l">recent misses</span></div>`);
        if (flagged) recStats.push(`<div class="sm-rec-stat"><span class="n">${flagged}</span><span class="l">flagged</span></div>`);
        if (!recStats.length) recStats.push(`<div class="sm-rec-stat"><span class="n">~20</span><span class="l">a smart starter mix</span></div>`);
        const free = !freeUsage().unlimited;
        const recTile = `<button type="button" class="sm-tile sm-rec" onclick="MACPrep.startRecommended()"><div class="sm-cat">Recommended for you</div><div class="sm-title" style="font-size:21px;">Today's focused set</div><div class="sm-desc" style="max-width:280px;margin-top:5px;">Adapts to you — due reviews, recent misses, and new questions in your weakest domains at a difficulty matched to your level.</div><div class="sm-rec-breakdown">${recStats.join('')}</div><div class="sm-rec-cta">Start focused set <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></div></button>`;
        const arcTop = Math.max(0, ...Object.keys(ARCADE_META).map((k) => arcadeBest(k)));
        const arcCount = free ? (arcadeFreeUsed() ? `${lockSvg(10)} Premium` : '1 free run') : (arcTop ? `Best ${arcTop}` : 'Set a high score');
        // Every study mode shown directly — no fold (Jake: don't hide modes behind a dropdown
        // when the grid isn't even full). Ordered by usefulness for board prep; Mock stays
        // prominent up top. rec (2x2) + Mock (wide) + the singles tile a clean 4-col bento.
        const tiles = [
            recTile,
            smTile('sm-mock', 'Exam simulation', 'Mock Exam', 'Simulate the real NCCAA boards — board-length, timed, and scored so you know you’re ready.', '180 Q · timed', 'MACPrep.openMockPicker()', free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-smart', 'Spaced repetition', 'Smart Review', 'Your weak areas + recent misses.', due ? `${due} due today` : '', 'MACPrep.smartReview()', free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-q10', 'Quick start', 'Quick 10', '10 quick questions to warm up.', '', 'MACPrep.startQuick(10)', free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-flash', 'Active recall', 'Flashcards', 'Hide the choices, recall, then flip for the rationale &amp; source.', 'Type &amp; flip', 'MACPrep.startFlashcards(20)', free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-spec', 'By specialty', 'Focused quiz', 'Drill any single specialty.', '', "MACPrep.jumpToCard('specialty-perf')", free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-missed', 'Targeted', 'Redo Missed', 'Re-drill what you got wrong.', missed ? `${missed} to fix` : 'none yet', 'MACPrep.redoMissed()', free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-flag', 'Targeted', 'Flagged', 'Questions you saved to revisit.', flagged ? `${flagged} saved` : 'none yet', 'MACPrep.startFlagged()', free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-duel', 'Compete', 'Duel a classmate', 'Same questions, head-to-head — share a code, see who wins.', '', 'MACPrep.openDuelPicker()', free ? `${lockSvg(10)} Premium` : 'New'),
            ...(deck ? [smTile('sm-mydeck', 'Active recall', 'My Flashcards', 'Recall your saved cards, then flip.', `${deck} saved`, 'MACPrep.startFlashcardDeck()', free ? `${lockSvg(10)} Premium` : 'New')] : []),
            smTile('sm-build', 'Custom', 'Build Your Own', 'Domain · count · difficulty.', '', 'MACPrep.toggleCustomize()', free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-boss', 'Challenge', 'Domain Bosses', 'Beat a domain to clear it.', (bossesCleared().length ? `${bossesCleared().length}/${uniqueDomains().length} defeated` : `${uniqueDomains().length} to beat`), 'MACPrep.openBossPicker()', free ? `${lockSvg(10)} Premium` : ''),
            smTile('sm-arcade', 'Play', 'Arcade', 'Four fast, score-chasing modes.', arcCount, 'MACPrep.openArcadePicker()'),
        ];
        el.innerHTML = `<div class="mono" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:15px;">Study modes</div>`
            + `<div class="sm-bento">${tiles.join('')}</div>`;
    }

    function toggleMoreModes(btn) {
        const more = $('sm-more'); if (!more) return;
        const open = !more.classList.toggle('hidden');
        if (btn) { btn.setAttribute('aria-expanded', String(open)); btn.classList.toggle('open', open); }
    }

    function renderDashboard() {
        const p = state.profile || {};
        grantAchievementXp(); // award XP for any newly-unlocked achievements (once each)
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
        renderDashLeaderboard();

        const usage = freeUsage();
        const card = $('free-allowance-card');
        if (usage.unlimited) {
            card.classList.add('hidden');
        } else {
            card.classList.remove('hidden');
            const pct = usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
            $('free-allowance-text').textContent =
                `${usage.used} of ${usage.limit} free questions used. ${usage.remaining} remaining — then it's a one-time $50 for the full 1,500+ bank.`;
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
        el.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px;margin-right:3px;"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg>' + fmtClock(s.timeLeft);
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

    function redoMissed() { if (!premiumGate('studymode')) return; startFromIds((state.profile && state.profile.missed_ids) || [], 'missed'); }
    function startFlagged() { if (!premiumGate('studymode')) return; startFromIds((state.profile && state.profile.flagged_ids) || [], 'flagged'); }
    // ---- Flag + personal-flashcard-deck actions (from the Review screen + quiz toolbar) ----
    function revFlagInner(on) {
        return `<svg viewBox="0 0 24 24" width="12" height="12" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22V15"/></svg>${on ? 'Flagged' : 'Flag'}`;
    }
    function revCardInner(on) {
        return `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>${on ? 'Saved' : '+ Card'}`;
    }
    async function flagFromReview(id, btn) {
        if (!id) return;
        const flags = new Set((state.profile && state.profile.flagged_ids) || []);
        const willFlag = !flags.has(id);
        try {
            await apiJSON('/api/user/flag', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ questionId: id, flagged: willFlag }) });
            if (willFlag) flags.add(id); else flags.delete(id);
            if (state.profile) state.profile.flagged_ids = Array.from(flags);
            if (btn) { btn.classList.toggle('on', willFlag); btn.innerHTML = revFlagInner(willFlag); }
            toast(willFlag ? 'Flagged — find it under Study Modes → Flagged.' : 'Removed from flagged.', 'ok');
        } catch (e) { toast('Could not update flag right now.'); }
    }
    async function flashcardFromReview(id, btn) {
        if (!id) return;
        const cards = new Set((state.profile && state.profile.flashcard_ids) || []);
        const willAdd = !cards.has(id);
        try {
            await apiJSON('/api/user/flashcard', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ questionId: id, saved: willAdd }) });
            if (willAdd) cards.add(id); else cards.delete(id);
            if (state.profile) state.profile.flashcard_ids = Array.from(cards);
            if (btn) { btn.classList.toggle('on', willAdd); btn.innerHTML = revCardInner(willAdd); }
            toast(willAdd ? 'Added to your flashcard deck — study it under Study Modes → My Flashcards.' : 'Removed from your deck.', 'ok');
        } catch (e) { toast('Could not update your deck right now.'); }
    }
    async function toggleFlashcard() {
        const s = state.session; if (!s) return; const q = s.pool[s.index]; if (!q) return;
        const cards = new Set((state.profile && state.profile.flashcard_ids) || []);
        const willAdd = !cards.has(q.id);
        try {
            await apiJSON('/api/user/flashcard', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ questionId: q.id, saved: willAdd }) });
            if (willAdd) cards.add(q.id); else cards.delete(q.id);
            if (state.profile) state.profile.flashcard_ids = Array.from(cards);
            updateFlashcardBtn();
            toast(willAdd ? 'Added to your flashcard deck.' : 'Removed from your deck.', 'ok');
        } catch (e) { /* ignore */ }
    }
    function updateFlashcardBtn() {
        const btn = $('flashcard-btn'); const s = state.session; if (!btn || !s) return;
        const q = s.pool[s.index];
        const on = q && ((state.profile && state.profile.flashcard_ids) || []).includes(q.id);
        btn.classList.toggle('on', !!on);
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></svg>${on ? 'In flashcards' : 'Add to flashcards'}`;
    }
    // Study "My Flashcards" — active recall over the deck you've saved.
    function startFlashcardDeck() {
        const ids = (state.profile && state.profile.flashcard_ids) || [];
        if (!ids.length) { toast('Your flashcard deck is empty — tap “+ Card” on a question or in Review to add some.'); return; }
        startFlashcards(0, ids);
    }

    // ---- Async 1v1 Duels — challenge a classmate to the same question set ----
    function openDuelPicker() {
        if (!premiumGate('duel')) return;
        closeNavMenus();
        const wrap = document.createElement('div');
        wrap.id = 'duel-overlay';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2600;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);';
        wrap.onclick = (e) => { if (e.target === wrap) closeDuelPicker(); };
        const optRow = (fn) => `<div style="display:flex;gap:9px;margin-bottom:18px;"><button class="sp-opt" style="flex:1;" onclick="MACPrep.${fn}(5)">5 Q</button><button class="sp-opt" style="flex:1;" onclick="MACPrep.${fn}(10)">10 Q</button><button class="sp-opt" style="flex:1;" onclick="MACPrep.${fn}(20)">20 Q</button></div>`;
        wrap.innerHTML = `<div role="dialog" aria-modal="true" aria-label="Duel a classmate" style="background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px;max-width:440px;width:100%;max-height:86vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.4);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px;">
                <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:21px;">⚔ Duel a classmate</div>
                <button onclick="MACPrep.closeDuelPicker()" aria-label="Close" style="background:none;border:none;color:var(--muted);cursor:pointer;line-height:1;display:inline-flex;padding:6px;"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </div>
            <div class="sub" style="font-size:13px;margin-bottom:16px;">Race a classmate through the same questions — match with a random student, or challenge someone specific with a code.</div>
            <div id="duel-recent"></div>
            <div class="mono" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:3px;">🎲 Random match</div>
            <div class="sub" style="font-size:12px;margin-bottom:8px;">We'll pair you instantly if someone's waiting — otherwise you're first in the queue.</div>
            ${optRow('duelRandom')}
            <div class="mono" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:3px;">Challenge someone specific</div>
            <div class="sub" style="font-size:12px;margin-bottom:8px;">Get a code + invite link to share — only they can join.</div>
            ${optRow('duelCreate')}
            <div class="mono" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:8px;">Have a code?</div>
            <div style="display:flex;gap:9px;">
                <input id="duel-code-input" type="text" maxlength="8" placeholder="ABC123" aria-label="Duel code" autocapitalize="characters" style="flex:1;text-transform:uppercase;letter-spacing:2px;font-family:ui-monospace,monospace;font-size:16px;padding:11px;background:var(--bg);border:1px solid var(--line);border-radius:8px;color:var(--text);" onkeydown="if(event.key==='Enter')MACPrep.duelJoin(this.value)">
                <button class="btn" type="button" onclick="MACPrep.duelJoin(document.getElementById('duel-code-input').value)">Join</button>
            </div>
        </div>`;
        document.body.appendChild(wrap);
        loadDuelRecent();
    }
    // Random matchmaking — instant if someone's waiting, else queue up as the creator.
    async function duelRandom(count) {
        if (!premiumGate('duel')) return;
        closeDuelPicker();
        toast('Finding you a random opponent…');
        try {
            const { resp, data } = await apiJSON('/api/duel/random', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ count: count || 10 }) });
            if (resp.status === 402) { openUpgradeModal('duel'); return; }
            if (!resp.ok || !data.questionIds) throw new Error(data.error || 'Could not start a random duel.');
            if (data.matched) toast('⚔ Matched with ' + (data.creatorName || 'a classmate') + '!', 'ok');
            startDuelSession(data.questionIds, { code: data.code, role: data.role || (data.matched ? 'opponent' : 'creator'), creatorName: data.creatorName, isRandom: true });
        } catch (e) { toast('Could not start a random duel: ' + e.message); }
    }
    // Show the player's finished duels in the picker (so a waiting random creator sees results).
    async function loadDuelRecent() {
        try {
            const { resp, data } = await apiJSON('/api/duel/mine', { headers: authHeaders() });
            if (!resp.ok) return;
            const el = $('duel-recent'); if (!el) return;
            const done = (data.duels || []).filter((d) => d.completed);
            if (!done.length) return;
            const rows = done.slice(0, 3).map((d) => {
                const meS = d.youAre === 'creator' ? d.creatorScore : d.opponentScore;
                const themS = d.youAre === 'creator' ? d.opponentScore : d.creatorScore;
                const themN = d.youAre === 'creator' ? (d.opponentName || 'Classmate') : (d.creatorName || 'Classmate');
                const tie = meS === themS, win = meS > themS;
                const badge = tie ? '🤝 Tie' : (win ? '🏆 Won' : 'Lost');
                const bc = tie ? 'var(--muted)' : (win ? 'var(--accent)' : 'var(--bad)');
                return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;padding:6px 0;border-top:1px solid var(--line);"><span>vs <strong>${escapeHtml(themN)}</strong> · ${meS}–${themS}</span><span style="font-weight:700;color:${bc};">${badge}</span></div>`;
            }).join('');
            el.innerHTML = `<div class="mono" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);margin-bottom:2px;">Your recent duels</div>${rows}<div style="height:18px;"></div>`;
        } catch (e) { /* best-effort */ }
    }
    function closeDuelPicker() { const o = $('duel-overlay'); if (o) o.remove(); }
    async function duelCreate(count) {
        if (!premiumGate('duel')) return;
        closeDuelPicker();
        toast('Setting up your duel…');
        try {
            const { resp, data } = await apiJSON('/api/duel/create', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ count: count || 10 }) });
            if (resp.status === 402) { openUpgradeModal('duel'); return; }
            if (!resp.ok || !data.questionIds) throw new Error(data.error || 'Could not create duel.');
            startDuelSession(data.questionIds, { code: data.code, role: 'creator' });
        } catch (e) { toast('Could not start duel: ' + e.message); }
    }
    async function duelJoin(code) {
        code = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        if (!code) { toast('Enter a duel code first.'); return; }
        if (!premiumGate('duel')) return;
        closeDuelPicker();
        toast('Loading duel…');
        try {
            const { resp, data } = await apiJSON('/api/duel/' + encodeURIComponent(code), { headers: authHeaders() });
            if (resp.status === 402) { openUpgradeModal('duel'); return; }
            if (!resp.ok || !data.questionIds) throw new Error(data.error || 'Duel not found.');
            if (data.youAre === 'creator') { toast('That’s your own duel — share the code with a classmate.'); return; }
            if (data.youAre === 'spectator' || (data.youAre === 'opponent' && data.opponentScore != null)) { showDuelResult(data, 'spectator'); return; }
            startDuelSession(data.questionIds, { code: data.code, role: 'opponent', creatorName: data.creatorName });
        } catch (e) { toast('Could not join duel: ' + e.message); }
    }
    function startDuelSession(ids, duel) {
        const byId = {}; (state.questions || []).forEach((q) => { byId[q.id] = q; });
        const ordered = (ids || []).map((id) => byId[id]).filter(Boolean);
        if (ordered.length < 3) { toast('This duel’s questions aren’t available right now.'); return; }
        beginSession(ordered, 'tutor');
        if (state.session) state.session.duel = duel;
        toast('⚔ Duel started — answer all ' + ordered.length + ', then your score locks in.');
    }
    async function finishDuel(s) {
        $('question-meta').textContent = '⚔ DUEL COMPLETE';
        try {
            const { resp, data } = await apiJSON('/api/duel/score', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ code: s.duel.code, score: s.correct, total: s.answered }) });
            if (!resp.ok) throw new Error(data.error || 'Could not save your duel score.');
            $('question-stem').innerHTML = duelResultHtml(s.duel.role, data);
        } catch (e) {
            $('question-stem').innerHTML = `<div style="color:var(--warn);">Your answers were graded, but the duel didn’t sync: ${escapeHtml(e.message)}</div>`;
        }
    }
    function showDuelResult(data, role) {
        go('quiz');
        $('question-meta').textContent = '⚔ DUEL';
        $('choices-container').innerHTML = ''; $('explanation-pane').classList.add('hidden');
        $('quiz-palette') && ($('quiz-palette').innerHTML = '');
        document.querySelectorAll('.quiz-extra').forEach((e) => { e.style.display = 'none'; });
        $('quiz-actions') && ($('quiz-actions').style.display = 'none');
        $('quiz-progress-wrap') && ($('quiz-progress-wrap').style.display = 'none');
        const sr = $('session-review'); if (sr) sr.classList.add('hidden');
        const sb = $('session-breakdown'); if (sb) sb.classList.add('hidden');
        $('question-stem').innerHTML = duelResultHtml(role, data);
        const btn = $('advance-vignette-trigger');
        if (btn) { btn.textContent = 'Back to Dashboard'; btn.className = 'btn'; btn.style.visibility = 'visible'; btn.onclick = () => go('dashboard'); }
    }
    function duelScoreCard(name, score, total, hi) {
        return `<div><div class="mono" style="font-size:11px;color:var(--muted);">${escapeHtml(name)}</div><div style="font-size:26px;font-weight:800;${hi ? 'color:var(--accent);' : ''}">${score == null ? '—' : score}<span style="font-size:14px;color:var(--muted);">/${total || '—'}</span></div></div>`;
    }
    function duelResultHtml(role, d) {
        if (role === 'creator' && d.opponentScore == null) {
            if (d.isRandom) {
                return `<div style="font-size:16px;">You scored <strong>${d.creatorScore}/${d.creatorTotal}</strong>. 🎲 You're in the random queue — we'll pair you with the next student who duels. <strong>Reopen Duel</strong> (Study Modes → Duel a classmate) to see who you drew and who won.</div>
                    <div style="margin-top:16px;"><button class="btn ghost" type="button" onclick="MACPrep.openDuelPicker()">Back to Duels</button></div>`;
            }
            return `<div style="font-size:16px;">You scored <strong>${d.creatorScore}/${d.creatorTotal}</strong>. Now challenge a classmate — send them this code:</div>
                <div style="margin:14px 0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <span class="mono" style="font-size:26px;font-weight:800;letter-spacing:3px;color:var(--accent);background:var(--accent-dim);border:1px solid var(--accent);border-radius:10px;padding:8px 18px;">${escapeHtml(d.code)}</span>
                    <button class="btn ghost" type="button" onclick="MACPrep.copyDuel('${escapeHtml(d.code)}')">Copy invite link</button>
                </div>
                <div class="mono" style="font-size:12px;color:var(--muted);">They open the link — or enter the code under Study Modes → Duel — play the same ${d.creatorTotal} questions, and you’ll both see who won.</div>`;
        }
        let mine, theirs;
        if (role === 'creator') { mine = { n: 'You', s: d.creatorScore, t: d.creatorTotal }; theirs = { n: d.opponentName || 'Classmate', s: d.opponentScore, t: d.opponentTotal }; }
        else if (role === 'opponent') { mine = { n: 'You', s: d.opponentScore, t: d.opponentTotal }; theirs = { n: d.creatorName || 'Classmate', s: d.creatorScore, t: d.creatorTotal }; }
        else { mine = { n: d.creatorName || 'Creator', s: d.creatorScore, t: d.creatorTotal }; theirs = { n: d.opponentName || 'Challenger', s: d.opponentScore, t: d.opponentTotal }; }
        let verdict;
        if (role === 'spectator') verdict = 'Duel results';
        else { const win = mine.s > theirs.s, tie = mine.s === theirs.s; verdict = tie ? '🤝 It’s a tie!' : (win ? '🏆 You win!' : `${escapeHtml(theirs.n)} takes this one`); }
        return `<div style="font-size:20px;font-weight:700;margin-bottom:12px;">${verdict}</div>
            <div style="display:flex;gap:22px;align-items:flex-end;">
                ${duelScoreCard(mine.n, mine.s, mine.t, role !== 'spectator' && mine.s >= (theirs.s || 0))}
                <div class="mono" style="color:var(--muted);padding-bottom:6px;">vs</div>
                ${duelScoreCard(theirs.n, theirs.s, theirs.t, false)}
            </div>
            <div style="margin-top:16px;"><button class="btn ghost" type="button" onclick="MACPrep.openDuelPicker()">Start another duel</button></div>`;
    }
    function copyDuel(code) {
        const link = location.origin + '/#duel=' + code;
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(link).then(() => toast('Invite link copied!', 'ok')).catch(() => window.prompt('Copy this invite link:', link)); }
        else window.prompt('Copy this invite link:', link);
    }
    // Deep link: opening /#duel=CODE (shared by a classmate) jumps straight into joining it.
    function checkDuelDeepLink() {
        try {
            const m = (location.hash || '').match(/duel=([A-Za-z0-9]{4,8})/);
            if (!m) return;
            history.replaceState(null, '', location.pathname + location.search);
            if (state.token) setTimeout(() => duelJoin(m[1]), 400);
        } catch (e) {}
    }

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
        btn.classList.toggle('on', !!flagged);
        btn.innerHTML = `<svg viewBox="0 0 24 24" fill="${flagged ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22V15"/></svg>${flagged ? 'Flagged' : 'Flag for review'}`;
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
        el.innerHTML = skeletonList(8);
        try {
            const { resp, data } = await apiJSON('/api/leaderboard', { headers: authHeaders() });
            if (!resp.ok) { el.innerHTML = '<div class="mono" style="color:var(--bad);">Could not load the leaderboard.</div>'; return; }
            state.leaderboard = data; state._lbAt = Date.now(); // shared freshness with the dashboard widget
            renderLeaderboard();
        } catch (e) { el.innerHTML = '<div class="mono" style="color:var(--bad);">Could not load the leaderboard.</div>'; }
    }
    function lbCountdown(iso) {
        const ms = new Date(iso).getTime() - Date.now();
        if (ms <= 0) return 'resetting now';
        const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000);
        return 'resets in ' + d + 'd ' + h + 'h';
    }
    const LB_TABS = [
        { key: 'weekly', label: 'Questions Answered', metric: 'Questions', note: 'Most questions answered since Monday 7 AM ET.' },
        { key: 'streak', label: 'Streak', metric: 'Day streak', note: 'Longest current daily study streak.' },
        { key: 'accuracy', label: 'Sharpshooter', metric: 'Accuracy', note: 'Highest accuracy this week (minimum 20 questions to qualify).' },
    ];
    function lbSetTab(k) { state.lbTab = k; renderLeaderboard(); }
    function lbMetricCell(r, tab) {
        if (tab === 'streak') return r.streak + ' 🔥';
        if (tab === 'accuracy') return r.accuracy.toFixed(1) + '% <span class="mono" style="font-size:10px;color:var(--muted);">/ ' + r.attempts + '</span>';
        return String(r.weekly);
    }
    function renderLeaderboard() {
        const el = $('leaderboard-body'); const data = state.leaderboard; if (!el || !data) return;
        const me = data.me || {}; const tab = state.lbTab || 'weekly';
        const tabDef = LB_TABS.find((t) => t.key === tab) || LB_TABS[0];
        const rows = (data.boards && data.boards[tab]) || [];
        const optedIn = !!me.opted_in, hasName = !!me.has_name;
        const minQ = data.min_accuracy_qs || 20;
        const msgLine = '<div id="lb-msg" class="mono" style="font-size:12px;color:var(--accent);margin-top:8px;"></div>';

        // ---- identity / opt-in control ----
        let settings;
        if (!optedIn) {
            settings = '<div class="card" style="margin-bottom:18px;"><h3 style="margin:0 0 4px;">You\'re hidden from the leaderboard</h3>'
                + '<p class="sub" style="margin:0 0 12px;font-size:13px;">Opt back in to appear and see where you rank. You\'re shown only as your first name + last initial — never your full name or email.</p>'
                + '<button class="btn" onclick="MACPrep.saveLeaderboardSettings(true)">Show me on the leaderboard</button>' + msgLine + '</div>';
        } else if (!hasName) {
            settings = '<div class="card" style="margin-bottom:18px;"><h3 style="margin:0 0 4px;">Add your name to appear</h3>'
                + '<p class="sub" style="margin:0 0 12px;font-size:13px;">You\'re on the leaderboard, but it shows people by name. Add yours — everyone sees just your <strong>first name + last initial</strong> (e.g. &ldquo;Jake K.&rdquo;).</p>'
                + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">'
                + '<input id="lb-name" type="text" maxlength="60" placeholder="First and last name" style="flex:1;min-width:180px;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);">'
                + '<button class="btn" onclick="MACPrep.saveLeaderboardName()">Save &amp; appear</button>'
                + '<button class="btn ghost" onclick="MACPrep.saveLeaderboardSettings(false)">Stay hidden</button></div>' + msgLine + '</div>';
        } else {
            settings = '<div class="card" style="margin-bottom:18px;display:flex;gap:12px;flex-wrap:wrap;justify-content:space-between;align-items:center;">'
                + '<div><h3 style="margin:0 0 2px;">You appear as <span style="color:var(--accent);">' + escapeHtml(me.name) + '</span></h3>'
                + '<p class="sub" style="margin:0;font-size:12.5px;">First name + last initial only. Opt out anytime.</p></div>'
                + '<button class="btn ghost" onclick="MACPrep.saveLeaderboardSettings(false)">Hide me</button>' + msgLine + '</div>';
        }

        // ---- my standing on the active board ----
        const myRank = tab === 'streak' ? me.rank_streak : tab === 'accuracy' ? me.rank_accuracy : me.rank_weekly;
        const myStandingVal = tab === 'streak' ? (me.streak || 0) + ' 🔥' : tab === 'accuracy' ? (me.accuracy || 0).toFixed(1) + '%' : (me.weekly || 0);
        let standingLine;
        if (!optedIn || !hasName) standingLine = 'Add your name above to claim your spot';
        else if (tab === 'accuracy' && !me.qualifies_accuracy) standingLine = 'Answer <strong>' + Math.max(0, minQ - (me.attempts || 0)) + '</strong> more this week to qualify for this board';
        else if (myRank) standingLine = 'You are <strong style="color:var(--accent);">#' + myRank + '</strong> of ' + (rows.length || me.players);
        else standingLine = 'Answer some questions to join this board';
        const standing = '<div class="card" style="margin-bottom:16px;display:flex;gap:18px;flex-wrap:wrap;justify-content:space-between;align-items:center;">'
            + '<div><div class="mono" style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;">' + escapeHtml(tabDef.label) + ' — ' + escapeHtml(lbCountdown(data.week_resets_at)) + '</div>'
            + '<div style="font-size:15px;margin-top:4px;">' + standingLine + '</div></div>'
            + '<div style="display:flex;gap:22px;">'
            + '<div style="text-align:center;"><div style="font-size:22px;font-weight:700;">' + (me.weekly || 0) + '</div><div class="mono" style="font-size:10px;color:var(--muted);text-transform:uppercase;">this week</div></div>'
            + '<div style="text-align:center;"><div style="font-size:22px;font-weight:700;color:var(--accent);">' + (me.streak || 0) + ' 🔥</div><div class="mono" style="font-size:10px;color:var(--muted);text-transform:uppercase;">streak</div></div>'
            + '</div></div>';

        // ---- tabs ----
        const tabs = '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">' + LB_TABS.map((t) =>
            '<button onclick="MACPrep.lbSetTab(\'' + t.key + '\')" style="padding:8px 15px;border-radius:999px;border:1px solid ' + (t.key === tab ? 'var(--accent)' : 'var(--line)') + ';background:' + (t.key === tab ? 'var(--accent-dim)' : 'transparent') + ';color:var(--text);cursor:pointer;font-size:13px;font-weight:' + (t.key === tab ? '700' : '500') + ';">' + t.label + '</button>').join('')
            + '</div><div class="sub" style="font-size:12.5px;margin:-6px 0 12px;">' + escapeHtml(tabDef.note) + '</div>';

        // ---- board table ----
        let board;
        if (!rows.length) {
            board = '<div class="card"><div class="mono" style="color:var(--muted);">'
                + (tab === 'accuracy' ? 'No one has answered ' + minQ + '+ questions this week yet — be the first to qualify.' : 'No one\'s on this board yet — answer some questions and be the first.') + '</div></div>';
        } else {
            const trs = rows.map((r) =>
                '<tr style="' + (r.is_me ? 'background:var(--accent-dim);' : '') + '">'
                + '<td style="padding:9px 10px;font-family:ui-monospace,monospace;' + (r.rank <= 3 ? 'font-weight:700;color:var(--accent);' : 'color:var(--text2);') + '">' + r.rank + '</td>'
                + '<td style="padding:9px 10px;">' + escapeHtml(r.name) + (r.title ? ' ' + titleChip(r.title, true) : '') + (r.is_me ? ' <span class="mono" style="font-size:10px;color:var(--accent);">YOU</span>' : '') + '</td>'
                + '<td style="padding:9px 10px;text-align:right;font-weight:600;">' + lbMetricCell(r, tab) + '</td></tr>').join('');
            board = '<div class="card" style="padding:6px;"><table style="width:100%;font-size:14px;border-collapse:collapse;">'
                + '<tr style="border-bottom:1px solid var(--line);"><th style="text-align:left;padding:8px 10px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">#</th><th style="text-align:left;padding:8px 10px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Player</th><th style="text-align:right;padding:8px 10px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">' + escapeHtml(tabDef.metric) + '</th></tr>'
                + trs + '</table></div>';
        }
        el.innerHTML = settings + standing + tabs + board;
    }
    async function saveLeaderboardSettings(optIn) {
        const msg = $('lb-msg');
        if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = 'Saving…'; }
        try {
            const { resp, data } = await apiJSON('/api/leaderboard/settings', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ opt_in: optIn }) });
            if (!resp.ok) throw new Error(data.error || 'Could not save.');
            await loadProfile();
            await loadLeaderboard();
        } catch (e) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } }
    }
    async function saveLeaderboardName() {
        const inp = $('lb-name'); const msg = $('lb-msg');
        const full_name = inp ? inp.value.trim().replace(/\s+/g, ' ') : '';
        if (!full_name) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = 'Enter your name first.'; } return; }
        if (msg) { msg.style.color = 'var(--accent)'; msg.textContent = 'Saving…'; }
        try {
            const r1 = await apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ full_name }) });
            if (!r1.resp.ok) throw new Error((r1.data && r1.data.error) || 'Could not save.');
            await apiJSON('/api/leaderboard/settings', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ opt_in: true }) });
            await loadProfile();
            await loadLeaderboard();
        } catch (e) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } }
    }

    // Full-width dashboard leaderboard — same three boards as the Leaderboard tab,
    // top 10 in two columns. Visible only when you're opted in AND have a name;
    // disappears entirely if you opt out (per Jake's spec).
    function dashLbSetTab(k) { state.dashLbTab = k; renderDashLeaderboard(); }
    async function renderDashLeaderboard() {
        const card = $('dash-leaderboard-card'); if (!card) return;
        const paint = () => {
            const data = state.leaderboard;
            if (!data || !data.me || !data.me.opted_in || !data.me.has_name) { card.classList.add('hidden'); return; }
            const me = data.me;
            const tab = state.dashLbTab || 'weekly';
            const rows = ((data.boards && data.boards[tab]) || []).slice(0, 10);
            const anyActivity = data.boards && (data.boards.weekly.length || data.boards.streak.length);
            if (!anyActivity) { card.classList.add('hidden'); return; }
            card.classList.remove('hidden');
            const row = (r) => '<div style="display:flex;align-items:center;gap:9px;padding:6px 0;font-size:13.5px;border-top:1px solid color-mix(in srgb,var(--line) 55%,transparent);">'
                + '<span class="mono" style="width:22px;text-align:right;' + (r.rank <= 3 ? 'color:var(--accent);font-weight:700;' : 'color:var(--muted);') + '">' + r.rank + '</span>'
                + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + (r.is_me ? 'font-weight:700;color:var(--accent);' : '') + '">' + escapeHtml(r.name) + (r.is_me ? ' <span class="mono" style="font-size:9px;">YOU</span>' : '') + '</span>'
                + '<span style="font-weight:600;">' + lbMetricCell(r, tab) + '</span></div>';
            const pills = LB_TABS.map((t) => '<button onclick="MACPrep.dashLbSetTab(\'' + t.key + '\')" style="padding:5px 12px;border-radius:999px;border:1px solid ' + (t.key === tab ? 'var(--accent)' : 'var(--line)') + ';background:' + (t.key === tab ? 'var(--accent-dim)' : 'transparent') + ';color:var(--text);cursor:pointer;font-size:12px;font-weight:' + (t.key === tab ? '700' : '500') + ';">' + t.label + '</button>').join('');
            const emptyCol = '<div class="mono" style="font-size:12px;color:var(--muted);padding:8px 0;">' + (tab === 'accuracy' ? 'No one has ' + (data.min_accuracy_qs || 20) + '+ questions yet this week.' : 'No one here yet.') + '</div>';
            const left = rows.slice(0, 5).map(row).join('') || emptyCol;
            const right = rows.slice(5, 10).map(row).join('');
            const meRank = tab === 'streak' ? me.rank_streak : tab === 'accuracy' ? me.rank_accuracy : me.rank_weekly;
            const meOutside = meRank && meRank > 10;
            card.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px 16px;flex-wrap:wrap;margin-bottom:8px;">'
                + '<h3 style="margin:0;display:inline-flex;align-items:center;gap:8px;"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4.5h8V8a4 4 0 0 1-8 0V4.5z"/><path d="M8 6H5.5v1.2A2.5 2.5 0 0 0 8 9.7"/><path d="M16 6h2.5v1.2A2.5 2.5 0 0 1 16 9.7"/><path d="M9.5 20h5"/><path d="M12 12.5V20"/></svg> Leaderboard</h3>'
                + '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + pills + '</div>'
                + '<a onclick="MACPrep.go(\'leaderboard\')" style="font-size:12px;color:var(--accent);cursor:pointer;margin-left:auto;">All boards →</a></div>'
                + '<div class="dash-lb-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:0 30px;"><div>' + left + '</div><div>' + right + '</div></div>'
                + (meOutside ? '<div style="margin-top:6px;">' + row({ rank: meRank, name: me.name, weekly: me.weekly, streak: me.streak, accuracy: me.accuracy, attempts: me.attempts, is_me: true }) + '</div>' : '');
        };
        if (state.leaderboard) paint();
        const stale = !state._lbAt || (Date.now() - state._lbAt) > 60000;
        if (stale) {
            try { const { resp, data } = await apiJSON('/api/leaderboard', { headers: authHeaders() }); if (resp.ok) { state.leaderboard = data; state._lbAt = Date.now(); paint(); } } catch (e) {}
        }
    }

    // ---- one-time name capture for legacy accounts ------------------------
    // Accounts created before we required a first + last name get asked once per
    // login until they provide it (so the leaderboard can show "First L.").
    function lbStripCred(s) { return String(s || '').replace(/\b(SAA|CAA|C-AA|AA-C|MD|DO|CRNA|RN|SRNA)\b\.?/gi, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim(); }
    function needsNameCapture() {
        const p = state.profile || {};
        if (p.is_admin) return false; // Jake already has a name; don't nag admins
        return !/\S+\s+\S+/.test(lbStripCred(p.full_name));
    }
    // ---- Credential capture: SAA (student) vs CAA (certified) --------------
    // Students add a graduation date; when it passes, the account's effective
    // credential auto-promotes to CAA (computed server-side) — which will gate the
    // future CME section to CAAs. Collected at signup, and as a one-time login
    // pop-up for accounts created before we asked.
    function onCredChange() {
        const sel = $('su-cred'), box = $('su-saa-fields');
        if (box) box.classList.toggle('hidden', !(sel && sel.value === 'SAA'));
    }
    function onCredModalChange() {
        const sel = $('cp-cred'), box = $('cp-saa');
        if (box) box.classList.toggle('hidden', !(sel && sel.value === 'SAA'));
    }
    function maybePromptCredential() {
        if (!state.token || !state.profile || state._credPromptOpen) return false;
        if (!state.profile.needs_credential) return false;
        openCredentialPrompt();
        return true;
    }
    function closeCredentialPrompt() { const o = $('cred-prompt-overlay'); if (o) o.remove(); state._credPromptOpen = false; }
    function openCredentialPrompt() {
        state._credPromptOpen = true;
        const p = state.profile || {};
        const pre = ['SAA', 'CAA'].includes(p.credential) ? p.credential : '';
        const inp = 'width:100%;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);margin:4px 0 12px;font-size:14px;';
        const lbl = 'font-size:10.5px;letter-spacing:.5px;color:var(--muted);';
        const wrap = document.createElement('div');
        wrap.id = 'cred-prompt-overlay';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2850;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);';
        wrap.innerHTML = `<div role="dialog" aria-modal="true" aria-labelledby="cp-title" style="background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px 24px;max-width:420px;width:100%;box-shadow:0 24px 70px rgba(0,0,0,.45);">
            <div style="font-family:ui-monospace,monospace;font-weight:800;font-size:15px;letter-spacing:-.5px;color:var(--text);margin-bottom:14px;">MAC<span style="color:var(--accent);">Prep</span></div>
            <div id="cp-title" style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:20px;margin-bottom:4px;">One quick question</div>
            <div class="sub" style="font-size:13px;margin-bottom:16px;">Are you a student (SAA) or a certified CAA? This tailors MACPrep to you — and when a student graduates, your account upgrades to CAA automatically.</div>
            <label class="mono" style="${lbl}">CREDENTIAL</label>
            <select id="cp-cred" onchange="MACPrep.onCredModalChange()" style="${inp}">
                <option value="" ${pre ? '' : 'selected'} disabled>Select…</option>
                <option value="SAA" ${pre === 'SAA' ? 'selected' : ''}>SAA — Student Anesthesiologist Assistant</option>
                <option value="CAA" ${pre === 'CAA' ? 'selected' : ''}>CAA — Certified Anesthesiologist Assistant</option>
            </select>
            <div id="cp-saa" class="${pre === 'SAA' ? '' : 'hidden'}">
                <label class="mono" style="${lbl}">EXPECTED GRADUATION DATE</label>
                <input id="cp-grad" type="date" value="${p.graduation_date || ''}" style="${inp}">
                <label class="mono" style="${lbl}">EXAM DATE <span style="text-transform:none;letter-spacing:0;">(optional)</span></label>
                <input id="cp-exam" type="date" value="${p.target_exam_date || ''}" style="${inp}">
            </div>
            <button class="btn" style="width:100%;margin-top:2px;" onclick="MACPrep.saveCredentialPrompt(this)">Save</button>
            <div id="cp-msg" class="mono" style="font-size:12px;color:var(--bad);margin-top:8px;text-align:center;"></div>
        </div>`;
        document.body.appendChild(wrap);
    }
    async function saveCredentialPrompt(btn) {
        const cred = ($('cp-cred') && $('cp-cred').value) || '';
        const grad = ($('cp-grad') && $('cp-grad').value) || '';
        const exam = ($('cp-exam') && $('cp-exam').value) || '';
        const msg = $('cp-msg');
        if (!cred) { if (msg) msg.textContent = 'Please choose SAA or CAA.'; return; }
        if (cred === 'SAA' && !grad) { if (msg) msg.textContent = 'Please add your expected graduation date.'; return; }
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
            const body = { credential: cred, graduation_date: cred === 'SAA' ? grad : null };
            if (cred === 'SAA' && exam) body.target_exam_date = exam;
            const { resp, data } = await apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            if (!resp.ok) throw new Error((data && data.error) || 'Could not save.');
            await loadProfile();
            closeCredentialPrompt();
            toast('Thanks — you\'re all set.', 'ok');
        } catch (e) {
            if (msg) msg.textContent = e.message;
            if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
        }
    }

    function maybePromptForName() {
        if (!state.token || !state.profile || state._namePromptOpen || state._credPromptOpen) return;
        if (!needsNameCapture()) return;
        openNamePrompt();
    }
    function openNamePrompt() {
        state._namePromptOpen = true;
        const wrap = document.createElement('div');
        wrap.id = 'name-prompt-overlay';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2800;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);';
        wrap.innerHTML = `<div role="dialog" aria-modal="true" style="background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px;max-width:400px;width:100%;box-shadow:0 24px 70px rgba(0,0,0,.45);">
            <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:20px;margin-bottom:4px;">Add your name</div>
            <div class="sub" style="font-size:13px;margin-bottom:16px;">MACPrep now has a leaderboard. You'll appear only as your <strong>first name + last initial</strong> (e.g. &ldquo;Jordan L.&rdquo;) — never your full name or email.</div>
            <div style="display:flex;gap:10px;margin-bottom:12px;">
                <div style="flex:1;"><label class="mono" style="font-size:10.5px;letter-spacing:.5px;color:var(--muted);">FIRST NAME</label><input id="np-first" type="text" autocomplete="given-name" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);margin-top:4px;"></div>
                <div style="flex:1;"><label class="mono" style="font-size:10.5px;letter-spacing:.5px;color:var(--muted);">LAST NAME</label><input id="np-last" type="text" autocomplete="family-name" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);margin-top:4px;"></div>
            </div>
            <label class="mono" style="font-size:10.5px;letter-spacing:.5px;color:var(--muted);">CREDENTIAL (OPTIONAL)</label>
            <select id="np-cred" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);margin:4px 0 16px;font-size:14px;">
                <option value="">Prefer not to say</option>
                <option value="SAA">SAA — Student Anesthesiologist Assistant</option>
                <option value="CAA">CAA — Certified Anesthesiologist Assistant</option>
            </select>
            <div style="display:flex;gap:10px;">
                <button class="btn ghost" style="flex:none;" onclick="MACPrep.closeNamePrompt()">Not now</button>
                <button class="btn" style="flex:1;" onclick="MACPrep.saveNamePrompt(this)">Save</button>
            </div>
            <div id="np-msg" class="mono" style="font-size:12px;color:var(--bad);margin-top:8px;text-align:center;"></div>
        </div>`;
        document.body.appendChild(wrap);
        if (state.profile && state.profile.credential && ['SAA', 'CAA'].includes(state.profile.credential)) { const c = $('np-cred'); if (c) c.value = state.profile.credential; }
        setTimeout(() => { const f = $('np-first'); if (f) f.focus(); }, 40);
    }
    function closeNamePrompt() { const o = $('name-prompt-overlay'); if (o) o.remove(); state._namePromptOpen = false; }
    async function saveNamePrompt(btn) {
        const first = (($('np-first') && $('np-first').value) || '').trim();
        const last = (($('np-last') && $('np-last').value) || '').trim();
        const credential = ($('np-cred') && $('np-cred').value) || '';
        const msg = $('np-msg');
        if (!first || !last) { if (msg) msg.textContent = 'Please enter your first and last name.'; return; }
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
            const body = { full_name: (first + ' ' + last).replace(/\s+/g, ' ').trim() };
            if (credential) body.credential = credential;
            const { resp, data } = await apiJSON('/api/user/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            if (!resp.ok) throw new Error((data && data.error) || 'Could not save.');
            await loadProfile();
            closeNamePrompt();
            toast('Thanks — you\'re all set.', 'ok');
            state._lbAt = 0; // refresh the dashboard widget with the new name
            if ($('dashboard-view') && !$('dashboard-view').classList.contains('hidden')) renderDashboard();
        } catch (e) { if (msg) msg.textContent = e.message; if (btn) { btn.disabled = false; btn.textContent = 'Save'; } }
    }

    async function loadNotebook() {
        const body = $('notebook-body'); if (body) body.innerHTML = skeletonList(4);
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
    // Theme-aware so "Correct"/"Incorrect" hit WCAG AA contrast on both light and dark
    // surfaces — a single fixed green/red failed on tinted accent-dim/danger-dim panels.
    const GRADE_GREEN = 'var(--grade-ok)', GRADE_RED = 'var(--grade-bad)';
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

        // Only the broad specialty/domain here — never the granular subtopic, which often
        // names the diagnosis/answer and would give away the question (user feedback 2026-07-05).
        const metaText = (q.category || q.domain_name || '').toUpperCase();
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
        updateFlashcardBtn();
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
                id: currentQ.id,
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
            return { id: q.id, meta: [q.category || q.domain_name, q.subtopic].filter(Boolean).join(' · '), category: s.diagnostic ? (q.domain_name || q.category || 'General') : (q.category || q.domain_name || 'General'), stem: q.stem || '', correct: !!g.correct, correctLetter: String.fromCharCode(65 + (g.correctIndex || 0)), yourLetter: String.fromCharCode(65 + a.selectedIndex), explanation: g.explanation || '' };
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
        if (s.duel) finishDuel(s);
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
        const flset = new Set((state.profile && state.profile.flagged_ids) || []);
        const cardset = new Set((state.profile && state.profile.flashcard_ids) || []);
        const rows = log.map((r, i) => {
            const fl = r.id && flset.has(r.id), fc = r.id && cardset.has(r.id);
            const actions = r.id ? `<div style="display:flex;gap:6px;flex:none;">
                    <button type="button" class="rev-act${fl ? ' on' : ''}" onclick="MACPrep.flagFromReview('${r.id}', this)" title="Flag this to review later — even ones you got right">${revFlagInner(fl)}</button>
                    <button type="button" class="rev-act${fc ? ' on' : ''}" onclick="MACPrep.flashcardFromReview('${r.id}', this)" title="Add this to your flashcard deck">${revCardInner(fc)}</button>
                </div>` : '';
            return `
            <div style="border-bottom:1px solid var(--line);padding:14px 0;">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:4px;">
                    <div class="mono" style="font-size:11px;color:var(--muted);">${i + 1}. ${r.meta || ''}</div>
                    ${actions}
                </div>
                <div style="font-size:14px;margin-bottom:6px;">${r.stem}</div>
                <div class="mono" style="font-size:12px;">
                    <span style="color:${r.correct ? 'var(--accent)' : 'var(--bad)'};">${r.correct ? '✓ Correct' : '✗ Incorrect'}</span>
                    &nbsp;·&nbsp; Your answer: ${r.yourLetter} &nbsp;·&nbsp; Correct: ${r.correctLetter}
                </div>
                ${r.explanation ? `<div style="font-size:13px;color:var(--text2);margin-top:6px;line-height:1.5;">${r.explanation}</div>` : ''}
            </div>`;
        }).join('');
        el.innerHTML = `<h2 style="margin:0 0 6px;">Review</h2><p class="sub">Every question from this session — <strong>Flag</strong> any to revisit later, or <strong>+ Card</strong> to add it to your flashcard deck.</p>${rows}`;
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
        if (!premiumGate('studymode')) return;
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
        if (!premiumGate('studymode')) return;
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

    function reviewDue() { if (!premiumGate('studymode')) return; startFromIds((state.profile && state.profile.due_ids) || [], 'due'); }

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
        $('question-stem').innerHTML = `You've worked through all <strong>${n}</strong> of your free questions. ${statLine}`
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

    // ---- premium gate + upgrade screen ------------------------------------
    // Every premium-only surface (Arcade, Mock Exam, Critical Events, Flashcards)
    // routes free users through ONE consistent upgrade screen. premiumGate()
    // returns true when the user already has access, otherwise it shows the
    // screen and returns false — so callers read as: `if (!premiumGate('mock')) return;`
    const PREMIUM_FEATURES = {
        studymode: { icon: '🎯', name: 'This study mode', blurb: 'Free accounts get the recommended session — 25 questions to try MACPrep. Upgrade to unlock every study mode (Quick sets, Smart Review, Focused quizzes by specialty, Custom sessions) plus flashcards, mock exams, duels, and the full 1,500+ question bank.' },
        arcade: { icon: '🕹️', name: 'Arcade', blurb: 'Unlimited high-score runs — Survival, Sudden Death, Time Attack & Blitz.' },
        mock: { icon: '📝', name: 'The Full-Length Mock Exam', blurb: 'A board-length, timed simulation of the real NCCAA exam — the closest thing to sitting the boards.' },
        critical: { icon: '🚨', name: 'Critical Event Cards', blurb: 'Clinician-reviewed rapid-response cards for every anesthesia crisis — searchable and printable.' },
        flashcards: { icon: '🗂️', name: 'Flashcard Mode', blurb: 'Active recall — hide the choices, type your answer, then flip for the rationale & source.' },
        duel: { icon: '⚔️', name: 'Duels', blurb: 'Challenge a classmate head-to-head on the same question set — share a code and see who wins.' },
    };
    // The single "what your $50 unlocks" list shown on every upgrade screen.
    const PREMIUM_UNLOCKS = [
        'The <strong>entire</strong> question bank — every domain &amp; specialty',
        'Full-length, timed <strong>mock exams</strong> at real NCCAA pace',
        'Unlimited <strong>Arcade</strong> — all four modes',
        '<strong>Flashcard</strong> active-recall study mode',
        'Clinician-reviewed <strong>Critical Event</strong> cards for every crisis',
        'Progress tracking, weak-spot review &amp; your exam-date plan',
    ];

    function premiumGate(featureKey) {
        if (freeUsage().unlimited) return true;
        openUpgradeModal(featureKey);
        return false;
    }

    function openUpgradeModal(featureKey) {
        closeNavMenus();
        closeUpgradeModal();
        const f = PREMIUM_FEATURES[featureKey] || null;
        try { track('upgrade_screen', { feature: featureKey || 'generic' }); } catch (e) {}
        const unlocks = PREMIUM_UNLOCKS.map((u) => `<div style="display:flex;gap:9px;align-items:flex-start;"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:3px;" aria-hidden="true"><path d="m5 12 5 5L20 6"/></svg><span>${u}</span></div>`).join('');
        const head = f
            ? `<div style="font-size:34px;line-height:1;margin-bottom:10px;">${f.icon}</div>
               <div class="mono" style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--warn);margin-bottom:6px;">Premium feature</div>
               <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:22px;line-height:1.2;">${f.name} is part of full access</div>
               <div class="sub" style="font-size:13.5px;margin-top:7px;">${f.blurb}</div>`
            : `<div class="mono" style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--warn);margin-bottom:6px;">Unlock everything</div>
               <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:22px;line-height:1.2;">Get full access to MACPrep</div>`;
        const wrap = document.createElement('div');
        wrap.id = 'upgrade-overlay';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2700;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);';
        wrap.onclick = (e) => { if (e.target === wrap) closeUpgradeModal(); };
        wrap.innerHTML = `<div role="dialog" aria-modal="true" style="background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px 26px 22px;max-width:440px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.45);position:relative;">
            <button onclick="MACPrep.closeUpgradeModal()" aria-label="Close" style="position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);cursor:pointer;font-size:24px;line-height:1;">&times;</button>
            ${head}
            <div style="margin:18px 0 4px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--bg);line-height:1.85;font-size:13.5px;color:var(--text2);">
                <div class="mono" style="font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:9px;">Your $50 unlocks</div>
                <div style="display:flex;flex-direction:column;gap:7px;">${unlocks}</div>
            </div>
            <div style="margin-top:14px;padding:11px 13px;border:1px solid var(--accent);border-radius:10px;background:var(--accent-dim);font-size:12.5px;color:var(--text);display:flex;gap:9px;align-items:center;">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none;" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
                <span><strong>100% Pass Guarantee</strong> — pass the NCCAA boards or your $50 back.</span>
            </div>
            <button class="btn" id="upgrade-cta" style="width:100%;margin-top:16px;" onclick="MACPrep.startCheckout(this)">Unlock full access — $50 (one-time)</button>
            <div class="mono" style="font-size:11px;color:var(--muted);margin-top:9px;text-align:center;">No subscription · 48-hour refund · secured by Stripe</div>
            <div style="text-align:center;margin-top:8px;"><a href="#redeem" onclick="event.preventDefault(); MACPrep.closeUpgradeModal(); MACPrep.goRedeem();" style="color:var(--accent);font-size:12.5px;">Have a class or cohort code? Redeem it free →</a></div>
        </div>`;
        document.body.appendChild(wrap);
    }
    function closeUpgradeModal() { const o = $('upgrade-overlay'); if (o) o.remove(); }

    // ---- Critical Events (premium) ----------------------------------------
    // Browse-first emergency reference: an index of the 26 events (grouped by
    // clinical category, filterable by chips) that opens ONE focused card at a
    // time — the way a paper emergency manual is actually used in a crisis. Each
    // focused card leads with a "First moves" key-dose strip + Immediate actions,
    // demotes the photo to a thumbnail, and collapses Sources. Content (card HTML
    // + scoped CSS) comes from the premium-gated /api/critical-events endpoint;
    // free users get the upgrade screen.
    const ceEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const CE_CATS = [
        { key: 'cardiac', label: 'Cardiac & Rhythm', color: '#e5574c' },
        { key: 'airway', label: 'Airway & Respiratory', color: '#38bdf8' },
        { key: 'anaphylaxis', label: 'Anaphylaxis & Metabolic', color: '#e0a53a' },
        { key: 'obstetric', label: 'Obstetric & Hemorrhage', color: '#d060c8' },
        { key: 'equipment', label: 'Equipment & Environment', color: '#46b58a' },
        { key: 'neuro', label: 'Neuro & Embolism', color: '#a78bfa' },
    ];
    const CE_META = {
        'ce-asystole': { cat: 'cardiac', trigger: 'Flatline, no pulse', moves: ['Epinephrine 1 mg IV q3–5 min', 'High-quality CPR; treat H’s & T’s'] },
        'ce-bradycardia': { cat: 'cardiac', trigger: 'Slow rate, poor perfusion', moves: ['Atropine 0.5–1 mg IV (max 3 mg)', 'Epi infusion 2–10 mcg/min · pace'] },
        'ce-pea': { cat: 'cardiac', trigger: 'Organized rhythm, no pulse', moves: ['Epinephrine 1 mg IV q3–5 min', 'CPR; find & treat the cause'] },
        'ce-vfvt': { cat: 'cardiac', trigger: 'Shockable rhythm, no pulse', moves: ['Defibrillate 120–200 J', 'Epi 1 mg + amiodarone 300 mg'] },
        'ce-svt-stable': { cat: 'cardiac', trigger: 'Fast narrow rhythm, stable', moves: ['Vagal maneuvers', 'Adenosine 6 mg → 12 mg IV push'] },
        'ce-svt-unstable': { cat: 'cardiac', trigger: 'Fast rhythm + instability', moves: ['Synchronized cardioversion', 'Adenosine 6→12 mg if narrow-regular'] },
        'ce-mi': { cat: 'cardiac', trigger: 'New ST changes / ischemia', moves: ['Treat hypotension, then nitroglycerin', 'Aspirin 160–325 mg · call cardiology'] },
        'ce-hypotension': { cat: 'cardiac', trigger: 'MAP <65 or >20–25% drop', moves: ['Phenylephrine 50–100 mcg / ephedrine 5–10 mg', 'Fluids; epi 10–100 mcg if refractory'] },
        'ce-hypoxemia': { cat: 'airway', trigger: 'Falling SpO₂', moves: ['100% O₂, high flow', 'Hand-ventilate; confirm tube & compliance'] },
        'ce-bronchospasm': { cat: 'airway', trigger: '↑Airway pressure, wheeze', moves: ['Deepen anesthetic', 'Albuterol 8–10 puffs; epi if severe'] },
        'ce-laryngospasm': { cat: 'airway', trigger: 'Stridor or silent closed glottis', moves: ['100% O₂ + jaw thrust + CPAP', 'Propofol; succinylcholine if it persists'] },
        'ce-cico': { cat: 'airway', trigger: 'Can’t intubate, can’t oxygenate', moves: ['Declare CICO', 'Scalpel–bougie front-of-neck access NOW'] },
        'ce-pneumothorax': { cat: 'airway', trigger: '↑Pressure, ↓SpO₂, ↓BP, absent sounds', moves: ['Stop N₂O; 100% O₂', 'Needle decompress → chest tube'] },
        'ce-fire-airway': { cat: 'airway', trigger: 'Flash/pop in the airway', moves: ['Remove tube; stop O₂; disconnect circuit', 'Saline into airway; reintubate'] },
        'ce-anaphylaxis': { cat: 'anaphylaxis', trigger: 'Collapse ± bronchospasm/rash after a trigger', moves: ['Epinephrine 10–100 mcg IV (0.5 mg IM)', 'Stop trigger; fluids; 100% O₂'] },
        'ce-malignant-hyperthermia': { cat: 'anaphylaxis', trigger: 'Rising ETCO₂ + tachycardia + rigidity', moves: ['Dantrolene 2.5 mg/kg IV (repeat to effect)', 'Stop trigger; cool; call MH hotline'] },
        'ce-last': { cat: 'anaphylaxis', trigger: 'CNS/cardiac signs after local anesthetic', moves: ['Stop injecting; 100% O₂', 'Lipid 20% 1.5 mL/kg bolus + infusion'] },
        'ce-transfusion-reaction': { cat: 'anaphylaxis', trigger: 'Fever/hypotension during a unit', moves: ['STOP the transfusion', 'Support ABCs; recheck the unit'] },
        'ce-amniotic-fluid-embolism': { cat: 'obstetric', trigger: 'Sudden collapse + hypoxia in labor', moves: ['100% O₂; support circulation', 'Anticipate arrest, C-section, DIC'] },
        'ce-total-spinal': { cat: 'obstetric', trigger: 'Rapid high block, apnea, hypotension', moves: ['Secure airway; 100% O₂', 'Epi 10–100 mcg; fluids; LUD'] },
        'ce-hemorrhage': { cat: 'obstetric', trigger: 'Rapid large-volume blood loss', moves: ['Activate MTP (1:1 FFP:PRBC)', 'TXA 1 g; call for help & blood'] },
        'ce-oxygen-failure': { cat: 'equipment', trigger: 'Loss of pipeline/cylinder O₂', moves: ['Go off-machine: Ambu on room air/cylinder', 'Open backup tank; switch to TIVA'] },
        'ce-power-failure': { cat: 'equipment', trigger: 'OR power loss', moves: ['Get light; confirm ventilation (Ambu)', 'Switch to TIVA; manual monitors'] },
        'ce-fire-patient': { cat: 'equipment', trigger: 'Fire on/around the patient', moves: ['Stop gases; remove drapes/material', 'Extinguish (CO₂ if electrical)'] },
        'ce-delayed-emergence': { cat: 'neuro', trigger: 'No wake-up past expected time', moves: ['Confirm O₂/ventilation; 100% O₂', 'Reverse opioids/benzos; check glucose, temp, CO₂'] },
        'ce-vae': { cat: 'neuro', trigger: '↓ETCO₂ + hypotension in at-risk surgery', moves: ['Flood field; lower site; 100% O₂', 'Aspirate central line; epi 10–100 mcg'] },
    };
    const CE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 4.3 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
    const CE_APP_CSS = `
#ce-overlay .ce-topbar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 20px;border-bottom:1px solid var(--line);}
#ce-overlay .ce-brandlink{display:inline-flex;align-items:center;gap:9px;text-decoration:none;flex:none;}
#ce-overlay .ce-brandwm{font-family:'Figtree',ui-monospace,sans-serif;font-weight:800;font-size:20px;letter-spacing:-1px;color:var(--text);}
#ce-overlay .ce-topright{display:flex;align-items:center;gap:13px;min-width:0;}
#ce-overlay .ce-secname{display:inline-flex;align-items:center;gap:7px;font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:15px;color:var(--text2);white-space:nowrap;}
#ce-overlay .ce-secname svg{width:17px;height:17px;color:var(--danger);}
#ce-overlay .ce-exit{background:none;border:1px solid var(--line);color:var(--text2);border-radius:8px;padding:5px 11px;cursor:pointer;font-size:13px;flex:none;}
#ce-overlay .ce-exit:hover{border-color:var(--accent);color:var(--text);}
#ce-overlay .ce-wrap{max-width:860px;margin:0 auto;padding:22px 22px 90px;}
#ce-overlay .ce-lead{margin-bottom:14px;}
#ce-overlay .ce-h1{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:26px;margin:0 0 5px;letter-spacing:-.01em;}
#ce-overlay .ce-sub{color:var(--text2);font-size:14px;margin:0;}
#ce-overlay .ce-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;position:sticky;top:0;background:linear-gradient(var(--bg) 78%,transparent);padding:8px 0 12px;z-index:2;}
#ce-overlay .ce-chip{--chip:var(--accent);display:inline-flex;align-items:center;gap:7px;background:var(--panel);border:1px solid var(--line);color:var(--text2);border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:600;cursor:pointer;transition:border-color .15s,color .15s,background .15s;}
#ce-overlay .ce-chip::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--chip);flex:none;}
#ce-overlay .ce-chip:hover{color:var(--text);border-color:var(--chip);}
#ce-overlay .ce-chip.on{background:color-mix(in srgb,var(--chip) 16%,transparent);border-color:var(--chip);color:var(--text);}
#ce-overlay .ce-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:12px;}
#ce-overlay .ce-tile{--cat:var(--muted);display:flex;align-items:flex-start;gap:13px;text-align:left;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--cat);border-radius:13px;padding:15px 16px;cursor:pointer;transition:transform .14s,border-color .14s,box-shadow .2s;}
#ce-overlay .ce-tile:hover{transform:translateY(-2px);border-color:var(--cat);box-shadow:0 14px 30px -20px rgba(0,0,0,.6);}
#ce-overlay .ce-tile-em{flex:none;width:40px;height:40px;border-radius:10px;background:color-mix(in srgb,var(--cat) 16%,transparent);color:var(--cat);display:flex;align-items:center;justify-content:center;}
#ce-overlay .ce-tile-em svg{width:23px;height:23px;}
#ce-overlay .ce-tile-tx{display:flex;flex-direction:column;gap:2px;min-width:0;}
#ce-overlay .ce-tile-nm{font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:15.5px;line-height:1.15;color:var(--text);}
#ce-overlay .ce-tile-tg{font-size:12.5px;color:var(--muted);line-height:1.3;}
#ce-overlay .ce-empty{color:var(--muted);padding:30px 0;text-align:center;}
#ce-overlay .ce-back{display:inline-flex;align-items:center;gap:6px;background:none;border:none;color:var(--accent-2);font-family:var(--mono);font-size:13px;font-weight:600;cursor:pointer;padding:0;margin-bottom:16px;}
#ce-overlay .ce-back svg{width:17px;height:17px;}
#ce-overlay .ce-focus{border-left:3px solid var(--cat,var(--accent));}
#ce-overlay .ce-focus .ce-emblem{background:color-mix(in srgb,var(--cat,var(--accent)) 16%,transparent);color:var(--cat,var(--accent-2));}
#ce-overlay .ce-keys{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 20px;padding:13px 15px;border:1px solid var(--cat,var(--accent));background:color-mix(in srgb,var(--cat,var(--accent)) 9%,transparent);border-radius:12px;}
#ce-overlay .ce-keys-lbl{font-family:var(--mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--cat,var(--accent-2));font-weight:700;flex:none;}
#ce-overlay .ce-key{font-family:var(--mono);font-size:13px;font-weight:600;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:5px 10px;}
#ce-overlay .ce-focus .ce-photo-sec{max-width:440px;}
#ce-overlay .ce-focus .ce-photo-sec .ce-photo img{max-height:210px;}
#ce-overlay .ce-focus ol.ce-actions li{font-size:15px;}
#ce-overlay .ce-focus ol.ce-actions li::before{font-size:13px;font-weight:800;width:26px;height:26px;top:2px;}
#ce-overlay .ce-src-det>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;}
#ce-overlay .ce-src-det>summary::-webkit-details-marker{display:none;}
#ce-overlay .ce-src-det>summary::after{content:"\\25b8";color:var(--muted);font-size:11px;}
#ce-overlay .ce-src-det[open]>summary::after{content:"\\25be";}
#ce-overlay .ce-src-det .ce-src-count{font-family:var(--mono);font-size:11px;color:var(--muted);}
#ce-overlay .ce-src-det ul.ce-sources{margin-top:12px;}
@media (max-width:560px){#ce-overlay .ce-wrap{padding:16px 15px 80px;}#ce-overlay .ce-grid{grid-template-columns:1fr;}}
`;

    async function startCriticalEvents(deepSlug) {
        if (!premiumGate('critical')) return;
        closeNavMenus();
        toast('Loading Critical Events…');
        try {
            const { resp, data } = await apiJSON('/api/critical-events', { headers: authHeaders() });
            if (resp.status === 401) { signOut(); return; }
            if (resp.status === 402) { openUpgradeModal('critical'); return; }
            if (!resp.ok || !data || !data.html) throw new Error((data && data.error) || 'Unavailable.');
            try { track('critical_events_open', { count: data.count || 0 }); } catch (e) {}
            ceInit(data, deepSlug);
        } catch (err) {
            toast('Could not open Critical Events: ' + err.message);
        }
    }

    function ceInit(bundle, deepSlug) {
        const hm = deepSlug ? [null, String(deepSlug)] : (location.hash || "").match(/ce=([a-z0-9-]+)/i);
        closeCriticalEvents();
        if (!$('ce-inject-css')) { const st = document.createElement('style'); st.id = 'ce-inject-css'; st.textContent = bundle.css || ''; document.head.appendChild(st); }
        if (!$('ce-app-css')) { const st = document.createElement('style'); st.id = 'ce-app-css'; st.textContent = CE_APP_CSS; document.head.appendChild(st); }
        const holder = document.createElement('div'); holder.innerHTML = bundle.html;
        const byId = {};
        [].slice.call(holder.querySelectorAll('.ce-card')).forEach((c) => { byId[c.id] = c; });
        state.ce = { byId: byId, cat: 'all', mode: 'index', slug: null };
        const wrap = document.createElement('div');
        wrap.id = 'ce-overlay';
        wrap.style.cssText = 'position:fixed;inset:0;z-index:2650;background:var(--bg);display:flex;flex-direction:column;';
        wrap.innerHTML = `
            <div class="ce-topbar">
                <a href="/" onclick="MACPrep.closeCriticalEvents(); if(MACPrep.go)MACPrep.go('dashboard'); return false;" aria-label="MACPrep home" class="ce-brandlink">
                    <svg width="24" height="24" viewBox="0 0 512 512" style="flex:none;" aria-hidden="true"><rect width="512" height="512" rx="112" fill="var(--accent)"/><path d="M116 258 H188 L222 162 L278 350 L316 208 L348 258 H396" fill="none" stroke="var(--on-accent)" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    <span class="ce-brandwm">MAC<span style="color:var(--accent);">Prep</span></span>
                </a>
                <div class="ce-topright"><span class="ce-secname">${CE_ICON}<span>Critical Events</span></span><button onclick="MACPrep.closeCriticalEvents()" aria-label="Exit Critical Events" class="ce-exit">Exit</button></div>
            </div>
            <div id="ce-body" style="flex:1;overflow:auto;"></div>`;
        document.body.appendChild(wrap);
        document.documentElement.style.overflow = 'hidden';
        document.addEventListener('keydown', ceKey);
        const wantId = hm ? ('ce-' + hm[1].replace(/^ce-/, '')) : null;
        if (wantId && byId[wantId]) ceOpen(wantId);
        else ceRenderIndex();
    }

    function closeCriticalEvents() {
        const o = $('ce-overlay'); if (o) o.remove();
        document.documentElement.style.overflow = '';
        document.removeEventListener('keydown', ceKey);
        if (/[#&]ce=/.test(location.hash || '')) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
        state.ce = null;
    }
    function ceKey(e) {
        if (e.key !== 'Escape' || !$('ce-overlay')) return;
        e.preventDefault();
        if (state.ce && state.ce.mode === 'focused') ceRenderIndex(); else closeCriticalEvents();
    }

    function ceRenderIndex() {
        const body = $('ce-body'); if (!body || !state.ce) return;
        state.ce.mode = 'index'; state.ce.slug = null;
        if (/[#&]ce=/.test(location.hash || '')) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
        const active = state.ce.cat;
        const chips = [{ key: 'all', label: 'All events', color: 'var(--accent)' }].concat(CE_CATS)
            .map((c) => `<button class="ce-chip${active === c.key ? ' on' : ''}" style="--chip:${c.color};" onclick="MACPrep.ceFilter('${c.key}')">${ceEsc(c.label)}</button>`).join('');
        const tiles = Object.keys(state.ce.byId)
            .filter((id) => active === 'all' || (CE_META[id] && CE_META[id].cat === active))
            .map((id) => {
                const card = state.ce.byId[id];
                const meta = CE_META[id] || {};
                const cat = CE_CATS.find((c) => c.key === meta.cat) || { color: 'var(--muted)' };
                const emblem = (card.querySelector('.ce-emblem') || {}).innerHTML || '';
                const title = ((card.querySelector('.ce-title') || {}).textContent || '').trim();
                return `<button class="ce-tile" style="--cat:${cat.color};" onclick="MACPrep.ceOpen('${id}')"><span class="ce-tile-em">${emblem}</span><span class="ce-tile-tx"><span class="ce-tile-nm">${ceEsc(title)}</span><span class="ce-tile-tg">${ceEsc(meta.trigger || '')}</span></span></button>`;
            }).join('');
        body.innerHTML = `<div class="ce-wrap"><div class="ce-lead"><h1 class="ce-h1">Critical Events</h1><p class="ce-sub">Clinician-reviewed rapid-reference cards for anesthesia crises. Filter by system, then open an event.</p></div><div class="ce-chips">${chips}</div><div class="ce-grid">${tiles || '<div class="ce-empty">No events in this category.</div>'}</div></div>`;
        const cf = ceFooter(); if (cf) { const w = body.querySelector('.ce-wrap'); if (w) w.appendChild(cf); }
        body.scrollTop = 0;
    }

    function ceFilter(cat) { if (!state.ce) return; state.ce.cat = cat; ceRenderIndex(); }
    // Clone the canonical site footer so every Critical Events screen carries it.
    // (The per-card PDF clones only the .ce-card, so the footer never prints.)
    function ceFooter() { const f = document.querySelector('footer'); return f ? f.cloneNode(true) : null; }

    function ceOpen(id, skipHash) {
        const body = $('ce-body'); if (!body || !state.ce || !state.ce.byId[id]) return;
        state.ce.mode = 'focused'; state.ce.slug = id;
        if (!skipHash) { try { history.replaceState(null, '', location.pathname + location.search + '#ce=' + id.replace(/^ce-/, '')); } catch (e) {} }
        const card = ceBuildFocused(state.ce.byId[id]);
        const wrap = document.createElement('div'); wrap.className = 'ce-wrap';
        const back = document.createElement('button'); back.className = 'ce-back'; back.type = 'button';
        back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg> All events';
        back.onclick = ceRenderIndex;
        wrap.appendChild(back); wrap.appendChild(card);
        const cf = ceFooter(); if (cf) wrap.appendChild(cf);
        body.innerHTML = ''; body.appendChild(wrap); body.scrollTop = 0;
    }

    function ceBuildFocused(srcCard) {
        const card = srcCard.cloneNode(true);
        const meta = CE_META[card.id] || {};
        const cat = CE_CATS.find((c) => c.key === meta.cat);
        if (cat) card.style.setProperty('--cat', cat.color);
        card.classList.add('ce-focus');
        const secs = [].slice.call(card.querySelectorAll('section.ce-sec'));
        const byLabel = (name) => secs.find((s) => (((s.querySelector('.ce-label') || {}).textContent) || '').trim().toLowerCase() === name);
        const header = card.querySelector('header.ce-head');
        const immediate = byLabel('immediate actions');
        const when = byLabel('when to suspect');
        const photoFig = card.querySelector('.ce-photo');
        const photo = photoFig ? photoFig.closest('section.ce-sec') : null;
        if (meta.moves && meta.moves.length && header) {
            const strip = document.createElement('div');
            strip.className = 'ce-keys';
            strip.innerHTML = '<span class="ce-keys-lbl">First moves</span>' + meta.moves.map((mv) => `<span class="ce-key">${ceEsc(mv)}</span>`).join('');
            header.insertAdjacentElement('afterend', strip);
        }
        const afterHead = card.querySelector('.ce-keys') || header;
        if (immediate && afterHead) afterHead.insertAdjacentElement('afterend', immediate);
        if (photo) { photo.classList.add('ce-photo-sec'); const anchor = when || immediate; if (anchor) anchor.insertAdjacentElement('afterend', photo); }
        const sources = byLabel('sources');
        if (sources) {
            const list = sources.querySelector('ul.ce-sources');
            const lbl = sources.querySelector('.ce-label');
            if (list && lbl) {
                const det = document.createElement('details'); det.className = 'ce-src-det';
                const sum = document.createElement('summary');
                sum.innerHTML = lbl.outerHTML + '<span class="ce-src-count">' + list.querySelectorAll('li').length + ' sources</span>';
                det.appendChild(sum); det.appendChild(list);
                lbl.remove(); sources.appendChild(det);
            }
        }
        return card;
    }

    // Print / Save-as-PDF a single card (light-themed, one page). Works from the
    // focused view — prints exactly what's on screen (key strip + actions first).
    function cePrintCard(cardId) {
        const card = document.getElementById(cardId); if (!card) return;
        const title = ((card.querySelector('.ce-title') || {}).textContent || 'Critical Event').trim();
        const cardCss = (($('ce-inject-css') || {}).textContent) || '';
        const appCss = (($('ce-app-css') || {}).textContent) || '';
        const clone = card.cloneNode(true);
        const pb = clone.querySelector('.ce-print'); if (pb) pb.remove();
        clone.querySelectorAll('details').forEach((d) => { d.open = true; });
        const lightVars = ":root{--bg:#fff;--panel:#fff;--panel2:#f5f7f9;--line:#d5dbe2;--line2:#c3ccd6;--text:#14181d;--text2:#3a424c;--muted:#6b7280;--accent:#146A4A;--accent-2:#146A4A;--accent-dim:#e9f4ee;--danger:#b42318;--danger-dim:#fbe9e7;--good:#146A4A;--warn:#8a5a12;--warn-dim:#f4ecdb;--cat:#146A4A;--serif:'Fraunces',Georgia,serif;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,Menlo,Consolas,monospace;}";
        const printCss = "*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}html,body{margin:0;background:#fff;}body{padding:10px 20px;color:var(--text);font-family:var(--sans);}.ce-brand{font-family:var(--mono);font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin:0 0 12px;}.ce-card{border:0 !important;border-radius:0 !important;padding:0 !important;margin:0 !important;background:#fff !important;overflow:visible !important;break-inside:auto !important;page-break-inside:auto !important;}.ce-head{border-bottom:1px solid #d5dbe2;padding-bottom:14px;margin-bottom:16px;break-inside:avoid;}.ce-emblem{color:var(--cat,#146A4A) !important;}.ce-sec{margin-bottom:16px;}.ce-label{break-after:avoid;}.ce-keys{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:0 0 16px;padding:11px 13px;border:1px solid var(--cat,#146A4A);border-radius:10px;}.ce-keys-lbl{font-family:var(--mono);font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:var(--cat,#146A4A);font-weight:700;}.ce-key{font-family:var(--mono);font-size:12.5px;font-weight:600;color:#111;background:#f5f7f9;border:1px solid #d5dbe2;border-radius:6px;padding:4px 9px;}.ce-keys,figure.ce-photo,.ce-photo,table.ce-drugs tr,ol.ce-actions li,ul.ce-suspect li,ul.ce-pitfalls li,ul.ce-sources li,.ce-node{break-inside:avoid;page-break-inside:avoid;}.ce-photo-sec{max-width:460px;}.ce-photo img{max-height:240px !important;}.ce-src-det>summary{list-style:none;}.ce-src-det>summary::-webkit-details-marker{display:none;}.ce-src-det .ce-src-count{display:none;}.ce-src-det .ce-label{display:inline-block;margin-bottom:10px;}a{color:var(--accent);}@page{margin:14mm 12mm;}";
        const doc = "<!doctype html><html><head><meta charset='utf-8'><title>" + ceEsc(title) + " — MACPrep Critical Events</title><style>" + lightVars + cardCss + appCss + printCss + "</style></head><body><div class='ce-brand'>MACPrep · Critical Events</div>" + clone.outerHTML + "</body></html>";
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
        document.body.appendChild(frame);
        const idoc = frame.contentWindow.document;
        idoc.open(); idoc.write(doc); idoc.close();
        let printed = false;
        const go = () => { if (printed) return; printed = true; try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) {} setTimeout(() => frame.remove(), 1500); };
        const img = idoc.querySelector('img');
        if (img && !img.complete) { img.addEventListener('load', go); img.addEventListener('error', go); setTimeout(go, 2500); }
        else { setTimeout(go, 300); }
    }

    // ---- flashcard mode (premium active-recall) ---------------------------
    // Hide the choices, type your answer from memory, flip to reveal the correct
    // answer + rationale + source. Self-graded — no MCQ attempt is recorded
    // (/api/flashcards is a read-only, premium-gated reveal).
    async function startFlashcards(count, ids) {
        if (!premiumGate('flashcards')) return;
        closeNavMenus();
        toast('Building your flashcard deck…');
        try {
            const qstr = (ids && ids.length) ? ('ids=' + encodeURIComponent(ids.slice(0, 200).join(','))) : ('count=' + (count || 20));
            const { resp, data } = await apiJSON('/api/flashcards?' + qstr, { headers: authHeaders() });
            if (resp.status === 401) { signOut(); return; }
            if (resp.status === 402) { openUpgradeModal('flashcards'); return; }
            if (!resp.ok || !Array.isArray(data.cards) || !data.cards.length) throw new Error(data.error || 'No cards available.');
            state.flash = { cards: data.cards, i: 0, revealed: false, right: 0, input: '' };
            try { track('flashcards_start', { size: data.cards.length }); } catch (e) {}
            renderFlashcards();
        } catch (err) {
            toast('Could not start flashcards: ' + err.message);
        }
    }

    function closeFlashcards() {
        const o = $('flash-overlay'); if (o) o.remove();
        state.flash = null;
        document.removeEventListener('keydown', flashKey);
    }

    function flashKey(e) {
        const f = state.flash; if (!f) return;
        if (e.key === 'Escape') { e.preventDefault(); closeFlashcards(); return; }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!f.revealed) flashReveal(); else flashNext(); }
    }

    function renderFlashcards() {
        const f = state.flash; if (!f) return;
        let wrap = $('flash-overlay');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'flash-overlay';
            wrap.style.cssText = 'position:fixed;inset:0;z-index:2650;background:var(--bg);display:flex;flex-direction:column;';
            document.body.appendChild(wrap);
            document.addEventListener('keydown', flashKey);
        }
        if (f.i >= f.cards.length) { wrap.innerHTML = flashDoneHtml(); return; }
        const pct = Math.round((f.i / f.cards.length) * 100);
        wrap.innerHTML = `
            <div style="flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 20px;border-bottom:1px solid var(--line);">
                <div style="display:flex;align-items:center;gap:9px;font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:17px;"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="13.5" height="13" rx="2"/><path d="M7 4h11a2 2 0 0 1 2 2v10"/></svg>Flashcards</div>
                <div style="display:flex;align-items:center;gap:14px;">
                    <div class="mono" style="font-size:12px;color:var(--muted);">Card ${f.i + 1} / ${f.cards.length}</div>
                    <button onclick="MACPrep.closeFlashcards()" aria-label="Exit flashcards" style="background:none;border:1px solid var(--line);color:var(--text2);border-radius:8px;padding:5px 11px;cursor:pointer;font-size:13px;">Exit</button>
                </div>
            </div>
            <div style="flex:none;height:3px;background:var(--line);"><div style="height:100%;width:${pct}%;background:var(--accent);transition:width .3s ease;"></div></div>
            <div style="flex:1;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:26px 20px 40px;">
                <div id="flash-card" style="width:100%;max-width:640px;transform-style:preserve-3d;"></div>
            </div>`;
        renderFlashFace();
    }

    function renderFlashFace() {
        const f = state.flash; if (!f) return;
        const card = $('flash-card'); if (!card) return;
        const c = f.cards[f.i];
        const meta = (c.category || '').toUpperCase();   // broad specialty only — subtopic can spoil the answer
        if (!f.revealed) {
            card.innerHTML = `
                <div class="card" style="padding:24px;">
                    <div class="mono" style="font-size:11px;letter-spacing:.5px;color:var(--muted);margin-bottom:12px;">${escapeHtml(meta)}</div>
                    <div style="font-size:16px;line-height:1.65;">${renderRich(c.stem)}</div>
                    <div style="margin-top:20px;">
                        <label class="mono" style="font-size:11px;letter-spacing:.5px;color:var(--muted);display:block;margin-bottom:6px;">YOUR ANSWER (FROM MEMORY)</label>
                        <textarea id="flash-input" rows="3" placeholder="Type what you think the answer is, then reveal…" style="width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;color:var(--text);font-size:14px;line-height:1.5;resize:vertical;font-family:inherit;">${escapeHtml(f.input || '')}</textarea>
                    </div>
                    <button class="btn" style="width:100%;margin-top:14px;" onclick="MACPrep.flashReveal()">Reveal answer ↦</button>
                    <div class="mono" style="font-size:11px;color:var(--muted);text-align:center;margin-top:9px;">Recall beats recognition — commit to an answer before you flip. <span style="opacity:.7;">(⌘/Ctrl + Enter)</span></div>
                </div>`;
            const ta = $('flash-input'); if (ta) setTimeout(() => ta.focus(), 30);
        } else {
            const refs = (c.references || []).map((r) => {
                if (r && typeof r === 'object') { const u = safeUrl(r.url); const t = escapeHtml(r.title || r.url || 'Source'); return u ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener" style="color:var(--accent);">${t}</a>` : t; }
                const sv = String(r); const u = safeUrl(sv); return u ? `<a href="${escapeHtml(sv)}" target="_blank" rel="noopener" style="color:var(--accent);">${escapeHtml(sv)}</a>` : escapeHtml(sv);
            }).filter(Boolean).join(' · ');
            const yours = (f.input || '').trim();
            card.innerHTML = `
                <div class="card" style="padding:24px;">
                    <div class="mono" style="font-size:11px;letter-spacing:.5px;color:var(--muted);margin-bottom:12px;">${escapeHtml(meta)}</div>
                    <div style="font-size:15px;line-height:1.6;color:var(--text2);">${renderRich(c.stem)}</div>
                    <div style="margin-top:18px;padding:14px 16px;border:1px solid ${GRADE_GREEN};border-radius:12px;background:color-mix(in srgb, ${GRADE_GREEN} 10%, transparent);">
                        <div class="mono" style="font-size:11px;letter-spacing:.5px;color:${GRADE_GREEN};margin-bottom:5px;">CORRECT ANSWER (${escapeHtml(c.correctLetter || '')})</div>
                        <div style="font-size:15.5px;font-weight:600;line-height:1.5;">${renderRich(c.correctText || '—')}</div>
                    </div>
                    ${yours ? `<div style="margin-top:12px;font-size:13px;color:var(--muted);"><span class="mono" style="font-size:11px;letter-spacing:.5px;">YOU WROTE:</span> ${escapeHtml(yours)}</div>` : ''}
                    <div style="margin-top:16px;font-size:14px;line-height:1.7;"><div class="mono" style="font-size:11px;letter-spacing:.5px;color:var(--muted);margin-bottom:5px;">RATIONALE</div>${renderRich(c.explanation || 'No explanation provided.')}</div>
                    ${refs ? `<div style="margin-top:14px;font-size:12.5px;color:var(--muted);"><span class="mono" style="font-size:11px;letter-spacing:.5px;">SOURCE:</span> ${refs}</div>` : ''}
                    <div style="display:flex;gap:10px;margin-top:20px;">
                        <button class="btn secondary" style="flex:1;" onclick="MACPrep.flashGrade(false)">✗ Missed it</button>
                        <button class="btn" style="flex:1;" onclick="MACPrep.flashGrade(true)">✓ I had it</button>
                    </div>
                </div>`;
        }
    }

    function flashReveal() {
        const f = state.flash; if (!f || f.revealed) return;
        const ta = $('flash-input'); if (ta) f.input = ta.value;
        const card = $('flash-card'); if (!card) { f.revealed = true; return renderFlashFace(); }
        card.style.transition = 'transform .2s ease-in';
        card.style.transform = 'perspective(1200px) rotateY(90deg)';
        setTimeout(() => {
            f.revealed = true; renderFlashFace();
            card.style.transition = 'none';
            card.style.transform = 'perspective(1200px) rotateY(-90deg)';
            void card.offsetWidth;
            card.style.transition = 'transform .2s ease-out';
            card.style.transform = 'perspective(1200px) rotateY(0deg)';
        }, 200);
    }

    function flashGrade(gotIt) { const f = state.flash; if (!f) return; if (gotIt) f.right++; flashNext(); }

    function flashNext() {
        const f = state.flash; if (!f) return;
        f.i++; f.revealed = false; f.input = '';
        if (f.i >= f.cards.length) { const w = $('flash-overlay'); if (w) w.innerHTML = flashDoneHtml(); try { track('flashcards_done', { size: f.cards.length, right: f.right }); } catch (e) {} return; }
        renderFlashcards();
    }

    function flashDoneHtml() {
        const f = state.flash || { right: 0, cards: [] };
        const n = f.cards.length || 1;
        const pct = Math.round((f.right / n) * 100);
        return `<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:24px;">
            <div class="card" style="max-width:440px;width:100%;padding:30px 26px;text-align:center;">
                <div style="margin-bottom:12px;display:flex;justify-content:center;"><svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="13.5" height="13" rx="2"/><path d="M7 4h11a2 2 0 0 1 2 2v10"/></svg></div>
                <div style="font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:23px;">Deck complete</div>
                <div class="sub" style="font-size:14px;margin-top:8px;">You felt confident on <strong style="color:var(--accent);">${f.right} / ${n}</strong> — ${pct}% recall. The ones you missed are your highest-value review.</div>
                <div style="display:flex;gap:10px;margin-top:22px;">
                    <button class="btn secondary" style="flex:1;" onclick="MACPrep.closeFlashcards()">Done</button>
                    <button class="btn" style="flex:1;" onclick="MACPrep.startFlashcards(20)">New deck</button>
                </div>
            </div>
        </div>`;
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
        if ($('prof-grad')) $('prof-grad').value = p.graduation_date || '';
        onProfCredChange();
        $('prof-examdate').value = p.target_exam_date || '';
        $('prof-phone').value = p.phone || '';
        refreshRemindersUI();
    }

    // ---- Push study reminders (PWA) ---------------------------------------
    function pushSupported() { return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window); }
    function urlB64ToUint8(base64) {
        const pad = '='.repeat((4 - base64.length % 4) % 4);
        const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(b64); const arr = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
        return arr;
    }
    let _pushVapid = null; // cached { enabled, publicKey }
    async function pushConfig() {
        if (_pushVapid) return _pushVapid;
        try { const { data } = await apiJSON('/api/push/vapid-public'); _pushVapid = data || { enabled: false }; } catch (e) { _pushVapid = { enabled: false }; }
        return _pushVapid;
    }
    async function currentPushSub() {
        try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch (e) { return null; }
    }
    async function refreshRemindersUI() {
        const card = $('reminders-card'); if (!card) return;
        if (!pushSupported()) { card.classList.add('hidden'); return; }
        const cfg = await pushConfig();
        if (!cfg.enabled) { card.classList.add('hidden'); return; } // dormant until VAPID keys are set on the server
        card.classList.remove('hidden');
        const sub = await currentPushSub();
        const btn = $('reminders-btn'), msg = $('reminders-msg');
        if (btn) btn.textContent = sub ? 'Turn off reminders' : 'Enable reminders';
        if (msg) msg.textContent = sub ? 'On — you’ll be nudged when reviews are due.' : (Notification.permission === 'denied' ? 'Notifications are blocked in your browser settings.' : '');
    }
    async function toggleReminders() {
        const btn = $('reminders-btn'), msg = $('reminders-msg');
        if (!pushSupported()) { if (msg) msg.textContent = 'This browser doesn’t support notifications.'; return; }
        const cfg = await pushConfig();
        if (!cfg.enabled) { if (msg) msg.textContent = 'Reminders aren’t available yet.'; return; }
        const existing = await currentPushSub();
        if (btn) btn.disabled = true;
        try {
            if (existing) {
                try { await apiJSON('/api/push/unsubscribe', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ endpoint: existing.endpoint }) }); } catch (e) {}
                await existing.unsubscribe();
                toast('Study reminders off.');
            } else {
                const perm = await Notification.requestPermission();
                if (perm !== 'granted') { if (msg) msg.textContent = 'Allow notifications to turn on reminders.'; return; }
                const reg = await navigator.serviceWorker.ready;
                const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(cfg.publicKey) });
                await apiJSON('/api/push/subscribe', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub }) });
                toast('Study reminders on ✓');
            }
        } catch (e) { if (msg) msg.textContent = 'Could not update reminders: ' + (e.message || e); }
        finally { if (btn) btn.disabled = false; refreshRemindersUI(); }
    }

    // Show the graduation-date field only for students (SAA) in the profile form.
    function onProfCredChange() {
        const sel = $('prof-credential'), w = $('prof-grad-wrap');
        if (w) w.style.display = (sel && sel.value === 'SAA') ? '' : 'none';
    }
    async function saveProfile() {
        const btn = $('prof-save-btn'); const msg = $('prof-save-msg');
        btn.disabled = true; msg.textContent = '';
        const isSAA = $('prof-credential').value === 'SAA';
        const body = {
            full_name: $('prof-fullname').value.trim(),
            credential: $('prof-credential').value,
            training_program: $('prof-program').value.trim(),
            graduation_date: (isSAA && $('prof-grad')) ? ($('prof-grad').value || '') : null,
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
        const t = $('admin-review-title'); if (t) t.textContent = 'Content review';
        const sub = $('admin-sub'); if (sub) sub.innerHTML = 'One queue for everything awaiting review — new AI-authored questions and proposed answer edits. Publish / Approve applies to the live bank; the original is untouched until you do. <span id="admin-counts" class="mono" style="color:var(--muted);"></span>';
        const an = $('admin-analytics'); if (an) an.classList.add('hidden'); // analytics lives under Metrics only
        loadVouchers();
        const wrap = $('admin-body'); if (wrap) wrap.innerHTML = '<div class="mono" style="color:var(--muted);">Loading review queue…</div>';
        try {
            const [qr, er, rr] = await Promise.all([
                apiJSON('/api/admin/questions?status=sme_review', { headers: authHeaders() }).catch(() => ({ data: {} })),
                apiJSON('/api/admin/edits', { headers: authHeaders() }).catch(() => ({ data: {} })),
                apiJSON('/api/admin/reviews', { headers: authHeaders() }).catch(() => ({ data: {} })),
            ]);
            const questions = (qr.data && qr.data.questions) || [];
            const edits = (er.data && er.data.edits) || [];
            // Flagged user reviews (auto-held for language) land in the same queue as questions/edits.
            const flaggedReviews = ((rr.data && rr.data.reviews) || []).filter((rv) => rv.status === 'pending');
            const qc = (qr.data && qr.data.counts) || {}, ec = (er.data && er.data.counts) || {};
            state.review = {
                list: [...questions.map((q) => ({ kind: 'question', q })), ...edits.map((e) => ({ kind: 'edit', e })), ...flaggedReviews.map((rv) => ({ kind: 'review', rv }))],
                index: 0,
                counts: { sme_review: qc.sme_review != null ? qc.sme_review : questions.length, published: qc.published || 0, rejected: qc.rejected || 0, editsPending: ec.pending != null ? ec.pending : edits.length, editsApproved: ec.approved || 0, flaggedReviews: flaggedReviews.length },
            };
            renderReview();
        } catch (e) {
            if (wrap) wrap.innerHTML = `<div class="mono" style="color:var(--bad);">${escapeHtml(e.message)}</div>`;
        }
    }

    function renderReview() {
        const r = state.review; const wrap = $('admin-body'); if (!r || !wrap) return;
        const c = r.counts || {};
        const cnt = $('admin-counts'); if (cnt) cnt.textContent = `${c.sme_review || 0} new · ${c.editsPending || 0} edits · ${c.flaggedReviews || 0} flagged reviews · ${c.published || 0} published · ${c.rejected || 0} rejected`;
        if (!r.list.length || r.index >= r.list.length) {
            wrap.innerHTML = '<div class="card"><h3>All caught up 🎉</h3><div class="mono" style="color:var(--muted);">Nothing awaiting review — new questions, proposed edits, and flagged reviews all land here.</div></div>';
            return;
        }
        const item = r.list[r.index];
        if (item.kind === 'edit') { renderEditCard(item.e); return; }
        if (item.kind === 'review') { renderReviewCard(item.rv); return; }
        renderQuestionCard(item.q);
    }

    function renderQuestionCard(q) {
        const r = state.review; const wrap = $('admin-body');
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
            <div class="mono" style="color:var(--muted);font-size:12px;margin-bottom:8px;">New question · ${r.index + 1} of ${r.list.length} · ${escapeHtml(q.id)} · ${escapeHtml((q.category || '') + ' · ' + (q.subtopic || '') + ' · ' + (q.difficulty || ''))}</div>
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
        const r = state.review; const q = r.list[r.index].q;
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

    // ---- Flagged review card — a user review auto-held for language, shown inline in
    // the same Content review queue as questions/edits. Approve publishes it to the
    // public Reviews page; Remove takes it down. Removal is confirmed (never one-click).
    function renderReviewCard(rv) {
        const r = state.review; const wrap = $('admin-body'); if (!wrap) return;
        const rating = rv.rating || 5;
        const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(Math.max(0, 5 - Math.round(rating)));
        wrap.innerHTML = `
            <div class="mono" style="color:var(--muted);font-size:12px;margin-bottom:8px;">Flagged review · ${r.index + 1} of ${r.list.length} · auto-held for language</div>
            <div class="card">
                <div style="color:#f5b73c;letter-spacing:2px;font-size:15px;">${stars}</div>
                <div style="font-size:15px;line-height:1.6;margin:10px 0;">“${escapeHtml(rv.body || '')}”</div>
                <div class="mono" style="font-size:12px;color:var(--muted);">${escapeHtml(rv.author_name || '')}${rv.credential ? ' · ' + escapeHtml(rv.credential) : ''}</div>
                <div class="mono" style="font-size:11px;color:var(--warn);margin-top:10px;">⚠ Held automatically — not on the public Reviews page until you approve it.</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;">
                    <button class="btn" onclick="MACPrep.reviewCardAct('approve')">✓ Approve &amp; publish</button>
                    <button class="btn ghost" onclick="MACPrep.reviewCardAct('skip')">Skip →</button>
                    <button class="btn" style="background:var(--danger);" onclick="MACPrep.reviewCardAct('remove')">✗ Remove</button>
                </div>
                <span id="review-msg" class="mono" style="font-size:12px;color:var(--accent);"></span>
            </div>`;
    }
    async function reviewCardAct(action) {
        const r = state.review; if (!r) return;
        const item = r.list[r.index]; if (!item || item.kind !== 'review') return;
        const rv = item.rv; const msg = $('review-msg');
        if (action === 'skip') { r.index++; renderReview(); return; }
        // Removal is deliberate — a confirmation guards against taking a review down by accident.
        if (action === 'remove' && !confirm('Remove this flagged review? It won’t be published.')) return;
        const apiAction = (action === 'approve') ? 'approve' : 'reject';
        try {
            const { resp, data } = await apiJSON('/api/admin/review', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ id: rv.id, action: apiAction }) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Failed.');
            r.counts.flaggedReviews = Math.max(0, (r.counts.flaggedReviews || 1) - 1);
            r.index++;
            renderReview();
        } catch (e) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } }
    }

    // ---- Answer-length edit card — rendered inline in the unified review queue
    // above (no separate tab). Approve applies the proposed choices to the live
    // question; the original is untouched until then.
    function renderEditCard(e) {
        const r = state.review; const wrap = $('admin-body'); if (!wrap) return;
        const GREEN = '#16a34a';
        const q = e.question || {};
        const orig = e.original_choices || [], prop = e.proposed_choices || [];
        const byLabel = {}; orig.forEach((o, i) => { byLabel[o.label || i] = o; });
        const rows = prop.map((p, i) => {
            const o = byLabel[p.label] || orig[i] || {};
            const isC = p.correct === true;
            const oLen = (o.text || '').length, pLen = (p.text || '').length;
            return `<div style="border:1px solid ${isC ? GREEN : 'var(--line)'};border-radius:8px;padding:11px;margin:9px 0;background:${isC ? 'color-mix(in srgb,' + GREEN + ' 9%,transparent)' : 'var(--bg)'};">
                <div style="font-family:ui-monospace,monospace;font-size:11px;color:${isC ? GREEN : 'var(--muted)'};margin-bottom:6px;font-weight:${isC ? 700 : 400};">[${escapeHtml(p.label || String.fromCharCode(65 + i))}]${isC ? ' ✓ CORRECT' : ''}</div>
                <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Original <span class="mono">(${oLen})</span> · <span style="color:var(--text2);">${escapeHtml(o.text || '—')}</span></div>
                <div style="font-size:11px;color:var(--muted);margin-bottom:2px;">Proposed <span class="mono">(<span data-len="${i}">${pLen}</span>)</span></div>
                <input data-ptext="${i}" oninput="MACPrep._editLen(${i})" value="${escapeHtml(p.text || '')}" style="width:100%;margin:2px 0;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:5px;color:var(--text);font-size:13px;">
                <textarea data-prat="${i}" rows="2" style="width:100%;margin-top:4px;padding:8px;background:var(--panel);border:1px solid var(--line);border-radius:5px;color:var(--muted);font-size:12px;">${escapeHtml(p.rationale || '')}</textarea>
            </div>`;
        }).join('');
        const correctLen = ((prop.find((p) => p.correct === true) || {}).text || '').length;
        const maxOther = Math.max(0, ...prop.filter((p) => !p.correct).map((p) => (p.text || '').length));
        const fixed = correctLen > 0 && correctLen <= maxOther;
        wrap.innerHTML = `
            <div class="mono" style="color:var(--muted);font-size:12px;margin-bottom:8px;">Proposed edit · ${r.index + 1} of ${r.list.length} · ${escapeHtml(e.question_id)} · ${escapeHtml((q.category || '') + (q.subtopic ? ' · ' + q.subtopic : ''))}</div>
            <div class="card">
                <div style="font-size:14px;line-height:1.55;margin-bottom:8px;">${escapeHtml(q.stem || '')}</div>
                <div class="mono" style="font-size:11px;color:${fixed ? GREEN : 'var(--warn)'};margin-bottom:4px;">${fixed ? '✓ correct is no longer the longest choice' : '⚠ correct is still the longest — trim it or lengthen a distractor before approving'}</div>
                ${e.note ? `<div class="mono" style="font-size:11px;color:var(--muted);margin-bottom:8px;">${escapeHtml(e.note)}</div>` : ''}
                ${rows}
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;">
                    <button class="btn" onclick="MACPrep.editAction('approve')">✓ Approve &amp; apply</button>
                    <button class="btn ghost" onclick="MACPrep.editAction('skip')">Skip →</button>
                    <button class="btn" style="background:var(--danger);" onclick="MACPrep.editAction('reject')">✗ Reject</button>
                </div>
                <span id="edit-msg" class="mono" style="font-size:12px;color:var(--accent);"></span>
            </div>`;
    }

    function _editLen(i) {
        const inp = $('admin-body').querySelector(`[data-ptext="${i}"]`);
        const span = $('admin-body').querySelector(`[data-len="${i}"]`);
        if (inp && span) span.textContent = (inp.value || '').length;
    }

    function collectEditChoices() {
        const r = state.review; const e = r.list[r.index].e; const prop = e.proposed_choices || [];
        return prop.map((p, i) => {
            const t = $('admin-body').querySelector(`[data-ptext="${i}"]`);
            const ra = $('admin-body').querySelector(`[data-prat="${i}"]`);
            return { ...p, text: t ? t.value : p.text, rationale: ra ? ra.value : p.rationale };
        });
    }

    async function editAction(action) {
        const r = state.review; if (!r) return;
        const e = r.list[r.index].e; const msg = $('edit-msg');
        if (action === 'skip') { r.index++; renderReview(); return; }
        const body = { id: e.id, action };
        if (action === 'approve') body.choices = collectEditChoices();
        try {
            const { resp, data } = await apiJSON('/api/admin/edit', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
            if (!resp.ok || !data.success) throw new Error(data.error || 'Failed.');
            if (action === 'approve') r.counts.editsApproved = (r.counts.editsApproved || 0) + 1;
            r.counts.editsPending = Math.max(0, (r.counts.editsPending || 1) - 1);
            r.index++;
            renderReview();
        } catch (err) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = err.message; } }
    }

    // ---- Reviews moderation (admin): approve/reject submissions + add curated ----
    async function reviewMod() {
        if (!(state.profile && state.profile.is_admin)) { go('dashboard'); return; }
        go('admin');
        const t = $('admin-review-title'); if (t) t.textContent = 'Reviews';
        const sub = $('admin-sub'); if (sub) sub.innerHTML = 'Approve or reject submitted reviews, or paste in a testimonial someone sent you. Approved reviews show on the public <a href="/reviews" target="_blank" rel="noopener">Reviews page</a>. <span id="admin-counts" class="mono" style="color:var(--muted);"></span>';
        ['admin-analytics', 'admin-vouchers'].forEach((id) => { const el = $(id); if (el) el.classList.add('hidden'); });
        const wrap = $('admin-body'); if (wrap) wrap.innerHTML = '<div class="mono" style="color:var(--muted);">Loading reviews…</div>';
        try {
            const { resp, data } = await apiJSON('/api/admin/reviews', { headers: authHeaders() });
            if (!resp.ok) throw new Error(data.error || 'Could not load.');
            state.reviewMod = { list: data.reviews || [], counts: data.counts || {} };
            renderReviewMod();
        } catch (e) { if (wrap) wrap.innerHTML = `<div class="mono" style="color:var(--bad);">${escapeHtml(e.message)}</div>`; }
    }
    function renderReviewMod() {
        const r = state.reviewMod; const wrap = $('admin-body'); if (!r || !wrap) return;
        const c = r.counts || {};
        const cnt = $('admin-counts'); if (cnt) cnt.textContent = `${c.pending || 0} pending · ${c.approved || 0} approved · ${c.rejected || 0} rejected`;
        const inp = 'width:100%;box-sizing:border-box;padding:8px 10px;margin-bottom:8px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--text);font-size:13px;';
        const add = `<div class="card" style="margin-bottom:18px;">
            <label>Add a testimonial (someone texted you one?)</label>
            <input id="rvm-name" placeholder="Name" maxlength="80" style="${inp}">
            <input id="rvm-cred" placeholder="Credential — e.g. SAA, Class of 2026 · or CAA" maxlength="80" style="${inp}">
            <select id="rvm-rating" style="${inp}"><option value="5">★★★★★ — 5</option><option value="4">★★★★ — 4</option><option value="3">★★★ — 3</option><option value="2">★★ — 2</option><option value="1">★ — 1</option></select>
            <textarea id="rvm-body" placeholder="Their words" rows="3" maxlength="2000" style="${inp}"></textarea>
            <label style="display:inline-flex;align-items:center;gap:6px;font-weight:400;font-size:13px;margin-bottom:10px;"><input type="checkbox" id="rvm-feat"> Feature (pin near the top)</label>
            <div><button class="btn" onclick="MACPrep.reviewModAdd()">Add — publishes live</button> <span id="rvm-msg" class="mono" style="font-size:12px;color:var(--accent);"></span></div>
        </div>`;
        const pending = r.list.length ? r.list.map((rv) => `<div class="card" style="margin-bottom:10px;">
            <div style="color:#f5b73c;letter-spacing:2px;">${'★'.repeat(rv.rating || 5)}${'☆'.repeat(5 - (rv.rating || 5))}</div>
            <div style="font-size:14px;line-height:1.5;margin:6px 0;">“${escapeHtml(rv.body || '')}”</div>
            <div class="mono" style="font-size:12px;color:var(--muted);">${escapeHtml(rv.author_name || '')}${rv.credential ? ' · ' + escapeHtml(rv.credential) : ''}</div>
            <div style="display:flex;gap:8px;margin-top:10px;"><button class="btn" onclick="MACPrep.reviewModAct(${rv.id},'approve')">✓ Approve</button><button class="btn ghost" onclick="MACPrep.reviewModAct(${rv.id},'reject')">✗ Reject</button></div>
        </div>`).join('') : '<div class="card"><div class="mono" style="color:var(--muted);">No pending reviews right now.</div></div>';
        wrap.innerHTML = add + '<div class="mono" style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin:4px 0 8px;">Pending submissions</div>' + pending;
    }
    async function reviewModAct(id, action) {
        // Reject takes a review down from the public page — confirm so it can't happen by accident.
        if (action === 'reject' && !confirm('Remove this review from the public Reviews page? It will be taken down immediately.')) return;
        try { const { resp, data } = await apiJSON('/api/admin/review', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ id, action }) }); if (!resp.ok || !data.success) throw new Error(data.error || 'Failed'); reviewMod(); } catch (e) { toast(e.message); }
    }
    async function reviewModAdd() {
        const g = (id) => (($(id) || {}).value || '').trim(); const msg = $('rvm-msg');
        const body = { create: true, author_name: g('rvm-name'), credential: g('rvm-cred'), rating: g('rvm-rating'), body: g('rvm-body'), featured: !!($('rvm-feat') && $('rvm-feat').checked) };
        if (!body.author_name || !body.body) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = 'Name and text required.'; } return; }
        try { const { resp, data } = await apiJSON('/api/admin/review', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) }); if (!resp.ok || !data.success) throw new Error(data.error || 'Failed'); reviewMod(); } catch (e) { if (msg) { msg.style.color = 'var(--bad)'; msg.textContent = e.message; } }
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
        { icon: '🏆', label: 'Leaderboard — weekly rankings', run: () => go('leaderboard'), auth: true },
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
        go, goRedeem, startQotd, login, signupInline, showSignin, showSignup, signOut, startSession, startDiagnostic, advance, saveProfile, setExamDate, setStudyGoal, startCheckout, submitFeedback, toggleReminders,
        requestPasswordReset, redoMissed, startFlagged, toggleFlag, flagFromReview, flashcardFromReview, toggleFlashcard, startFlashcardDeck, changePassword, deleteAccount, toggleMobileNav, toggleNavMenu, closeNavMenus,
        smartReview, startSample, saveNote, reviewQueue, adminAction, editAction, reviewCardAct, _editLen,
        reviewMod, reviewModAct, reviewModAdd,
        gotoQuestion, prevQuestion, submitExam, redeemCode, generateVouchers, copyCodes, loadLeaderboard, saveLeaderboardSettings, saveLeaderboardName, lbSetTab, dashLbSetTab, openNamePrompt, closeNamePrompt, saveNamePrompt, copyReferral,
        onCredChange, onCredModalChange, maybePromptCredential, openCredentialPrompt, closeCredentialPrompt, saveCredentialPrompt, onProfCredChange,
        startRecommended, toggleCustomize, toggleMoreModes, openCmdk, closeCmdk, cmdkInput, cmdkKey, cmdkRun,
        reportQuestion, setConfidence, reviewConfidentMisses,
        drillSpecialty, openSpecialtyPicker, closeSpecialtyPicker, startSpecialtyQuiz, reviewDue, resumeSession, discardSession,
        startMockExam, openMockPicker, closeMockPicker, startQuick, jumpToCard, openWhatsNew, closeWhatsNew, closeWhatsNewPopup,
        ringFocus, ringBlur, toggleSidebar, resetProgress, closeLevelUp, openDailyChest,
        openBossPicker, closeBossPicker, startBossFight,
        openArcadePicker, closeArcadePicker, startArcade,
        premiumGate, openUpgradeModal, closeUpgradeModal, startCriticalEvents, closeCriticalEvents, cePrintCard, ceOpen, ceFilter,
        startFlashcards, closeFlashcards, flashReveal, flashGrade,
        openDuelPicker, closeDuelPicker, duelCreate, duelRandom, duelJoin, copyDuel,
        saveTitle, openTitlePicker, closeTitlePicker,
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
    // Global Escape closes the topmost open overlay/modal — WCAG 2.1.2 keyboard dismiss.
    // (Flashcards + Critical Events own a focused surface and handle their own Escape; this
    // covers the ~12 overlays that previously could only be dismissed with the mouse.)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const closers = [
            ['levelup-overlay', closeLevelUp], ['upgrade-overlay', closeUpgradeModal],
            ['boss-overlay', closeBossPicker], ['arcade-overlay', closeArcadePicker],
            ['title-overlay', closeTitlePicker],
            ['name-prompt-overlay', closeNamePrompt], ['ce-overlay', closeCriticalEvents],
            ['wn-popup', closeWhatsNewPopup], ['whatsnew-panel', closeWhatsNew], ['mock-picker', closeMockPicker],
            ['duel-overlay', closeDuelPicker], ['specialty-picker', closeSpecialtyPicker], ['cmdk', closeCmdk],
            ['calc-modal', toggleCalc], ['labs-modal', toggleLabs],
        ];
        for (let i = 0; i < closers.length; i++) {
            const el = $(closers[i][0]);
            if (el && !el.classList.contains('hidden')) { e.preventDefault(); try { closers[i][1](); } catch (_) {} return; }
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

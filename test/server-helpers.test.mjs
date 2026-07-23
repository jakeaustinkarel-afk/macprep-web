import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    answerChoiceId,
    applyServedFilter,
    analyticsPlatformFromMeta,
    deleteMacprepAccount,
    getServedQuestionQuery,
    isFreeTrialSessionPurpose,
    isValidProfileDate,
    lifecycleCredential,
    mobileAccountHash,
    normalizeLifecycleStage,
    normalizeTrainingProgram,
    normalizeVoucherLabel,
    readCookieHeader,
    registrationProfileError,
    resolveLifecycleCapabilities,
    resolveSubmittedChoiceIndex,
    runDatabaseHealthProbe,
    normalizeMobileStore,
    resolveFacultyScope,
    sanitizeAnalyticsMeta,
    sanitizeApplicantProgress,
    selectUnansweredFreePool,
    shouldReportDatabaseHealthFailure,
    summarizeProductUsage,
    trustedBaseUrl,
    validateAppleTransactionPayload,
    validateGooglePurchasePayload,
} from '../src/server.mjs';
import { fetchAllPostgrestRows } from '../src/lib/postgrest-pagination.mjs';
import { auditAnswerPositionBalance, validateQuestionForPublication } from '../src/lib/question-validation.mjs';

test('served question lookup applies the published-content filter before grading', () => {
    const calls = [];
    const query = {
        select(columns) { calls.push(['select', columns]); return this; },
        eq(column, value) { calls.push(['eq', column, value]); return this; },
        in(column, values) { calls.push(['in', column, values]); return this; },
    };
    const client = { from(table) { calls.push(['from', table]); return query; } };

    const result = getServedQuestionQuery(client, 'question-42');

    assert.equal(result, query);
    assert.deepEqual(calls[0], ['from', 'questions']);
    assert.match(calls[1][1], /teaching_debrief/);
    assert.match(calls[1][1], /debrief_reviewed_at/);
    assert.deepEqual(calls[2], ['eq', 'id', 'question-42']);
    assert.deepEqual(calls[3], ['in', 'status', ['published']]);
});

test('served filter keeps the query chain intact', () => {
    const query = { in(column, values) { this.args = [column, values]; return this; } };
    assert.equal(applyServedFilter(query), query);
    assert.deepEqual(query.args, ['status', ['published']]);
});

test('stable choice ids follow answer text across an editorial reorder', () => {
    const original = {
        id: 'question-42',
        choices: [{ text: 'Alpha' }, { text: 'Bravo' }, { text: 'Charlie' }],
    };
    const submittedId = answerChoiceId(original.id, original.choices[0]);
    const reordered = {
        ...original,
        choices: [original.choices[2], original.choices[1], original.choices[0]],
    };

    assert.equal(resolveSubmittedChoiceIndex(reordered, { choiceId: submittedId }), 2);
    assert.throws(
        () => resolveSubmittedChoiceIndex(reordered, { choiceId: 'not-a-current-choice' }),
        (error) => error.status === 409 && error.code === 'stale_question'
    );
});

test('the signed-in trial only permits the recommended session', () => {
    assert.equal(isFreeTrialSessionPurpose('recommended'), true);
    for (const purpose of ['sample', 'qotd', 'arcade', 'diagnostic', 'mock', 'custom', 'review']) {
        assert.equal(isFreeTrialSessionPurpose(purpose), false);
    }
});

test('a resumed trial serves only unanswered questions from its fixed pool', () => {
    const pool = [{ id: 'question-1' }, { id: 'question-2' }, { id: 'question-3' }];
    assert.deepEqual(
        selectUnansweredFreePool(pool, ['question-1'], 25).map((question) => question.id),
        ['question-2', 'question-3']
    );
    assert.deepEqual(
        selectUnansweredFreePool(pool, ['question-1', 'question-2', 'question-3'], 25),
        []
    );
});

test('mobile store names are allowlisted', () => {
    assert.equal(normalizeMobileStore('apple'), 'apple');
    assert.equal(normalizeMobileStore('google_play'), 'google_play');
    assert.equal(normalizeMobileStore('stripe'), null);
});

test('product analytics keeps native, web, and legacy events separate', () => {
    const now = new Date('2026-07-17T12:00:00Z');
    const rows = [
        { name: 'app_open', user_id: 'ios-user', meta: { platform: 'ios' }, created_at: '2026-07-17T11:00:00Z' },
        { name: 'mock_exam_start', user_id: 'ios-user', meta: { platform: 'ios' }, created_at: '2026-07-17T11:01:00Z' },
        { name: 'session_start', user_id: 'web-user', meta: { platform: 'web' }, created_at: '2026-07-15T12:00:00Z' },
        { name: 'session_complete', user_id: 'web-user', meta: { platform: 'web' }, created_at: '2026-07-15T12:10:00Z' },
        { name: 'critical_events_open', user_id: 'legacy-user', meta: {}, created_at: '2026-07-01T12:00:00Z' },
    ];
    const usage = summarizeProductUsage(rows, now);
    const ios = usage.platforms.find((row) => row.platform === 'ios');
    const web = usage.platforms.find((row) => row.platform === 'web');
    const untagged = usage.platforms.find((row) => row.platform === 'untagged');
    const mock = usage.feature_usage.find((row) => row.name === 'mock_exam_start');
    const critical = usage.feature_usage.find((row) => row.name === 'critical_events_open');

    assert.deepEqual(ios, { platform: 'ios', active_30d: 1, active_7d: 1, entries: 1, sessions: 0, completed: 0 });
    assert.deepEqual(web, { platform: 'web', active_30d: 1, active_7d: 1, entries: 0, sessions: 1, completed: 1 });
    assert.equal(untagged.active_30d, 1);
    assert.deepEqual(mock.by_platform, { web: 0, ios: 1, android: 0, untagged: 0 });
    assert.deepEqual(critical.by_platform, { web: 0, ios: 0, android: 0, untagged: 1 });
    assert.equal(analyticsPlatformFromMeta({ platform: 'android' }), 'android');
    assert.equal(analyticsPlatformFromMeta({ platform: 'desktop' }), 'untagged');
});

test('analytics metadata rejects arbitrary and identifying fields', () => {
    assert.deepEqual(sanitizeAnalyticsMeta('session_complete', {
        platform: 'ios', size: 25, answered: 24, mode: 'recommended',
        email: 'student@example.com', program: 'Example University', custom: { secret: true },
    }), { platform: 'ios', size: 25, mode: 'recommended', answered: 24 });
    assert.deepEqual(sanitizeAnalyticsMeta('landing_view', {
        platform: 'desktop', vid: 'visitor-123', email: 'student@example.com',
    }), { platform: 'untagged', vid: 'visitor-123' });
    assert.deepEqual(sanitizeAnalyticsMeta('boss_start', {
        platform: 'web', domain: 'Not a real domain',
    }), { platform: 'web' });
});

test('registration separates lifecycle stage, credential, and program requirements', () => {
    assert.equal(normalizeTrainingProgram('  Nova   Southeastern University (Tampa)  '), 'Nova Southeastern University (Tampa)');
    assert.equal(normalizeTrainingProgram('Emory\u0000\nUniversity'), 'Emory University');
    assert.equal(normalizeLifecycleStage(' Applicant '), 'applicant');
    assert.equal(normalizeLifecycleStage('aspiring'), null);
    assert.equal(lifecycleCredential('applicant'), null);
    assert.equal(lifecycleCredential('student'), 'SAA');
    assert.equal(lifecycleCredential('practicing'), 'CAA');
    assert.equal(registrationProfileError({ lifecycleStage: 'applicant', graduationDate: null, trainingProgram: '' }), '');
    assert.equal(registrationProfileError({ lifecycleStage: 'incoming_student', graduationDate: null, trainingProgram: '' }), 'Please select where you are in your AA journey.');
    assert.equal(registrationProfileError({ lifecycleStage: 'practicing', graduationDate: null, trainingProgram: '' }), 'Please select your AA program.');
    assert.equal(registrationProfileError({ lifecycleStage: 'practicing', graduationDate: null, trainingProgram: 'Program not listed' }), 'Please select your AA program.');
    assert.equal(registrationProfileError({ lifecycleStage: 'student', graduationDate: null, trainingProgram: 'Emory University' }), 'Current AA students must add a valid expected graduation date.');
    assert.equal(registrationProfileError({ lifecycleStage: 'student', graduationDate: '2027-02-30', trainingProgram: 'Emory University' }), 'Current AA students must add a valid expected graduation date.');
    assert.equal(registrationProfileError({ lifecycleStage: 'student', graduationDate: '2027-05-01', trainingProgram: 'Emory University' }), '');
    assert.equal(isValidProfileDate('2028-02-29'), true);
    assert.equal(isValidProfileDate('2027-02-29'), false);
});

test('lifecycle capabilities give admins every surface and keep members stage-scoped', () => {
    assert.deepEqual(resolveLifecycleCapabilities('applicant'), {
        applicant_workspace: true,
        board_prep: false,
        professional_resources: false,
        admin_tools: false,
    });
    assert.deepEqual(resolveLifecycleCapabilities('incoming_student'), {
        applicant_workspace: true,
        board_prep: false,
        professional_resources: false,
        admin_tools: false,
    });
    assert.deepEqual(resolveLifecycleCapabilities('student'), {
        applicant_workspace: false,
        board_prep: true,
        professional_resources: false,
        admin_tools: false,
    });
    assert.deepEqual(resolveLifecycleCapabilities('practicing'), {
        applicant_workspace: false,
        board_prep: true,
        professional_resources: true,
        admin_tools: false,
    });
    assert.deepEqual(resolveLifecycleCapabilities('student', { isAdmin: true }), {
        applicant_workspace: true,
        board_prep: true,
        professional_resources: true,
        admin_tools: true,
    });
    assert.deepEqual(resolveLifecycleCapabilities('student', { isReview: true }), {
        applicant_workspace: false,
        board_prep: true,
        professional_resources: false,
        admin_tools: false,
    });
});

test('applicant progress accepts only bounded planning data', () => {
    const clean = sanitizeApplicantProgress({
        target_cycle: '2028', shadowing_hours: 42.26,
        tasks: { research_programs: true, hidden_admin_task: true },
        prerequisites: { biology: 'complete', physics: 'invented' },
        programs: [
            { name: '  Emory   University  ', status: 'submitted', secret: 'drop me' },
            { name: '<script>alert(1)</script>', status: 'not-real' },
            { name: '', status: 'accepted' },
        ],
    });
    assert.equal(clean.target_cycle, '2028');
    assert.equal(clean.shadowing_hours, 42.3);
    assert.equal(clean.tasks.research_programs, true);
    assert.equal(Object.hasOwn(clean.tasks, 'hidden_admin_task'), false);
    assert.equal(clean.prerequisites.biology, 'complete');
    assert.equal(clean.prerequisites.physics, 'not_started');
    assert.deepEqual(clean.programs, [
        { name: 'Emory University', status: 'submitted' },
        { name: '<script>alert(1)</script>', status: 'researching' },
    ]);
});

test('applicant lifecycle remains excluded while dated transitions preserve entitlement', async () => {
    const [server, migration, datedMigration, app, landing, updates] = await Promise.all([
        readFile(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../supabase/migrations/20260722223000_applicant_lifecycle.sql', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../supabase/migrations/20260722231500_auto_graduation_lifecycle.sql', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../src/app.js', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../updates.html', import.meta.url)), 'utf8'),
    ]);
    const guardedRoutes = [
        '/api/questions', '/api/study-session', '/api/questions/search', '/api/exam-export',
        '/api/flashcards', '/api/critical-events', '/api/gamification', '/api/grade',
        '/api/grade-batch', '/api/leaderboard', '/api/user/flag', '/api/user/flashcard',
        '/api/duel/create', '/api/user/note', '/api/user/notebook',
    ];
    for (const route of guardedRoutes) {
        const start = server.indexOf(`'${route}'`);
        assert.ok(start >= 0, `missing route ${route}`);
        const next = server.indexOf('\napp.', start + route.length);
        const section = server.slice(start, next < 0 ? server.length : next);
        assert.match(section, /requireBoardPrepLifecycle/, `${route} must enforce lifecycle server-side`);
    }
    const applicantProgressStart = server.indexOf("app.post('/api/user/applicant-progress'");
    const applicantProgressEnd = server.indexOf("app.post('/api/user/lifecycle'", applicantProgressStart);
    const applicantProgressRoute = server.slice(applicantProgressStart, applicantProgressEnd);
    assert.match(applicantProgressRoute, /const adminUser = isAdminUser\(user\)/);
    assert.match(applicantProgressRoute, /if \(!adminUser && !\['applicant', 'incoming_student'\]\.includes\(lifecycle\.stage\)\)/);
    assert.match(server, /capabilities = resolveLifecycleCapabilities/);
    assert.match(app, /function profileCapability\(name\)/);
    assert.match(app, /view === 'applicant' && !applicantWorkspaceEnabled\(\)/);
    assert.match(app, /view === 'professional' && !professionalResourcesEnabled\(\)/);
    assert.match(landing, /id="nav-admin-applicant"/);
    assert.match(landing, /id="nav-professional"/);
    assert.match(landing, /id="professional-view"/);
    assert.match(migration, /p\.lifecycle_stage = 'student'/);
    assert.match(migration, /where lifecycle_stage in \('incoming_student', 'student', 'practicing'\)/);
    assert.match(datedMigration, /where lifecycle_stage = 'incoming_student'[\s\S]*matriculation_date <= current_date/);
    assert.match(datedMigration, /where lifecycle_stage = 'student'[\s\S]*graduation_date <= current_date/);
    assert.match(datedMigration, /lifecycle_stage = 'practicing',[\s\S]*credential = 'CAA'/);
    assert.doesNotMatch(datedMigration, /account_tier|premium_unlocked|stripe|voucher/i);
    assert.match(server, /startLifecycleScheduler\(\)/);
    assert.match(app + updates, /moves? into the practicing CAA experience on graduation/i);
});

test('cohort voucher labels normalize safely for generation and renaming', () => {
    assert.equal(normalizeVoucherLabel('  VCOM-Auburn\n Class of 2027\t Sent 2026  '), 'VCOM-Auburn Class of 2027 Sent 2026');
    assert.equal(normalizeVoucherLabel(null), '');
});

test('faculty scope is derived from the verified account assignment, not a query parameter', () => {
    const user = { id: 'faculty-user', email: 'faculty@example.edu', email_confirmed_at: '2026-01-01T00:00:00Z' };
    const scope = resolveFacultyScope({
        user,
        requestedProgram: 'Another University',
        profile: { is_faculty: true, faculty_program: '  Emory   University  ' },
    });
    assert.deepEqual(scope, { user, program: 'Emory University', role: 'faculty', isAdmin: false });
    assert.equal(resolveFacultyScope({ user, profile: { is_faculty: true, faculty_program: '' } }), null);
    assert.equal(resolveFacultyScope({ user: { ...user, email_confirmed_at: null }, profile: { is_faculty: true, faculty_program: 'Emory University' } }), null);
    assert.equal(resolveFacultyScope({ user, profile: { is_faculty: false, faculty_program: 'Emory University' } }), null);
});

test('cookie parsing matches exact names and safely decodes values', () => {
    const header = 'other_macprep_access=wrong; macprep_access=token%2Evalue; theme=dark';
    assert.equal(readCookieHeader(header, 'macprep_access'), 'token.value');
    assert.equal(readCookieHeader(header, 'missing'), '');
    assert.equal(readCookieHeader('macprep_access=%E0%A4%A', 'macprep_access'), '');
});

test('database health probes cancel slow requests and classify the timeout', async () => {
    let signal;
    const startedAt = Date.now();
    await assert.rejects(
        runDatabaseHealthProbe((probeSignal) => {
            signal = probeSignal;
            return new Promise((resolve) => {
                probeSignal.addEventListener('abort', () => resolve({ error: new Error('aborted') }), { once: true });
            });
        }, 20),
        /timed out after 20 ms/
    );
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - startedAt < 500, 'the timeout should bound the probe duration');
});

test('database health alerts require repeated failures and honor their cooldown', () => {
    const base = Date.UTC(2026, 6, 22, 12);
    assert.equal(shouldReportDatabaseHealthFailure({ consecutiveFailures: 1, lastReportedAt: 0, now: base }), false);
    assert.equal(shouldReportDatabaseHealthFailure({ consecutiveFailures: 2, lastReportedAt: 0, now: base }), true);
    assert.equal(shouldReportDatabaseHealthFailure({ consecutiveFailures: 3, lastReportedAt: base - 60_000, now: base }), false);
    assert.equal(shouldReportDatabaseHealthFailure({ consecutiveFailures: 3, lastReportedAt: base - 16 * 60_000, now: base }), true);
});

test('browser code keeps authentication credentials out of JavaScript storage and headers', async () => {
    const browserFiles = await Promise.all([
        '../src/app.js', '../metrics.html', '../faculty.html', '../pricing.html', '../reviews.html',
    ].map((relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')));
    for (const source of browserFiles) {
        assert.doesNotMatch(source, /sessionStorage\.getItem\(['"]macprep_token['"]\)/);
        assert.doesNotMatch(source, /Authorization\s*[:=].*Bearer/i);
    }

    const server = await readFile(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), 'utf8');
    const authSection = server.slice(server.indexOf("app.post('/api/authenticate'"), server.indexOf("app.post('/api/auth/logout'"));
    assert.match(authSection, /authenticated:\s*!!data\.session/);
    assert.match(authSection, /authenticated:\s*true/);
    assert.doesNotMatch(authSection, /token:\s*data\.session\?\.access_token/);
    assert.doesNotMatch(authSection, /res\.json\(\{\s*token:\s*data\.session\.access_token/);

    const passwordSection = server.slice(server.indexOf('class AuthPasswordUpdateError'), server.indexOf("app.post('/api/user/delete'"));
    assert.match(passwordSection, /\/auth\/v1\/user/);
    assert.match(passwordSection, /current_password/);
    assert.doesNotMatch(passwordSection, /admin\.updateUserById\([^)]*password/s);
});

test('publication validation requires one aligned answer, rationales, blueprint tags, and a real source', () => {
    const question = {
        stem: 'A stable adult develops hypotension immediately after induction of general anesthesia. What is the best initial response?',
        explanation: 'The response should address the most likely mechanism while preserving perfusion and reassessing the patient.',
        domain_name: 'Principles of Anesthesia',
        subtopic: 'Induction hypotension',
        correct_answer: 'B',
        choices: [
            { text: 'Observe without intervention', rationale: 'Observation alone does not address clinically important hypotension.', correct: false },
            { text: 'Treat the likely mechanism and reassess', rationale: 'Prompt targeted treatment supports perfusion while the cause is evaluated.', correct: true },
            { text: 'Deepen the anesthetic immediately', rationale: 'Additional anesthetic can worsen vasodilation and reduce perfusion pressure.', correct: false },
            { text: 'Delay action until a laboratory result returns', rationale: 'The immediate hemodynamic problem should be addressed before delayed tests return.', correct: false },
        ],
        references: [{ doi: '10.1016/j.bja.2020.01.001' }],
    };
    assert.deepEqual(validateQuestionForPublication(question), { valid: true, errors: [] });
    const unsafe = validateQuestionForPublication({ ...question, correct_answer: 'A', references: [{ doi: '10.1213/ane.0000000000000000' }] });
    assert.equal(unsafe.valid, false);
    assert.match(unsafe.errors.join(' '), /does not match/);
    assert.match(unsafe.errors.join(' '), /placeholder/);
});

test('Apple entitlement payload requires the expected app, product, and account token', () => {
    const userId = 'd2f6e72f-8f53-4a06-a5d0-f89126774399';
    const payload = {
        transactionId: '2000001234567890',
        originalTransactionId: '2000001234567890',
        bundleId: 'org.macprep.app',
        productId: 'org.macprep.app.full_access',
        type: 'Non-Consumable',
        appAccountToken: userId,
        environment: 'Sandbox',
        purchaseDate: 1760000000000,
    };
    const entitlement = validateAppleTransactionPayload(payload, { userId, transactionId: payload.transactionId });
    assert.equal(entitlement.store, 'apple');
    assert.equal(entitlement.transactionId, payload.originalTransactionId);
    assert.equal(entitlement.productId, payload.productId);

    assert.throws(
        () => validateAppleTransactionPayload({ ...payload, appAccountToken: '8b8bbd37-9c0d-4b0e-8f6a-fd0b891afb49' }, { userId, transactionId: payload.transactionId }),
        /different MACPrep account/
    );
    assert.throws(
        () => validateAppleTransactionPayload({ ...payload, productId: 'org.macprep.app.other' }, { userId, transactionId: payload.transactionId }),
        /not MACPrep full access/
    );
});

test('Google entitlement payload requires a completed account-bound purchase', () => {
    const userId = 'd2f6e72f-8f53-4a06-a5d0-f89126774399';
    const payload = {
        purchaseStateContext: { purchaseState: 'PURCHASED' },
        productLineItem: [{ productId: 'org.macprep.app.full_access' }],
        obfuscatedExternalAccountId: mobileAccountHash(userId),
        purchaseCompletionTime: '2026-07-17T20:00:00Z',
    };
    const entitlement = validateGooglePurchasePayload(payload, { userId });
    assert.equal(entitlement.store, 'google_play');
    assert.equal(entitlement.environment, 'production');
    assert.equal(mobileAccountHash(userId), mobileAccountHash(userId.toUpperCase()));

    assert.throws(
        () => validateGooglePurchasePayload({ ...payload, purchaseStateContext: { purchaseState: 'PENDING' } }, { userId }),
        /not complete/
    );
    assert.throws(
        () => validateGooglePurchasePayload({ ...payload, obfuscatedExternalAccountId: mobileAccountHash('8b8bbd37-9c0d-4b0e-8f6a-fd0b891afb49') }, { userId }),
        /different MACPrep account/
    );
});

test('account deletion propagates a database cleanup failure', async () => {
    const expected = new Error('transaction failed');
    await assert.rejects(
        deleteMacprepAccount({ rpc: async () => ({ error: expected }) }, 'user-1'),
        expected
    );
});

test('redirect bases require an allowlisted HTTPS origin', () => {
    assert.equal(trustedBaseUrl('https://www.macprep.org/checkout'), 'https://www.macprep.org');
    assert.equal(trustedBaseUrl('http://www.macprep.org'), '');
    assert.equal(trustedBaseUrl('https://macprep.org.attacker.example'), '');
});

test('PostgREST pagination collects every page and stops after a short page', async () => {
    const calls = [];
    const rows = await fetchAllPostgrestRows(async (from, to) => {
        calls.push([from, to]);
        if (from === 0) return { data: [{ id: 1 }, { id: 2 }], error: null };
        return { data: [{ id: 3 }], error: null };
    }, { pageSize: 2 });

    assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
    assert.deepEqual(calls, [[0, 1], [2, 3]]);
});

test('database migration contains the service-role-only rollups required by the server', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260717200046_database_contract_and_rollups.sql', import.meta.url)), 'utf8');
    for (const name of ['macprep_saa_benchmark', 'macprep_faculty_cohort_rollup', 'macprep_leaderboard_rollup', 'delete_macprep_account']) {
        assert.match(migration, new RegExp(`function public\\.${name}`));
    }
    assert.match(migration, /grant execute on function public\.delete_macprep_account\(uuid\) to service_role/);
});

test('account-deletion fix uses the deployed suggestions ownership column', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260717200559_fix_account_deletion_user_suggestions.sql', import.meta.url)), 'utf8');
    assert.match(migration, /user_suggestions\s+where lower\(coalesce\(user_email,/);
    assert.doesNotMatch(migration, /user_suggestions where user_id/);
    assert.match(migration, /grant execute on function public\.delete_macprep_account\(uuid\) to service_role/);
});

test('account-deletion fix casts the legacy voucher claim identifier', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260717200659_fix_account_deletion_voucher_claim_type.sql', import.meta.url)), 'utf8');
    assert.match(migration, /claimed_by_id = p_user::text/);
    assert.match(migration, /grant execute on function public\.delete_macprep_account\(uuid\) to service_role/);
});

test('security migration revokes legacy public data access', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260717211946_revoke_legacy_public_data_access.sql', import.meta.url)), 'utf8');
    assert.match(migration, /drop policy if exists "Allow public read access to questions"/);
    assert.match(migration, /drop policy if exists "Allow open review readings"/);
    assert.match(migration, /revoke all on table public\.macprep_questions_deprecated from anon, authenticated/);
    assert.match(migration, /revoke all on table public\.user_reviews from anon, authenticated/);
});

test('exam submission migration makes batch retries idempotent', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260718201644_atomic_exam_submissions.sql', import.meta.url)), 'utf8');
    assert.match(migration, /add column if not exists submission_id uuid/);
    assert.match(migration, /unique index if not exists idx_user_progress_submission_question/);
    assert.match(migration, /\(user_id, submission_id, question_id\)/);
});

test('repeat-attempt migration removes only the legacy per-question uniqueness rule', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260718192649_allow_repeat_question_attempts.sql', import.meta.url)), 'utf8');
    assert.match(migration, /drop constraint if exists unique_user_question/);
    assert.match(migration, /drop index if exists public\.unique_user_question/);
    assert.match(migration, /create index if not exists idx_user_progress_user_question/);
    assert.doesNotMatch(migration, /create unique index if not exists idx_user_progress_user_question/);
    assert.doesNotMatch(migration, /drop index if exists public\.idx_user_progress_submission_question/);
});

test('account entitlement migration makes every grant server-only and replay-safe', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260718201718_account_entitlement_ledger.sql', import.meta.url)), 'utf8');
    assert.match(migration, /create table if not exists public\.account_entitlements/);
    assert.match(migration, /unique \(source, source_reference\)/);
    assert.match(migration, /create unique index if not exists idx_account_entitlements_source_external_payment/);
    assert.match(migration, /for update/);
    assert.match(migration, /revoke all on table public\.account_entitlements from public, anon, authenticated/);
    for (const name of ['grant_macprep_entitlement', 'set_macprep_entitlement_status', 'claim_macprep_voucher']) {
        assert.match(migration, new RegExp(`function public\\.${name}`));
    }
});

test('learning rollup migration keeps cross-account data behind service-role functions', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260718201730_transactional_review_and_learning_rollups.sql', import.meta.url)), 'utf8');
    for (const name of ['apply_macprep_question_edit', 'macprep_user_learning_rollup', 'macprep_saa_question_stats', 'reset_macprep_progress', 'claim_macprep_daily_job']) {
        assert.match(migration, new RegExp(`function public\\.${name}`));
        assert.match(migration, new RegExp(`grant execute on function public\\.${name}`));
    }
    assert.match(migration, /revoke all on table public\.user_domain_ability from public, anon, authenticated/);
    assert.match(migration, /create trigger trg_macprep_domain_ability/);
});

test('shared limits and peer estimates are atomic, private, and latest-answer based', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260718202820_distributed_rate_limits_and_honest_benchmarks.sql', import.meta.url)), 'utf8');
    assert.match(migration, /create table if not exists public\.rate_limit_windows/);
    assert.match(migration, /primary key \(bucket, identity_hash\)/);
    assert.match(migration, /on conflict \(bucket, identity_hash\) do update/);
    assert.match(migration, /alter table public\.rate_limit_windows enable row level security/);
    assert.match(migration, /revoke all on table public\.rate_limit_windows from public, anon, authenticated/);
    assert.match(migration, /function public\.consume_macprep_rate_limit/);
    assert.match(migration, /distinct on \(up\.user_id, up\.question_id\)/);
    assert.match(migration, /distinct on \(up\.question_id\)/);
    assert.match(migration, /function public\.macprep_user_practice_readiness/);
    assert.match(migration, /grant execute on function public\.macprep_user_practice_readiness\(uuid, text\[\]\) to service_role/);
});

test('native purchase bridges publish an explicit compatibility handshake', async () => {
    const ios = await readFile(fileURLToPath(new URL('../mobile/plugins/macprep-purchases/ios/Sources/MacprepPurchases/MacprepPurchasesPlugin.swift', import.meta.url)), 'utf8');
    const android = await readFile(fileURLToPath(new URL('../mobile/plugins/macprep-purchases/android/src/main/java/org/macprep/purchases/MacprepPurchasesPlugin.java', import.meta.url)), 'utf8');
    for (const source of [ios, android]) {
        assert.match(source, /getCapabilities/);
        assert.match(source, /bridgeVersion/);
        assert.match(source, /productIds/);
    }
});

test('mobile purchase migration makes the server-only receipt ledger replay-safe', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260717225318_mobile_purchase_entitlements.sql', import.meta.url)), 'utf8');
    assert.match(migration, /create table if not exists public\.mobile_purchase_entitlements/);
    assert.match(migration, /unique \(store, store_transaction_id\)/);
    assert.match(migration, /enable row level security/);
    assert.match(migration, /revoke all on table public\.mobile_purchase_entitlements from public, anon, authenticated/);
    assert.match(migration, /delete from public\.mobile_purchase_entitlements where user_id = p_user/);
});

test('regression repair keeps repeat practice and provider events order-safe', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260718213000_recent_regression_repairs.sql', import.meta.url)), 'utf8');
    assert.match(migration, /distinct on \(up\.user_id, up\.question_id\)/);
    assert.match(migration, /distinct on \(question_id\) question_id, is_correct, confidence/);
    assert.match(migration, /from per_question where not is_correct/);
    assert.match(migration, /status in \('refunded', 'revoked', 'disputed'\)/);
    assert.match(migration, /and not p_allow_reactivate/);
    assert.match(migration, /function public\.macprep_user_id_from_mobile_hash/);
    assert.match(migration, /revoke all on function public\.sync_macprep_provider_entitlement/);
    assert.match(migration, /grant execute on function public\.sync_macprep_provider_entitlement[\s\S]+to service_role/);
});

test('batch retries reveal the persisted attempt and browser sign-out waits for confirmation', async () => {
    const server = await readFile(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), 'utf8');
    const batch = server.slice(server.indexOf("app.post('/api/grade-batch'"), server.indexOf('// User cosmetics'));
    assert.match(batch, /eq\('submission_id', submissionId\)/);
    assert.match(batch, /select\('question_id, selected_label, is_correct'\)/);
    assert.match(batch, /results: persistedResults/);
    assert.match(batch, /correct: persistedById\.get\(questionId\)\?\.is_correct === true/);
    assert.doesNotMatch(batch, /results: gradedAnswers\.map/);

    const browser = await readFile(fileURLToPath(new URL('../src/app.js', import.meta.url)), 'utf8');
    const signOut = browser.slice(browser.indexOf('async function signOut()'), browser.indexOf('// Forgot-password'));
    assert.match(signOut, /const response = await fetch\('\/api\/auth\/logout'/);
    assert.match(signOut, /if \(!response\.ok\) throw/);
    assert.ok(signOut.indexOf('await fetch') < signOut.indexOf('setToken(null)'));
    assert.match(browser, /wasAlreadyAnswered/);
});

test('user save routes inspect Supabase errors instead of returning false success', async () => {
    const server = await readFile(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), 'utf8');
    for (const marker of ["app.post('/api/user/flag'", "app.post('/api/user/flashcard'", "app.post('/api/user/note'", "app.post('/api/duel/score'"]) {
        const start = server.indexOf(marker);
        const end = server.indexOf('\n});', start) + 4;
        const route = server.slice(start, end);
        assert.match(route, /error/);
        assert.match(route, /throw/);
    }
});

test('answer-position audit rejects predictable authored batches', () => {
    const skewed = Array.from({ length: 12 }, (_, index) => ({
        id: `authored-batch-r50-${String(index + 1).padStart(3, '0')}`,
        correct_answer: 'A',
    }));
    const result = auditAnswerPositionBalance(skewed);

    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.type === 'dominant_answer_position'));
    assert.ok(result.issues.some((issue) => issue.type === 'answer_position_run'));
});

test('answer-position audit accepts a balanced batch with short natural runs', () => {
    const answers = ['C', 'A', 'D', 'B', 'E', 'B', 'D', 'A', 'E', 'C', 'C', 'D', 'A', 'B', 'E'];
    const balanced = answers.map((answer, index) => ({
        id: `authored-batch-r50-${String(index + 1).padStart(3, '0')}`,
        correct_answer: answer,
    }));

    assert.equal(auditAnswerPositionBalance(balanced).valid, true);
});

test('answer-position repair relabels choices and keys together', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260719204500_rebalance_published_answer_positions.sql', import.meta.url)), 'utf8');
    assert.match(migration, /jsonb_set\(choice, '\{label\}'/);
    assert.match(migration, /correct_answer = chr\(64 \+ rebuilt\.target_index\)/);
    assert.match(migration, /where coalesce\(\(choice->>'correct'\)::boolean, false\)/);
    assert.match(migration, /having max\(n\) - min\(n\) > 1/);

    const retiredRandomizer = await readFile(fileURLToPath(new URL('../rebalance_question_bank.mjs', import.meta.url)), 'utf8');
    assert.match(retiredRandomizer, /Direct question-bank randomization is retired/);
    assert.doesNotMatch(retiredRandomizer, /Math\.random|\.update\(/);

    const browser = await readFile(fileURLToPath(new URL('../src/app.js', import.meta.url)), 'utf8');
    assert.match(browser, /QUESTION_BANK_REVISION = '20260721-stable-choice-ids-v2'/);
    assert.match(browser, /s\.questionBankRevision !== QUESTION_BANK_REVISION/);
});

test('answer revisions preserve historical labels and keep peer charts comparable', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260719211040_answer_revision_and_reliability_repairs.sql', import.meta.url)), 'utf8');
    assert.match(migration, /add column if not exists answer_revision integer/);
    assert.match(migration, /trg_macprep_question_answer_revision/);
    assert.match(migration, /trg_macprep_progress_answer_revision/);
    assert.match(migration, /q\.answer_revision = up\.answer_revision/);
    assert.match(migration, /when upper\(up\.selected_label\) = inferred\.old_key then affected\.current_key/);
    assert.match(migration, /select auth\.uid\(\)/);
    assert.match(migration, /select auth\.jwt\(\)/);
});

test('reported stale-layout attempts are repaired and future grading uses choice identity', async () => {
    const [migration, server, browser, landing] = await Promise.all([
        readFile(fileURLToPath(new URL('../supabase/migrations/20260722005000_reported_question_repairs.sql', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../src/app.js', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8'),
    ]);

    assert.match(migration, /Expected exactly one stale-layout attempt for each of five reports/);
    assert.match(migration, /set selected_label = upper\(repair\.correct_answer\),[\s\S]+is_correct = true/);
    assert.match(migration, /rebuild_review_state/);
    assert.match(migration, /rebuild_domain_ability/);
    assert.match(migration, /persistent fetal bradycardia/);
    assert.match(server, /function answerChoiceId/);
    assert.match(server, /assertCurrentChoiceIdentity\(q, req\.body\)/);
    assert.match(server, /build: 'applicant-information-20260723\.1'/);
    assert.match(browser, /choiceId: currentQ\.choices\?\.\[selectedIndex\]\?\.id/);
    assert.match(browser, /answerRevision: currentQ\.answer_revision/);
    assert.match(landing, /choiceId:q\.choices\[sel\]&&q\.choices\[sel\]\.id/);
});

test('cohort group renaming is admin-only, owner-scoped, and merge-safe', async () => {
    const [server, browser] = await Promise.all([
        readFile(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../src/app.js', import.meta.url)), 'utf8'),
    ]);
    const start = server.indexOf("app.patch('/api/admin/vouchers/label'");
    const end = server.indexOf("app.get('/api/admin/vouchers'", start);
    const route = server.slice(start, end);
    assert.ok(start > -1 && end > start);
    assert.match(route, /getAdminUser\(req\)/);
    assert.match(route, /eq\('owner_director_id', admin\.id\)/);
    assert.match(route, /ilike\('label', label\)/);
    assert.match(route, /status\(409\)/);
    assert.match(route, /update\(\{ label \}, \{ count: 'exact' \}\)/);
    assert.match(route, /currentLabel === null[^;]+\.is\('label', null\)/);
    assert.match(browser, /\/api\/admin\/vouchers\/label/);
    assert.match(browser, /beginVoucherRename/);
    assert.match(browser, /new Map\(\)/);
});

test('full-bank tools paginate and static pricing delegates to the platform purchase flow', async () => {
    const [server, pricing, serviceWorker, reviews] = await Promise.all([
        readFile(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../pricing.html', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../sw.js', import.meta.url)), 'utf8'),
        readFile(fileURLToPath(new URL('../reviews.html', import.meta.url)), 'utf8'),
    ]);
    assert.match(server, /function fetchAllServedQuestionRows/);
    assert.doesNotMatch(server, /\.limit\(1500\)/);
    assert.doesNotMatch(pricing, /\/api\/create-checkout-session/);
    assert.match(pricing, /\/index\.html#upgrade/);
    assert.match(serviceWorker, /client\.navigate\(target\)/);
    assert.match(reviews, /reviewed before appearing publicly/);
    assert.doesNotMatch(server, /status\(500\)\.json\(\{\s*error:\s*[a-zA-Z]+\.message\s*\}\)/);
});

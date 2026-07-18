import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    applyServedFilter,
    analyticsPlatformFromMeta,
    deleteMacprepAccount,
    getServedQuestionQuery,
    isFreeTrialSessionPurpose,
    isValidProfileDate,
    mobileAccountHash,
    normalizeTrainingProgram,
    readCookieHeader,
    registrationProfileError,
    normalizeMobileStore,
    resolveFacultyScope,
    sanitizeAnalyticsMeta,
    selectUnansweredFreePool,
    summarizeProductUsage,
    trustedBaseUrl,
    validateAppleTransactionPayload,
    validateGooglePurchasePayload,
} from '../src/server.mjs';
import { fetchAllPostgrestRows } from '../src/lib/postgrest-pagination.mjs';
import { validateQuestionForPublication } from '../src/lib/question-validation.mjs';

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
    assert.deepEqual(calls[2], ['eq', 'id', 'question-42']);
    assert.deepEqual(calls[3], ['in', 'status', ['published']]);
});

test('served filter keeps the query chain intact', () => {
    const query = { in(column, values) { this.args = [column, values]; return this; } };
    assert.equal(applyServedFilter(query), query);
    assert.deepEqual(query.args, ['status', ['published']]);
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

test('registration requires a real AA program and preserves a clean program label', () => {
    assert.equal(normalizeTrainingProgram('  Nova   Southeastern University (Tampa)  '), 'Nova Southeastern University (Tampa)');
    assert.equal(normalizeTrainingProgram('Emory\u0000\nUniversity'), 'Emory University');
    assert.equal(registrationProfileError({ credential: 'CAA', graduationDate: null, trainingProgram: '' }), 'Please select your AA program.');
    assert.equal(registrationProfileError({ credential: 'CAA', graduationDate: null, trainingProgram: 'Program not listed' }), 'Please select your AA program.');
    assert.equal(registrationProfileError({ credential: 'SAA', graduationDate: null, trainingProgram: 'Emory University' }), 'Students (SAA) must add a valid graduation date.');
    assert.equal(registrationProfileError({ credential: 'SAA', graduationDate: '2027-02-30', trainingProgram: 'Emory University' }), 'Students (SAA) must add a valid graduation date.');
    assert.equal(registrationProfileError({ credential: 'SAA', graduationDate: '2027-05-01', trainingProgram: 'Emory University' }), '');
    assert.equal(isValidProfileDate('2028-02-29'), true);
    assert.equal(isValidProfileDate('2027-02-29'), false);
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

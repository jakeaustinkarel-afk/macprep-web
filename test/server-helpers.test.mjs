import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    applyServedFilter,
    deleteMacprepAccount,
    getServedQuestionQuery,
    isFreeTrialSessionPurpose,
    mobileAccountHash,
    normalizeTrainingProgram,
    registrationProfileError,
    normalizeMobileStore,
    selectUnansweredFreePool,
    trustedBaseUrl,
    validateAppleTransactionPayload,
    validateGooglePurchasePayload,
} from '../src/server.mjs';
import { fetchAllPostgrestRows } from '../src/lib/postgrest-pagination.mjs';

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

test('registration requires a real AA program and preserves a clean program label', () => {
    assert.equal(normalizeTrainingProgram('  Nova   Southeastern University (Tampa)  '), 'Nova Southeastern University (Tampa)');
    assert.equal(registrationProfileError({ credential: 'CAA', graduationDate: null, trainingProgram: '' }), 'Please select your AA program.');
    assert.equal(registrationProfileError({ credential: 'CAA', graduationDate: null, trainingProgram: 'Program not listed' }), 'Please select your AA program.');
    assert.equal(registrationProfileError({ credential: 'SAA', graduationDate: null, trainingProgram: 'Emory University' }), 'Students (SAA) must add a graduation date.');
    assert.equal(registrationProfileError({ credential: 'SAA', graduationDate: '2027-05-01', trainingProgram: 'Emory University' }), '');
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
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260717203000_revoke_legacy_public_data_access.sql', import.meta.url)), 'utf8');
    assert.match(migration, /drop policy if exists "Allow public read access to questions"/);
    assert.match(migration, /drop policy if exists "Allow open review readings"/);
    assert.match(migration, /revoke all on table public\.macprep_questions_deprecated from anon, authenticated/);
    assert.match(migration, /revoke all on table public\.user_reviews from anon, authenticated/);
});

test('mobile purchase migration makes the server-only receipt ledger replay-safe', async () => {
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260717225318_mobile_purchase_entitlements.sql', import.meta.url)), 'utf8');
    assert.match(migration, /create table if not exists public\.mobile_purchase_entitlements/);
    assert.match(migration, /unique \(store, store_transaction_id\)/);
    assert.match(migration, /enable row level security/);
    assert.match(migration, /revoke all on table public\.mobile_purchase_entitlements from public, anon, authenticated/);
    assert.match(migration, /delete from public\.mobile_purchase_entitlements where user_id = p_user/);
});

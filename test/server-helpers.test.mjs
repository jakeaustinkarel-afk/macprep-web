import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyServedFilter, deleteMacprepAccount, getServedQuestionQuery } from '../src/server.mjs';
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

test('account deletion propagates a database cleanup failure', async () => {
    const expected = new Error('transaction failed');
    await assert.rejects(
        deleteMacprepAccount({ rpc: async () => ({ error: expected }) }, 'user-1'),
        expected
    );
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
    const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20260717194118_database_contract_and_rollups.sql', import.meta.url)), 'utf8');
    for (const name of ['macprep_saa_benchmark', 'macprep_faculty_cohort_rollup', 'macprep_leaderboard_rollup', 'delete_macprep_account']) {
        assert.match(migration, new RegExp(`function public\\.${name}`));
    }
    assert.match(migration, /grant execute on function public\.delete_macprep_account\(uuid\) to service_role/);
});

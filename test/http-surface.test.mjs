import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { app } from '../src/server.mjs';

test('the HTTP surface serves public assets and denies repository internals', async (t) => {
    const server = app.listen(0);
    if (!server.listening) await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get('cache-control') || '', /no-store/);
    assert.equal((await health.json()).ok, true);

    const crossSiteMutation = await fetch(`${base}/api/event`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: 'macprep_access=fake-browser-session',
            Origin: 'https://attacker.example',
        },
        body: JSON.stringify({ type: 'test' }),
    });
    assert.equal(crossSiteMutation.status, 403);
    assert.equal((await crossSiteMutation.json()).error, 'Cross-site request rejected.');

    for (const publicPath of ['/', '/pricing', '/faq', '/privacy', '/src/app.js', '/public-shell.css']) {
        const response = await fetch(`${base}${publicPath}`);
        assert.equal(response.status, 200, `${publicPath} should be public`);
        assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
        assert.equal(response.headers.get('x-frame-options'), 'DENY');
        assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
        assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
        assert.equal(response.headers.get('x-permitted-cross-domain-policies'), 'none');
    }

    const canonical = await fetch(`${base}/pricing.html?from=test`, { redirect: 'manual' });
    assert.equal(canonical.status, 301);
    assert.equal(canonical.headers.get('location'), '/pricing?from=test');

    for (const privatePath of [
        '/.env', '/AGENTS.md', '/package.json', '/src/server.mjs',
        '/supabase/migrations/20260718201718_account_entitlement_ledger.sql',
        '/mobile/ios/App/App/AppDelegate.swift', '/node_modules/express/package.json',
        '/docs/codex/PROJECT_CONTEXT.md', '/local/claude-export/data.json',
    ]) {
        const response = await fetch(`${base}${privatePath}`, { redirect: 'manual' });
        assert.equal(response.status, 404, `${privatePath} must not be public`);
    }
});

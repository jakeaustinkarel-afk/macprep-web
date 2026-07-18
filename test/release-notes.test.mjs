import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the newest in-app release note also appears in the public update log', async () => {
    const [appSource, updatesHtml] = await Promise.all([
        readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
        readFile(new URL('../updates.html', import.meta.url), 'utf8'),
    ]);
    const newestEntry = appSource.match(/const WHATS_NEW = \[\s*\{[^}]*?title: '([^']+)'/);

    assert.ok(newestEntry, 'WHATS_NEW must contain a newest release entry.');
    assert.ok(
        updatesHtml.toLowerCase().includes(newestEntry[1].toLowerCase()),
        `The public update log must include the newest in-app release title: ${newestEntry[1]}`
    );
});

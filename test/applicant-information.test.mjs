import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
    AA_PROGRAM_DIRECTORY,
    AA_PROGRAM_DIRECTORY_META,
    publicAAProgramDirectory,
} from '../src/lib/aa-program-directory.mjs';

test('the applicant directory is a sanitized, dated CAAHEP snapshot', () => {
    assert.equal(AA_PROGRAM_DIRECTORY_META.verifiedOn, '2026-07-23');
    assert.equal(AA_PROGRAM_DIRECTORY_META.sourceUrl, 'https://www.caahep.org/students/find-an-accredited-program');
    assert.equal(AA_PROGRAM_DIRECTORY.length, 25);
    assert.equal(new Set(AA_PROGRAM_DIRECTORY.map((program) => program.id)).size, AA_PROGRAM_DIRECTORY.length);

    for (const program of AA_PROGRAM_DIRECTORY) {
        assert.ok(program.institution);
        assert.ok(program.city);
        assert.match(program.state, /^[A-Z]{2}$/);
        assert.ok(['Initial', 'Continuing'].includes(program.accreditationStatus));
        assert.match(program.initialAccreditationDate, /^\d{4}-\d{2}-\d{2}$/);
        assert.match(program.programUrl, /^https:\/\//);
        if (program.outcomesUrl) assert.match(program.outcomesUrl, /^https:\/\//);
    }

    const publicPayload = publicAAProgramDirectory();
    const serialized = JSON.stringify(publicPayload);
    assert.doesNotMatch(serialized, /programDirector|peopleId|email|phone|street|zip|address/i);

    const profiles = AA_PROGRAM_DIRECTORY.filter((program) => program.admissionsProfile);
    assert.equal(profiles.length, 2);
    for (const program of profiles) {
        assert.match(program.admissionsProfile.sourceUrl, /^https:\/\//);
        assert.ok(program.admissionsProfile.reportingPeriod);
        assert.ok(program.admissionsProfile.stats.length >= 5);
    }
});

test('the applicant experience states its evidence boundary and links primary sources', async () => {
    const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /Information, not admissions advice\./);
    assert.match(html, /We do not estimate missing acceptance rates/);
    assert.match(html, /id="applicant-directory-list"/);
    assert.match(html, /CAAHEP Find an Accredited Program/);
    assert.match(html, /NCCAA certification eligibility/);
    assert.match(html, /href="https:\/\/www\.aspiringcaa\.com\/"/);
});

test('every public CAA resources footer includes Aspiring CAA exactly once', async () => {
    const root = path.resolve(new URL('..', import.meta.url).pathname);
    const directories = [root, path.join(root, 'guides')];
    const htmlFiles = [];
    for (const directory of directories) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.html')) htmlFiles.push(path.join(directory, entry.name));
        }
    }

    let resourceFooters = 0;
    for (const file of htmlFiles) {
        const html = await readFile(file, 'utf8');
        if (!html.includes('CAA resources')) continue;
        resourceFooters += 1;
        assert.equal(
            (html.match(/class="pf-card" href="https:\/\/www\.aspiringcaa\.com\/"/g) || []).length,
            1,
            `${path.relative(root, file)} must include one Aspiring CAA resource card`
        );
    }
    assert.ok(resourceFooters >= 20, 'Expected the shared public resource footer across the public site.');
});

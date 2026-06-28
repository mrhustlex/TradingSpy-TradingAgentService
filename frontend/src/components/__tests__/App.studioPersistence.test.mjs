import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(__dirname, '../../App.jsx'), 'utf8');

test('AI Strategy Studio remains mounted while another tab is active', () => {
    assert.match(appSource, /<div hidden=\{activeTab !== 'studio'\}>/);
    assert.equal(
        appSource.includes("{activeTab === 'studio' && ("),
        false,
        'conditional rendering unmounts Studio and loses its generation state',
    );
    assert.equal(
        (appSource.match(/<AIStrategyStudio/g) || []).length,
        1,
        'Studio should have one persistent component instance',
    );
});

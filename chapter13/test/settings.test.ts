import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, defaultSettingsPath, parseSettingsJson } from '../src/model/index.ts';

test('parseSettingsJson loads currentModel and currentThinkingLevel', () => {
    const settings = parseSettingsJson(JSON.stringify({
        currentModel: 'deepseek-flash',
        currentThinkingLevel: 'high',
    }), 'settings.json');

    assert.deepEqual(settings, {
        currentModel: 'deepseek-flash',
        currentThinkingLevel: 'high',
    });
});

test('parseSettingsJson ignores unknown keys and missing values', () => {
    assert.deepEqual(parseSettingsJson(JSON.stringify({}), 'settings.json'), {});
    assert.deepEqual(parseSettingsJson(JSON.stringify({ theme: 'dark' }), 'settings.json'), {});
});

test('parseSettingsJson rejects invalid JSON and field types', () => {
    assert.throws(() => parseSettingsJson('{nope', 'settings.json'), /invalid JSON/);
    assert.throws(() => parseSettingsJson(JSON.stringify('str'), 'settings.json'), /must be a JSON object/);
    assert.throws(() => parseSettingsJson(JSON.stringify({ currentModel: 5 }), 'settings.json'), /invalid currentModel/);
    assert.throws(() => parseSettingsJson(JSON.stringify({ currentModel: '' }), 'settings.json'), /invalid currentModel/);
    assert.throws(() => parseSettingsJson(JSON.stringify({ currentThinkingLevel: 'xhigh' }), 'settings.json'), /invalid currentThinkingLevel/);
    assert.throws(() => parseSettingsJson(JSON.stringify({ currentThinkingLevel: 5 }), 'settings.json'), /invalid currentThinkingLevel/);
});

test('defaultSettingsPath points into ~/.zeroagent/settings.json', () => {
    assert.match(defaultSettingsPath(), /\.zeroagent[/\\]settings\.json$/);
});

test('SettingsStore loads an empty object for a missing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'za-settings-missing-'));
    try {
        const store = new SettingsStore(join(root, 'settings.json'));
        assert.deepEqual(await store.load(), {});
        assert.deepEqual(store.snapshot(), {});
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('SettingsStore setCurrentModel persists and merges with existing keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'za-settings-model-'));
    try {
        const file = join(root, 'settings.json');
        const store = new SettingsStore(file);
        await store.setCurrentModel('deepseek-flash');

        const raw = JSON.parse(await readFile(file, 'utf-8'));
        assert.deepEqual(raw, { currentModel: 'deepseek-flash' });

        await store.setCurrentThinkingLevel('low');
        const merged = JSON.parse(await readFile(file, 'utf-8'));
        assert.deepEqual(merged, { currentModel: 'deepseek-flash', currentThinkingLevel: 'low' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('SettingsStore setCurrentThinkingLevel persists without clobbering currentModel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'za-settings-level-'));
    try {
        const file = join(root, 'settings.json');
        const store = new SettingsStore(file);
        await store.setCurrentThinkingLevel('max');

        const raw = JSON.parse(await readFile(file, 'utf-8'));
        assert.deepEqual(raw, { currentThinkingLevel: 'max' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

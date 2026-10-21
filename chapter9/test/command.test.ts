import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import {
    CommandRegistry,
    parseCommandFile,
    loadCommandFromFile,
    loadCommandsFromDirectory,
    loadAllCommands,
    loadCommands,
    userCommandsDir,
    projectCommandsDir,
    expandTemplate,
    listAvailableCommands,
    tryRunCommand,
    type CommandDefinition,
} from '../src/command/index.ts';

// ---------------------------------------------------------------------------
// CommandRegistry tests
// ---------------------------------------------------------------------------

test('CommandRegistry registers and retrieves commands', () => {
    const registry = new CommandRegistry();
    const command: CommandDefinition = {
        name: 'review',
        description: 'Review a file',
        template: 'Review $1',
    };
    registry.register(command);
    assert.equal(registry.has('review'), true);
    assert.equal(registry.get('review'), command);
    assert.deepEqual(registry.names(), ['review']);
    assert.deepEqual(registry.list(), [command]);
});

test('CommandRegistry register overwrites same-name command', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'review', description: 'first', template: 'v1' });
    registry.register({ name: 'review', description: 'second', template: 'v2' });
    const command = registry.get('review');
    assert.equal(command?.description, 'second');
    assert.equal(command?.template, 'v2');
    assert.equal(registry.list().length, 1);
});

test('CommandRegistry list, names, and has', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'review', description: 'Review', template: 'Review $1' });
    registry.register({ name: 'commit', description: 'Commit', template: 'Commit $1' });
    assert.deepEqual(registry.list().map((c) => c.name), ['review', 'commit']);
    assert.deepEqual(registry.names(), ['review', 'commit']);
    assert.equal(registry.has('review'), true);
    assert.equal(registry.has('missing'), false);
});

test('CommandRegistry remove and clear', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'a', description: 'A', template: 'ta' });
    registry.register({ name: 'b', description: 'B', template: 'tb' });
    assert.equal(registry.remove('a'), true);
    assert.equal(registry.has('a'), false);
    assert.equal(registry.list().length, 1);
    assert.equal(registry.remove('missing'), false);
    registry.clear();
    assert.equal(registry.list().length, 0);
});

// ---------------------------------------------------------------------------
// parseCommandFile tests
// ---------------------------------------------------------------------------

test('parseCommandFile parses frontmatter and template body', () => {
    const content = `---
name: review
description: Review a file
---
Review the file:

$1`;
    const command = parseCommandFile(content, 'review.md');
    assert.equal(command.name, 'review');
    assert.equal(command.description, 'Review a file');
    assert.equal(command.template, 'Review the file:\n\n$1');
});

test('parseCommandFile throws on missing frontmatter', () => {
    assert.throws(
        () => parseCommandFile('no frontmatter here', 'review.md'),
        /missing YAML frontmatter/,
    );
});

test('parseCommandFile throws on missing name field', () => {
    const content = `---
description: no name
---
Template.`;
    assert.throws(
        () => parseCommandFile(content, 'review.md'),
        /missing required frontmatter field: name/,
    );
});

test('parseCommandFile throws on missing description field', () => {
    const content = `---
name: has-name
---
Template.`;
    assert.throws(
        () => parseCommandFile(content, 'review.md'),
        /missing required frontmatter field: description/,
    );
});

test('parseCommandFile throws on empty template body', () => {
    const content = `---
name: empty
description: empty body
---
`;
    assert.throws(
        () => parseCommandFile(content, 'review.md'),
        /empty template body/,
    );
});

// ---------------------------------------------------------------------------
// loadCommandFromFile tests
// ---------------------------------------------------------------------------

test('loadCommandFromFile loads a markdown file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-cmd-file-'));
    const file = join(dir, 'review.md');
    await writeFile(file, `---
name: review
description: Review a file
---
Review $1`);

    const result = await loadCommandFromFile(file);
    assert.ok(result !== undefined);
    assert.equal(result.command.name, 'review');
    assert.equal(result.command.description, 'Review a file');
    assert.equal(result.command.template, 'Review $1');
    assert.equal(result.source, file);

    await rm(dir, { recursive: true });
});

test('loadCommandFromFile returns undefined for unreadable file', async () => {
    const result = await loadCommandFromFile('/nonexistent/path/cmd.md');
    assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// loadCommandsFromDirectory tests
// ---------------------------------------------------------------------------

test('loadCommandsFromDirectory loads markdown files and skips others', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-cmds-'));
    await writeFile(join(dir, 'review.md'), `---
name: review
description: Review a file
---
Review $1`);
    await writeFile(join(dir, 'commit.md'), `---
name: commit
description: Commit message
---
Commit $1`);
    await writeFile(join(dir, 'notes.txt'), 'not a command');

    const loaded = await loadCommandsFromDirectory(dir);
    assert.equal(loaded.length, 2);
    const names = loaded.map((c) => c.command.name).sort();
    assert.deepEqual(names, ['commit', 'review']);

    await rm(dir, { recursive: true });
});

test('loadCommandsFromDirectory returns empty array for nonexistent directory', async () => {
    const loaded = await loadCommandsFromDirectory('/nonexistent/path/commands');
    assert.deepEqual(loaded, []);
});

// ---------------------------------------------------------------------------
// loadAllCommands / loadCommands tests
// ---------------------------------------------------------------------------

test('loadAllCommands project command overrides global command', async () => {
    const realHome = process.env.HOME;
    const tempHome = await mkdtemp(join(tmpdir(), 'za-cmd-home-'));
    process.env.HOME = tempHome;

    try {
        // Global command "review"
        const globalCommands = join(tempHome, '.zeroagent', 'commands');
        await mkdir(globalCommands, { recursive: true });
        await writeFile(join(globalCommands, 'review.md'), `---
name: review
description: Global review
---
Global template $1`);

        // Project command "review" (same name) + project-only "commit"
        const workdir = await mkdtemp(join(tmpdir(), 'za-cmd-work-'));
        const projectCommands = join(workdir, '.zeroagent', 'commands');
        await mkdir(projectCommands, { recursive: true });
        await writeFile(join(projectCommands, 'review.md'), `---
name: review
description: Project review
---
Project template $1`);
        await writeFile(join(projectCommands, 'commit.md'), `---
name: commit
description: Commit message
---
Commit $1`);

        const { registry, loaded } = await loadAllCommands(workdir);
        assert.ok(loaded.length >= 2);

        const review = registry.get('review');
        assert.equal(review?.description, 'Project review');
        assert.equal(review?.template, 'Project template $1');
        assert.equal(registry.has('commit'), true);

        await rm(workdir, { recursive: true });
    } finally {
        process.env.HOME = realHome;
        await rm(tempHome, { recursive: true });
    }
});

test('loadCommands replaces registry contents in place', async () => {
    const realHome = process.env.HOME;
    const tempHome = await mkdtemp(join(tmpdir(), 'za-cmd-home2-'));
    process.env.HOME = tempHome;

    try {
        const workdir = await mkdtemp(join(tmpdir(), 'za-cmd-work2-'));
        const projectCommands = join(workdir, '.zeroagent', 'commands');
        await mkdir(projectCommands, { recursive: true });
        await writeFile(join(projectCommands, 'fresh.md'), `---
name: fresh
description: A fresh command
---
Fresh $1`);

        const registry = new CommandRegistry();
        registry.register({ name: 'stale', description: 'Stale', template: 'Stale' });

        const loaded = await loadCommands(workdir, registry);
        assert.equal(loaded.length, 1);
        assert.equal(registry.has('stale'), false);
        assert.equal(registry.has('fresh'), true);

        await rm(workdir, { recursive: true });
    } finally {
        process.env.HOME = realHome;
        await rm(tempHome, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// Directory path helpers
// ---------------------------------------------------------------------------

test('userCommandsDir returns ~/.zeroagent/commands', () => {
    const dir = userCommandsDir();
    assert.equal(dir, join(homedir(), '.zeroagent', 'commands'));
});

test('projectCommandsDir returns {workdir}/.zeroagent/commands', () => {
    const dir = projectCommandsDir('/my/project');
    assert.equal(dir, join('/my/project', '.zeroagent', 'commands'));
});

// ---------------------------------------------------------------------------
// expandTemplate tests
// ---------------------------------------------------------------------------

test('expandTemplate substitutes positional arguments', () => {
    assert.equal(expandTemplate('Review $1', ['tools.ts']), 'Review tools.ts');
    assert.equal(expandTemplate('$1 -> $2', ['a', 'b']), 'a -> b');
});

test('expandTemplate missing argument becomes empty string', () => {
    assert.equal(expandTemplate('Review $2', ['tools.ts']), 'Review ');
});

test('expandTemplate handles multi-digit positional', () => {
    const args = Array.from({ length: 10 }, (_, i) => `arg${i + 1}`);
    assert.equal(expandTemplate('$10', args), 'arg10');
});

test('expandTemplate default value substitution', () => {
    assert.equal(expandTemplate('Focus on ${2:-style}', ['tools.ts', 'security']), 'Focus on security');
    assert.equal(expandTemplate('Focus on ${2:-style}', ['tools.ts']), 'Focus on style');
    assert.equal(expandTemplate('Focus on ${2:-style}', ['tools.ts', '']), 'Focus on style');
});

test('expandTemplate empty default is allowed', () => {
    assert.equal(expandTemplate('x${1:-}y', []), 'xy');
});

test('expandTemplate defaults resolve before plain placeholders', () => {
    assert.equal(expandTemplate('${1:-$2}', ['', 'fallback']), 'fallback');
});

test('expandTemplate leaves unsupported shell syntax untouched', () => {
    assert.equal(expandTemplate('use $@ and ${1-default}', []), 'use $@ and ${1-default}');
});

test('listAvailableCommands includes built-ins and registered commands', () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'review', description: 'Review changes', template: 'Review $1' });
    assert.equal(listAvailableCommands(registry), '/sessions, /resume, /clear, /reload, /review');
});

test('tryRunCommand expands and dispatches a registered command', async () => {
    const registry = new CommandRegistry();
    registry.register({ name: 'review', description: 'Review changes', template: 'Review $1' });
    let receivedPrompt = '';

    const handled = await tryRunCommand(registry, '/review chapter8/src/cli.ts', async (prompt) => {
        receivedPrompt = prompt;
    });

    assert.equal(handled, true);
    assert.equal(receivedPrompt, 'Review chapter8/src/cli.ts');
});

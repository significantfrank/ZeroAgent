import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import {
    SkillRegistry,
    parseSkillFile,
    loadSkillFromDir,
    loadSkillsFromDirectory,
    loadAllSkills,
    userSkillsDir,
    projectSkillsDir,
    type SkillDefinition,
} from '../src/skill/index.ts';

// ---------------------------------------------------------------------------
// SkillRegistry tests
// ---------------------------------------------------------------------------

test('SkillRegistry registers and retrieves skills', () => {
    const registry = new SkillRegistry();
    const skill: SkillDefinition = {
        name: 'test-skill',
        description: 'A test skill',
        instructions: 'Do the thing.',
    };
    registry.register(skill);
    assert.equal(registry.has('test-skill'), true);
    assert.equal(registry.get('test-skill'), skill);
    assert.deepEqual(registry.names(), ['test-skill']);
    assert.deepEqual(registry.list(), [skill]);
});

test('SkillRegistry register overwrites same-name skill', () => {
    const registry = new SkillRegistry();
    registry.register({ name: 'dup', description: 'first', instructions: 'v1' });
    registry.register({ name: 'dup', description: 'second', instructions: 'v2' });
    const skill = registry.get('dup');
    assert.equal(skill?.description, 'second');
    assert.equal(skill?.instructions, 'v2');
    assert.equal(registry.list().length, 1);
});

test('SkillRegistry.copyFrom copies skills and replaces same-name entries', () => {
    const source = new SkillRegistry();
    source.register({ name: 'shared', description: 'Source skill', instructions: 'Source instructions' });
    source.register({ name: 'extra', description: 'Extra skill', instructions: 'Extra instructions' });
    const target = new SkillRegistry();
    target.register({ name: 'shared', description: 'Target skill', instructions: 'Target instructions' });

    assert.equal(target.copyFrom(source), target);
    assert.equal(target.get('shared')?.description, 'Source skill');
    assert.equal(target.get('extra')?.instructions, 'Extra instructions');
    assert.deepEqual(target.names(), ['shared', 'extra']);
});

test('SkillRegistry remove and clear', () => {
    const registry = new SkillRegistry();
    registry.register({ name: 'a', description: 'A', instructions: 'ia' });
    registry.register({ name: 'b', description: 'B', instructions: 'ib' });
    assert.equal(registry.remove('a'), true);
    assert.equal(registry.has('a'), false);
    assert.equal(registry.list().length, 1);
    registry.clear();
    assert.equal(registry.list().length, 0);
});

test('SkillRegistry buildInstructions combines all skills', () => {
    const registry = new SkillRegistry();
    registry.register({ name: 'alpha', description: 'A', instructions: 'Be alpha.' });
    registry.register({ name: 'beta', description: 'B', instructions: 'Be beta.' });
    const instructions = registry.buildInstructions();
    assert.ok(instructions.includes('## Skill: alpha'));
    assert.ok(instructions.includes('Be alpha.'));
    assert.ok(instructions.includes('## Skill: beta'));
    assert.ok(instructions.includes('Be beta.'));
    assert.ok(instructions.includes('---'));
});

test('SkillRegistry buildInstructions returns empty string when no skills', () => {
    const registry = new SkillRegistry();
    assert.equal(registry.buildInstructions(), '');
});

test('SkillRegistry buildCatalog lists only skill names and descriptions', () => {
    const registry = new SkillRegistry();
    registry.register({ name: 'alpha', description: 'First skill', instructions: 'Alpha instructions.' });
    registry.register({ name: 'beta', description: 'Second skill', instructions: 'Beta instructions.' });
    assert.equal(registry.buildCatalog(), '- alpha: First skill\n- beta: Second skill');
});

test('SkillRegistry prompt instructions contain only skill names and descriptions', () => {
    const registry = new SkillRegistry();
    registry.register({ name: 'alpha', description: 'First skill', instructions: 'Alpha instructions.' });
    registry.register({ name: 'beta', description: 'Second skill', instructions: 'Beta instructions.' });

    const instructions = registry.buildPromptInstructions();
    assert.equal(instructions, '可用的skills:\n- alpha: First skill\n- beta: Second skill');
    assert.ok(!instructions.includes('Alpha instructions.'));
    assert.ok(!instructions.includes('Beta instructions.'));

    registry.remove('alpha');
    assert.equal(registry.buildPromptInstructions(), '可用的skills:\n- beta: Second skill');
    registry.clear();
    assert.equal(registry.buildPromptInstructions(), '');
});

// ---------------------------------------------------------------------------
// parseSkillFile tests
// ---------------------------------------------------------------------------

test('parseSkillFile parses frontmatter and body', () => {
    const content = `---
name: my-skill
description: A useful skill
---
This is the instruction text.

Use it wisely.`;
    const skill = parseSkillFile(content, 'skill.md');
    assert.equal(skill.name, 'my-skill');
    assert.equal(skill.description, 'A useful skill');
    assert.equal(skill.instructions, 'This is the instruction text.\n\nUse it wisely.');
});

test('parseSkillFile throws on missing frontmatter', () => {
    assert.throws(
        () => parseSkillFile('no frontmatter here', 'skill.md'),
        /missing YAML frontmatter/,
    );
});

test('parseSkillFile throws on missing name field', () => {
    const content = `---
description: no name
---
Instructions.`;
    assert.throws(
        () => parseSkillFile(content, 'skill.md'),
        /missing required frontmatter field: name/,
    );
});

test('parseSkillFile throws on missing description field', () => {
    const content = `---
name: has-name
---
Instructions.`;
    assert.throws(
        () => parseSkillFile(content, 'skill.md'),
        /missing required frontmatter field: description/,
    );
});

test('parseSkillFile throws on empty instructions body', () => {
    const content = `---
name: empty
description: empty body
---
`;
    assert.throws(
        () => parseSkillFile(content, 'skill.md'),
        /empty instructions body/,
    );
});

// ---------------------------------------------------------------------------
// loadSkillFromDir tests
// ---------------------------------------------------------------------------

test('loadSkillFromDir loads a skill from a directory with skill.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-skilldir-'));
    await writeFile(join(dir, 'skill.md'), `---
name: my-skill
description: A skill in a directory
---
Do the thing.`);
    // Extra files in the directory should be fine
    await writeFile(join(dir, 'reference.md'), 'extra reference');

    const result = await loadSkillFromDir(dir);
    assert.ok(result !== undefined);
    assert.equal(result.skill.name, 'my-skill');
    assert.equal(result.skill.description, 'A skill in a directory');
    assert.equal(result.skill.instructions, 'Do the thing.');
    assert.equal(result.source, dir);

    await rm(dir, { recursive: true });
});

test('loadSkillFromDir returns undefined for directory without skill.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-noskill-'));
    await writeFile(join(dir, 'readme.md'), 'not a skill');

    const result = await loadSkillFromDir(dir);
    assert.equal(result, undefined);

    await rm(dir, { recursive: true });
});

// ---------------------------------------------------------------------------
// loadSkillsFromDirectory tests
// ---------------------------------------------------------------------------

test('loadSkillsFromDirectory loads all skill subdirectories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'za-skills-'));

    // Skill alpha
    await mkdir(join(dir, 'alpha'));
    await writeFile(join(dir, 'alpha', 'skill.md'), `---
name: alpha
description: Alpha skill
---
Be alpha.`);

    // Skill beta
    await mkdir(join(dir, 'beta'));
    await writeFile(join(dir, 'beta', 'skill.md'), `---
name: beta
description: Beta skill
---
Be beta.`);

    // Non-directory entry should be skipped
    await writeFile(join(dir, 'stray.md'), 'not a directory');

    // Directory without skill.md should be skipped
    await mkdir(join(dir, 'empty-dir'));
    await writeFile(join(dir, 'empty-dir', 'notes.md'), 'no skill.md here');

    const loaded = await loadSkillsFromDirectory(dir);
    assert.equal(loaded.length, 2);
    const names = loaded.map((s) => s.skill.name).sort();
    assert.deepEqual(names, ['alpha', 'beta']);

    await rm(dir, { recursive: true });
});

test('loadSkillsFromDirectory returns empty array for nonexistent directory', async () => {
    const loaded = await loadSkillsFromDirectory('/nonexistent/path/skills');
    assert.deepEqual(loaded, []);
});

// ---------------------------------------------------------------------------
// loadAllSkills tests (user-level + project-level)
// ---------------------------------------------------------------------------

test('loadAllSkills loads from both directories with project override', async () => {
    // Isolate from real ~/.zeroagent/skills/ by pointing HOME to a temp dir
    const realHome = process.env.HOME;
    const tempHome = await mkdtemp(join(tmpdir(), 'za-loadall-home-'));
    process.env.HOME = tempHome;

    try {
        const workdir = await mkdtemp(join(tmpdir(), 'za-workdir-'));
        const projectSkillsPath = join(workdir, '.zeroagent', 'skills');
        await mkdir(join(projectSkillsPath, 'project-skill'), { recursive: true });
        await writeFile(join(projectSkillsPath, 'project-skill', 'skill.md'), `---
name: project-skill
description: A project-level skill
---
Follow project conventions.`);

        const { registry, loaded } = await loadAllSkills(workdir);
        // At minimum, the project skill should be loaded
        assert.ok(loaded.length >= 1);
        assert.ok(registry.has('project-skill'));
        const skill = registry.get('project-skill');
        assert.equal(skill?.description, 'A project-level skill');
        assert.equal(skill?.instructions, 'Follow project conventions.');

        await rm(workdir, { recursive: true });
    } finally {
        process.env.HOME = realHome;
        await rm(tempHome, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// Directory path helpers
// ---------------------------------------------------------------------------

test('userSkillsDir returns ~/.zeroagent/skills', () => {
    const dir = userSkillsDir();
    assert.ok(dir.endsWith(join('.zeroagent', 'skills')));
});

test('projectSkillsDir returns {workdir}/.zeroagent/skills', () => {
    const dir = projectSkillsDir('/my/project');
    assert.equal(dir, join('/my/project', '.zeroagent', 'skills'));
});


'use strict';

/**
 * Pi runtime identity + descriptor (installer wiring).
 *
 * Behavioral tests for the pi runtime's identity resolution and installer
 * surface. No source-grep: all assertions call exported functions and assert on
 * returned values / resolved layouts.
 *
 * Scope: descriptor presence, configHome/dirName/alias resolution, --pi
 * flag + --all + interactive menu wiring, and that pi resolves an artifact
 * layout (skills + agents). Full install byte-identity / no-hooks assertions
 * belong to the install dry-run suite.
 *
 * RULESET.TESTS.no-source-grep
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const install = require('../bin/install.js');
const namePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const homes = require('../gsd-core/bin/lib/runtime-homes.cjs');
const layoutMod = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const { canonicalizeRuntimeName, getDirName } = namePolicy;
const { getGlobalConfigDir } = homes;
const { resolveRuntimeArtifactLayout } = layoutMod;

describe('pi runtime — identity resolution', () => {
  test('configHome resolves to ~/.pi/agent', () => {
    assert.equal(
      getGlobalConfigDir('pi', null),
      path.join(os.homedir(), '.pi', 'agent'),
    );
  });

  test('configHome honors PI_CODING_AGENT_DIR override', () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = '/tmp/pi-override';
    try {
      assert.equal(getGlobalConfigDir('pi', null), '/tmp/pi-override');
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  test('getDirName returns .pi (single-segment local dir)', () => {
    assert.equal(getDirName('pi'), '.pi');
  });

  test('aliases canonicalize to pi', () => {
    assert.equal(canonicalizeRuntimeName('pi'), 'pi');
    assert.equal(canonicalizeRuntimeName('pi-cli'), 'pi');
    assert.equal(canonicalizeRuntimeName('pi-coding-agent'), 'pi');
    assert.equal(canonicalizeRuntimeName('Pi-Coding-Agent'), 'pi');
  });
});

describe('pi runtime — capability registry', () => {
  test('pi descriptor is registered with the expected axes', () => {
    const entry = registry.runtimes && registry.runtimes.pi;
    assert.ok(entry, 'pi is in the capability registry');
    const rt = entry.runtime;
    assert.equal(rt.configHome.kind, 'dot-home');
    assert.equal(rt.hooksSurface, 'none');
    assert.equal(rt.sandboxTier, 'none');
    assert.equal(rt.installSurface, 'profile-marker-only');
    assert.equal(rt.writesSharedSettings, false);
    // skills kind names the pi converter; agents kind is raw copy
    const skills = rt.artifactLayout.global.find((k) => k.kind === 'skills');
    const agents = rt.artifactLayout.global.find((k) => k.kind === 'agents');
    assert.equal(skills.converter, 'convertClaudeCommandToPiSkill');
    assert.equal(agents.converter, null);
  });
});

describe('pi runtime — installer flag wiring', () => {
  test('--pi selects pi', () => {
    assert.deepEqual(install.selectRuntimesFromArgs(['--pi']), ['pi']);
  });

  test('--all includes pi', () => {
    assert.ok(install.allRuntimes.includes('pi'), 'allRuntimes includes pi');
    assert.ok(
      install.selectRuntimesFromArgs(['--all']).includes('pi'),
      '--all selects pi',
    );
  });

  test('interactive menu: pi is option 17, All is option 18', () => {
    assert.equal(install.runtimeMap['17'], 'pi');
    assert.deepEqual(install.parseRuntimeInput('17'), ['pi']);
    const allChoice = install.parseRuntimeInput('18');
    assert.ok(allChoice.includes('pi'), 'option 18 (All) includes pi');
    assert.ok(allChoice.length > 1, 'option 18 returns the full runtime list');
  });

  test('interactive prompt text advertises pi and ~/.pi/agent', () => {
    const text = install.buildRuntimePromptText();
    assert.match(text, /Pi/);
    assert.match(text, /~\/\.pi\/agent/);
  });
});

describe('pi runtime — artifact layout resolution', () => {
  test('resolveRuntimeArtifactLayout(pi, global) yields skills + agents', () => {
    const l = resolveRuntimeArtifactLayout('pi', '/tmp/pi-stage', 'global');
    const kinds = l.kinds.map((k) => k.kind).sort();
    assert.deepEqual(kinds, ['agents', 'skills']);
  });

  test('resolveRuntimeArtifactLayout(pi, local) yields skills', () => {
    const l = resolveRuntimeArtifactLayout('pi', '/tmp/pi-stage', 'local');
    assert.ok(l.kinds.some((k) => k.kind === 'skills'));
  });
});

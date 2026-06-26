'use strict';

/**
 * Pi runtime — real install dry-run (fake HOME subprocess).
 *
 * Proves `--pi --global` produces the on-disk layout the pi descriptor
 * promises: skills/ land at the pi config home converted to pi-native form,
 * agents/ land path-rewritten to the pi install root, the runtime-agnostic
 * gsd-core/ tree lands, and NO native hooks surface is written (pi has no hook
 * bus — installSurface is profile-marker-only). Invokes bin/install.js as a
 * real subprocess against an isolated HOME so the installer's main() runs end
 * to end (require()-ing it is a no-op under the GSD_TEST_MODE guard).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { cleanup } = require('./helpers.cjs');

const MANIFEST_NAME = 'gsd-file-manifest.json';

function installPiGlobal(root) {
  // HOME points at an isolated dir; no --config-dir, so targetDir resolves to
  // the real pi config home: <HOME>/.pi/agent (getGlobalConfigDir('pi')).
  const res = spawnSync(process.execPath, [INSTALL_SCRIPT, '--pi', '--global'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: installerEnv({ HOME: root, USERPROFILE: root }),
  });
  assert.strictEqual(res.status, 0,
    `installer exited ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  return res;
}

describe('pi runtime install dry-run — on-disk layout', () => {
  test('lands skills/ (converted), agents/ + gsd-core/, with no hooks surface', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-dryrun-'));
    try {
      installPiGlobal(root);
      const configDir = path.join(root, '.pi', 'agent');

      // Config home resolved to ~/.pi/agent (the real descriptor path).
      assert.ok(fs.existsSync(configDir), 'pi config home ~/.pi/agent is created');

      // skills/ — converted to pi-native form (space-delimited lowercase
      // allowed-tools), one gsd-<name>/SKILL.md dir per command.
      const skillsDir = path.join(configDir, 'skills');
      assert.ok(fs.existsSync(skillsDir), 'skills/ is written');
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.ok(skillDirs.length > 0, 'at least one gsd-* skill dir is written');
      const sampleSkill = path.join(skillsDir, skillDirs[0].name, 'SKILL.md');
      assert.ok(fs.existsSync(sampleSkill), 'each skill dir has a SKILL.md');
      const skillText = fs.readFileSync(sampleSkill, 'utf8');
      const atLine = skillText.split('\n').find((l) => /^allowed-tools:/.test(l));
      assert.ok(atLine, 'an allowed-tools line is present');
      assert.ok(!/^allowed-tools:\s*\n\s*-/.test(skillText) && !/^- (Read|Write|Edit|Bash|Glob|Grep)$/m.test(skillText),
        'allowed-tools is NOT a YAML array');
      // The six mappable tools are lowercased to their pi spellings.
      assert.match(atLine, /\bread\b/);
      assert.match(atLine, /\bbash\b/);
      assert.match(atLine, /\bfind\b/, 'Glob maps to find');
      assert.doesNotMatch(atLine, /\b(Read|Write|Edit|Bash|Glob|Grep)\b/,
        'no mappable Claude tool name survives unconverted');
      // Unmapped names pass through verbatim (the allowlist is permissive).
      assert.match(atLine, /\bAgent\b/, 'Agent preserved verbatim');
      assert.match(atLine, /\bAskUserQuestion\b/, 'AskUserQuestion preserved verbatim');

      // agents/ — present, path-rewritten to the pi install root (not ~/.claude).
      const agentsDir = path.join(configDir, 'agents');
      assert.ok(fs.existsSync(agentsDir), 'agents/ is written');
      const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));
      assert.ok(agentFiles.length > 0, 'at least one gsd-* agent is written');
      const plannerText = fs.readFileSync(path.join(agentsDir, 'gsd-planner.md'), 'utf8');
      assert.ok(plannerText.includes('$HOME/.pi/agent/gsd-core/'),
        'agent @-references are rewritten to the pi install root');
      assert.ok(!plannerText.includes('~/.claude/gsd-core/'),
        'agent @-references do not leak the Claude config dir');

      // gsd-core/ — runtime-agnostic workflow assets land under the config home.
      assert.ok(fs.existsSync(path.join(configDir, 'gsd-core')),
        'gsd-core/ workflow assets are written');

      // No native hooks surface (pi has no hook bus).
      assert.ok(!fs.existsSync(path.join(configDir, 'hooks')),
        'no hooks/ directory is written');
      assert.ok(!fs.existsSync(path.join(configDir, 'settings.json')),
        'no settings.json is written (profile-marker-only)');

      // pi uses skills, not the Claude-Code-local flat commands/ layout.
      assert.ok(!fs.existsSync(path.join(configDir, 'commands')),
        'no commands/ directory is written (pi is skills-based)');

      // Manifest recorded the install.
      assert.ok(fs.existsSync(path.join(configDir, MANIFEST_NAME)),
        'file manifest is written');
    } finally {
      cleanup(root);
    }
  });

  test('banner labels the runtime "Pi" (not "Claude Code")', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-banner-'));
    try {
      const res = spawnSync(process.execPath, [INSTALL_SCRIPT, '--pi', '--global'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: installerEnv({ HOME: root, USERPROFILE: root }),
      });
      assert.strictEqual(res.status, 0,
        `installer exited ${res.status}\nstderr: ${res.stderr}`);
      assert.match(res.stdout, /Installing for .*Pi.* to/,
        'install banner labels the runtime Pi');
      assert.doesNotMatch(res.stdout, /Installing for .*Claude Code/,
        'install banner does not mislabel pi as Claude Code');
    } finally {
      cleanup(root);
    }
  });
});
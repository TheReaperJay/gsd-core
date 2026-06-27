'use strict';

/**
 * Pi runtime — real install dry-run (fake HOME subprocess).
 *
 * Proves `--pi --global` produces the on-disk layout the pi descriptor
 * promises: skills/ land at the pi config home converted to pi-native form
 * (name hyphenated; body path-rewritten by the new `case 'pi'` in
 * _applyRuntimeRewrites), the runtime-agnostic gsd-core/ tree lands, and
 * NO native hooks surface is written (pi has no hook bus — installSurface
 * is profile-marker-only). NO agents/ directory is written — pi does not
 * scan ~/.pi/agent/agents/ from disk (verified against pi's
 * dist/core/resource-loader.js:485 which scans agentDir/{skills,prompts,
 * themes,extensions} only). Invokes bin/install.js as a real subprocess
 * against an isolated HOME so the installer's main() runs end to end
 * (require()-ing it is a no-op under the GSD_TEST_MODE guard).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { INSTALL_SCRIPT, installerEnv } = require('./helpers/install-shared.cjs');
const { extractFrontmatterAndBody } = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
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

      // skills/ — converted to pi-native form, one gsd-<name>/SKILL.md dir
      // per command. After C3, body bytes containing ~/.claude/gsd-core/...
      // are rewritten to ~/.pi/agent/gsd-core/... via the new `case 'pi':`
      // in _applyRuntimeRewrites.
      const skillsDir = path.join(configDir, 'skills');
      assert.ok(fs.existsSync(skillsDir), 'skills/ is written');
      const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.ok(skillDirs.length > 0, 'at least one gsd-* skill dir is written');
      const sampleSkill = path.join(skillsDir, skillDirs[0].name, 'SKILL.md');
      assert.ok(fs.existsSync(sampleSkill), 'each skill dir has a SKILL.md');
      const skillText = fs.readFileSync(sampleSkill, 'utf8');
      // pi's skill loader requires name to match [a-z0-9-]+; the colon namespace
      // form (gsd:add-tests) must be hyphenated to load cleanly as /skill:gsd-*.
      assert.match(skillText, /^name: gsd-[a-z0-9-]+$/m, 'skill name is hyphen-form, not colon-form');
      assert.doesNotMatch(skillText, /^name: gsd:/m, 'no colon-form skill name remains');
      // Skill body path-rewrite (the C3 fix): ~/.claude/ → ~/.pi/agent/ in
      // skill body text. Walk every skill to assert no Claude config paths leak.
      const bodiesWithTildeClaude = [];
      for (const sd of skillDirs) {
        const sk = fs.readFileSync(path.join(skillsDir, sd.name, 'SKILL.md'), 'utf8');
        const body = extractFrontmatterAndBody(sk).body;
        if (body.includes('~/.claude/') || body.includes('$HOME/.claude/')) {
          bodiesWithTildeClaude.push(sd.name);
        }
      }
      assert.strictEqual(
        bodiesWithTildeClaude.length,
        0,
        `every skill body's ~/.claude/ paths must be rewritten to pi install root (failures: ${bodiesWithTildeClaude.join(', ')})`,
      );

      // No agents/ — pi does not scan ~/.pi/agent/agents/ from disk, so the
      // descriptor has no agents kind and the install must not create the dir.
      assert.ok(!fs.existsSync(path.join(configDir, 'agents')),
        'no agents/ directory is written (pi does not load agents/ from disk)');

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

  test('lands bridge file at ~/.pi/agent/extensions/ (global) and <cwd>/.pi/extensions/ (local), recorded in manifest, removed on uninstall', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-bridge-'));
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-bridge-local-'));
    try {
      // ----- global install: bridge lands at <root>/.pi/agent/extensions/ -----
      installPiGlobal(root);
      const configDir = path.join(root, '.pi', 'agent');
      const bridgeDest = path.join(configDir, 'extensions', 'gsd-pi-bridge.ts');
      assert.ok(fs.existsSync(bridgeDest),
        'bridge file installed at <globalConfigDir>/extensions/gsd-pi-bridge.ts');

      // File byte-identity: shipped source === installed copy. Catches any
      // future bug where the layout staging copies the wrong dir or transforms
      // content during transit.
      const sourcePath = path.join(__dirname, '..', 'extensions', 'pi', 'gsd-pi-bridge.ts');
      const sourceBytes = fs.readFileSync(sourcePath);
      const destBytes = fs.readFileSync(bridgeDest);
      assert.ok(sourceBytes.equals(destBytes),
        'installed bridge is byte-identical to the shipped source');

      // Manifest recorded the bridge file with a hash entry.
      const manifestPath = path.join(configDir, MANIFEST_NAME);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(
        Object.prototype.hasOwnProperty.call(manifest.files, 'extensions/gsd-pi-bridge.ts'),
        `manifest must record extensions/gsd-pi-bridge.ts; got keys: ${Object.keys(manifest.files).filter(k => k.includes('extension')).join(', ') || '(none)'}`,
      );
      const manifestHash = manifest.files['extensions/gsd-pi-bridge.ts'];
      assert.ok(typeof manifestHash === 'string' && manifestHash.length > 0,
        'manifest hash is a non-empty string');

      // ----- local install: bridge lands at <localRoot>/.pi/extensions/ -----
      // The installer uses process.cwd() for the local target base; the test
      // spawns the installer with cwd=localRoot so install writes
      // <localRoot>/.pi/extensions/gsd-pi-bridge.ts.
      const localRes = spawnSync(process.execPath, [INSTALL_SCRIPT, '--pi', '--local'], {
        cwd: localRoot,
        encoding: 'utf8',
        env: installerEnv({ HOME: root, USERPROFILE: root }),
      });
      assert.strictEqual(localRes.status, 0,
        `local installer exited ${localRes.status}\nstdout: ${localRes.stdout}\nstderr: ${localRes.stderr}`);
      const localBridge = path.join(localRoot, '.pi', 'extensions', 'gsd-pi-bridge.ts');
      assert.ok(fs.existsSync(localBridge),
        'bridge file installed at <localCwd>/.pi/extensions/gsd-pi-bridge.ts');
      // The local configDir is the project .pi/, NOT .pi/agent/.
      assert.ok(!fs.existsSync(path.join(localRoot, '.pi', 'agent')),
        'local install does NOT create .pi/agent/ (that path is global-only)');

      // ----- uninstall: bridge is removed from the global config home -----
      const uninstallRes = spawnSync(process.execPath, [
        INSTALL_SCRIPT, '--pi', '--uninstall', '--global', '--config-dir', configDir,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: installerEnv({ HOME: root, USERPROFILE: root }),
      });
      assert.strictEqual(uninstallRes.status, 0,
        `uninstaller exited ${uninstallRes.status}\nstdout: ${uninstallRes.stdout}\nstderr: ${uninstallRes.stderr}`);
      assert.ok(!fs.existsSync(bridgeDest),
        'bridge file removed from global config home by uninstall');
    } finally {
      cleanup(root);
      cleanup(localRoot);
    }
  });
});
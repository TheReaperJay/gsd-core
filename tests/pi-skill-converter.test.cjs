'use strict';

/**
 * Pi skill converter tests.
 *
 * pi (@earendil-works/pi-coding-agent) loads Claude skill files natively, but
 * its `allowed-tools` is a permissive, space-delimited lowercase allowlist.
 * `convertClaudeCommandToPiSkill` rewrites the Claude YAML array form to that
 * line, mapping the six Claude tools that have a pi spelling
 * (Read→read, Write→write, Edit→edit, Bash→bash, Grep→grep, Glob→find) and
 * passing every other name (mcp__context7__*, Agent, AskUserQuestion, WebFetch,
 * WebSearch, …) through verbatim — a non-installed allowlist entry is inert, so
 * unknown names are preserved rather than dropped. The skill body is untouched.
 *
 * The converter is exported from runtime-artifact-conversion.cjs (it is NOT
 * duplicated into bin/install.js like the opencode/kilo converters), so tests
 * require it from the lib module directly.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  convertClaudeCommandToPiSkill,
  extractFrontmatterAndBody,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

// Sample Claude command frontmatter mirroring real GSD sources
// (commands/gsd/ai-integration-phase.md): a YAML array of Capitalized tool
// names including the six mappable ones plus unmapped MCP and unknown tools.
function sampleCommand() {
  return [
    '---',
    'name: gsd:ai-integration-phase',
    'description: Generate an AI-SPEC.md design contract for phases that involve building AI systems.',
    'argument-hint: "[phase number]"',
    'allowed-tools:',
    '  - Read',
    '  - Write',
    '  - Bash',
    '  - Glob',
    '  - Grep',
    '  - Agent',
    '  - WebFetch',
    '  - WebSearch',
    '  - AskUserQuestion',
    '  - mcp__context7__*',
    'requires: [phase]',
    '---',
    '',
    '<objective>',
    'Create an AI design contract (AI-SPEC.md) for a phase involving AI system development.',
    'Orchestrates gsd-framework-selector → gsd-ai-researcher.',
    '</objective>',
    '',
    'Invoke /gsd:ai-integration-phase from slash form.',
    'Invoke /gsd-ai-integration-phase from hyphen slash form.',
  ].join('\n');
}

describe('convertClaudeCommandToPiSkill — allowed-tools rewrite', () => {
  test('rewrites the YAML array into a single space-delimited lowercase line', () => {
    const result = convertClaudeCommandToPiSkill(sampleCommand(), 'gsd-ai-integration-phase');

    // The YAML array is gone; exactly one space-delimited allowed-tools line.
    const lines = result.split('\n');
    const atLines = lines.filter((l) => /^allowed-tools:/.test(l));
    assert.equal(atLines.length, 1, 'exactly one allowed-tools line is emitted');
    assert.equal(atLines[0], 'allowed-tools: read write bash find grep Agent WebFetch WebSearch AskUserQuestion mcp__context7__*');
    assert.ok(!result.includes('\n  - Read'), 'no YAML list items remain');
    assert.ok(!/\n\s*-\s+\w/.test(result), 'no YAML array syntax remains anywhere');
  });

  test('maps the six Claude tools to their pi spellings (Glob→find, not glob)', () => {
    const cmd = [
      '---',
      'name: gsd:x',
      'allowed-tools:',
      '  - Read',
      '  - Write',
      '  - Edit',
      '  - Bash',
      '  - Grep',
      '  - Glob',
      '---',
      'body',
    ].join('\n');
    const result = convertClaudeCommandToPiSkill(cmd, 'gsd-x');
    assert.equal(
      result.split('\n').find((l) => /^allowed-tools:/.test(l)),
      'allowed-tools: read write edit bash grep find',
    );
  });

  test('preserves mcp__context7__* and unmapped tool names verbatim (allowlist is permissive)', () => {
    const result = convertClaudeCommandToPiSkill(sampleCommand(), 'gsd-ai-integration-phase');
    const line = result.split('\n').find((l) => /^allowed-tools:/.test(l));
    // Unmapped names are passed through unchanged — never dropped, never lowercased.
    assert.ok(line.includes('mcp__context7__*'), 'mcp__context7__* preserved verbatim');
    assert.ok(line.includes('Agent'), 'Agent preserved verbatim (not lowercased)');
    assert.ok(line.includes('AskUserQuestion'), 'AskUserQuestion preserved verbatim');
    assert.ok(line.includes('WebFetch'), 'WebFetch preserved verbatim');
    assert.ok(line.includes('WebSearch'), 'WebSearch preserved verbatim');
    // And they keep their source ordering.
    assert.ok(
      line.indexOf('Agent') < line.indexOf('WebFetch') &&
        line.indexOf('WebFetch') < line.indexOf('mcp__context7__*'),
      'tool ordering is preserved',
    );
  });
});

describe('convertClaudeCommandToPiSkill — body & frontmatter preservation', () => {
  test('leaves the skill body byte-identical to the source', () => {
    const src = sampleCommand();
    const result = convertClaudeCommandToPiSkill(src, 'gsd-ai-integration-phase');
    // The converter passes `body` through from extractFrontmatterAndBody
    // untouched, so the extracted body must round-trip identically.
    assert.equal(
      extractFrontmatterAndBody(result).body,
      extractFrontmatterAndBody(src).body,
      'extracted body is byte-identical to source',
    );
  });

  test('preserves non-allowed-tools frontmatter fields untouched', () => {
    const result = convertClaudeCommandToPiSkill(sampleCommand(), 'gsd-ai-integration-phase');
    assert.ok(result.includes('name: gsd:ai-integration-phase'), 'name preserved');
    assert.ok(
      result.includes('description: Generate an AI-SPEC.md design contract for phases that involve building AI systems.'),
      'description preserved',
    );
    assert.ok(result.includes('argument-hint: "[phase number]"'), 'argument-hint preserved');
    assert.ok(result.includes('requires: [phase]'), 'requires preserved');
  });

  test('returns input verbatim when there is no frontmatter', () => {
    const noFrontmatter = 'Just a body, no frontmatter at all.\nLine two.';
    const result = convertClaudeCommandToPiSkill(noFrontmatter, 'gsd-x');
    assert.equal(result, noFrontmatter, 'no-frontmatter input is returned unchanged');
  });

  test('handles a single allowed-tools line with no body changes (minimal frontmatter)', () => {
    const cmd = ['---', 'name: gsd:y', 'allowed-tools:', '  - Read', '  - Bash', '---', 'body'].join('\n');
    const result = convertClaudeCommandToPiSkill(cmd, 'gsd-y');
    assert.ok(result.startsWith('---\n'), 'frontmatter opens with ---');
    assert.equal(extractFrontmatterAndBody(result).body, extractFrontmatterAndBody(cmd).body, 'body round-trips identically');
    assert.ok(result.includes('allowed-tools: read bash'), 'array collapsed to space-delimited line');
  });
});

describe('convertClaudeCommandToPiSkill — signature compatibility', () => {
  test('accepts the full skillsKind call-site positional args without breaking', () => {
    // Signature: (content, skillName, runtime, cmdNames, isGlobal) — only
    // content is used; the rest are accepted and ignored so the converter slots
    // into the generic skillsKind dispatch.
    const result = convertClaudeCommandToPiSkill(
      sampleCommand(),
      'gsd-ai-integration-phase',
      'pi',
      ['ai-integration-phase'],
      true,
    );
    assert.ok(result.includes('allowed-tools: read write bash find grep Agent'));
  });
});
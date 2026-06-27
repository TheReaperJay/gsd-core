'use strict';

/**
 * Pi skill converter tests.
 *
 * pi's skill loader (dist/core/skills.js loadSkillFromFile, lines 183-226)
 * consumes only `name`, `description`, and `disable-model-invocation` from
 * frontmatter. Every other frontmatter field is dropped. `convertClaudeCommand
 * ToPiSkill` therefore performs exactly one Claude→pi transform: it
 * hyphenates the `name:` value (Claude's colon namespace `gsd:add-tests` fails
 * pi's validateName `[a-z0-9-]+` at skills.js:79 and produces a broken
 * /skill:gsd:add-tests invocation; the hyphen form `gsd-add-tests` loads cleanly
 * as /skill:gsd-add-tests). The skill body is passed through verbatim.
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
    'Reference: @~/.claude/gsd-core/references/ai-design.md',
    'Reference: $HOME/.claude/gsd-core/references/ai-design.md',
    '',
    'Invoke /gsd:ai-integration-phase from slash form.',
    'Invoke /gsd-ai-integration-phase from hyphen slash form.',
  ].join('\n');
}

describe('convertClaudeCommandToPiSkill — pass-through behavior', () => {
  test('passes unknown frontmatter fields through verbatim (pi consumes only name/description/disable-model-invocation)', () => {
    const result = convertClaudeCommandToPiSkill(sampleCommand(), 'gsd-ai-integration-phase');
    // allowed-tools is dropped-by-pi territory — the converter emits it verbatim
    // so the file is byte-faithful to the source and any future pi tooling that
    // chooses to consume it has the original Claude form to work with.
    assert.ok(result.includes('allowed-tools:'), 'allowed-tools line preserved');
    assert.ok(/^\s*-\s+(Read|Write|Bash|Glob|Grep)/m.test(result), 'YAML array items preserved verbatim');
    assert.ok(result.includes('argument-hint: "[phase number]"'), 'argument-hint preserved');
    assert.ok(result.includes('requires: [phase]'), 'requires preserved');
    assert.ok(result.includes('mcp__context7__*'), 'mcp tools preserved');
  });

  test('does NOT transform allowed-tools (no case-insensitive rewriting, no lowercase collapse)', () => {
    const result = convertClaudeCommandToPiSkill(sampleCommand(), 'gsd-ai-integration-phase');
    // Specifically assert the converter does not perform the dead work of
    // rewriting allowed-tools — this guards against future regressions if
    // someone tries to "re-add the feature".
    assert.ok(result.includes('  - Read'), 'Read preserved as-is (no lowercase collapse)');
    assert.ok(result.includes('  - Glob'), 'Glob preserved as-is (no map to find)');
    assert.ok(!result.includes('allowed-tools: read write'), 'no collapsed lowercase line');
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

  test('hyphenates the name field (pi skills require [a-z0-9-]+, not colon)', () => {
    const result = convertClaudeCommandToPiSkill(sampleCommand(), 'gsd-ai-integration-phase');
    // Claude's colon namespace (gsd:ai-integration-phase) fails pi's skill-name
    // validation and produces a broken /skill:gsd:ai-integration-phase invocation;
    // the converter rewrites the name value to hyphen form.
    assert.ok(result.includes('name: gsd-ai-integration-phase'), 'name is hyphenated');
    assert.ok(!result.includes('name: gsd:ai-integration-phase'), 'colon name form is gone');
    // Body references to the colon form are intentionally preserved verbatim —
    // they are instructional text for the model, not a parsed invocation; the
    // converter only rewrites the `name:` frontmatter value.
  });

  test('preserves non-name frontmatter fields untouched', () => {
    const result = convertClaudeCommandToPiSkill(sampleCommand(), 'gsd-ai-integration-phase');
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

  test('handles a minimal frontmatter with no allowed-tools block', () => {
    const cmd = ['---', 'name: gsd:z', '---', 'body'].join('\n');
    const result = convertClaudeCommandToPiSkill(cmd, 'gsd-z');
    assert.ok(result.includes('name: gsd-z'), 'name hyphenated');
    assert.ok(!result.includes('allowed-tools:'), 'no allowed-tools added');
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
    // After C1, allowed-tools is preserved verbatim (not collapsed).
    assert.ok(result.includes('  - Read'), 'allowed-tools array preserved under 5-arg call');
    assert.ok(result.includes('name: gsd-ai-integration-phase'), 'name hyphenated under 5-arg call');
  });
});
/**
 * gsd-pi-bridge.ts — native TS guard extension for pi (@earendil-works/pi-coding-agent).
 *
 * This file is a static artifact shipped in the gsd-core npm package and copied
 * to pi's config dir at install time. It is consumed in-place by pi's jiti
 * loader (dist/core/extensions/loader.js) and runs inside pi's process. It is
 * NOT compiled by gsd-core's `tsc` build (tsconfig.build.json only includes
 * src/*.cts) and is NOT imported by gsd-core's compiled runtime.
 *
 * Pattern matches skills/commands/agents/hooks: source file in the package,
 * copied by install, never imported by gsd-core. See pi's docs/extensions.md
 * for extension discovery rules.
 *
 * Guards ported from hooks/gsd-*.{js,sh}:
 *   - gsd-worktree-path-guard   (tool_call for write/edit)
 *   - gsd-validate-commit       (tool_call for bash, when hooks.community===true)
 *   - gsd-read-injection-scanner (tool_result for read; lite for grep/find/ls/bash)
 *   - gsd-context-monitor       (tool_result for all, debounced)
 *   - gsd-session-state         (session_start, when hooks.community===true)
 *
 * NOT ported (deliberate):
 *   - gsd-prompt-guard          — pi has no equivalent of Claude's prompt
 *                                 pre-scanning hook surface.
 *   - gsd-read-guard            — same reason.
 *   - gsd-graphify-update, gsd-cursor-*, gsd-check-update, gsd-update-banner,
 *     gsd-config-reload, gsd-ensure-canonical-path — Claude/Cursor-specific.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// ============================================================================
// pi tool name vocabulary
// ============================================================================
//
// The bridge dispatches handlers based on event.toolName. The set of tool names
// below is verified against @earendil-works/pi-coding-agent@0.78.0
// (dist/core/tools/index.d.ts:36 `ToolName = "read" | "bash" | "edit" |
// "write" | "grep" | "find" | "ls"`). The bridge is consumed by pi's jiti
// loader at pi-runtime, where the package IS installed; this file is
// self-contained and does NOT import these names from the package at runtime,
// keeping it loadable in gsd-core's test process without a devDep.
//
// If pi renames a tool in a future version (e.g. 0.81 introduces a new tool or
// drops one), update the constants below. Tests under tests/pi-bridge.unit.test.cjs
// assert the dispatcher behavior for each constant.

const TOOL_READ = "read";
const TOOL_WRITE = "write";
const TOOL_EDIT = "edit";
const TOOL_BASH = "bash";
const TOOL_GREP = "grep";
const TOOL_FIND = "find";
const TOOL_LS = "ls";

// ============================================================================
// .planning/config.json reader
// ============================================================================

interface PlanningConfig {
  hooks?: { community?: boolean; context_warnings?: boolean };
  security?: { injection_blocking?: boolean };
}

export function readPlanningConfig(cwd: string): PlanningConfig {
  const configPath = path.join(cwd, ".planning", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PlanningConfig) : {};
  } catch {
    return {};
  }
}

// ============================================================================
// git subcommand classifier (port of hooks/lib/git-cmd.js#isGitSubcommand)
// ============================================================================

/**
 * Determines whether a shell command string invokes a specific git subcommand.
 * Handles four forms that a naive `^git\s+commit` regex misses:
 *   bare:         git commit -m "..."
 *   -C path:      git -C /some/path commit -m "..."
 *   env-prefix:   GIT_AUTHOR_NAME=x git commit "..."
 *   full-path:    /usr/bin/git commit -m "..."
 *
 * Pure string token walk — no exec needed.
 */
const ARGUMENT_TAKING_FLAGS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--html-path",
  "--man-path",
  "--info-path",
  "--list-cmds",
]);

function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let i = 0;
  let quote: string | null = null;
  while (i < cmd.length) {
    const c = cmd[i];
    if (quote) {
      if (c === "\\" && i + 1 < cmd.length) {
        buf += cmd[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      if (buf.length > 0) {
        tokens.push(buf);
        buf = "";
      }
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      buf += cmd[i + 1];
      i += 2;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.length > 0) tokens.push(buf);
  return tokens;
}

export function isGitSubcommand(cmd: string, sub: string): boolean {
  const tokens = tokenize(cmd);
  // Skip env-style prefix tokens (FOO=bar) until we find the git executable.
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return false;
  const head = tokens[i];
  // bare `git`, full path `/usr/bin/git`, or `git.exe` on Windows.
  if (!/(^|\/)git(\.exe)?$/.test(head)) return false;
  i++;
  // Skip git global options that take an argument (consume the next token).
  while (i < tokens.length && ARGUMENT_TAKING_FLAGS.has(tokens[i])) {
    i += 2;
  }
  // Skip git global boolean flags.
  while (
    i < tokens.length &&
    /^(-p|--paginate|--no-pager|--no-replace-objects|--bare|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks)$/.test(
      tokens[i],
    )
  ) {
    i++;
  }
  return i < tokens.length && tokens[i] === sub;
}

// ============================================================================
// Conventional Commits validator (port of hooks/gsd-validate-commit.sh)
// ============================================================================

const CONVENTIONAL_COMMITS_REGEX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+\))?!?: .+$/;
const MAX_SUBJECT_LENGTH = 72;

type CommitBlockReason =
  | { code: "CONVENTIONAL_COMMITS_VIOLATION"; reason: string }
  | { code: "COMMIT_SUBJECT_TOO_LONG"; reason: string };

export function extractCommitSubject(command: string): string | null {
  const m =
    command.match(/-m\s+"([^"]+)"/) ?? command.match(/-m\s+'([^']+)'/);
  return m ? m[1] : null;
}

function validateCommitSubject(subject: string): CommitBlockReason | null {
  if (!CONVENTIONAL_COMMITS_REGEX.test(subject)) {
    return {
      code: "CONVENTIONAL_COMMITS_VIOLATION",
      reason:
        "Commit message must follow Conventional Commits: <type>(<scope>): <subject>. Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore. Subject must be <=72 chars, lowercase, imperative mood, no trailing period.",
    };
  }
  const firstLine = subject.split("\n", 1)[0];
  if (firstLine.length > MAX_SUBJECT_LENGTH) {
    return {
      code: "COMMIT_SUBJECT_TOO_LONG",
      reason: "Commit subject must be 72 characters or less.",
    };
  }
  return null;
}

// ============================================================================
// Worktree path guard (port of hooks/gsd-worktree-path-guard.js)
// ============================================================================

const SPAWNOPT = {
  encoding: "utf8" as const,
  stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
  timeout: 2000,
  windowsHide: true,
};

function git(args: string[], cwd: string): { status: number; stdout: string } {
  const r = spawnSync("git", args, { ...SPAWNOPT, cwd });
  return {
    status: r.status ?? 0,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
  };
}

export function nearestExistingDir(start: string): string | null {
  let dir = start;
  let prev: string;
  do {
    prev = dir;
    try {
      fs.accessSync(dir, fs.constants.F_OK);
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  } while (dir !== prev);
  return null;
}

type WorktreeCheckResult =
  | { kind: "allow" }
  | { kind: "block"; reason: string };

function checkWorktreePath(filePath: string, cwd: string): WorktreeCheckResult {
  if (!filePath) return { kind: "allow" };
  if (!path.isAbsolute(filePath)) return { kind: "allow" };

  const gitDirResult = git(["rev-parse", "--git-dir"], cwd);
  if (gitDirResult.status !== 0 || !gitDirResult.stdout) {
    return { kind: "allow" }; // not a git repo
  }
  const gitDir = gitDirResult.stdout.trim();
  if (!/[/\\]\.git[/\\]worktrees[/\\]/.test(gitDir)) {
    return { kind: "allow" }; // not a linked worktree
  }

  const branchResult = git(["symbolic-ref", "--short", "HEAD"], cwd);
  const branch =
    branchResult.status === 0 && branchResult.stdout
      ? branchResult.stdout.trim()
      : "";
  // Positive allow-list: only enforce inside GSD-managed executor worktrees.
  if (!/^worktree-agent-[A-Za-z0-9._/-]+$/.test(branch)) {
    return { kind: "allow" };
  }

  const wtTopResult = git(["rev-parse", "--show-toplevel"], cwd);
  if (wtTopResult.status !== 0 || !wtTopResult.stdout) {
    return { kind: "allow" }; // fail open
  }
  const wtTopRaw = wtTopResult.stdout.trim();

  const resolved = path.resolve(filePath);

  // Direct .git detection: if the absolute path is INSIDE the worktree's
  // .git/ directory (the gitlink file or its conceptual contents), block.
  // In a linked worktree, <wt>/.git is a file pointing back to the main
  // repo's .git/worktrees/wt/, so rev-parse --is-inside-git-dir on the file
  // path returns false. This path-string check catches that case directly
  // before rev-parse's ambiguity can let it through.
  const relToWt = path.relative(wtTopRaw, resolved);
  if (
    relToWt &&
    !relToWt.startsWith("..") &&
    !path.isAbsolute(relToWt) &&
    (relToWt === ".git" ||
      relToWt.startsWith(`.git${path.sep}`) ||
      relToWt.startsWith(".git/"))
  ) {
    return {
      kind: "block",
      reason:
        `Worktree path guard: '${filePath}' is inside the worktree's .git/ directory. ` +
        `Writing to git internals from an isolated executor worktree is not permitted. Use a relative path.`,
    };
  }
  let checkDir: string;
  try {
    checkDir = fs.statSync(resolved).isDirectory()
      ? resolved
      : path.dirname(resolved);
  } catch {
    checkDir = path.dirname(resolved);
  }
  const nearestDir = nearestExistingDir(checkDir);
  if (!nearestDir) return { kind: "allow" };

  const fileTopResult = git(["rev-parse", "--show-toplevel"], nearestDir);
  if (fileTopResult.status !== 0 || !fileTopResult.stdout) {
    // Outside any git repo — check if it's inside .git/
    const insideGitDir = git(["rev-parse", "--is-inside-git-dir"], nearestDir);
    if (
      insideGitDir.status === 0 &&
      insideGitDir.stdout &&
      insideGitDir.stdout.trim() === "true"
    ) {
      return {
        kind: "block",
        reason:
          `Worktree path guard: '${filePath}' is inside a git internal (.git) directory, ` +
          `not the active worktree at '${wtTopRaw}'. Writing to repository internals via an ` +
          `absolute path is not permitted from an isolated executor worktree. Use a relative path.`,
      };
    }
    return { kind: "allow" }; // truly outside git — fail open
  }
  const fileTopRaw = fileTopResult.stdout.trim();
  if (fileTopRaw === wtTopRaw) return { kind: "allow" };
  return {
    kind: "block",
    reason:
      `Worktree path guard: '${filePath}' resolves to git root '${fileTopRaw}' which ` +
      `differs from the active worktree root '${wtTopRaw}'. This likely means an ` +
      `absolute path was derived from the orchestrator's main repository instead of ` +
      `the active worktree. To fix: use a relative path, or re-derive the base ` +
      `directory with \`git rev-parse --show-toplevel\` from within the worktree ` +
      `(hook cwd: '${cwd}').`,
  };
}

// ============================================================================
// Prompt injection scanner (port of hooks/gsd-read-injection-scanner.js)
// ============================================================================

interface InjectionHit {
  pattern: RegExp;
  severity: "LOW" | "MEDIUM" | "HIGH";
}

const INJECTION_PATTERNS: ReadonlyArray<InjectionHit> = [
  { pattern: /\bignore (?:all )?previous instructions\b/i, severity: "HIGH" },
  { pattern: /\bdisregard (?:all )?(?:prior|previous) (?:rules|instructions)\b/i, severity: "HIGH" },
  { pattern: /\byou are now\b.{0,40}\bmode\b/i, severity: "HIGH" },
  { pattern: /\bsystem prompt:\s*[^\n]{0,200}/i, severity: "HIGH" },
  { pattern: /\bpretend (?:to be|you are)\b/i, severity: "MEDIUM" },
  { pattern: /\bforget (?:everything|all)\b/i, severity: "MEDIUM" },
  { pattern: /\boverride\b.{0,40}\b(?:instructions|rules|safety)\b/i, severity: "MEDIUM" },
  { pattern: /\bjailbreak\b/i, severity: "MEDIUM" },
  { pattern: /\bact as\b/i, severity: "LOW" },
  { pattern: /\bdo not tell the user\b/i, severity: "LOW" },
];

type InjectionVerdict = "NONE" | "LOW" | "MEDIUM" | "HIGH";

function scanForInjection(text: string): InjectionVerdict {
  let count = 0;
  let highest: InjectionVerdict = "NONE";
  for (const hit of INJECTION_PATTERNS) {
    if (hit.pattern.test(text)) {
      count++;
      if (hit.severity === "HIGH") highest = "HIGH";
      else if (hit.severity === "MEDIUM" && highest !== "HIGH") highest = "MEDIUM";
      else if (highest === "NONE") highest = "LOW";
    }
  }
  if (count >= 3) return "HIGH";
  return highest;
}

// ============================================================================
// Context monitor (port of hooks/gsd-context-monitor.js)
// ============================================================================

const CTX_DEBOUNCE_MS = 60_000;
const CTX_WARNING_LEFT = 0.35; // 35% remaining
const CTX_CRITICAL_LEFT = 0.25; // 25% remaining

const lastWarnedAt = new Map<string, number>();

function notifyContextUsage(ctx: ExtensionContext): void {
  const usage = ctx.getContextUsage();
  if (!usage || usage.percent == null) return;
  // Pi's ContextUsage.percent is 0-100 (% of context window USED).
  // Convert to fraction remaining. Clamp to [0, 1] so bad/oversized
  // estimates can't produce negative or absurd "X% remaining" strings.
  const left = Math.max(0, Math.min(1, (100 - usage.percent) / 100));
  const sessionId = ctx.sessionManager.getSessionId();
  const now = Date.now();
  const last = lastWarnedAt.get(sessionId) ?? 0;
  if (now - last < CTX_DEBOUNCE_MS) return;
  lastWarnedAt.set(sessionId, now);

  if (left <= CTX_CRITICAL_LEFT) {
    ctx.ui.notify(
      `Context CRITICAL: only ${(left * 100).toFixed(0)}% remaining. Consider compacting.`,
      "error",
    );
  } else if (left <= CTX_WARNING_LEFT) {
    ctx.ui.notify(
      `Context WARNING: ${(left * 100).toFixed(0)}% remaining. Consider compacting soon.`,
      "warning",
    );
  }
}

// ============================================================================
// Default export — the extension factory
// ============================================================================

export default function (pi: ExtensionAPI): void {
  // ---- tool_call: worktree path guard (write/edit) ----
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (event.toolName !== TOOL_WRITE && event.toolName !== TOOL_EDIT) return;
    const input = event.input as { path?: string };
    if (!input || typeof input.path !== "string") return;
    const result = checkWorktreePath(input.path, ctx.cwd);
    if (result.kind === "block") {
      return { block: true, reason: result.reason };
    }
  });

  // ---- tool_call: validate-commit (bash, opt-in via hooks.community) ----
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (event.toolName !== TOOL_BASH) return;
    const input = event.input as { command?: string };
    if (!input || typeof input.command !== "string") return;
    if (!isGitSubcommand(input.command, "commit")) return;

    const cfg = readPlanningConfig(ctx.cwd);
    if (cfg.hooks?.community !== true) return; // opt-in gate

    const subject = extractCommitSubject(input.command);
    if (subject === null) return; // no -m flag, nothing to validate

    const failure = validateCommitSubject(subject);
    if (failure) {
      return { block: true, reason: `[${failure.code}] ${failure.reason}` };
    }
  });

  // ---- tool_call: worktree advisory for bash (absolute paths outside worktree) ----
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    if (event.toolName !== TOOL_BASH) return;
    const input = event.input as { command?: string };
    if (!input || typeof input.command !== "string") return;
    const cfg = readPlanningConfig(ctx.cwd);
    if (cfg.hooks?.community !== true) return; // advisory is opt-in
    // Match an absolute-path reference outside the active worktree toplevel.
    const wtTopResult = git(["rev-parse", "--show-toplevel"], ctx.cwd);
    if (wtTopResult.status !== 0 || !wtTopResult.stdout) return;
    const wtTop = wtTopResult.stdout.trim();
    const absMatch = input.command.match(/(\/[A-Za-z0-9._/-]+\/[A-Za-z0-9._/-]+)/);
    if (!absMatch) return;
    const referenced = absMatch[1];
    if (referenced.startsWith(wtTop)) return;
    // Don't block — bash is too general. Just send a follow-up advisory.
    pi.sendUserMessage(
      `[gsd] Bash command references absolute path '${referenced}' which is outside the active worktree '${wtTop}'. Confirm this is intentional.`,
      { deliverAs: "followUp" },
    );
  });

  // ---- tool_result: read-injection scanner (read tool only — replace on HIGH+opt-in) ----
  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (event.toolName !== TOOL_READ) return;
    const cfg = readPlanningConfig(ctx.cwd);
    const text = (event.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");
    if (!text) return;
    const verdict = scanForInjection(text);
    if (verdict === "HIGH" && cfg.security?.injection_blocking === true) {
      return {
        content: [
          { type: "text" as const, text: `[GSD-INJECTION-BLOCKED] HIGH-severity patterns detected in read result; original content suppressed.\n\n${text}` },
        ],
      };
    }
    if (verdict !== "NONE") {
      pi.sendUserMessage(
        `[gsd] ${verdict} severity injection patterns detected in read result. Review before acting.`,
        { deliverAs: "followUp" },
      );
    }
  });

  // ---- tool_result: read-injection scanner lite (grep/find/ls/bash — advisory only) ----
  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    const isLite =
      event.toolName === TOOL_GREP ||
      event.toolName === TOOL_FIND ||
      event.toolName === TOOL_LS ||
      event.toolName === TOOL_BASH;
    if (!isLite) return;
    const text = (event.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");
    if (!text) return;
    const verdict = scanForInjection(text);
    if (verdict === "HIGH" || verdict === "MEDIUM") {
      pi.sendUserMessage(
        `[gsd] ${verdict} severity patterns in ${event.toolName} output. Review before acting.`,
        { deliverAs: "followUp" },
      );
    }
  });

  // ---- tool_result: context monitor (all tools, debounced) ----
  pi.on("tool_result", (_event: ToolResultEvent, ctx: ExtensionContext) => {
    const cfg = readPlanningConfig(ctx.cwd);
    if (cfg.hooks?.context_warnings === false) return; // opt-out
    notifyContextUsage(ctx);
  });

  // ---- session_start: state reminder (opt-in) ----
  pi.on("session_start", (event, ctx: ExtensionContext) => {
    if (event.reason !== "startup") return; // only on fresh startup, not reload/new/resume/fork
    const cfg = readPlanningConfig(ctx.cwd);
    if (cfg.hooks?.community !== true) return;
    const statePath = path.join(ctx.cwd, ".planning", "STATE.md");
    try {
      const raw = fs.readFileSync(statePath, "utf8");
      const lines = raw.split("\n").slice(0, 20).join("\n").trim();
      if (!lines) return;
      pi.sendUserMessage(
        `[gsd] Resuming from .planning/STATE.md (first 20 lines):\n\n${lines}`,
        { deliverAs: "followUp" },
      );
    } catch {
      // missing or unreadable — no-op
    }
  });
}
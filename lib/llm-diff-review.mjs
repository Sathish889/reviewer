#!/usr/bin/env node
// Generic Claude-backed code reviewer for a git diff — the engine behind the per-repo pre-push hook.
//
// Usage:  node llm-diff-review.mjs <repoRoot> [baseRef]
//   - baseRef given (pre-push):  reviews `git diff <baseRef>...HEAD` (what's about to be pushed)
//   - no baseRef (manual test):  reviews uncommitted+staged (`git diff HEAD`) if any,
//                                else unpushed (`git diff @{upstream}..HEAD`), else vs origin default branch.
//
// ADVISORY ONLY: always exits 0 — never blocks a push. Graceful degrade if the claude CLI is missing.
// Output: one finding per line `- <file>:<line> :: <issue> (severity)`, or exactly `CLEAN`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

let MODEL = 'sonnet';
const MAX_DIFF_CHARS = 60000;     // cap so a huge diff can't blow the prompt
const CLI_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 300000);  // 5 min (cross-repo contract review reads related repos); override with REVIEW_TIMEOUT_MS. Advisory → bail rather than hang.

function out(m) { process.stdout.write(m.endsWith('\n') ? m : m + '\n'); }
function git(repo, args) { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? (r.stdout || '') : ''; }
function which(bin) { const r = spawnSync('command', ['-v', bin], { shell: '/bin/bash', encoding: 'utf8' }); return r.status === 0 && (r.stdout || '').trim() ? r.stdout.trim() : ''; }

// Optional config: model + cross-repo rules. Paths/hints are machine-specific → kept OUT of git
// (see llm-review.config.example.json). First readable location wins; absent → clean single-repo review.
function loadConfig(repoRoot) {
  const home = process.env.HOME || '';
  const candidates = [
    process.env.LLM_REVIEW_CONFIG,
    repoRoot && path.join(repoRoot, 'llm-review.config.json'),
    repoRoot && path.join(repoRoot, '.llm-review.config.json'),
    home && path.join(home, '.config', 'llm-review', 'config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch { /* missing/invalid → next */ }
  }
  return {};
}

const repoRoot = process.argv[2];
const baseRef = process.argv[3] || '';
if (!repoRoot) { out('llm-diff-review: usage: node llm-diff-review.mjs <repoRoot> [baseRef] — skipping'); process.exit(0); }
if (!git(repoRoot, ['rev-parse', '--git-dir'])) { out(`llm-diff-review: ${repoRoot} is not a git repo — skipping`); process.exit(0); }

// --- pick the diff to review ---
let diff = '', label = '';
if (baseRef) { diff = git(repoRoot, ['diff', `${baseRef}...HEAD`]); label = `${baseRef}...HEAD`; }
else {
  diff = git(repoRoot, ['diff', 'HEAD']);                       // uncommitted + staged
  label = 'uncommitted changes (working tree vs HEAD)';
  if (!diff.trim()) {
    const up = git(repoRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']).trim();
    if (up) { diff = git(repoRoot, ['diff', `${up}..HEAD`]); label = `unpushed commits (${up}..HEAD)`; }
    else {
      for (const b of ['origin/main', 'origin/master']) {
        const mb = git(repoRoot, ['merge-base', b, 'HEAD']).trim();
        if (mb) { diff = git(repoRoot, ['diff', `${mb}..HEAD`]); label = `commits vs ${b}`; break; }
      }
    }
  }
}
if (!diff.trim()) { out('llm-diff-review: no changes to review — CLEAN'); process.exit(0); }
const truncated = diff.length > MAX_DIFF_CHARS;
if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS) + `\n...[diff truncated at ${MAX_DIFF_CHARS} chars — review the rest manually]...`;

if (!which('claude')) { out('llm-diff-review: claude CLI not available — review skipped'); process.exit(0); }

// --- config + CROSS-REPO context: review the diff against related repos (source-of-truth / integrated apps),
// not this repo alone. Repo paths + hints are MACHINE-SPECIFIC and live in a gitignored config
// (see llm-review.config.example.json), so nothing local is committed. No config → clean single-repo review. ---
const config = loadConfig(repoRoot);
if (config.model) MODEL = config.model;
const rr = repoRoot.replace(/\/+$/, '');

// What changed? Computed once, used for BOTH the cross-repo token-gate and the multi-mode focus below.
const changedFiles = git(repoRoot, baseRef ? ['diff', '--name-only', `${baseRef}...HEAD`] : ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);

// TOKEN GATE: only pull in heavy related repos when the diff is actually CONTRACT-RELEVANT.
// A pure behaviour tweak (a search box, a component's UX) has nothing to verify elsewhere — loading extra
// repos just makes the review slow/expensive. A rule opts into this gate with "contractOnly": true.
const contractRelevant =
  changedFiles.some((f) => /docs\/api\/.*\.json$|docs\/api-md\/|api-index\.json|sidebar\.json/.test(f)) ||
  /\b(endpoint|route|method|params?|reqParams|resParams|possibleValues|transformer|validator|controller|api-index|api-reference)\b/i.test(diff);

// First matching cross-repo rule wins; each rule = { match:<regex on repo path>, related:[<abs paths>], hint, contractOnly? }.
let related = [], crossHint = '';
for (const rule of (Array.isArray(config.crossRepo) ? config.crossRepo : [])) {
  let re; try { re = new RegExp(rule.match); } catch { continue; }
  if (re.test(rr) && (!rule.contractOnly || contractRelevant)) {
    related = Array.isArray(rule.related) ? rule.related : [];
    crossHint = rule.hint || '';
    break;
  }
}
const addDirs = [rr, ...related.filter((d) => d && git(d, ['rev-parse', '--git-dir']))];

// --- multi-mode focus: tailor the review to WHAT changed (web / mobile / API docs / e2e) ---
let modeHint = '';
if (changedFiles.some((f) => /docs\/api\/.*\.json$|docs\/api-md\//.test(f))) modeHint = 'MODE = API DOCS: focus on contract accuracy — request params vs the validator, response fields vs the transformer whitelist, enums vs the data-model, path/method vs the controller.';
else if (changedFiles.some((f) => /\.(spec|e2e)\.ts$|\/e2e\//.test(f))) modeHint = 'MODE = E2E / PLAYWRIGHT: focus on test correctness — over-broad selectors or missing awaits that create false-greens, and whether the change is actually covered.';
else if (changedFiles.some((f) => /\.component\.(ts|html|scss)$|apps\/[^/]+\/src\/app\//.test(f))) modeHint = 'MODE = WEB (Angular): focus on component logic, signals/observables, routing, and consistency with the docs/data it renders.';
else if (changedFiles.some((f) => /\.(kt|java|swift|m|mm|dart)$|\/android\/|\/ios\//.test(f))) modeHint = 'MODE = MOBILE: focus on platform lifecycle, null-safety, threading, and correct use of the API contract.';

const prompt = `You are a meticulous senior engineer doing a PRE-PUSH code review of a git diff for the repository at ${repoRoot} (${label}).
${crossHint ? '\n' + crossHint + '\nYou have read-only access to the related repo(s) above — USE Read/Grep/Glob to check integration and contract accuracy against them, not just this diff in isolation.\n' : ''}${modeHint ? '\n' + modeHint + '\n' : ''}
TOKEN DISCIPLINE (important): be SURGICAL. Open ONLY the specific file(s) directly relevant to the changed lines — the handler/validator/transformer for a changed endpoint, or the component a changed template binds to. Do NOT browse or read whole repos; prefer one targeted Grep (by symbol/field name) over broad reads, and stop reading as soon as a concern is confirmed or refuted.


Report ONLY real, high-confidence problems introduced by this change:
- bugs / logic errors / off-by-one / null & undefined handling
- security issues (injection, auth/authorization gaps, secrets, unsafe deserialization)
- data loss / destructive operations / migrations without guards
- breaking API or contract changes, removed validation, or removed fields/params that callers may depend on
- broken or swallowed error handling, race conditions, resource leaks
- CONTRACT DRIFT vs the source of truth (open the related repo to confirm): response fields that don't match the transformer's emitted whitelist (phantom fields, missing emitted fields, wrong key names), request params that don't match the validator, possibleValues missing data-model enum values, or method/path disagreeing with the controller
- cross-service integration breaks: a change that breaks how this endpoint/component integrates with another service or the docs/contract it depends on
- dead code introduced by this change: empty/no-op functions left behind, or calls to logic this diff removed

Be CONSERVATIVE and HIGH-PRECISION: a false positive is worse than missing a minor nit. Do NOT report style, formatting, naming, or subjective preferences. You may use your read-only tools (Read/Grep/Glob) to open other files in the repo to confirm whether a change is actually safe (e.g. whether a removed field is still referenced elsewhere) before reporting.

OUTPUT FORMAT — strict, nothing else:
- One finding per line, exactly: - <file>:<line> :: <issue> (severity)   where severity is high|medium|low
- If there are no real problems, output exactly the single word: CLEAN
No preamble, no headings, no summary.

DIFF:
${diff}`;

const args = ['-p', '--model', MODEL, '--output-format', 'text', '--add-dir', ...addDirs, '--allowedTools', 'Read', 'Grep', 'Glob', '--permission-mode', 'plan', prompt];
let res;
try { res = spawnSync('claude', args, { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { out(`llm-diff-review: claude invocation failed (${e && e.message ? e.message : e}) — skipped`); process.exit(0); }
if (res.error) { out(`llm-diff-review: claude skipped — ${res.error.code === 'ETIMEDOUT' ? `timed out after ${CLI_TIMEOUT_MS}ms` : res.error.message}`); process.exit(0); }
const stdout = (res.stdout || '').trim();
if (res.status !== 0 || !stdout) { const e = (res.stderr || '').trim().split('\n').slice(0, 4).join(' '); out(`llm-diff-review: claude skipped — returned ${res.status}${e ? ` (${e})` : ' (no output)'}`); process.exit(0); }
out(stdout);
if (truncated) out('- (note) diff was truncated for review — large change, verify the remainder manually (low)');
process.exit(0);

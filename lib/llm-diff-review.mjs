#!/usr/bin/env node
// llm-review — a generic, provider-agnostic AI code reviewer for a git diff.
// Runs on whichever agentic CLI you have: Claude Code (`claude`, reads ANTHROPIC_API_KEY) OR the Gemini CLI
// (`gemini`, reads GEMINI_API_KEY). Both can Read/Grep/Glob the repo, so the reviewer traces the real FLOW and
// ARCHITECTURE across dependent services — not just the changed lines. Advisory: it prints findings, never edits
// anything, and never blocks a push.
//
// Usage:  node llm-diff-review.mjs <repoRoot> [baseRef]
//   - baseRef given (pre-push):  reviews `git diff <baseRef>...HEAD` (what's about to be pushed)
//   - no baseRef (manual):       reviews uncommitted+staged (`git diff HEAD`) if any,
//                                else unpushed (`git diff @{upstream}..HEAD`), else vs the origin default branch.
//
// Provider:  auto-detects `claude` then `gemini`. Force with LLM_REVIEW_PROVIDER=claude|gemini or config.provider.
// Robustness: generated/build/vendored files are excluded; large diffs are CHUNKED (never silently truncated);
//             the per-call timeout is a HARD wall-clock bound (spawn detached, kill the process group on timeout).
// Always exits 0 (advisory). Graceful-degrades if no provider CLI is installed.
// Output: one finding per line `- <file>:<line> :: <issue> (severity)`, ordered most-severe first, or `CLEAN`.

import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const CHUNK_CHARS = Number(process.env.REVIEW_CHUNK_CHARS || 200000);   // target max chars per review chunk (multi-file packing)
const HARD_FILE_CAP = Number(process.env.REVIEW_FILE_CAP || 400000);    // a single file's diff bigger than this is truncated (rare) with a loud note
const MAX_CHUNKS = Number(process.env.REVIEW_MAX_CHUNKS || 12);         // bound total review calls; files beyond are REPORTED as not-reviewed (never dropped silently)
const CLI_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS || 300000);  // per-call HARD cap, 5 min. Override with REVIEW_TIMEOUT_MS. Advisory → bail rather than hang.

function out(m) { process.stdout.write(m.endsWith('\n') ? m : m + '\n'); }
function note(m) { process.stderr.write(m.endsWith('\n') ? m : m + '\n'); }   // progress → stderr so it never pollutes the findings on stdout
function git(repo, args) { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? (r.stdout || '') : ''; }
function which(bin) { const r = spawnSync('command', ['-v', bin], { shell: '/bin/bash', encoding: 'utf8' }); return r.status === 0 && (r.stdout || '').trim() ? r.stdout.trim() : ''; }

// Split a unified diff into per-file sections (on `diff --git` boundaries) so we can chunk without cutting a file mid-hunk.
function splitByFile(d) {
  return d.split(/(?=^diff --git )/m).filter((s) => s.trim()).map((text) => {
    const m = text.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = (m && m[2]) || (text.match(/^\+\+\+ b\/(.+)$/m) || [])[1] || '?';
    return { file, text };
  });
}
// Greedily pack per-file sections into chunks each ≤ cap. A single file bigger than cap becomes its own chunk (reviewed whole).
function packChunks(sections, cap) {
  const chunks = []; let cur = [], len = 0;
  for (const s of sections) {
    if (len && len + s.text.length > cap) { chunks.push(cur); cur = []; len = 0; }
    cur.push(s); len += s.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Optional config: provider + model + cross-repo rules + extra excludes + requirements. Machine-specific paths
// live OUT of git (see llm-review.config.example.json). First readable location wins; absent → clean defaults.
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

// Optional user requirements / spec to review the change AGAINST. From env (path or inline text),
// config.requirementsFile, or a REQUIREMENTS file in the repo. Capped so it can't blow the prompt.
function loadRequirements(repoRoot, config) {
  const env = process.env.LLM_REVIEW_REQUIREMENTS;
  const paths = [];
  if (env) paths.push(env);
  if (config.requirementsFile) paths.push(path.resolve(repoRoot, config.requirementsFile));
  for (const n of ['REQUIREMENTS.md', 'docs/REQUIREMENTS.md', 'REQUIREMENTS.txt']) paths.push(path.join(repoRoot, n));
  for (const p of paths) {
    try { const t = fs.readFileSync(p, 'utf8').trim(); if (t) return t.slice(0, 12000); } catch { /* not a file → next */ }
  }
  if (env && !fs.existsSync(env)) return env.slice(0, 12000);   // env was inline text, not a path
  return '';
}

// LOCAL DEPENDENCY FOLDERS: pull in local source deps that live OUTSIDE the repo root (file:/link:/portal: and
// workspace packages) so the reviewer can check the change against what it actually imports. node_modules skipped.
function localDepDirs(root) {
  const found = new Set();
  const rootAbs = path.resolve(root);
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(root, p);
    if (abs === rootAbs || abs.startsWith(rootAbs + path.sep)) return;   // inside root → already covered
    if (/(^|\/)node_modules(\/|$)/.test(abs)) return;
    try { if (fs.statSync(abs).isDirectory()) found.add(abs); } catch {}
  };
  try {
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const v of Object.values(deps)) {
      const m = String(v).match(/^(?:file:|link:|portal:)(.+)$/);
      if (m) add(m[1].trim());
    }
    let ws = pkg.workspaces;
    if (ws && !Array.isArray(ws)) ws = ws.packages;
    for (const g of (Array.isArray(ws) ? ws : [])) {
      const base = String(g).replace(/\/\*+$/, '');
      try { for (const d of fs.readdirSync(path.resolve(root, base))) add(path.join(base, d)); } catch {}
    }
  } catch {}
  return [...found].slice(0, 6);
}

// ---- Providers: an agentic CLI that can read the repo (Read/Grep/Glob) and answer a prompt. Each reads its
// API key from the environment, so anyone can run this with whichever key they have. Every field is overridable
// via config.providers[name] = { bin, model, extraArgs:[] } and env, so CLI-version drift is easy to adapt to. ----
const BUILTIN_PROVIDERS = {
  claude: {
    bin: 'claude', defaultModel: 'sonnet',              // key: ANTHROPIC_API_KEY (or an authenticated Claude CLI)
    // read-only agentic review: plan mode + only Read/Grep/Glob
    args: ({ model, addDirs, extra, prompt }) =>
      ['-p', '--model', model, '--output-format', 'text', '--add-dir', ...addDirs,
        '--allowedTools', 'Read', 'Grep', 'Glob', '--permission-mode', 'plan', ...extra, prompt],
  },
  gemini: {
    bin: 'gemini', defaultModel: 'gemini-2.5-pro',      // key: GEMINI_API_KEY
    // cwd is set to the repo root; extra roots go via --include-directories. No --yolo → it stays read-only.
    args: ({ model, addDirs, extra, prompt }) =>
      ['-m', model, ...(addDirs.length > 1 ? ['--include-directories', addDirs.slice(1).join(',')] : []),
        ...extra, '-p', prompt],
  },
};
function pickProvider(config) {
  const want = (process.env.LLM_REVIEW_PROVIDER || config.provider || '').toLowerCase();
  const order = want ? [want] : ['claude', 'gemini'];
  for (const name of order) {
    const base = BUILTIN_PROVIDERS[name];
    if (!base) continue;
    const ov = (config.providers && config.providers[name]) || {};
    const bin = process.env.LLM_REVIEW_BIN_CMD || ov.bin || base.bin;
    if (which(bin)) {
      return {
        name, bin, build: base.args,
        model: process.env.LLM_REVIEW_MODEL || ov.model || config.model || base.defaultModel,
        extra: Array.isArray(ov.extraArgs) ? ov.extraArgs : [],
      };
    }
    if (want) return null;   // explicitly requested provider, but its CLI isn't on PATH
  }
  return null;
}

const repoRoot = process.argv[2];
const baseRef = process.argv[3] || '';
if (!repoRoot) { out('llm-diff-review: usage: node llm-diff-review.mjs <repoRoot> [baseRef] — skipping'); process.exit(0); }
if (!git(repoRoot, ['rev-parse', '--git-dir'])) { out(`llm-diff-review: ${repoRoot} is not a git repo — skipping`); process.exit(0); }

const config = loadConfig(repoRoot);
const rr = repoRoot.replace(/\/+$/, '');
const provider = pickProvider(config);
const requirements = loadRequirements(rr, config);

// --- EXCLUDE generated / build / vendored files from the diff (git pathspec magic: '*' also matches '/').
// Universal defaults + anything the user adds via config `excludes` (e.g. generated docs, snapshots). ---
const GENERIC_EXCLUDES = [
  '*/dist/*', 'dist/*', '*/build/*', 'build/*', '*/out/*', 'out/*', '*/.next/*', '.next/*',
  '*/coverage/*', 'coverage/*', '*/node_modules/*', 'node_modules/*', '*/vendor/*',
  '*.min.js', '*.min.css', '*.map', '*.snap',
  'package-lock.json', '*/package-lock.json', '*yarn.lock', '*pnpm-lock.yaml', '*bun.lockb',
  '*Gemfile.lock', '*Cargo.lock', '*composer.lock', '*poetry.lock', '*go.sum',
];
const EXCLUDES = [...GENERIC_EXCLUDES, ...(Array.isArray(config.excludes) ? config.excludes : [])].map((p) => `:(exclude)${p}`);

const gitDiff = (rangeArgs) => git(repoRoot, ['diff', ...rangeArgs, '--', ...EXCLUDES]);
const gitDiffNames = (rangeArgs) => git(repoRoot, ['diff', '--name-only', ...rangeArgs, '--', ...EXCLUDES]).split('\n').filter(Boolean);

// --- pick the diff to review (generated files already excluded) ---
let rangeArgs = ['HEAD'], label = 'uncommitted changes (working tree vs HEAD)';
if (baseRef) { rangeArgs = [`${baseRef}...HEAD`]; label = `${baseRef}...HEAD`; }
let diff = gitDiff(rangeArgs);
if (!diff.trim() && !baseRef) {
  const up = git(repoRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']).trim();
  if (up) { rangeArgs = [`${up}..HEAD`]; label = `unpushed commits (${up}..HEAD)`; diff = gitDiff(rangeArgs); }
  else {
    for (const b of ['origin/main', 'origin/master']) {
      const mb = git(repoRoot, ['merge-base', b, 'HEAD']).trim();
      if (mb) { rangeArgs = [`${mb}..HEAD`]; label = `commits vs ${b}`; diff = gitDiff(rangeArgs); break; }
    }
  }
}
if (!diff.trim()) { out('llm-diff-review: no reviewable (non-generated) changes — CLEAN'); process.exit(0); }

if (!provider) { out('llm-diff-review: no reviewer CLI found — install `claude` (ANTHROPIC_API_KEY) or `gemini` (GEMINI_API_KEY). review skipped'); process.exit(0); }

// What changed? Used for the cross-repo token-gate and the mode hint below.
const changedFiles = gitDiffNames(rangeArgs);

// TOKEN GATE: only pull heavy related repos in when the diff is actually CONTRACT-RELEVANT (a rule opts in
// via "contractOnly": true). A pure behaviour/UX tweak has nothing to verify elsewhere — keep it fast + cheap.
const contractRelevant =
  changedFiles.some((f) => /(api|schema|contract|route|controller|dto|resolver|openapi|swagger)/i.test(f) || /\.(proto|graphql|graphqls)$/i.test(f)) ||
  /\b(endpoint|route|method|params?|schema|contract|dto|validator|controller|migration|interface|proto|graphql|enum)\b/i.test(diff);

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
const depDirs = localDepDirs(rr);
const depHint = depDirs.length
  ? `LOCAL DEPENDENCY FOLDERS: this project links these local source folders that live OUTSIDE the repo root — you have read-only access to them. Verify the change against how it actually USES them (imported symbols, types, shared contracts) and flag any break: ${depDirs.join(', ')}.`
  : '';
const addDirs = [...new Set([rr, ...related.filter((d) => d && git(d, ['rev-parse', '--git-dir'])), ...depDirs])];

const reqBlock = requirements
  ? `\nUSER REQUIREMENTS / SPEC — the change must actually SATISFY these. Verify it does, and flag any requirement left unmet, partially met, or contradicted as a finding:\n"""\n${requirements}\n"""\n`
  : '';

const contextHints = `${crossHint ? '\n' + crossHint + '\nYou have read-only access to the related repo(s) above — USE Read/Grep/Glob to verify integration and contract accuracy against them, not just this diff in isolation.\n' : ''}${depHint ? '\n' + depHint + '\n' : ''}${reqBlock}
You have read-only access (Read/Grep/Glob) to the ENTIRE project at the repo root${depHint || related.length ? ' PLUS the related/dependency folders listed above' : ''} — review the change in the context of the whole codebase, its architecture, and the services it depends on, not just the changed lines.`;

const reviewBody = `HOW TO REVIEW — work through these steps before writing any finding:

1) SUBJECT, ARCHITECTURE & DEPENDENCIES. Identify what this change is really about and WHERE it sits in the system: which layer/boundary it touches (UI, API/controller, domain/service, data/store, integration/queue, infra/config) and which OTHER modules or services depend on it or are depended on by it. Use Grep/Glob to map the real structure, and follow the change across every boundary it crosses — into the related repos and dependency folders you can access. Enumerate the dependent services/modules this change can affect; reason about EACH, not just the edited file.

2) FLOW — OLD vs NEW (regression / backward-compatibility — the part reviewers most often miss). Trace the end-to-end flow: what CALLS the changed code and what it CALLS, and what data/contract crosses each hop. The diff's context + removed ('-') lines PLUS the unchanged code you can Read ARE the old behavior. For each changed unit, work out what it did BEFORE vs NOW. The existing flow must keep working exactly as before UNLESS changing it is the clear intent. Flag any existing caller, consumer, test, persisted data, default, or documented contract that would now break or silently behave differently. Removed/renamed fields, params, validation, branches, or enum values that callers rely on are regressions — confirm with Grep.

3) COMPREHENSIVE PASS across the whole surface. Walk EVERY path the change creates or alters — success, error, and edge/boundary (empty, null, zero, negative, max, concurrent, first/last, timeout, retry, permission-denied, offline). Apply whichever of these fit the code under review:
   • WEB / frontend: rendering, state, routing, data binding, XSS/escaping, a11y of critical flows, consistency with the API it consumes.
   • MOBILE: lifecycle, background/foreground, null-safety, main-thread work, offline & retry, permissions, platform-API misuse.
   • BACKEND / CLOUD: auth & authorization on EVERY entry point, input validation, DB queries (N+1, injection, missing transaction), idempotency, guarded migrations, config/secrets, rate limits, cloud IAM/permissions, cold-start/timeout.
   • TERMINAL / CLI / devices: argument & exit-code handling, stdin/stdout/pipes, signals, device/session lifecycle, partial failure.
   • PAYMENTS / money movement (treat issues here as HIGH): correct amount, currency & rounding; idempotency so a retry can't double-charge; safe capture/void/refund/cancel state transitions; races on concurrent operations; never trust a client-supplied amount; auth on every money-moving endpoint; no card/secret data logged; reconciliation & failure handling.

CHECK for every real problem introduced or exposed by this change:
- bugs / logic errors / off-by-one / null & undefined / inverted or wrong conditionals
- REGRESSIONS: existing behavior, callers, tests, defaults, or persisted data silently changed or broken
- security: injection, auth/authorization gaps, leaked secrets, unsafe deserialization, SSRF, path traversal, missing input validation
- data loss / destructive ops / migrations without guards
- breaking API/contract changes: removed validation, or removed/renamed fields/params/enum values callers depend on
- CONTRACT DRIFT vs a source of truth (open the related repo/service to confirm): response fields vs what the handler actually returns, request params vs the validator, enums vs the data model, method/path vs the route/controller
- cross-service / integration breaks with a dependent service or the docs/contract this change depends on
- async / concurrency: races, missing awaits, unhandled rejections, ordering assumptions
- broken / swallowed error handling, resource leaks, unclosed handles/subscriptions
- MISSING TEST COVERAGE for a new behavior/branch this change introduces
- dead code introduced by this change: empty/no-op functions left behind, or calls to logic this diff removed

PRECISION: every finding must be a REAL, defensible problem tied to THIS change, with a concrete impact you can name (which caller breaks, which value is wrong, which contract drifts, which path is uncovered, which requirement is unmet). Confirm regressions via Read/Grep before reporting. Do NOT report pure style, formatting, naming, or subjective preference — but do NOT stay silent on a real risk. The goal is to miss NOTHING a careful staff engineer or a downstream reviewer would legitimately catch.

TOKEN DISCIPLINE (effectiveness FIRST, tokens SECOND): never skip a real check or a needed Read/Grep — coverage is the point. Be surgical: open the file(s) directly on the flow, prefer one targeted Grep (by symbol/field) over broad reads, stop once a concern is confirmed or refuted, and never read node_modules, build/dist output, or lockfiles.`;

const reviewPromptFor = (diffText) => `You are a meticulous STAFF-level engineer doing an EXHAUSTIVE code review of a git diff for the repository at ${repoRoot} (${label}). GOAL: catch EVERY real problem this change introduces or exposes — correctness, regressions, security, contract/integration breaks, and unmet requirements — so that NO downstream reviewer (another AI reviewer, a bot, or a human) is left with a legitimate issue you missed. Missing a real problem is the PRIMARY failure; noisy nits are the secondary one.
${contextHints}

${reviewBody}

OUTPUT FORMAT — strict, nothing else:
- One finding per line, exactly: - <file>:<line> :: <issue> (severity)   where severity is high|medium|low
- Order findings most-severe first (all high, then medium, then low).
- Make <issue> specific: name the flow/architecture impact (what breaks / what value is wrong / which contract drifts / which path is uncovered / which requirement is unmet), not just a category word.
- Severity: high = bug / security / data-loss / breaking-contract / payment error / regression that reaches a real consumer; medium = logic gap, missing error handling, contract drift, uncovered new path, partially-met requirement; low = minor robustness or a concrete risk-reducing improvement.
- If there are genuinely no real problems, output exactly the single word: CLEAN
No preamble, no headings, no summary.

DIFF:
${diffText}`;

// --- run the provider with a HARD wall-clock bound (pure Node, no coreutils needed) ---
// spawnSync's timeout only SIGTERMs the DIRECT child and then blocks reading its stdout until EOF, so a wedged
// grandchild can hang the whole thing far past the cap. Instead spawn the provider DETACHED (its own process
// group) and, on timeout, signal the ENTIRE group (SIGTERM then SIGKILL) and resolve immediately — never wait
// on a stuck pipe. process.kill(-pid) needs the group leader that `detached` gives us.
function runReview(prompt) {
  const argv = provider.build({ model: provider.model, addDirs, extra: provider.extra, prompt });
  return new Promise((resolve) => {
    let child;
    try { child = spawn(provider.bin, argv, { detached: true, cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ error: e }); }
    let so = '', se = '', done = false;
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); resolve(res); };
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const timer = setTimeout(() => {
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 15000).unref();
      try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
      child.unref();
      finish({ timedOut: true });
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => { so += d; if (so.length > 32 * 1024 * 1024) so = so.slice(0, 32 * 1024 * 1024); });
    child.stderr.on('data', (d) => { if (se.length < 1024 * 1024) se += d; });
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (status) => finish({ status, stdout: so, stderr: se }));
  });
}
function reviewText(res) {
  if (res.timedOut || (res.error && res.error.code === 'ETIMEDOUT')) return { ok: false, err: `timed out after ${CLI_TIMEOUT_MS}ms` };
  if (res.error) return { ok: false, err: res.error.message };
  const stdout = (res.stdout || '').trim();
  if (res.status !== 0 || !stdout) { const e = (res.stderr || '').trim().split('\n').slice(0, 4).join(' '); return { ok: false, err: `returned ${res.status}${e ? ` (${e})` : ' (no output)'}` }; }
  return { ok: true, text: stdout };
}

// --- CHUNK the diff so nothing is silently dropped, review each chunk, merge findings ---
const sections = splitByFile(diff);
for (const s of sections) if (s.text.length > HARD_FILE_CAP) { s.trunc = true; s.text = s.text.slice(0, HARD_FILE_CAP) + `\n...[${s.file}: diff truncated at ${HARD_FILE_CAP} chars]...\n`; }
let chunks = packChunks(sections, CHUNK_CHARS);
const dropped = [];
if (chunks.length > MAX_CHUNKS) { for (const c of chunks.slice(MAX_CHUNKS)) for (const s of c) dropped.push(s.file); chunks = chunks.slice(0, MAX_CHUNKS); }
note(`llm-diff-review: reviewing with ${provider.name} (${provider.model})${chunks.length > 1 ? ` — ${sections.length} files in ${chunks.length} chunk(s)` : ''}`);

const findings = [];
const failed = [];
for (let i = 0; i < chunks.length; i++) {
  const files = chunks[i].map((s) => s.file);
  if (chunks.length > 1) note(`  ▶ chunk ${i + 1}/${chunks.length}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` +${files.length - 6} more` : ''}`);
  const r = reviewText(await runReview(reviewPromptFor(chunks[i].map((s) => s.text).join('\n'))));
  if (!r.ok) { failed.push({ files, err: r.err }); note(`     skipped — ${r.err}`); continue; }
  if (/^\s*CLEAN\s*$/i.test(r.text)) continue;
  for (const l of r.text.split('\n')) { const t = l.trim(); if (t.startsWith('- ')) findings.push(t); }
}
for (const s of sections) if (s.trunc) findings.push(`- ${s.file}:0 :: file diff too large — only the first ${HARD_FILE_CAP} chars were reviewed; verify the rest manually (low)`);
if (dropped.length) findings.push(`- (scope):0 :: ${dropped.length} file(s) NOT reviewed — diff exceeded ${MAX_CHUNKS} chunks (raise REVIEW_MAX_CHUNKS to cover them): ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? ` +${dropped.length - 10} more` : ''} (medium)`);
for (const f of failed) findings.push(`- (review):0 :: ${f.files.length} file(s) NOT reviewed — ${f.err}: ${f.files.slice(0, 6).join(', ')}${f.files.length > 6 ? ` +${f.files.length - 6} more` : ''} (medium)`);

if (!findings.length) { out('CLEAN'); process.exit(0); }
const sev = (l) => (/\(high\)\s*$/.test(l) ? 0 : /\(medium\)\s*$/.test(l) ? 1 : 2);
findings.sort((a, b) => sev(a) - sev(b));
out(findings.join('\n'));
process.exit(0);

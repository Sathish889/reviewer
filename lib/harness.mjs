#!/usr/bin/env node
// harness.mjs — measure what the reviewer CATCHES, per category, on changes whose defects are known.
//
// Without this, "the reviewer misses architecture issues" is an impression, and every prompt change
// is a guess nobody can check. A case is a tiny repository (base/), a change applied on top of it
// (change/), and the defects that change contains (case.json). The harness builds each case, runs the
// real engine on it, and scores whether each expected defect came back — in the right file, saying the
// right thing, under the right category. Clean CONTROL cases measure the other side: noise.
//
//     llm-review --eval                 show the plan and what it would cost (no calls)
//     llm-review --eval --yes           run every case, print the scoreboard, append to history
//     llm-review --eval --yes --only semantic-scheduled-success,blast-rename
//     llm-review --capture-miss --commit <sha> --at <file:line> --category semantic --note "..."
//                                       turn a REAL miss into a case, so it can never be missed twice
//
// Cases come from <kit>/eval/cases and from ~/.config/llm-review/eval-cases (your captured misses,
// which hold your code and therefore never live in this repository).
//
// Cost: every case is one real review. The default budget is 'minimal'. Nothing runs without --yes.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, STATE_DIR, HISTORY_FILE, lastEvalRun } from './shared.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so two versions can be scored on the same cases: LLM_REVIEW_EVAL_ENGINE=<old checkout>/lib/llm-diff-review.mjs
const ENGINE = process.env.LLM_REVIEW_EVAL_ENGINE || path.join(KIT, 'lib', 'llm-diff-review.mjs');
const HOME = process.env.HOME || '.';
const CASE_DIRS = () => [process.env.LLM_REVIEW_EVAL_CASES || path.join(KIT, 'eval', 'cases'), path.join(HOME, '.config', 'llm-review', 'eval-cases')];
const CALLS_PER_RUN = { minimal: 2, balanced: 4, thorough: 8 };

export function loadCases(only = []) {
  const cases = [];
  for (const dir of CASE_DIRS()) {
    let names = [];
    try { names = fs.readdirSync(dir).sort(); } catch { continue; }
    for (const n of names) {
      const meta = path.join(dir, n, 'case.json');
      let j; try { j = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { continue; }
      if (only.length && !only.includes(n)) continue;
      cases.push({ name: n, dir: path.join(dir, n), ...j, expect: Array.isArray(j.expect) ? j.expect : [] });
    }
  }
  return cases;
}

function copyTree(src, dst) {
  if (!fs.existsSync(src)) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    // A case is data someone else may have written: a symlink in it would copy whatever it points at
    // (a key, a dotfile) into the eval repo, and from there into a prompt.
    if (e.name === '.deleted' || e.isSymbolicLink()) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyTree(s, d); }
    else fs.copyFileSync(s, d);
  }
}
const g = (repo, ...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

// base/ is committed, change/ is laid over it and staged — exactly the state a pre-commit gate sees.
export function buildCase(c, root) {
  const repo = path.join(root, c.name);
  fs.mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '.');
  g(repo, 'config', 'user.email', 'eval@llm-review'); g(repo, 'config', 'user.name', 'eval');
  g(repo, 'config', 'core.hooksPath', '/dev/null');          // the machine's own review hook must not fire
  g(repo, 'config', 'commit.gpgsign', 'false');              // nor the user's signing setup
  copyTree(path.join(c.dir, 'base'), repo);
  g(repo, 'add', '-A');
  if (g(repo, 'commit', '-qm', 'base', '--allow-empty').status !== 0) return null;   // scored UNVERIFIED
  copyTree(path.join(c.dir, 'change'), repo);
  try {
    for (const f of fs.readFileSync(path.join(c.dir, 'change', '.deleted'), 'utf8').split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) continue;     // never outside the case repo
      fs.rmSync(path.join(repo, f), { force: true });
    }
  } catch {}
  g(repo, 'add', '-A');
  return repo;
}

// An expectation is CAUGHT when some finding names one of its files and says one of its keywords —
// whatever it was filed under — and CLASSIFIED when it was also filed under an accepted category.
// Keywords, not exact text: two correct reviews of the same defect never use the same words.
export function score(c, report, ran = true) {
  // A review that did not happen measures nothing. Scoring its empty report would read as "every
  // expectation missed" and "the control is clean" — and --improve would then retire good lessons on
  // the strength of a provider outage. So it is UNVERIFIED, and nothing downstream may learn from it.
  const unverified = !ran || !report || !Array.isArray(report.findings) || !!report.allFailed || (report.failedPasses || 0) > 0;
  if (unverified) return { case: c.name, clean: !!c.clean, unverified: true, expected: c.expect.length, caught: 0, classified: 0, missed: [], evidence: [], blocking: 0, findings: 0, calls: ((report || {}).budget || {}).callsMade || 0, incomplete: true, categories: {} };
  const all = [
    ...(report.findings || []).map((f) => ({ file: f.file, line: f.line, text: f.issue, category: f.category, severity: f.severity })),
    ...(report.deterministic || []).map((d) => ({ file: d.file, line: d.line, text: `${d.check} ${d.message || ''}`, category: d.category || 'bug', severity: d.severity })),
  ];
  const fileOk = (f, files) => !files || !files.length || files.some((x) => f === x || f.endsWith('/' + x) || x.endsWith('/' + f));
  // With no keywords, a file match alone would accept any finding in that file — so the line must be
  // close too, and an expectation with neither files nor keywords can never be caught by accident.
  const lineOk = (f, e) => (e.keywords && e.keywords.length) || !e.line || Math.abs((f.line || 0) - e.line) <= 6;
  const caught = [], missed = [], evidence = [];
  let classified = 0;
  for (const e of c.expect) {
    const kw = (e.keywords || []).map((k) => k.toLowerCase());
    if (!kw.length && !(e.files && e.files.length)) { missed.push({ index: c.expect.indexOf(e), category: e.category, lesson: e.lesson || '' }); continue; }
    const hit = all.filter((f) => fileOk(f.file, e.files) && lineOk(f, e) && (!kw.length || kw.some((k) => f.text.toLowerCase().includes(k))));
    if (hit.length) {
      // The finding that earned the catch, kept so a "caught" can be checked by eye, not taken on trust.
      evidence.push({ category: e.category, finding: `${hit[0].file}:${hit[0].line} [${hit[0].category}] ${hit[0].text}`.slice(0, 240) });
      caught.push(e.category);
      if (hit.some((f) => (e.accept || [e.category]).includes(f.category))) classified++;
    } else missed.push({ index: c.expect.indexOf(e), category: e.category, lesson: e.lesson || '' });
  }
  const blocking = all.filter((f) => f.severity === 'high').length;
  return { case: c.name, clean: !!c.clean, expected: c.expect.length, caught: caught.length, classified, missed, evidence,
    blocking, findings: all.length, calls: (report.budget || {}).callsMade || 0,
    incomplete: !!report.incomplete, categories: report.categories || {} };
}

export async function runEval({ cases: names = [], budget = 'minimal', trialIds = [], quiet = false } = {}) {
  const cases = loadCases(names);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-review-eval-'));
  const results = [];
  try {
    for (const c of cases) {
      const repo = buildCase(c, root);
      if (!repo) { results.push(score(c, null, false)); continue; }
      const reportFile = path.join(root, `${c.name}.report.json`);
      // Fresh every time: a cached answer would measure last week's prompt, and report 0 calls.
      const env = { ...process.env, LLM_REVIEW_BUDGET: budget, LLM_REVIEW_REPORT: reportFile, LLM_REVIEW_LESSON_TRIAL: trialIds.join(','), LLM_REVIEW_NO_CACHE: process.env.LLM_REVIEW_EVAL_CACHE === '1' ? (process.env.LLM_REVIEW_NO_CACHE || '') : '1' };
      delete env.REVIEW_FAIL_ON;                    // advisory: we want every finding, not a verdict
      if (!quiet) process.stderr.write(`  eval: ${c.name} …\n`);
      const proc = spawnSync(process.execPath, [ENGINE, repo, '--staged'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'], maxBuffer: 32 * 1024 * 1024 });
      let report = null;
      try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch {}
      // Keep the raw reports when asked: a score is only as good as the findings behind it.
      if (process.env.LLM_REVIEW_EVAL_KEEP) {
        try { fs.mkdirSync(process.env.LLM_REVIEW_EVAL_KEEP, { recursive: true }); fs.copyFileSync(reportFile, path.join(process.env.LLM_REVIEW_EVAL_KEEP, `${c.name}.${budget}.json`)); } catch {}
      }
      // Advisory runs exit 0 whenever the engine got as far as reporting; anything else is a crash.
      results.push(score(c, report, proc.status === 0));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const verified = results.filter((r) => !r.unverified);
  const totals = verified.reduce((t, r) => ({
    expected: t.expected + r.expected, caught: t.caught + r.caught, classified: t.classified + r.classified,
    noise: t.noise + (r.clean ? r.blocking : 0), calls: t.calls + r.calls,
  }), { expected: 0, caught: 0, classified: 0, noise: 0, calls: 0 });
  totals.unverified = results.length - verified.length;
  const byCategory = {};
  for (const c of cases) {
    const r = results.find((x) => x.case === c.name);
    if (!r || r.unverified) continue;
    c.expect.forEach((e, i) => {
      const b = byCategory[e.category] = byCategory[e.category] || { expected: 0, caught: 0 };
      b.expected++;
      if (!r.missed.some((m) => m.index === i)) b.caught++;
    });
  }
  const run = { at: new Date().toISOString(), budget, trial: trialIds.length > 0, lessons: trialIds, results, totals, byCategory };
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    fs.appendFileSync(HISTORY_FILE(), JSON.stringify(run) + '\n');
  } catch {}
  return run;
}

export function printScoreboard(run, prev, { verbose = false } = {}) {
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
  console.log(`\nllm-review eval — ${run.at} — budget ${run.budget}${run.trial ? ` — TRIAL of ${run.lessons.join(', ')}` : ''}`);
  console.log('  case                                   caught  classified  high-findings  calls');
  for (const r of run.results) {
    const tag = r.unverified ? 'UNVERIFIED' : r.clean ? `${r.blocking ? 'NOISE' : 'ok'} (control)` : `${r.caught}/${r.expected}`;
    console.log(`  ${r.case.padEnd(38)} ${tag.padEnd(7)} ${String(r.clean ? '—' : `${r.classified}/${r.expected}`).padEnd(11)} ${String(r.blocking).padEnd(14)} ${r.calls}${r.incomplete ? '  (incomplete)' : ''}`);
  }
  console.log('\n  by category:');
  for (const [k, v] of Object.entries(run.byCategory)) {
    const was = prev && prev.byCategory && prev.byCategory[k];
    const delta = was ? `  (was ${pct(was.caught, was.expected)})` : '';
    console.log(`    ${k.padEnd(14)} ${pct(v.caught, v.expected).padStart(4)}  ${v.caught}/${v.expected}${delta}`);
  }
  const t = run.totals;
  console.log(`\n  recall ${pct(t.caught, t.expected)} (${t.caught}/${t.expected}), classified ${pct(t.classified, t.expected)}, noise on controls ${t.noise}, ${t.calls} provider call(s)`);
  if (t.unverified) console.log(`  ${t.unverified} case(s) UNVERIFIED — the review itself failed (quota, auth, timeout); they are excluded from every number above and from --improve`);
  if (verbose) {
    console.log('\n  evidence:');
    for (const r of run.results) for (const e of r.evidence || []) console.log(`    ${r.case} [${e.category}] ← ${e.finding}`);
  }
  const missed = run.results.flatMap((r) => r.missed.map((m) => `${r.case} [${m.category}]`));
  if (missed.length) console.log(`  missed: ${missed.join(', ')}\n  next: llm-review --improve   (turns each miss with a lesson into a trialled candidate)`);
}

// A REAL miss becomes a permanent case. The commit's changed files (before and after) plus the file
// where the defect actually was are copied into a case under ~/.config/llm-review/eval-cases, so the
// next eval — and every trial of a lesson — has to catch it.
export function captureMiss({ repo, commit, at, category, note, lesson, force = false }) {
  const [atFile, atLine] = String(at || '').split(':');
  if (!repo || !commit || !atFile || !category) throw new Error('capture needs --repo, --commit, --at <file:line> and --category');
  // Both end up in a path under ~/.config: neither may climb out of it.
  if (!CATEGORIES.includes(category)) throw new Error(`unknown category '${category}' (valid: ${CATEGORIES.join(', ')})`);
  if (path.isAbsolute(atFile) || atFile.split(/[\\/]/).includes('..')) throw new Error(`--at must be a repo-relative path, got '${atFile}'`);
  const sha = g(repo, 'rev-parse', '--verify', `${commit}^{commit}`).stdout.trim();
  if (!sha) throw new Error(`${commit} is not a commit in ${repo}`);
  // A path from git can still hold '..' only if the repository itself is hostile; refuse those too.
  // A root commit has no parent: diff it against the empty tree, so its files are captured too.
  const parent = g(repo, 'rev-parse', '--verify', '--quiet', `${sha}^`).stdout.trim() || '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const files = g(repo, 'diff', '--name-only', parent, sha).stdout.split('\n').filter((f) => f && !f.split('/').includes('..')).slice(0, 40);
  const name = `miss-${sha.slice(0, 8)}-${category}`;
  const dir = path.join(HOME, '.config', 'llm-review', 'eval-cases', name);
  if (fs.existsSync(dir) && !force) throw new Error(`${dir} already exists — pass --force to replace it`);
  fs.rmSync(dir, { recursive: true, force: true });
  const put = (side, rev, f) => {
    const r = g(repo, 'show', `${rev}:${f}`);
    if (r.status !== 0) return false;
    fs.mkdirSync(path.dirname(path.join(dir, side, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, side, f), r.stdout);
    return true;
  };
  const deleted = [];
  for (const f of [...new Set([...files, atFile])]) {
    if (parent !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904') put('base', parent, f);
    if (!put('change', sha, f) && files.includes(f)) deleted.push(f);
  }
  if (deleted.length) fs.writeFileSync(path.join(dir, 'change', '.deleted'), deleted.join('\n') + '\n');
  const words = String(note || '').match(/[A-Za-z_][\w.]{4,}/g) || [];
  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify({
    description: note || `missed ${category} in ${sha.slice(0, 10)}`,
    source: { repo, commit: sha, at },
    expect: [{ category, files: [atFile], line: Number(atLine) || 0, keywords: [...new Set(words)].slice(0, 6), lesson: lesson || '' }],
  }, null, 2) + '\n');
  return { name, dir, files: files.length };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'eval') {
    const only = (opt('--only') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const budget = opt('--budget') || process.env.LLM_REVIEW_BUDGET || 'minimal';
    const cases = loadCases(only);
    if (!cases.length) { console.log('No eval cases found.'); return 2; }
    const calls = cases.length * (CALLS_PER_RUN[budget] || 4);
    if (!rest.includes('--yes')) {
      console.log(`Eval plan: ${cases.length} case(s) at budget '${budget}' — up to ${calls} provider call(s).`);
      for (const c of cases) console.log(`  - ${c.name}${c.clean ? ' (clean control)' : ''}: ${c.description || ''}`);
      console.log('\nNothing has run. Add --yes to spend the calls.');
      return 0;
    }
    const prev = lastEvalRun();
    const run = await runEval({ cases: only, budget });
    printScoreboard(run, prev, { verbose: rest.includes('--verbose') });
    return 0;
  }
  if (cmd === 'capture') {
    const r = captureMiss({ repo: opt('--repo') || process.cwd(), commit: opt('--commit'), at: opt('--at'), category: opt('--category'), note: opt('--note'), lesson: opt('--lesson'), force: rest.includes('--force') });
    console.log(`Captured ${r.name} (${r.files} changed file(s)) at ${r.dir}\nEdit its case.json: tighten "keywords", and write the general "lesson" so --improve can learn it.`);
    return 0;
  }
  console.error('usage: harness.mjs eval [--yes] [--only a,b] [--budget minimal|balanced|thorough] | capture --commit SHA --at file:line --category C [--note ...] [--lesson ...]');
  return 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`llm-review: ${e.message}`); process.exit(2); });
}

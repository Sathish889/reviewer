#!/usr/bin/env node
// llm-review --learn-style : infer the author's conventions from code they have ALREADY written, and
// save them as a style profile.
//
// The point is that a style profile nobody agrees with gets switched off. Rather than asking you to
// pick numbers, this reads what you actually do — the 95th percentile of your line lengths, the
// indentation you use, how long your functions run — and proposes that. Costs no tokens: it is
// arithmetic over files on disk.
//
// Usage: node learn-style.mjs <repoRoot...> [--write] [--json]
//   --write  save to ~/.config/llm-review/style.json (merging, never clobbering your own edits)

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const JSON_ONLY = args.includes('--json');
const roots = args.filter((a) => !a.startsWith('--'));
if (!roots.length) roots.push(process.cwd());

const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|kt|rb|php|cs|swift|scala|sh|bash|zsh|c|h|cpp|hpp|css|scss)$/i;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|target|\.venv|__pycache__|\.next)(\/|$)/;

function walk(dir, acc = [], depth = 0) {
  if (depth > 8 || acc.length > 4000) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (SKIP.test(full)) continue;
    if (e.isDirectory()) walk(full, acc, depth + 1);
    else if (CODE.test(e.name)) acc.push(full);
  }
  return acc;
}

const lens = [];              // every line length, for a percentile
const fileLens = [];          // lines per file
const funcLens = [];          // rough function lengths, by brace depth returning to zero
let tabIndented = 0, spaceIndented = 0;
const indentWidths = new Map();
let trailing = 0, totalLines = 0;
const params = [];

for (const root of roots) {
  for (const f of walk(root)) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (txt.includes('\0')) continue;                      // binary
    const ls = txt.split('\n');
    if (ls.length > 5000) continue;                        // generated or vendored in all but name
    // Minified or bundled output, whatever it is called. A single 200k-character line is not a style
    // choice anyone made, and one such file drags every percentile with it.
    let longest = 0;
    for (const l of ls) if (l.length > longest) longest = l.length;
    if (longest > 2000) continue;
    if (txt.length / Math.max(1, ls.length) > 200) continue;   // mean line length that high means generated
    fileLens.push(ls.length);
    let depth = 0, funcStart = -1;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i];
      totalLines++;
      lens.push(l.length);
      if (/[ \t]+$/.test(l)) trailing++;
      const ind = l.match(/^([ \t]+)\S/);
      if (ind) {
        if (ind[1].includes('\t')) tabIndented++;
        else { spaceIndented++; const w = ind[1].length; if (w > 0 && w <= 8) indentWidths.set(w, (indentWidths.get(w) || 0) + 1); }
      }
      // A crude but honest function-length estimate: from a signature line to the depth returning to 0.
      if (funcStart < 0 && /\b(function|def |func |fn )\b|=>\s*\{|\)\s*\{\s*$/.test(l)) { funcStart = i; depth = 0; }
      if (funcStart >= 0) {
        depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
        if (depth <= 0 && i > funcStart) { funcLens.push(i - funcStart + 1); funcStart = -1; }
      }
      const sig = l.match(/\(([^)]{0,300})\)\s*(\{|=>|:)/);
      if (sig && sig[1].trim()) params.push(sig[1].split(',').length);
    }
  }
}

if (!lens.length) { console.error('learn-style: no source files found under ' + roots.join(', ')); process.exit(1); }

const pct = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))]; };
// Not Math.max(...arr): spreading blows the call stack somewhere around a hundred thousand elements,
// and a large monorepo has millions of lines.
const maxOf = (arr) => { let m = 0; for (const n of arr) if (n > m) m = n; return m; };
// The 95th percentile, rounded up to a round number: a limit set at your longest line is no limit,
// and one set at your median would flag half of what you already wrote.
const roundUp = (n) => [80, 100, 110, 120, 140, 160].find((c) => c >= n) || 160;

const gcdWidth = [...indentWidths.entries()].sort((a, b) => b[1] - a[1])[0];
const profile = {
  maxLineLength: roundUp(pct(lens, 0.95)),
  indent: tabIndented > spaceIndented ? 'tabs' : 'spaces',
  indentWidth: gcdWidth ? gcdWidth[0] : 2,
  maxFunctionLines: Math.max(20, Math.min(120, pct(funcLens.length ? funcLens : [40], 0.9))),
  maxFileLines: Math.max(200, Math.min(1200, pct(fileLens, 0.9))),
  maxParams: Math.max(3, Math.min(8, pct(params.length ? params : [4], 0.95))),
  trailingWhitespace: trailing / Math.max(1, totalLines) > 0.02,
  severity: 'low',
};

if (JSON_ONLY) { console.log(JSON.stringify({ style: profile }, null, 2)); process.exit(0); }

console.log(`Read ${lens.length} lines across ${fileLens.length} files in ${roots.join(', ')}\n`);
console.log('Inferred YOUR style:');
console.log(`  max line length     ${profile.maxLineLength}   (95th percentile of your lines: ${pct(lens, 0.95)}, longest: ${maxOf(lens)})`);
console.log(`  indentation         ${profile.indent} (${profile.indentWidth})`);
console.log(`  max function lines  ${profile.maxFunctionLines}`);
console.log(`  max file lines      ${profile.maxFileLines}`);
console.log(`  max parameters      ${profile.maxParams}`);
console.log(`  trailing whitespace ${profile.trailingWhitespace ? 'tolerated' : 'not allowed'}`);
console.log(`\nStyle findings are reported at '${profile.severity}', so they never block a commit.`);
console.log(`Raise to 'medium' and gate at medium if you want them enforced.`);

if (!WRITE) { console.log('\nRe-run with --write to save to ~/.config/llm-review/style.json'); process.exit(0); }

const dest = path.join(process.env.HOME || '.', '.config', 'llm-review', 'style.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
let existing = {};
try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch {}
// Merge, so anything you set by hand survives being re-learned.
const out = { ...existing, style: { ...profile, ...(existing.style || {}) } };
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`\nSaved to ${dest}`);
console.log('Values you had already set were kept. Edit that file to override anything.');

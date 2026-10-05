// impact.mjs — CHANGE INTELLIGENCE, computed in code before any reviewer is called.
//
// Why this exists: a reviewer was asked to do blast radius ("grep every changed symbol"), a same-class
// sweep, old-vs-new flow, layering and duplication — all inside a 10-tool-call allowance shared with
// three other mandates. On anything larger than a toy diff it ran out after the first two greps, so
// the categories that need the most searching (blast radius, semantic change, architecture) were the
// ones it silently skipped. `git grep` answers "who calls this?" perfectly, in milliseconds, for free.
// So the searching happens here, and the model's budget is spent JUDGING what the search found.
//
// Every function is pure over (sections, a grep function) so the tests can drive it without a repo.
// Nothing here is a verdict on its own except `impactFindings`, which is kept deliberately narrow.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// ---- what counts as a declaration, per language ----------------------------------------------------
// Ordered most-specific first. Each captures the declared NAME in group 1. Methods are the hardest
// case and the noisiest, so the method form refuses control-flow keywords explicitly.
const DECL = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|enum|trait|struct|protocol)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/,
  // Module-level only: an indented `let` is a local, and a local has no callers to break.
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/,
  /^\s+export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*[?!]?)\s*\(/,                                  // python, ruby
  /^\s*def\s+self\.([A-Za-z_]\w*[?!]?)/,                                              // ruby class method
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/,                                // go
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,                    // rust
  /^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/, // kotlin
  // Java / C# / TS class members: modifiers, optional return type, name, '(' — and NOT a keyword.
  /^\s*(?:(?:public|private|protected|static|final|abstract|async|override|readonly|virtual|synchronized|get|set)\s+)+(?:[\w<>[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*\(/,
  /^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/,       // bare TS/JS method
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'else',
  'do', 'try', 'with', 'super', 'this', 'typeof', 'await', 'yield', 'constructor', 'require', 'import']);
// Names too common to grep meaningfully: every file has a `render` or an `init`, so their reference
// counts measure the language, not this change.
const GENERIC = new Set(['main', 'init', 'run', 'get', 'set', 'test', 'setup', 'render', 'update', 'create',
  'handle', 'handler', 'index', 'default', 'value', 'data', 'result', 'error', 'callback', 'next', 'start',
  'stop', 'close', 'open', 'load', 'save', 'build', 'parse', 'format', 'toString', 'toJSON', 'equals',
  'hashCode', 'describe', 'it', 'expect', 'props', 'state', 'options', 'config', 'self', 'cls', 'args']);

export function declName(line) {
  for (const re of DECL) {
    const m = re.exec(line);
    if (m && m[1] && !KEYWORDS.has(m[1])) return m[1];
  }
  return '';
}
const meaningful = (n) => n && n.length >= 3 && !GENERIC.has(n);

// Walk a section's hunks, yielding each line with its kind and its line number on the NEW side
// (removed lines carry the new-side position they were removed at, which is what a reader opens).
// `ctx` is the enclosing declaration: git's hunk header names it when the function starts above the
// hunk, but when it starts INSIDE the hunk (a function at the top of a file) the header is empty, so
// the nearest declaration seen on a context or added line takes over.
function* walk(sec) {
  let newLine = 0, ctx = '', inHunk = false;
  for (const raw of sec.text.split('\n')) {
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
    if (h) { inHunk = true; newLine = Number(h[1]) - 1; ctx = h[2] || ''; yield { kind: 'hunk', text: ctx, line: newLine + 1 }; continue; }
    // Only the file header is '+++'/'---'. Inside a hunk the same bytes are content: a removed
    // `-- comment` line, an added `++i;`.
    if (!inHunk) continue;
    const body = raw.slice(1);
    if (raw.startsWith('-')) { yield { kind: '-', text: body, line: newLine + 1, ctx }; continue; }
    if (!raw.startsWith('+') && !raw.startsWith(' ')) continue;
    newLine++;
    if (declName(body)) ctx = body;
    yield { kind: raw[0], text: body, line: newLine, ctx };
  }
}

// ---- 1. which symbols did this change touch? -----------------------------------------------------
// removed  — declared on a '-' line and not re-declared on any '+' line anywhere in the diff
// added    — declared on a '+' line only
// changed  — declared on both sides but the declaration line differs (signature / modifiers / default)
// body     — not redeclared, but its body changed (git's hunk header names the enclosing function)
export function changedSymbols(sections) {
  const minus = new Map(), plus = new Map(), body = new Map();
  for (const sec of sections) {
    for (const l of walk(sec)) {
      if (l.kind === 'hunk') continue;
      if (l.kind === '-' || l.kind === '+') {
        const n = declName(l.text);
        if (meaningful(n)) {
          const m = l.kind === '-' ? minus : plus;
          if (!m.has(n)) m.set(n, { name: n, file: sec.file, line: l.line, text: l.text.trim() });
        }
        // The enclosing function of a changed line: its behaviour changed even if its signature did not.
        const enc = declName(l.ctx || '');
        if (meaningful(enc) && !body.has(enc)) body.set(enc, { name: enc, file: sec.file, line: l.line });
      }
    }
  }
  const out = [];
  for (const [n, d] of minus) {
    if (!plus.has(n)) out.push({ ...d, kind: 'removed' });
    else if (plus.get(n).text !== d.text) out.push({ ...plus.get(n), kind: 'changed', was: d.text });
  }
  for (const [n, d] of plus) if (!minus.has(n)) out.push({ ...d, kind: 'added' });
  for (const [n, d] of body) if (!minus.has(n) && !plus.has(n)) out.push({ ...d, kind: 'body' });
  // Removed and changed first: those are the ones whose callers can break.
  const rank = { removed: 0, changed: 1, body: 2, added: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// ---- 2. who references them? ---------------------------------------------------------------------
// One `git grep` per symbol, word-matched and fixed-string. `treeish` is a commit for a range review
// (the code as it will be), or '' for the working tree, where untracked files are searched too.
// `budgetMs` bounds the whole measurement, not one search: in a large monorepo forty greps at a second
// each would stall every commit. Past it, searches return nothing and the reviewer searches for itself.
export function makeGrep(repo, treeish, excludes = [], budgetMs = 20000) {
  const started = Date.now();
  const memo = new Map();
  return (name) => {
    if (memo.has(name)) return memo.get(name);
    // null, not []: "could not search" must never render as "nothing references it".
    if (Date.now() - started > budgetMs) return null;
    const res = grepOnce(repo, treeish, excludes, name);
    memo.set(name, res);
    return res;
  };
}
function grepOnce(repo, treeish, excludes, name) {
    const args = ['-C', repo, 'grep', '-n', '-I', '-w', '-F', '--no-color', '-e', name];
    // '' = the working tree (untracked files too), '--cached' = the index a commit would contain,
    // anything else = a commit's tree.
    if (!treeish) args.push('--untracked');
    else args.push(treeish);
    args.push('--', '.', ...excludes);
    const r = spawnSync('git', args, { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024 });
    if (r.status === 1) return [];                       // git grep: 1 = searched, no match
    if (r.status !== 0 || r.error) return null;          // timed out or failed: unknown, not "none"
    if (!r.stdout) return [];
    const refs = [];
    for (const row of r.stdout.split('\n')) {
      if (!row) continue;
      // treeish form is "<sha>:file:line:text"; worktree form is "file:line:text"
      const s = treeish && treeish !== '--cached' && row.startsWith(treeish + ':') ? row.slice(treeish.length + 1) : row;
      const m = s.match(/^(.+?):(\d+):(.*)$/);
      if (m) refs.push({ file: m[1], line: Number(m[2]), text: m[3] });
      if (refs.length >= 400) break;          // a symbol referenced 400 times is "everywhere" already
    }
    return refs;
}

const COMMENT = /^\s*(\/\/|#|\*|\/\*|--|;)/;
export function blastRadius(symbols, grep, changedFiles, { maxSymbols = 20, maxRefs = 6 } = {}) {
  const changed = new Set(changedFiles);
  const rows = [];
  for (const s of symbols.slice(0, maxSymbols)) {
    const got = grep(s.name);
    if (got === null) { rows.push({ ...s, unknown: true, outside: 0, inside: 0, declaredElsewhere: false, refs: [], outsideFiles: [] }); continue; }
    const all = got;
    const refs = all.filter((r) => !COMMENT.test(r.text) && declName(r.text) !== s.name);
    const outside = refs.filter((r) => !changed.has(r.file));
    const inside = refs.filter((r) => changed.has(r.file) && !(r.file === s.file && r.line === s.line));
    // Still declared somewhere in the tree? A "removed" symbol that was MOVED is not dangling.
    const declaredElsewhere = all.some((r) => declName(r.text) === s.name && r.file !== s.file);
    rows.push({ ...s, outside: outside.length, inside: inside.length, declaredElsewhere,
      refs: outside.slice(0, maxRefs).map((r) => `${r.file}:${r.line}`),
      outsideFiles: [...new Set(outside.map((r) => r.file))] });
  }
  return rows;
}

// ---- 3. what did the change MEAN? ----------------------------------------------------------------
// A diff shows text; a regression is a change in meaning. These pair each removed line with the added
// line that replaced it and name the kind of meaning that moved — the comparison that flipped, the
// status that changed, the guard that vanished. They are evidence for the reviewer, not findings: a
// changed constant is often exactly the intent. The reviewer decides; it just no longer has to notice.
const tok = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9_$]+/).filter((w) => w.length > 1));
function sim(a, b) {
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return 0;
  let i = 0; for (const t of A) if (B.has(t)) i++;
  return i / (A.size + B.size - i);
}
const OPS = /===|!==|==|!=|<=|>=|=>|&&|\|\||\?\?|(?<![<>=!])[<>](?![=>])/g;
const LITS = /'[^']*'|"[^"]*"|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:true|false|null|undefined|None|True|False|nil)\b/g;
const GUARD = /^\s*(if\b|elif\b|unless\b|guard\b|assert|require\(|throw\b|raise\b|return\b|break\b|continue\b|.*\b(validate|authori[sz]e|authenticate|permission|isAllowed|check[A-Z_]\w*|ensure\w*)\b)/;

export function semanticSignals(sections, { max = 30 } = {}) {
  const out = [];
  const push = (file, line, kind, detail, ctx) => {
    if (out.length < max) out.push({ file, line, kind, detail: detail.slice(0, 160), fn: declName(ctx || '') || '' });
  };
  for (const sec of sections) {
    if (/\.(md|markdown|mdx|txt|rst|adoc|json|lock|ya?ml|toml|csv|svg)$/i.test(sec.file)) continue;
    let minus = [], plus = [];
    const flush = () => {
      const used = new Set();
      // Pairing is quadratic in the block size. A rewritten or regenerated file is not where a single
      // flipped operator hides, and the hook runs synchronously, so a huge block is not paired at all.
      if (minus.length * plus.length > 4000) { minus = []; plus = []; return; }
      for (const m of minus) {
        // Best partner on the + side: the most similar line not already claimed.
        // A line rewritten under the same leading keyword (`return acc` → `return total`) is the same
        // statement changed, however few tokens it shares — pair it rather than call it removed.
        const lead = (t) => (t.trim().match(/^(return|if|elif|throw|raise|await|yield|break|continue)\b/) || [])[1] || '';
        let best = -1, bs = 0;
        plus.forEach((p, i) => {
          if (used.has(i)) return;
          const s = Math.max(sim(m.text, p.text), lead(m.text) && lead(m.text) === lead(p.text) ? 0.41 : 0);
          if (s > bs) { bs = s; best = i; }
        });
        if (best >= 0 && bs >= 0.4) {
          used.add(best);
          const p = plus[best];
          diffMeaning(sec.file, m, p, push);
        } else if (GUARD.test(m.text) && m.text.trim().length > 3 && !IMPORT.test(m.text)) {
          push(sec.file, m.line, 'guard-removed', `removed: ${m.text.trim()}`, m.ctx);
        }
      }
      plus.forEach((p, i) => {
        if (used.has(i)) return;
        if (!/^\s*(return|throw|raise)\b/.test(p.text) || !/\bif\b|\?/.test(plus.map((x) => x.text).join(' '))) return;
        // A NEW branch that returns a status the function already returned elsewhere is the shape of
        // the worst semantic regression there is: every caller that acts on that status now acts on the
        // new situation too.
        const status = p.text.match(/\b[A-Z][A-Za-z0-9]*\.[A-Z][A-Z0-9_]{2,}\b|['"][A-Z][A-Z0-9_]{2,}['"]/);
        push(sec.file, p.line, status ? 'status-returned-on-new-path' : 'early-exit-added', `added: ${p.text.trim()}`, p.ctx);
      });
      minus = []; plus = [];
    };
    for (const l of walk(sec)) {
      if (l.kind === '-') { if (plus.length) flush(); minus.push(l); }
      else if (l.kind === '+') plus.push(l);
      else flush();
    }
    flush();
  }
  return out;
}
function diffMeaning(file, m, p, push) {
  const a = m.text, b = p.text;
  const opsA = (a.match(OPS) || []).join(' '), opsB = (b.match(OPS) || []).join(' ');
  if (opsA !== opsB && (opsA || opsB)) push(file, p.line, 'operator-changed', `${opsA || '∅'} → ${opsB || '∅'} in: ${b.trim()}`, p.ctx);
  const negA = (a.match(/(^|[^!=])!(?!=)|\bnot\s/g) || []).length, negB = (b.match(/(^|[^!=])!(?!=)|\bnot\s/g) || []).length;
  if (negA !== negB) push(file, p.line, 'negation-changed', `${a.trim()} → ${b.trim()}`, p.ctx);
  // Literals AND enum-style members: `Status.SCHEDULED` → `Status.SUCCESS` changes the value exactly as
  // much as 'SCHEDULED' → 'SUCCESS' does, and is how most code spells a status.
  const vals = (t) => [...(t.match(LITS) || []), ...(t.match(/\b[A-Z][A-Za-z0-9]*\.[A-Z][A-Z0-9_]+\b/g) || [])];
  const litA = vals(a), litB = vals(b);
  let valueSignal = false;
  if (litA.join('|') !== litB.join('|') && (litA.length || litB.length)) {
    const gone = litA.filter((x) => !litB.includes(x)), came = litB.filter((x) => !litA.includes(x));
    if (gone.length || came.length) {
      const kind = /^\s*return\b/.test(b) ? 'return-value-changed' : /\b(status|state|code|type|kind|mode|role)\b/i.test(b) ? 'status-value-changed' : 'constant-changed';
      push(file, p.line, kind, `${gone.join(', ') || '∅'} → ${came.join(', ') || '∅'} in: ${b.trim()}`, p.ctx);
      valueSignal = true;
    }
  }
  // Any other change to WHAT a return statement returns is still a change to the function's contract —
  // but a renamed local (`return acc` → `return total`) is not, so a single-token return is skipped.
  if (!valueSignal && /^\s*return\b/.test(a) && /^\s*return\b/.test(b) && a.replace(/\s+/g, '') !== b.replace(/\s+/g, '') && tok(a).size > 2) {
    push(file, p.line, 'return-value-changed', `${a.trim()} → ${b.trim()}`, p.ctx);
  }
  if (/\bawait\b/.test(a) !== /\bawait\b/.test(b)) push(file, p.line, /\bawait\b/.test(a) ? 'await-removed' : 'await-added', b.trim(), p.ctx);
  // A default parameter value is a contract every caller that omits the argument depends on.
  const defA = a.match(/(\w+)\s*(?::[^=,)]+)?=\s*([^,)]+)/), defB = b.match(/(\w+)\s*(?::[^=,)]+)?=\s*([^,)]+)/);
  if (declName(a) && defA && defB && defA[1] === defB[1] && defA[2].trim() !== defB[2].trim())
    push(file, p.line, 'default-changed', `${defA[1]}: ${defA[2].trim()} → ${defB[2].trim()}`, p.ctx);
}

// Who ACTS on a value a semantic signal names? A status's meaning changing matters through the code that
// branches on it, which is often nowhere near the function that returns it (a worker on the far side of
// an event). Grep each status-like value and attach its references outside the diff.
const VALUE = /\b[A-Z][A-Za-z0-9]*\.[A-Z][A-Z0-9_]{2,}\b|['"]([A-Z][A-Z0-9_]{2,})['"]/g;
export function valueConsumers(semantic, grep, changedFiles, { maxValues = 8, maxRefs = 6 } = {}) {
  const changed = new Set(changedFiles);
  const seen = new Map();
  let n = 0;
  for (const s of semantic) {
    if (!/return-value|status-value|status-returned|constant-changed/.test(s.kind)) continue;
    const vals = [...String(s.detail).matchAll(VALUE)].map((m) => m[1] || m[0]);
    const refs = [];
    for (const v of [...new Set(vals)]) {
      if (!seen.has(v)) {
        if (n++ >= maxValues) break;
        seen.set(v, (grep(v) || []).filter((r) => !changed.has(r.file) && !COMMENT.test(r.text)).map((r) => `${r.file}:${r.line}`));
      }
      for (const r of seen.get(v)) if (!refs.includes(`${v} @ ${r}`)) refs.push(`${v} @ ${r}`);
    }
    if (refs.length) s.consumers = refs.slice(0, maxRefs);
  }
  return semantic;
}

// ---- 4. architecture & code-quality signals ------------------------------------------------------
const IMPORT = /^\s*(?:import\s.*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|(?:const|let|var)\s+.*?=\s*require\(\s*['"]([^'"]+)['"]\s*\)|from\s+([\w.]+)\s+import\b|import\s+([\w.]+)\s*$|require\s+['"]([^'"]+)['"]|use\s+([\w:]+)\s*;)/;
const DATA_LAYER = /^(pg|mysql2?|mongodb|mongoose|@prisma\/client|prisma|typeorm|sequelize|knex|ioredis|redis|sqlite3|better-sqlite3|drizzle-orm|sqlalchemy|psycopg2?|pymongo|django\.db|database\/sql|gorm\.io|aws-sdk|@aws-sdk\/client-(dynamodb|s3|sqs))\b/;
const UI_OR_EDGE = /(^|\/)(components?|views?|pages?|ui|screens?|widgets?|templates?|controllers?|routes?|handlers?|resolvers?)\//i;

export function architectureSignals(sections, readFile) {
  const out = [];
  for (const sec of sections) {
    const added = [];
    for (const l of walk(sec)) {
      if (l.kind !== '+') continue;
      const m = IMPORT.exec(l.text);
      if (!m) continue;
      const mod = m.slice(1).find(Boolean);
      if (mod) added.push({ mod, line: l.line });
    }
    for (const { mod, line } of added) {
      if (UI_OR_EDGE.test(sec.file) && DATA_LAYER.test(mod))
        out.push({ file: sec.file, line, kind: 'layer-skip', detail: `${sec.file} (UI/edge layer) now imports the data/driver module '${mod}' directly` });
      // A NEW relative import closes a cycle when the target already imports this file back.
      if (mod.startsWith('.') && readFile) {
        const dir = path.posix.dirname(sec.file);
        const target = path.posix.normalize(path.posix.join(dir, mod));
        const self = sec.file.replace(/\.[^./]+$/, '');
        for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js']) {
          const body = readFile(target + ext);
          if (body == null) continue;
          const back = path.posix.relative(path.posix.dirname(target + ext), self);
          const backRe = new RegExp(`['"](\\./)?${back.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[a-z]+)?['"]`);
          if (backRe.test(body)) out.push({ file: sec.file, line, kind: 'import-cycle', detail: `${sec.file} → ${target + ext} → ${sec.file}` });
          break;
        }
      }
    }
    if (added.length >= 8) out.push({ file: sec.file, line: added[0].line, kind: 'fan-out', detail: `${added.length} new imports in one file — is it taking on several jobs?` });
  }
  return out;
}

// Long functions, and added lines that already exist verbatim elsewhere (copy-paste of logic the repo
// already has). The duplicate check greps for the most distinctive added lines only, so it stays cheap.
export function qualitySignals(sections, grep, style = {}) {
  const out = [];
  const maxFn = style.maxFunctionLines || 50;
  const probes = [];
  for (const sec of sections) {
    if (/\.(md|markdown|mdx|txt|rst|json|lock|ya?ml|toml|csv|svg|snap)$/i.test(sec.file) || /(^|\/)(test|tests|__tests__|spec)\//.test(sec.file)) continue;
    // Brace depth bounds a function: without it, every top-level line after a declaration was billed
    // to that declaration. A brace-less language (python) is not measured rather than mis-measured.
    let fn = null, len = 0, deepest = 0, depth = 0, opened = false;
    const close = () => {
      if (fn && opened && len > maxFn) out.push({ file: sec.file, line: fn.line, kind: 'long-function', detail: `${fn.name} adds ${len} lines in one function (limit ${maxFn})` });
      fn = null; len = 0; depth = 0; opened = false;
    };
    const braces = (t) => {
      const code = t.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
      for (const ch of code) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
    };
    for (const l of walk(sec)) {
      if (l.kind === 'hunk') { close(); continue; }
      if (l.kind !== '+') {
        if (l.kind === ' ' && fn) { len++; braces(l.text); if (opened && depth <= 0) close(); }
        continue;
      }
      const n = declName(l.text);
      if (n && (!fn || depth <= 1)) { close(); fn = { name: n, line: l.line }; }
      if (fn) { len++; braces(l.text); if (opened && depth <= 0) close(); }
      const indent = (l.text.match(/^\s*/) || [''])[0].replace(/\t/g, '    ').length;
      if (indent > deepest) deepest = indent;
      const t = l.text.trim();
      if (t.length >= 45 && !IMPORT.test(l.text) && !COMMENT.test(l.text) && !/^['"`].*['"`],?$/.test(t)) probes.push({ file: sec.file, line: l.line, text: t });
    }
    close();
    if (deepest >= 24) out.push({ file: sec.file, line: 0, kind: 'deep-nesting', detail: `added code nests ${Math.floor(deepest / 4)}+ levels deep — guard clauses would flatten it` });
  }
  if (grep) {
    // Longest first: a long identical line is far less likely to be coincidence than a short one.
    const changed = new Set(sections.map((s) => s.file));
    for (const p of probes.sort((a, b) => b.text.length - a.text.length).slice(0, 8)) {
      const hits = (grep(p.text) || []).filter((r) => !changed.has(r.file));
      if (hits.length) out.push({ file: p.file, line: p.line, kind: 'duplicate', detail: `this line already exists in ${hits.slice(0, 3).map((r) => `${r.file}:${r.line}`).join(', ')} — reuse that instead of copying it?` });
    }
  }
  return out;
}

// ---- 5. the one thing certain enough to report on its own ----------------------------------------
// A symbol this change REMOVED, that is not re-declared anywhere, and that files this change did NOT
// touch still reference — and whose referencing file also names the module it came from, so a mere
// namesake elsewhere does not count. Medium, never high: a word match is strong evidence, not proof,
// so it never blocks the default high gate (a gate armed at medium has asked for exactly this).
export function impactFindings(rows, readFile) {
  const out = [];
  for (const r of rows) {
    if (r.kind !== 'removed' || r.declaredElsewhere || !r.outside) continue;
    // The module must be NAMED as an import path or a qualifier: `/status'`, `'./status`, `.status`
    // (python), or `status.` (a Go package). A bare directory word like `lib` appears in every file.
    const stem = path.posix.basename(r.file).replace(/\.[^.]+$/, '');
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = new RegExp(`[/'"\\.]${esc(stem)}(\\.[a-z]+)?['"\\s;]|\\b${esc(stem)}\\.${esc(r.name)}\\b|from\\s+[\\w.]*\\b${esc(stem)}\\s+import`);
    const importers = r.outsideFiles.filter((f) => {
      const body = readFile ? readFile(f) : null;
      return body != null && named.test(body);
    });
    if (!importers.length) continue;
    out.push({ file: r.file, line: r.line, sev: 1, id: 'dangling-reference',
      msg: `[blast-radius] \`${r.name}\` is removed here but still used by ${importers.length} file(s) this change does not touch: ${r.refs.filter((x) => importers.includes(x.replace(/:\d+$/, ''))).slice(0, 4).join(', ') || importers.slice(0, 4).join(', ')}` });
  }
  return out;
}

// ---- rendering for the prompt ---------------------------------------------------------------------
export function renderIntel({ rows, semantic, arch, quality }) {
  const parts = [];
  if (rows.length) {
    parts.push('BLAST RADIUS MAP — every symbol this change declares, removes or alters, and where the rest of the\nrepository references it. Computed with `git grep` before you were called: do NOT spend tool calls\nre-searching these names. Read the call sites that matter and decide whether each still works.');
    for (const r of rows) {
      const what = { removed: 'REMOVED', changed: 'SIGNATURE CHANGED', body: 'BEHAVIOUR CHANGED (body)', added: 'added' }[r.kind];
      if (r.unknown) { parts.push(`  - ${what} \`${r.name}\` (${r.file}:${r.line}) — references NOT MEASURED (search timed out or its budget ran out): search for this one yourself`); continue; }
      const where = r.outside ? `${r.outside} reference(s) in files this diff does NOT touch: ${r.refs.join(', ')}${r.outside > r.refs.length ? ', …' : ''}` : 'no references outside the diff';
      const moved = r.kind === 'removed' && r.declaredElsewhere ? ' (re-declared elsewhere — moved?)' : '';
      const dead = r.kind === 'added' && !r.outside && !r.inside ? ' — nothing references it: dead code, or the caller is missing' : '';
      parts.push(`  - ${what} \`${r.name}\` (${r.file}:${r.line})${moved} — ${where}${dead}${r.was ? `\n      was: ${r.was.slice(0, 120)}` : ''}`);
    }
  }
  if (semantic.length) {
    parts.push('SEMANTIC CHANGE SIGNALS — places where the MEANING moved, not just the text. For each, work out what\na caller of the enclosing function now gets that it did not before, and whether every caller expects that:');
    for (const s of semantic) {
      parts.push(`  - ${s.file}:${s.line} ${s.kind}${s.fn ? ` in ${s.fn}()` : ''}: ${s.detail}`);
      if (s.consumers) parts.push(`      code outside the diff that reads these values: ${s.consumers.join(', ')}`);
    }
  }
  if (arch.length || quality.length) {
    parts.push('ARCHITECTURE & CODE-QUALITY SIGNALS — measured, not judged. Confirm or dismiss each:');
    for (const s of [...arch, ...quality]) parts.push(`  - ${s.file}:${s.line} ${s.kind}: ${s.detail}`);
  }
  return parts.join('\n');
}

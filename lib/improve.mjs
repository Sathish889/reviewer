#!/usr/bin/env node
// improve.mjs — the SELF-IMPROVING half of llm-review.
//
//   agents   the specialist reviewers (lenses) in llm-diff-review.mjs
//   loops    the gap loop inside one review; the eval → lesson → trial loop here, across reviews
//   harness  lib/harness.mjs — seeded cases with known defects, scored per category
//   improve  this file: every MISS the harness measures becomes a candidate lesson, the lesson is
//            TRIALLED against the case it was missed on (and the clean controls), and it is promoted
//            into every future prompt only if it turned the miss into a catch without adding noise.
//
// A lesson is "look for X" guidance and nothing else. Its text comes ONLY from files the user owns —
// a case.json `lesson` they wrote, or `--lessons add` — never from model output and never from a
// reviewed repository, so it sits with missed.md and style.json on the trusted side. The quieting
// filter below is a second line, not the boundary: a lesson that tells a reviewer to skip, ignore,
// downgrade or approve anything is refused when written AND when read, in case the store is edited.
//
//     llm-review --improve            plan the next round (no calls)
//     llm-review --improve --yes      run it: trial candidates against their cases, promote or retire
//     llm-review --lessons            list lessons and their evidence
//     llm-review --lessons add <category> "<look-for text>"
//     llm-review --lessons retire <id> | promote <id>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, lastEvalRun } from './shared.mjs';

const HOME = process.env.HOME || '.';
export const LESSONS_FILE = () => process.env.LLM_REVIEW_LESSONS || path.join(HOME, '.config', 'llm-review', 'lessons.json');

// Anything that would make a reviewer report LESS. Matched case-insensitively against the whole text.
// Directive forms only: "a retry that can skip cleanup" is a perfectly good thing to look for.
// A blocklist cannot be complete, which is why it is not the only guard: a lesson is also only ever
// rendered as an item to LOOK FOR, under a heading that says so, and it never touches severity.
const QUIETING = /\b(do\s*n[o']?t|never|no\s+need\s+to|stop|don'?t\s+bother(\s+to)?)\s+(report|flag|mention|check|look|raise|review|bother)|\b(omit|exclude|leave\s+out|remove)\b.{0,40}\b(from\s+(the\s+|your\s+)?(review|report|output|findings|verdict)|findings?\b|warnings?\b)|\b(ignore|skip|suppress|dismiss|drop|disregard|overlook|pass\s+over|waive)\s+(this|these|those|it|them|any|all|every|findings?|issues?|warnings?|problems?|reports?|the\b|anything|\w+\s+(findings?|issues?|about))|\bdowngrade|\blower\s+(the\s+|its\s+)?severity|\btreat\s+\S+(\s+\S+){0,3}\s+as\s+(low|safe|clean|fine|acceptable|ok|expected|intended)|\bis\s+(always\s+)?(acceptable|intended|expected|fine|safe)\b|\b(report|output|answer|say|mark)\s+["'`]?clean\b|\bapprove\b|\bfalse\s+positive|\bnot\s+(a\s+)?(bug|finding|issue|problem)|\bnon-?issues?\b|\bavoid\s+(flagging|reporting|raising|mentioning)|\bfocus\s+only\s+on|\bonly\s+(report|flag)\b/i;
export function lessonIsSafe(text) {
  const t = String(text || '').trim();
  return t.length >= 12 && t.length <= 400 && !QUIETING.test(t);
}

function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(LESSONS_FILE(), 'utf8'));
    return Array.isArray(j.lessons) ? j : { lessons: [] };
  } catch { return { lessons: [] }; }
}
function writeStore(store) {
  fs.mkdirSync(path.dirname(LESSONS_FILE()), { recursive: true });
  fs.writeFileSync(LESSONS_FILE(), JSON.stringify(store, null, 2) + '\n');
}

// What the engine injects: promoted lessons, plus any candidate named in LLM_REVIEW_LESSON_TRIAL (that
// is how a trial run tests a lesson without promoting it first). Bounded, because it rides in every call.
export function loadLessons() {
  const trial = new Set((process.env.LLM_REVIEW_LESSON_TRIAL || '').split(',').map((x) => x.trim()).filter(Boolean));
  return readStore().lessons
    .filter((l) => (l.status === 'promoted' || trial.has(l.id)) && CATEGORIES.includes(l.category) && lessonIsSafe(l.text))
    .sort((a, b) => (b.caught || 0) - (a.caught || 0))
    .slice(0, 20);
}
export function renderLessons(lessons) {
  if (!lessons.length) return '';
  let body = '';
  for (const l of lessons) {
    const line = `  - [${l.category}] ${l.text}\n`;
    if (body.length + line.length > 3000) break;
    body += line;
  }
  return `
LESSONS LEARNED — defect classes this reviewer has MISSED before and has since been measured catching.
Each is a thing to look for, in the category named. Check every one that could apply to this change:
${body}`;
}

export function addLesson({ category, text, source, status = 'candidate', caseName = '' }) {
  if (!CATEGORIES.includes(category)) throw new Error(`unknown category '${category}' (valid: ${CATEGORIES.join(', ')})`);
  if (!lessonIsSafe(text)) throw new Error('refused: a lesson must say what to LOOK FOR (12-400 chars) and may not tell the reviewer to ignore, skip, downgrade or approve anything');
  const store = readStore();
  const norm = text.trim().toLowerCase();
  const dup = store.lessons.find((l) => l.text.trim().toLowerCase() === norm);
  if (dup) {
    // A person adding a lesson by hand outranks an earlier trial: say what actually happened to it.
    if (status === 'promoted' && dup.status !== 'promoted') { dup.status = 'promoted'; dup.source = source || dup.source; writeStore(store); }
    return dup;
  }
  const l = { id: 'L-' + crypto.createHash('sha1').update(category + norm).digest('hex').slice(0, 8), category, text: text.trim(),
    source: source || 'manual', case: caseName, status, created: new Date().toISOString(), trials: [] };
  store.lessons.push(l);
  writeStore(store);
  return l;
}
export function setStatus(id, status, trial) {
  const store = readStore();
  const l = store.lessons.find((x) => x.id === id);
  if (!l) throw new Error(`no lesson ${id}`);
  l.status = status;
  if (trial) { l.trials = [...(l.trials || []), trial].slice(-10); if (trial.caught) l.caught = (l.caught || 0) + 1; }
  writeStore(store);
  return l;
}

// ---- the improvement round -----------------------------------------------------------------------
// 1. Read the most recent eval run from history. Every expectation it did not catch is a MISS.
// 2. A miss whose case carries a `lesson` (the general class, written when the case was made) gets
//    that lesson as a candidate. A miss with none is reported: a human writes the class once, because
//    a lesson generalised wrongly from one instance teaches the reviewer the instance, not the class.
// 3. Each candidate is trialled: its own case plus every clean control, with the candidate injected.
//    PROMOTE when its case is now caught AND no control gained a blocking finding; otherwise RETIRE.
export async function improve({ yes = false, runEval }) {
  const ev = lastEvalRun();
  if (!ev) { console.log('No eval run on record yet. Run `llm-review --eval --yes` first — the improvement loop starts from measured misses.'); return 0; }
  const store = readStore();
  console.log(`Last eval: ${ev.at} — ${ev.totals.caught}/${ev.totals.expected} expectations caught (budget ${ev.budget}).`);
  if (ev.totals.unverified) console.log(`  (${ev.totals.unverified} case(s) were UNVERIFIED and are not learned from)`);
  const misses = ev.results.filter((r) => !r.clean && !r.unverified && r.missed.length);
  if (!misses.length) { console.log('Nothing was missed. Nothing to learn this round.'); return 0; }

  // One candidate per distinct lesson text; a lesson shared by several missed cases is trialled on all.
  const plan = new Map();
  for (const r of misses) {
    for (const m of r.missed) {
      if (!m.lesson) { console.log(`  - ${r.case}: missed ${m.category} — case has no "lesson" text; write the general class into its case.json to make it learnable`); continue; }
      const key = m.lesson.trim().toLowerCase();
      const existing = store.lessons.find((l) => l.text.trim().toLowerCase() === key);
      if (existing && existing.status === 'retired') { console.log(`  - ${r.case}: lesson ${existing.id} was already trialled and retired — not retrying it`); continue; }
      if (existing && existing.status === 'promoted') { console.log(`  - ${r.case}: lesson ${existing.id} is promoted and it was STILL missed — the case needs a sharper lesson`); continue; }
      const p = plan.get(key) || { category: m.category, lesson: m.lesson, cases: [] };
      if (!p.cases.includes(r.case)) p.cases.push(r.case);
      plan.set(key, p);
    }
  }
  if (!plan.size) return 0;
  const controls = ev.results.filter((r) => r.clean && !r.unverified).map((r) => r.case);
  const runs = [...plan.values()].reduce((a, p) => a + p.cases.length + controls.length, 0);
  console.log(`\nPlan: trial ${plan.size} candidate lesson(s), EACH on its own, against its case(s) and ${controls.length} clean control(s).`);
  for (const p of plan.values()) console.log(`  + [${p.category}] ${p.lesson}  (from ${p.cases.join(', ')})`);
  if (!yes) { console.log(`\nThis costs real review calls — ${runs} review run(s) at budget '${ev.budget}'. Re-run with --yes to spend them.`); return 0; }

  // Each candidate alone: trialled together, one noisy candidate retired all of them, and a catch was
  // credited to whichever lesson happened to be listed first.
  const baseline = Object.fromEntries(ev.results.map((r) => [r.case, r]));
  for (const p of plan.values()) {
    const l = addLesson({ category: p.category, text: p.lesson, source: `eval:${p.cases[0]}`, caseName: p.cases.join(',') });
    const trial = await runEval({ cases: [...p.cases, ...controls], budget: ev.budget, trialIds: [l.id] });
    const by = Object.fromEntries(trial.results.map((r) => [r.case, r]));
    // A trial that could not run decides nothing: the lesson stays a candidate for the next round.
    if ([...p.cases, ...controls].some((c) => !by[c] || by[c].unverified)) {
      console.log(`  pending  ${l.id} [${p.category}] — part of its trial could not run (provider error); it stays a candidate`);
      continue;
    }
    const caught = p.cases.every((c) => !by[c].missed.some((m) => m.category === p.category));
    const noise = controls.some((c) => by[c].blocking > ((baseline[c] || {}).blocking || 0));
    const verdict = caught && !noise ? 'promoted' : 'retired';
    setStatus(l.id, verdict, { at: trial.at, cases: p.cases, caught, controlNoise: noise });
    console.log(`  ${verdict === 'promoted' ? 'PROMOTED' : 'retired '} ${l.id} [${p.category}] — ${caught ? 'its miss is now caught' : 'still missed'}${noise ? ', but a clean control gained a blocking finding' : ''}`);
  }
  return 0;
}

// ---- CLI -----------------------------------------------------------------------------------------
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'lessons') {
    const [sub, a, ...b] = rest;
    if (sub === 'add') { const l = addLesson({ category: a, text: b.join(' '), source: 'manual', status: 'promoted' }); console.log(`added ${l.id} [${l.category}] (promoted)`); return 0; }
    if (sub === 'retire' || sub === 'promote') { const l = setStatus(a, sub === 'retire' ? 'retired' : 'promoted'); console.log(`${l.id} → ${l.status}`); return 0; }
    const store = readStore();
    if (!store.lessons.length) { console.log(`No lessons yet (${LESSONS_FILE()}).`); return 0; }
    for (const l of store.lessons) console.log(`${l.id}  ${l.status.padEnd(9)} [${l.category}] ${l.text}${l.case ? `  (case: ${l.case})` : ''}${l.caught ? `  caught x${l.caught}` : ''}`);
    return 0;
  }
  if (cmd === 'run') {
    const { runEval } = await import('./harness.mjs');
    return improve({ yes: rest.includes('--yes'), runEval });
  }
  console.error('usage: improve.mjs run [--yes] | lessons [add <category> <text> | retire <id> | promote <id>]');
  return 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`llm-review: ${e.message}`); process.exit(2); });
}

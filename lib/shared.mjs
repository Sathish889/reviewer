// shared.mjs — the few facts the engine, the harness and the lesson loop must agree on. Kept in one
// place because two copies of a category list drift, and a category one side does not know is either
// refused (a lesson) or silently dropped (a finding).

import fs from 'node:fs';
import path from 'node:path';

export const CATEGORIES = ['bug', 'semantic', 'blast-radius', 'architecture', 'code-quality', 'security', 'qa', 'performance', 'style'];

export const STATE_DIR = () => process.env.LLM_REVIEW_STATE || path.join(process.env.HOME || '.', '.local', 'state', 'llm-review');
export const HISTORY_FILE = () => path.join(STATE_DIR(), 'eval-history.jsonl');

// The most recent eval run that was a real measurement — not a lesson trial, which measures a variant.
export function lastEvalRun() {
  try {
    const rows = fs.readFileSync(HISTORY_FILE(), 'utf8').trim().split('\n').filter(Boolean);
    for (let i = rows.length - 1; i >= 0; i--) { const r = JSON.parse(rows[i]); if (!r.trial) return r; }
  } catch {}
  return null;
}

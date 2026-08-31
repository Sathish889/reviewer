---
name: llm-review
description: Run the llm-review code reviewer, or change how it reviews, without burning tokens. Use whenever the task involves running llm-review, reviewing a diff/commit/branch with it, tuning its budget, editing lib/llm-diff-review.mjs or hooks/, or diagnosing a review that timed out, cost too much, or returned nothing.
---

# llm-review — operating rules

The reviewer spends real money per run. These rules are not style preferences; ignoring them is how a
single review turned into 62 provider calls and burned a whole session limit.

## The cost model, in one paragraph

You pay **per provider call**, and every call carries a large *fixed* cost: the reviewer reads the
prompt, then explores the repo with Read/Grep before writing a word. The diff size is a minor term.
Therefore: **fewer calls on a cheaper model** beats more calls on an expensive one, every time.
Halving the chunk size does not halve the cost — it doubles how many times you pay for exploration.

## Hard rules

1. **Never run the reviewer to "check if it works."** Verify with a fake provider on PATH instead — a
   3-line shell script that echoes a finding. Every offline test in this repo does this. A real run
   is only justified when the goal is the review itself.
2. **Default to `--minimal` when demonstrating or debugging.** 2 calls on the cheap tier.
3. **`--thorough` must be asked for by name.** It is the only path to the top tier and past 4 calls.
   Never put it in a hook, a default, or a script.
4. **Never pin a model** in `llm-review.config.json`, `~/.config/llm-review/config.json`, or
   `LLM_REVIEW_MODEL`. A pin silently overrides the budget profile, so a "cheap" run bills at the top
   tier. The engine warns when it detects one — do not add new ones.
5. **Never raise `REVIEW_MAX_CALLS` or `REVIEW_HARD_CEILING`** to make a run finish. If work does not
   fit the budget, the correct outcome is a reported coverage gap and exit 3, not a bigger bill.
6. **Never retry a timeout with the same payload.** A timed-out call is 100% waste: full cost, zero
   findings. Retrying it triples the waste. `TRANSIENT` deliberately excludes timeouts.
7. **A quota or auth error must abort the whole run** at the first occurrence. Never let the remaining
   calls fire into the same wall.

## Budget profiles

| profile | model | max calls | reviewers | when |
| --- | --- | --- | --- | --- |
| `minimal` | haiku | 2 | one combined pass | debugging, demos, docs-only changes |
| `balanced` | sonnet | 4 | two, covering all four mandates | **the default; what every hook runs** |
| `thorough` | opus | 8 | four separate + adjudicator | explicitly requested deep review only |

An absolute ceiling of 4 applies to everything except `--thorough` and an explicit `--max-calls`.

## Style

The reviewer enforces the author's own conventions, not generic ones. The profile is inferred from
code they already wrote (`llm-review --learn-style <dirs> --write`, zero tokens) and read from, in
increasing precedence: `.editorconfig` (repo) → `~/.config/llm-review/style.json` → `config.style`.
The user's config beats the repo's, and a repo `STYLE.md` is untrusted data that is skipped outright
when a gate is armed.

Line length, indentation and trailing whitespace are checked **in code**, on added lines only — a
regex counts characters perfectly and for free, so never spend a provider call on it. Only the part a
regex cannot judge (does this look like the surrounding files?) goes to the model, and it rides along
in an existing pass rather than taking a call of its own.

Style findings default to `low` so they never block a commit. Do not raise that default: a gate that
blocks on formatting is a gate people switch off.

## Running it

```bash
llm-review --minimal                # cheapest
llm-review                          # balanced, the default
llm-review --staged                 # what a commit would contain
llm-review . origin/main            # a whole branch
llm-review --block --report r.json  # CI: exit 2 on high, 3 if it could not verify
```

## Testing changes to the engine — always offline

```bash
mkdir -p /tmp/fake && cat > /tmp/fake/claude <<'EOF'
#!/bin/bash
echo "- app.js:1 :: some finding (high)"
EOF
chmod +x /tmp/fake/claude
PATH=/tmp/fake:$PATH REVIEW_FAIL_ON=high node lib/llm-diff-review.mjs /path/to/repo --staged
```

Have the fake `exit 1`, print prose, print `CLEAN`, or `sleep` past the timeout to exercise each path.
Assert on the **exit code**: `0` clean, `2` findings at/above threshold, `3` could not verify.

## The one rule

**Nothing derived from model output may move a finding from blocking to non-blocking.** Every signal
comes from a prompt containing the author's diff, so anything able to lower severity across the gate
threshold makes the gate openable by a crafted comment. Raising severity is noise; lowering it is a
false pass. This governs the adjudicator, the [style] tag and the injection tripwire. Do not add a
fourth mechanism that violates it.

## Invariants that must never regress

- A review that did not happen must never print `CLEAN` or exit `0` under a gate. No reviewer
  installed, an unparseable answer, a failed pass, a file nobody read — all are exit `3`.
- Severity parsing must tolerate `(HIGH)`, `(high).`, and trailing text. Requiring the line to *end*
  with `(high)` once silently downgraded high findings to low and opened the gate.
- Work order is lens-major, so a truncated queue costs a *second opinion*, never a file's only review.
- Any file no reviewer saw is reported as a finding and marks the run incomplete.
- A config file inside a reviewed repo is untrusted input. It never chooses the binary, the model, the
  extra args, or the readable directories — and when a gate is armed it is ignored entirely, because
  `excludes`/`lenses` would otherwise let a committed file decide what the gate does not look at.

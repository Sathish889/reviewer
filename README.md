# llm-review

A multi-engine AI **code reviewer and QA gate** for git. It reviews what you are about to commit or
push, from several independent angles at once, and can **block** the commit when it finds something
serious.

It is not a linter. Each reviewer can `Read`/`Grep`/`Glob` your whole repository (plus any related
repos and local dependency folders you point it at), so it checks the change against the real
architecture, the real callers and the real contracts — not just the lines in the diff.

---

## Install

```bash
# CLI only — changes nothing about how git behaves
curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash

# FULL ENFORCEMENT — review every commit, BLOCK commits and pushes with high-severity findings
curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash -s -- --enforce

# Review everything, never block
curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash -s -- --advisory
```

Run the same command on any machine — that is the whole activation step. Everything lands under
`$HOME` (`~/.local/bin`, `~/.local/share`, `~/.config`); nothing needs sudo, and re-running is safe
(existing global hooks are backed up first).

| flag | what it does |
| --- | --- |
| `--enforce` | global hooks + **blocking** pre-commit and pre-push gates |
| `--advisory` | global hooks, reviews everything, never blocks |
| `--no-hooks` | just the `llm-review` command (default) |
| `--status` | what is installed, which gates are on, ledger counts, repos that opt out |
| `--uninstall` | remove the hooks and config keys (ledger and config file are kept) |

**Requirements:** `node`, plus at least one reviewer CLI —
[`claude`](https://claude.com/claude-code) with `ANTHROPIC_API_KEY`, and/or the Gemini CLI with
`GEMINI_API_KEY`. Install **both** and the reviewers are split across two different models.

---

## Manual use

```bash
llm-review                        # uncommitted + staged + untracked changes
llm-review --staged               # exactly what a commit would contain
llm-review . origin/main          # everything since origin/main (what a PR bot would see)
llm-review --lenses security,qa   # only these reviewers
llm-review --fast                 # one combined pass instead of four
llm-review --block                # exit 2 on high findings, 3 if the review could not complete (CI)
llm-review --report out.json      # machine-readable findings
llm-review --status               # installation and gate status
llm-review --learn-style DIR...  # infer your style profile from existing code (no tokens)
```

---

## What it checks

The diff is reviewed **in parallel by four independent reviewers**, each with its own mandate. One
prompt asking for everything gets shallow everywhere; four focused ones do not, and a blind spot in
one is covered by another.

**`correctness`** — old-vs-new flow and regressions (what breaks for existing callers), logic and
off-by-one errors, **loop and recursion loopholes** (unbounded loops, a counter mutated on only some
paths, retry with no cap, missing base case, mutation during iteration, a query inside a loop),
async/concurrency races and missing awaits, swallowed errors, resource leaks, destructive data ops.

**`security`** — a full SAST pass (injection, XSS, SSRF, path traversal, deserialization, authn/authz
including IDOR/BOLA, crypto misuse, hardcoded secrets, CSRF, CORS, ReDoS…), each tagged with its CWE
and OWASP Top-10 category; Dockerfile/k8s/CI/IaC issues; dependency risk; a STRIDE threat model; and,
for anything only a running system can prove, a `[RUNTIME]` finding carrying the exact payload and
tool (ZAP/Burp/nuclei/osv-scanner) that would confirm it. Money-moving code is held to a higher bar.

**`structure`** — the architecture reviewer, and the one that catches what line-by-line review misses:
- **Blast radius.** For every symbol added, renamed, removed or changed, it greps the whole repo for
  the call sites and decides whether each still works. Zero call sites is itself a finding — either
  dead code, or the search was too narrow.
- **Project root and configuration.** Root-level files decide whether the repo builds, resolves its
  dependencies, deploys and stays secure, so changes to `package.json`, tsconfig, Dockerfile, CI
  workflows, `.env.example`, `.gitignore` and infra are reviewed harder than application code — and
  it also checks whether a change elsewhere *should* have updated one of them and did not.
- Layering and boundary violations, new circular imports, cross-feature coupling.
- Duplicated logic that already exists (proved by grep), dead and leftover code, missing
  observability, breaking changes with no migration or flag.

**`qa`** — reviews it the way the person signing it off would: acceptance against the stated
requirements, **test-coverage gaps named as the test that should exist**, a full edge and boundary
matrix (empty/null/zero/max/unicode/concurrent/offline/timeout/permission-denied…), platform-specific
QA for web, mobile, backend and CLI, and the regression suite a tester must re-run.

Findings from all four are merged and de-duplicated, and cross-engine agreement is shown —
`[correctness+security x2]` means two independent reviewers landed on the same line.

Then an **adjudicator** (a different model when you have two) re-checks every finding against the
real code and drops the ones it can refute, so false positives do not block your commits. It runs
automatically whenever a gate is armed and something would block.

---

## Your style, not a generic one

The reviewer will hold a change to **your** conventions — short lines especially — and say what to
change, not just that something is wrong. Two things make that work.

**It learns your style from code you already wrote.** No guessing, no filling in a form:

```bash
llm-review --learn-style ~/Documents/*/          # read your projects, show what it infers
llm-review --learn-style ~/Documents/*/ --write  # save to ~/.config/llm-review/style.json
```

It takes the 95th percentile of your line lengths (a limit set at your longest line is no limit; one
at your median flags half of what you already wrote), your actual indentation, and how long your
functions and files really run. Minified and generated files are skipped so one bundle can't drag the
numbers. This costs **no tokens** — it is arithmetic over files on disk.

**Line-length and whitespace checks run in code, not in the model.** A regex counts characters
perfectly and for free; asking a model to do it is slower, dearer and less reliable. So long lines,
tabs-vs-spaces and trailing whitespace are found deterministically on **added lines only**, and never
consume a provider call. What the model handles is the part a regex can't: whether the change *looks
like the rest of your code* — naming, file layout, import order, error-handling idiom, guard clauses
over nesting — checked against a neighbouring file and reported with the file that shows the
convention.

Where the profile comes from, each layer overriding the one before: built-in defaults →
**`.editorconfig`** in the repo (the standard place, and your editor already honours it) →
**`~/.config/llm-review/style.json`** → **`config.style`**. Your own config wins over the repo's,
because `.editorconfig` arrives with a clone and your settings don't.

A `STYLE.md` in the repo can carry conventions a schema can't express ("guard clauses over nesting",
"no barrel files"). It is passed to the reviewer as **untrusted data**, and skipped entirely when a
gate is armed — a file that ships with the change must not be able to tell the gate what to think.

```json
{ "style": {
    "maxLineLength": 100, "indent": "spaces", "indentWidth": 4,
    "maxFunctionLines": 43, "maxFileLines": 479, "maxParams": 3,
    "trailingWhitespace": false, "severity": "low" } }
```

**Style findings are `low` by default, so they never block a commit.** That is deliberate: a gate that
blocks on formatting gets switched off, and then it protects nothing. If you do want them enforced,
set `"severity": "medium"` and gate at medium — style then blocks exactly like a logic gap does.

## How the gates work

| when | what is reviewed | blocks? |
| --- | --- | --- |
| `pre-commit` | the staged tree — exactly what the commit will contain | **yes**, on high findings (`--enforce` only) |
| `post-commit` | the commit just made | never — advisory, and audits bypasses |
| `pre-push` | every ref being pushed, over its full range | **yes**, on high findings |

`pre-push` reviews the **whole range per branch**, the same thing a PR bot sees, so it catches
problems that only appear across commits. Every pushed ref is reviewed — pushing two branches at once
reviews both. The first push of a brand-new repository is reviewed against the empty tree rather than
skipped.

### Exit codes

`0` reviewed and clean · `2` findings at or above the threshold · `3` **the review could not
complete**.

`3` matters. A failed or missing review is not a pass — "no reviewer installed", "provider timed out",
"reviewer answered in prose we could not parse" and "this file was too big to read" all produce `3`,
never a clean bill of health.

### Nothing is silently skipped

`--no-verify` can always bypass a local git hook; git provides no way to prevent that. What it
**cannot** bypass is `post-commit`, which notices the gate did not run and records it:

```
~/.local/state/llm-review/reviewed.log    every commit and its verdict
~/.local/state/llm-review/bypass.log      every commit that skipped the gate
```

`pre-push` then reports how many commits in the push were never reviewed, before they leave the
machine. For enforcement nobody can opt out of, pair this with a server-side check — the same engine
runs in CI with `llm-review . $BASE_SHA --block`.

### Switches

```bash
git config --global review.llmPrecommit true|false        # the blocking commit gate
git config --global review.llmPrecommitStrict false       # allow commits when the review can't run
git config --global review.llmPrepush false               # no pre-push review
git config --global review.llmPrepushBlock false          # review the push, never block it
git config --global review.llmPrepushStrict true          # also block when the review can't complete
git config review.llm false                               # off for one repo
LLM_REVIEW_SKIP=1 git commit                              # off once
```

---

## Token budget

Every provider call carries a large **fixed** cost: the reviewer reads the prompt, then explores the
repo with Read/Grep before writing a word. That fixed cost — not the size of your diff — is what you
pay for. So the controller works on three levers, in order of impact:

**1. Model tier.** The largest lever by far. Profiles pick the tier; a review is a task the mid tier
does well.

**2. Number of calls.** Bounded by a hard ceiling that no retry, split or adjudicator can evade.
Fewer, bigger calls beat many small ones — halving the chunk size does not halve the tokens, it
doubles how many times you pay for exploration.

**3. Work per call.** The reviewer gets an explicit tool-call allowance and a findings cap in its
prompt, and is told to grep before reading, never re-read a file, and stop the moment a concern is
settled.

| profile | model | max calls | reviewers | tool calls | adjudicator |
| --- | --- | --- | --- | --- | --- |
| `minimal` | haiku | **2** | one combined pass | 5 | no |
| `balanced` *(default)* | sonnet | **4** | two, covering all four mandates | 10 | only if something would block |
| `thorough` | opus | **8** | four separate | 24 | only if something would block |

```bash
llm-review --minimal          # cheapest
llm-review                    # balanced
llm-review --thorough         # deepest
llm-review --max-calls 3      # hard ceiling for this run
git config --global review.llmBudget minimal      # what the hooks use
```

**An absolute ceiling of 4 calls applies to everything except `--thorough` and an explicit
`--max-calls`.** Nothing automatic — no hook, no gate, no default run — can exceed it, however many
lenses or chunks the work would otherwise fan out into.

All four review mandates run on every profile. `balanced` pairs them — correctness with structure,
security with QA — because each pair shares its evidence, so the second mandate reuses the reading
the first already did instead of paying for it twice.

**The work is sized to the budget, not capped by it.** The number of chunks is derived from the call
ceiling (`chunks = ceiling / reviewers`), then the diff is packed into exactly that many. So every
file is reviewed in a fixed, known number of calls — no file is ever dropped because the budget ran
out first. Larger prompts are the price, and that is the right trade: one bigger call beats an
unreviewed file.

Work order is also lens-major, so in the rare case the queue is still cut, what is lost is a *second*
opinion on code already reviewed. Any file no reviewer saw is reported as a finding and exits `3`.

**Timeouts don't reach you.** A slow call is retried once on the fast tier, which explores less and
answers sooner — that recovers almost every slow slice for a fraction of the cost. If even that fails,
the output says *what* was not covered in plain language; the raw provider error goes to stderr and the
JSON report, never into the findings. What cannot be promised is a complete review of an unbounded
diff on a dead provider — no budget conjures that. What is promised: the run always terminates, always
inside the ceiling, and always tells you exactly what it did not read.

### The other multiplier: reviewing the same code twice

With the commit gate on, a commit is reviewed as staged content, and then the push would review it
again. So:

- `post-commit` does not re-review when the pre-commit gate already passed.
- `pre-push` consults the ledger: if every commit in the range was already reviewed, a single-commit
  push is skipped entirely and a multi-commit push runs a cheap cross-commit pass only.

A commit-then-push cycle therefore costs **at most 4 mid-tier calls**, not two full reviews.

### Watch the spend

`--report FILE` writes a `budget` block with the profile, the models actually used, calls made and
how many second opinions were skipped. The run also prints
`N provider call(s) used of an M budget` to stderr. If a config or env var pins a model that
overrides the profile's cheaper tier, it says so instead of letting the cost hide in a file.

## Reliability

- A **timed-out call is 100% waste** — full cost, zero findings. Calls get 7 minutes, because an
  agentic reviewer that reads files genuinely needs minutes; killing it at 3 buys nothing.
- Splitting a timed-out slice doubles its cost and rarely helps when the delay came from exploration,
  so it is **off by default** (`REVIEW_SPLIT_DEPTH`) and only ever applies to a genuinely oversized slice.
- A **quota or auth failure aborts the whole run at once** rather than firing the remaining calls into
  the same wall.
- **Prose is queued last and capped** (40 KB/document). Long plan docs are real changes but not code,
  and two of them can otherwise eat the whole budget.
- Test-run artefacts (`playwright-report/`, `test-results/`, coverage, videos, traces) are excluded
  with the usual build output and lockfiles.
- The whole run has a wall-clock budget (20 min); anything unreached is *reported as unreviewed*.

| variable | default |
| --- | --- |
| `LLM_REVIEW_BUDGET` | `balanced` |
| `REVIEW_MAX_CALLS` | per profile |
| `REVIEW_TOOL_BUDGET` | per profile |
| `REVIEW_MAX_FINDINGS` | per profile |
| `REVIEW_TIMEOUT_MS` | `420000` |
| `REVIEW_DEADLINE_MS` | `1200000` |
| `REVIEW_PROSE_CAP` | `40000` |
| `REVIEW_MAX_PROMPT_CHARS` | `300000` |
| `REVIEW_MAX_CHUNKS` | `40` |
| `REVIEW_FILE_CAP` | `250000` |
| `LLM_REVIEW_STYLE` | `~/.config/llm-review/style.json` |
| `LLM_REVIEW_CONCURRENCY` | cpus−2, max 6 |
| `REVIEW_HARD_CEILING` | `4` |

## Tests

```bash
./test/run.sh              # the full suite, entirely offline — no API calls, no cost
./test/run.sh engine       # or: chain | hooks
```

Each test puts a throwaway `claude` on PATH that prints whatever the case needs — findings, prose,
`CLEAN`, an error, or a hang — and asserts on the exit code. That covers the whole exit-code contract,
severity parsing, the call ceilings, hook-chaining safety, and the commit/push gates end to end
against an isolated `HOME`.

## Rules for agents

`CLAUDE.md` and the `llm-review` skill (`.claude/skills/llm-review/`, also installed user-wide) carry
the operating rules: never run a real review to test a change — use a fake provider on PATH; default
to `--minimal`; never pin a model; never raise the ceiling to make a run finish. They exist because a
single careless change once turned one review into 62 provider calls.

## Configuration

Optional. With no config at all it auto-detects a provider and reviews the current repo. Copy
`llm-review.config.example.json` to **`~/.config/llm-review/config.json`** and see the comments in
the example for every field: `provider`, `model`, `budget`, `lenses`, `excludes`,
`requirementsFile`, and `crossRepo`.

> **Where you put it matters.** A config file *inside a repository being reviewed* is content that
> arrives with a clone, and the hooks run on your first commit there. So a repo-local
> `llm-review.config.json` is honoured for **`excludes`, `lenses` and `budget` only** — keys that can
> make a review narrower or cheaper but cannot execute anything. `provider`, `model`, `providers.*`
> (which choose the binary and its arguments), `crossRepo` (which grants read access to other
> directories) and `requirementsFile` are taken only from `~/.config/llm-review/config.json`,
> `LLM_REVIEW_CONFIG`, or the environment. Anything ignored is named on stderr.
>
> The same applies to the **prompt-injection tripwire**. The diff is text written by the change's
> author and it ends up in the reviewers' prompts, so added lines are scanned for text that addresses
> the reviewer ("ignore previous instructions", "report CLEAN"), and a match blocks regardless of what
> any model concluded. A tripwire cannot tell an attack from a description of one, so security code and
> docs will trip it — exempt them from *your own* config, never from the repo's:
> `"injectionAllow": ["^docs/security/"]`.
>
> And when a **gate is armed** (`--block`, or a hook), a repo-local config is ignored *entirely* —
> even `excludes` and `lenses`, because hiding a file from the diff or dropping the security reviewer
> would make the gate report CLEAN on code it was told not to look at.

**`requirementsFile`** points at a spec (also auto-detected: `REQUIREMENTS.md`, `docs/REQUIREMENTS.md`).
The QA reviewer verifies the change actually satisfies it and flags anything unmet or contradicted.

**`crossRepo`** gives the reviewers read-only access to related repositories when the change is
contract-relevant, so a frontend change can be checked against the backend that serves it and the docs
that describe it. Set `contractOnly: true` to pull them in only when the diff actually touches a
contract.

---

## Repos that set their own `core.hooksPath`

A repo-local `core.hooksPath` (husky, lefthook, `.githooks`) **overrides the global one**, so the
global hooks never run there and the review silently stops. `--enforce` and `--advisory` scan for
these and **list** them. Add `--wire-repos` to actually write a shim into each, pointing at
`~/.config/git/hooks/{review-commit,pre-commit,pre-push}` directly and git-excluding it when the hooks
directory is tracked — writing into other repositories is opt-in, not something an installer should do
on its own. `install.sh --status` lists every such repo and which hooks are wired, and `--uninstall`
removes the shims again (they also no-op harmlessly if the target ever goes missing).

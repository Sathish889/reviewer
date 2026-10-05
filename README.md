# llm-review

**An AI code reviewer that runs as a git gate.** It reviews what you are about to commit or push,
from several independent angles at once, and refuses the change when it finds something serious.

Not a linter. Each reviewer reads your actual repository — it greps for every call site of a symbol
you changed, opens the neighbouring file to compare conventions, and checks the change against the
services it talks to. It reports what breaks, not what looks unusual.

---

## Install

One command. Nothing to clone, no repository left on disk to maintain.

```bash
# Review every commit and push, and BLOCK on high-severity findings
curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash -s -- --enforce
```

```bash
# Review everything, never block — good for the first few days
curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash -s -- --advisory
```

```bash
# Just the `llm-review` command, no git hooks, nothing automatic
curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash
```

Run the same line on any machine — that is the whole setup. It downloads a tarball (no `git clone`,
no `.git` directory), installs to `~/.local`, and needs no sudo. Re-running upgrades in place and
keeps your config.

### Install flags

| flag | effect |
| --- | --- |
| `--enforce` | global hooks + **blocking** commit and push gates |
| `--advisory` | global hooks, reviews everything, blocks nothing |
| *(none)* | the `llm-review` CLI only; git behaves exactly as before |
| `--wire-repos` | also wire repos that set their own `core.hooksPath` (husky, lefthook, `.githooks`) |
| `--status` | what is installed, which gates are on, ledger counts |
| `--uninstall` | remove hooks, config keys and shims (ledger and settings are kept) |

### Requirements

- **`node`** 18 or newer
- **at least one reviewer CLI** — [`claude`](https://claude.com/claude-code) (`ANTHROPIC_API_KEY`)
  and/or the Gemini CLI (`GEMINI_API_KEY`)

Install both and the reviewers are split across two different models, so one model's blind spot is
covered by the other.

### Pinning a version

```bash
LLM_REVIEW_REF=v1.2.0 curl -fsSL .../install.sh | bash -s -- --enforce
```

| variable | effect |
| --- | --- |
| `LLM_REVIEW_REF` | tag, branch or commit sha to install |
| `LLM_REVIEW_TARBALL` | download URL — a mirror, proxy, or `file://` path |
| `LLM_REVIEW_REPO` | source repository (the tarball slug is derived from it) |
| `LLM_REVIEW_SLUG` | `owner/name` for the tarball URL, if you need it set independently |

A pinned ref that cannot be fetched **fails** rather than falling back to the default branch — an
install that looks pinned but is not is worse than one that plainly refuses.

> **On trusting the download.** `curl | bash` runs code you have not read, and this download is
> unsigned. The installer treats the payload as untrusted input — it must contain the files it should,
> and it is rejected if it holds a symlink pointing outside itself — but that is damage limitation,
> not provenance. If that trade is not acceptable to you, read `install.sh` first, or pin
> `LLM_REVIEW_REF` to a sha you have reviewed.

---

## Usage

```bash
llm-review                        # uncommitted + staged + untracked changes
llm-review --staged               # exactly what a commit would contain
llm-review . origin/main          # a whole branch, the way a PR bot sees it
llm-review . <base> <tip>         # an explicit range
llm-review --commit <sha>         # ONE commit, read as the code was at that commit
```

`llm-review . <sha>` reviews everything **after** `<sha>` up to HEAD, not the commit itself — and
`llm-review . HEAD` is an empty range. To review a single commit, use `--commit`.

| flag | effect |
| --- | --- |
| `--minimal` | cheapest profile: 2 calls, one combined reviewer |
| `--thorough` | deepest: up to 8 calls, five separate reviewers on the top model tier |
| `--budget NAME` | `minimal` · `balanced` (default) · `thorough` |
| `--max-calls N` | hard ceiling on provider calls for this run |
| `--commit SHA` | review one commit, against its parent, reading that commit's tree |
| `--lenses LIST` | pick reviewers: `correctness,semantic,blast,architecture,quality,security,qa,style` or a group: `change,design,risk,impact` |
| `--no-loop` | skip the gap loop |
| `--eval [--yes]` | score the reviewer on seeded cases, per category (plan only without `--yes`) |
| `--improve [--yes]` | turn measured misses into trialled lessons (plan only without `--yes`) |
| `--lessons` | list / `add` / `retire` / `promote` what the reviewer has learned |
| `--capture-miss …` | turn a real miss into a permanent eval case |
| `--block` | exit `2` on high findings, `3` if the review could not complete — for CI |
| `--report FILE` | write findings and spend as JSON |
| `--learn-style DIR…` | infer your style profile from existing code (costs nothing) |
| `--learn-miss "…"` | record something a downstream reviewer caught, so future reviews check for it |
| `--status` | installation and gate status |

---

## What it reviews

Specialist reviewers work the same diff, each with its own mandate. One prompt asking for everything
gets shallow everywhere, and whatever comes last gets the least attention. Every finding is filed
under a **category**, so the output says what kind of problem it is:

```
- src/gateway/merchant.routes.js:7 :: [semantic] scheduled deactivation now returns SUCCESS, so this
  route runs deactivateStores immediately [change] (high)
```

| category | reviewer | what it hunts |
| --- | --- | --- |
| `bug` | `correctness` | wrong results: logic, off-by-one, loop loopholes, async races, swallowed errors, leaks, destructive data ops |
| `semantic` | `semantic` | same shape, different meaning: a status that now means more, a flipped comparison, a changed default, a dropped await, sync↔async, units |
| `blast-radius` | `blast` | every caller, importer and consumer the change left behind — in files the diff never touched — plus the same-class sweep |
| `architecture` | `architecture` | layering and boundaries, new import cycles, paired files that must agree, project-root config, operability, design fit |
| `code-quality` | `quality` | duplicated logic (named), dead code, unbounded error handling, untestable code, names that lie |
| `security` | `security` | SAST with CWE + OWASP, infra/CI, dependencies, STRIDE, `[RUNTIME]` attack plans, money movement |
| `qa` | `qa` | acceptance, the missing test named, the edge matrix, platform QA, the regression suite |
| `performance` | `correctness` | N+1, O(n²) on a growing path, work repeated per item |
| `style` | `style` | your conventions, checked in code first (see below) |

The `balanced` profile runs three of them in parallel, grouped by the evidence they share:
`change` (bug + semantic + blast radius), `design` (architecture + code quality + style) and `risk`
(security + QA). `thorough` gives correctness, impact, design, security and QA a call each.

### Change intelligence: the searching is done before any reviewer is called

Blast radius and semantic review are mostly *searching*: who calls this, what did they get before,
what do they get now. A metered reviewer with a ten-tool-call budget shared across several mandates
ran out after the first couple of greps, which is why exactly these categories came back empty. So
`lib/impact.mjs` does the searching in code, with `git grep`, for free, and hands every reviewer:

- a **blast radius map**: each symbol the change removes, re-signatures, alters or adds, and every
  reference to it in files the diff does not touch;
- **semantic signals**: each place the meaning moved, such as `'SCHEDULED' → 'SUCCESS'` in a return
  value, `>` → `>=`, a changed default, a removed guard or a dropped `await`;
- **architecture and code-quality signals**: a UI or route file importing a database driver, a new
  import cycle, a long function, an added line that already exists elsewhere.

The reviewer then spends its budget judging those call sites, not finding them. One result is certain
enough to report on its own: an export the change removes that untouched files still import is a
`[blast-radius]` finding at `medium`, so a heuristic alone never blocks a `high` gate.

### The gap loop

A reviewer holding several mandates reports on the one it has most to say about and goes quiet on the
rest. When a core category comes back **empty although the measurements found strong evidence for it**
(a removed symbol still referenced, a changed return value or default, a layer skip, a duplicate), one
focused second pass is asked to settle exactly those categories: report the defect, or answer CLEAN.
It only spends budget the run already has. It never takes the call the adjudicator needs, never runs
after a failed pass, and like everything model-derived it can only add findings. It is on for
`balanced` and `thorough`, and off for `minimal` (whose point is one call) unless `LLM_REVIEW_GAP_LOOP=1`.
Turn it off everywhere with `--no-loop` or `LLM_REVIEW_GAP_LOOP=0`.

Findings from every reviewer are merged and de-duplicated. Cross-reviewer agreement is shown —
`[correctness+security x2]` means two independent reviewers landed on the same line, which is the
strongest confidence signal available.

An **adjudicator** then re-checks every finding against the real code and drops the ones it can
refute, so false positives do not accumulate.

### Reviewing an older commit

In a range or `--commit` review, the working tree is a *different version* of the code: callers have
changed since, files are gone. A reviewer reading the present to judge the past traces today's blast
radius. So when the reviewed tip is not the checked-out HEAD, the reviewer gets a read-only
`git archive` export of that commit instead. There is no checkout, no hooks run, and nothing is written
to the repository. Exports larger than `REVIEW_SNAPSHOT_MAX_MB` (default 300) fall back to the working
tree, with a warning.

---

## Agents → loops → harness → a reviewer that improves itself

```
agents     specialist reviewers, one mandate each           lib/llm-diff-review.mjs
  ↓
loops      gap loop inside a review; eval → lesson → trial    lib/llm-diff-review.mjs, lib/improve.mjs
  ↓
harness    seeded cases with known defects, scored per        lib/harness.mjs, eval/cases/
           category, plus clean controls that measure noise
  ↓
improve    every measured miss → a candidate lesson → trialled → promoted only if it helped
```

**Measure.** `llm-review --eval` lists the cases and what they would cost. `llm-review --eval --yes`
builds each case as a tiny repository, runs the real engine on it, and scores it: did each expected
defect come back in the right file, saying the right thing, under the right category? Clean
**controls** count the other side: any high finding on a correct change is noise. Every run is appended
to `~/.local/state/llm-review/eval-history.jsonl`, and the scoreboard shows each category against the
previous run.

Measured on 2026-10-05 against the 12 bundled cases, old engine vs this one (real calls):

| | caught | filed under the right category | noise on the clean control | calls |
| --- | --- | --- | --- | --- |
| 7 single-defect cases, `minimal` | 7/7 → 7/7 | 0% → 100% | 0 → 0 | 9 → 9 |
| 4 multi-file cases, `minimal` | 5/5 → 5/5 | 0% → 100% | 0 → 0 | 6 → 6 |
| 12-symbol signature change, `balanced` | 1/1 → 1/1 | 0% → 100% | — | 2 → 3 |

These bundled cases are small, and both engines catch their defects once pointed at the code, so they
show classification, not recall. Recall is measured on **your** misses: capture each one (below), and
the next `--eval` holds every later version to it.

**Improve.** `llm-review --improve` reads the last eval. Each miss whose case carries a `lesson` (the
general *class* of defect, written once by a person) becomes a candidate. `--improve --yes` trials it:
the case it was missed on, plus every clean control, with the candidate injected into the prompt.

- The miss is now caught and no control gained a blocking finding: **promoted**. Every future review
  carries it, in its category.
- Anything else: **retired**, and never retried.

**Capture real misses.** When a merge-request bot or a colleague catches something this reviewer did
not, turn it into a permanent case:

```bash
llm-review --capture-miss --commit <sha> --at src/routes/merchant.js:7 --category semantic \
  --note "scheduled deactivation cascades immediately" \
  --lesson "When a function returns an existing status for a new situation, check every caller that branches on it"
```

The commit's files, before and after, land in `~/.config/llm-review/eval-cases/` (your code, so never
in this repository). From then on every eval and every lesson trial must catch it.

**A lesson can only make the reviewer look harder.** A lesson is the one piece of this system whose text
can come from a model, so it lives under the same rule as the adjudicator. A lesson telling the
reviewer to skip, ignore, downgrade, approve or "not report" anything is refused when written and
filtered when read, even if someone edits `lessons.json` by hand.

**Cost.** Each eval case is one real review: up to 2 calls on `minimal` (the default for `--eval`).
Nothing runs without `--yes`, and no hook ever runs an eval.

---

## Making sure nothing new turns up later

The point of reviewing before a commit is that no reviewer downstream finds something afterwards. That
splits into two problems with very different answers, and it is worth being straight about which is
which.

**Deterministic reviewers — solvable completely.** ESLint, `tsc`, SonarQube, CI checks. You do not ask
a model to predict what ESLint will say; you run ESLint.

- **Free built-in checks**, on added lines only, costing no provider call: unresolved
  merge markers, `.only(`/`fdescribe` (CI goes green while running almost none of the suite), leaked
  AWS/Slack/GitHub/Google/Stripe keys and private keys, `debugger` left in, skipped tests. These block
  on their own severity regardless of what any model concluded — a regex that matched is not a
  judgement a reviewer can talk itself out of. The same token inside a markdown file is documentation,
  not a leak — but a *real* credential in a README is still a leak, so the secret checks run on prose
  too while the code checks do not. Vendors' published placeholders (`AKIAIOSFODNN7EXAMPLE` and
  friends) are never treated as live credentials, wherever they appear.

  These are cheap and certain about *what they matched* — but a pattern can still express the wrong
  thing, and four of these originally did: `fit(` matched every scikit-learn `model.fit(X, y)`,
  `=======` matched any comment separator, Laravel's real `dd($var)` was missed, and AWS's own
  documentation placeholder was reported as a leaked key. So there is an escape hatch, and it demands
  a justification:

  ```js
  // llm-review-ignore-file: aws-key — fixtures for the secret-scanner tests
  const k = "AKIA...";                    // whole file, one check

  const k = "AKIA...";  // llm-review-ignore: aws-key — documented sample value
  ```

  **Every honoured suppression is reported on every run**, with its reason — a marker that silences a
  check quietly is indistinguishable from the check not existing. And **a marker with no reason after
  the em-dash is ignored and reported.** Silencing a check is a
  decision someone should have to justify where the next reader sees it, and a suppression that
  explains nothing is indistinguishable from switching the tool off.
- **Preflight** runs the project's *own* checks before spending anything: `npm run lint`,
  `typecheck`, `tsc --noEmit`, `ruff check`, `go vet`, or whatever you list in `config.preflight`. If
  CI would fail, you find out from the same command with the same exit code, now.

  ```bash
  git config review.llmPreflight true        # this repo only — the safe default
  git config --global review.llmPreflight true   # every repo, including ones you clone later
  ```

  **Off by default, deliberately.** These commands come from the repository — running them executes its
  lint config, its plugins, its scripts — so an automatic hook doing it would hand a hostile clone code
  execution. Prefer the **per-repo** form: the global one grants that trust to every repository you
  will ever clone on the machine, which is a much larger promise than "I trust this project".

**Review the same thing the MR bot reviews.** On the second and later pushes, a naive pre-push hook
sees only the commits being added — while the bot on the merge request re-reviews the *whole branch
against its target*, every time. Anything wrong in an earlier push is then invisible locally and
reported remotely on every run, which is what "the bot keeps finding more" usually is. `pre-push`
therefore reviews the full branch by default; the finding cache makes that affordable, because a
re-push only pays for the sections that actually changed.

```bash
git config review.llmPrepushFullBranch false   # review only the newly pushed commits instead
```

**One bug is rarely one bug.** Measured on a real merge request: the identical
attacker-controlled-filename flaw appeared in three sibling components, and each round of review
surfaced one more. So every defect triggers a **same-class sweep** — name the pattern behind it, grep
the whole repository for that pattern including files the diff never touched, and report every
instance at once.

**Know what the project already does.** A hardcoded English string is only a bug if you know the
project is translated; otherwise it reads as ordinary code. i18n directories, Angular, Next.js, Prisma
and Storybook are detected from the filesystem, and `CONTRIBUTING.md` is passed through verbatim.
Paired files — a component's `.ts` and `.html`, a header and its implementation, a migration and its
model — are read together, because a mismatch between them is invisible in either half alone.

**Judgement-based reviewers — not solvable, only shrinkable.** Another model, or a colleague, can
always raise something this one did not. Nobody can promise otherwise.

What can be stopped is the *same* miss happening twice:

```bash
llm-review --learn-miss "PR bot found an N+1 in the serializer; we only checked the query"
```

Every later review is then told to look for that class specifically and to say explicitly when it does
not apply. This is the only training available short of fine-tuning, and it is worth more than it
sounds, because real misses cluster — they are usually a gap in the mandate rather than bad luck. The
record lives in `~/.config/llm-review/missed.md`, in your config rather than the repo: it is the
reviewer's memory, not the project's, and a repo-supplied version would be a way to feed instructions
into every prompt.

## Your code style, not a generic one

Style rules nobody agreed to get switched off, and then they protect nothing. So the profile is
measured from code you already wrote:

```bash
llm-review --learn-style ~/projects/*/           # show what it infers
llm-review --learn-style ~/projects/*/ --write    # save to ~/.config/llm-review/style.json
```

It takes the 95th percentile of your line lengths (a limit at your longest line is no limit; one at
your median flags half of what you already wrote), your real indentation, and how long your functions
and files actually run. Minified and generated files are skipped so one bundle cannot drag the
numbers. Costs **no tokens** — it is arithmetic over files on disk.

**Line length, indentation and trailing whitespace are checked in code, not by a model**, on added
lines only. A regex counts characters perfectly and for free. What the model judges is the part a
regex cannot: whether the change *looks like the rest of your code* — naming, file layout, import
order, error idiom, guard clauses over nesting — compared against a neighbouring file, and it must
name the file that shows the convention. That mandate rides inside an existing pass, so the whole
feature adds **no calls**.

Profile sources, each overriding the one before: built-in defaults → **`.editorconfig`** in the repo →
**`~/.config/llm-review/style.json`** → **`config.style`**. Your config wins over the repo's, because
`.editorconfig` arrives with a clone and your settings do not.

**Style findings are `low` by default and never block a commit.** A gate that blocks on formatting is
a gate people turn off. Set `"severity": "medium"` and gate at medium if you want them enforced.

---

## The gates

| when | what is reviewed | blocks? |
| --- | --- | --- |
| `pre-commit` | the staged tree — exactly what the commit will contain | **yes**, on high findings (`--enforce`) |
| `post-commit` | the commit just made | never — advisory, and audits bypasses |
| `pre-push` | every ref being pushed, over its full range | **yes**, on high findings |

`pre-push` reviews the **whole range per branch** — the same thing a PR bot sees — so it catches
problems that only appear across commits. Every pushed ref is reviewed, and the first push of a new
repository is reviewed against the empty tree rather than skipped.

### Exit codes

`0` reviewed and clean · `2` findings at or above the threshold · `3` **the review could not
complete**.

`3` is the one that matters. A failed or missing review is not a pass: "no reviewer installed",
"provider timed out", "the reviewer answered in prose we could not parse" and "this file was too big
to read" all produce `3`, never a clean bill of health.

### One rule behind all of it

> **Nothing derived from model output may move a finding from blocking to non-blocking.**

Every signal here comes from a prompt containing the author's own diff. If any of them could *lower*
a severity across the gate threshold, the gate would be openable by a crafted comment. Raising a
severity only produces noise; lowering it produces a false clean bill of health. So:

- the **adjudicator** may drop findings below the threshold, never one at or above it — a disputed
  blocking finding is marked and still blocks
- a **`[style]` tag** caps a finding below the threshold, never across it
- the **injection tripwire** blocks regardless of what any model concluded

The cost is that a false-positive high finding blocks and the tool cannot clear it. You are the
appeal mechanism, via a fix or `--no-verify`. That is the right way round.

### Nothing is silently skipped

`--no-verify` can always bypass a local git hook — git provides no way to prevent that. What it
cannot bypass is `post-commit`, which notices the gate did not run and records it:

```
~/.local/state/llm-review/reviewed.log    every commit and its verdict
~/.local/state/llm-review/bypass.log      every commit that skipped the gate
```

`pre-push` then reports how many commits in the push were never reviewed, before they leave the
machine. For enforcement nobody can opt out of, pair this with a server-side check — the same engine
runs in CI as `llm-review . $BASE_SHA --block`.

### Switches

```bash
git config --global review.llmPrecommit true|false      # the blocking commit gate
git config --global review.llmPrecommitStrict false     # allow commits when the review cannot run
git config --global review.llmPrepushBlock false        # review pushes, never block them
git config --global review.llmBudget minimal            # which profile the hooks use
git config review.llm false                             # off for one repo
LLM_REVIEW_SKIP=1 git commit                            # off once
```

---

## Token budget

Every provider call carries a large **fixed** cost: the reviewer reads the prompt, then explores the
repo before writing a word. That fixed cost — not the size of your diff — is what you pay for.

| profile | model | max calls | reviewers | adjudicator |
| --- | --- | --- | --- | --- |
| `minimal` | haiku | **2** | one combined pass | no |
| `balanced` *(default)* | sonnet | **4** | two, covering all four mandates | only if something would block |
| `thorough` | opus | **8** | four separate | only if something would block |

**An absolute ceiling of 4 applies to everything except `--thorough` and an explicit `--max-calls`.**
No hook, gate or default run can exceed it, however many reviewers or chunks the work would fan into.

All four mandates run on every profile. `balanced` pairs them — correctness with structure and style,
security with QA — because each pair shares its evidence, so the second mandate reuses the reading the
first already did instead of paying for it twice.

**The work is sized to the budget, not capped by it.** Chunk count is derived from the ceiling
(`chunks = ceiling ÷ reviewers`) and the diff packed to fit, so no file is dropped because the budget
ran out. Any file no reviewer saw is reported as a finding and exits `3`.

**Nothing is reviewed twice.** A blocked commit gets fixed and re-committed, and without a cache the
next review re-reads every file. Measured on this repository: the same 23-file change was reviewed 8
times for 21 provider calls, and 70% of the file sections were byte-identical between an attempt and
its retry. Findings are now cached per file section, so a retry only pays for what you actually
changed — an identical re-run costs **zero** calls.

The cache key is what makes that sound: it covers the section's exact bytes, the lens, the provider
*and* model, the style profile, and the sorted set of **all** changed paths. That last part matters —
the `structure` reviewer reasons across the whole changed set, so if a file enters or leaves the diff,
nothing is reused. `LLM_REVIEW_NO_CACHE=1` forces a fresh review; entries expire after 30 days.

The key names the model, not the model's behaviour — so if a provider changes what sits behind an
alias like `sonnet`, cached verdicts from the older one are reused until they expire. The TTL is the
bound on that; shorten it with `REVIEW_CACHE_TTL_DAYS`, or clear
`~/.local/state/llm-review/cache/` after a provider update you care about.

**Reviewing the same code twice** is the other multiplier. `post-commit` does not re-review what the
commit gate already passed, and `pre-push` consults the ledger: a single-commit push whose commit is
already reviewed is skipped entirely. A commit-then-push cycle costs **at most 4 mid-tier calls**.

`--report FILE` records the profile, the models actually used, calls made, and how many second
opinions were skipped. If a config pins a model that overrides the profile's cheaper tier, the run
says so instead of letting the cost hide in a file.

---

## Reliability

- A **timed-out call is 100% waste** — full cost, zero findings. Calls get 7 minutes, because an
  agentic reviewer that reads files needs minutes; killing it at 3 buys nothing.
- A slow call is **retried once on the fast tier**, and the first attempt is capped at half the
  remaining budget so that retry can still run.
- A **quota or auth failure aborts the whole run** rather than firing the rest into the same wall.
- **Prose is queued last and capped** (40 KB/document). Long plan documents are real changes but not
  code, and two of them can otherwise eat the whole budget.
- Test artefacts (`playwright-report/`, `test-results/`, coverage, videos, traces) are excluded with
  build output and lockfiles.
- The whole run has a wall-clock budget; anything unreached is *reported as unreviewed*.

---

## Configuration

Optional — with no config it auto-detects a provider and reviews the current repo. Copy
`llm-review.config.example.json` to **`~/.config/llm-review/config.json`**; the example documents
every field.

> **Where you put it matters.** A config file *inside a repository being reviewed* arrives with a
> clone, and the hooks run on your first commit there. So a repo-local `llm-review.config.json` is
> honoured for `excludes`, `lenses` and `budget` only — and **ignored entirely when a gate is
> armed**, because hiding a file from the diff would make the gate report CLEAN on code it was told
> not to look at. `provider`, `model`, `providers.*` (which choose the binary and its arguments),
> `crossRepo` (which grants read access to other directories) and `requirementsFile` come only from
> your own config or the environment.

**`requirementsFile`** points at a spec (also auto-detected: `REQUIREMENTS.md`). The QA reviewer
verifies the change satisfies it and flags anything unmet.

**`crossRepo`** gives the reviewers read-only access to related repositories when the change is
contract-relevant, so a frontend change is checked against the backend that serves it and the docs
that describe it. `contractOnly: true` pulls them in only when the diff actually touches a contract.

---

## Repos that set their own `core.hooksPath`

A repo-local `core.hooksPath` (husky, lefthook, `.githooks`) **overrides the global one**, so the
global hooks never run there. `--wire-repos` writes a shim into each such repo, pointing at
`~/.config/git/hooks/` and git-excluding it when the hooks directory is tracked. Without that flag
they are only listed — writing into other repositories is opt-in, not something an installer should
do on its own. `--uninstall` removes the shims again, and they no-op harmlessly if their target ever
disappears.

---

## Tests

```bash
./test/run.sh              # the full suite, entirely offline — no API calls, no cost
./test/run.sh engine       # or: chain | hooks
```

Each test puts a throwaway `claude` on `PATH` that prints whatever the case needs — findings, prose,
`CLEAN`, an error, or a hang — and asserts on the exit code. That covers the exit-code contract,
severity parsing, the call ceilings, hook-chaining safety, the style checks, and the commit and push
gates end to end against an isolated `HOME`.

## Uninstall

```bash
~/.local/share/llm-review/install.sh --uninstall
```

Removes the hooks, the config keys and any shims. Your review ledger and
`~/.config/llm-review/` are left alone.

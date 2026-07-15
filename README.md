# llm-review

A universal, **AI-backed code reviewer** for any git repo — run it with **either a Claude or a Gemini key**.
Point it at your changes and it studies the **architecture and flow across the services your code depends on**,
then reports *real* problems — bugs, regressions, security holes, data loss, breaking/contract changes,
payment-correctness issues, dead code, and unmet requirements — one finding per line.

It works for **web, mobile, cloud/backend, terminal/CLI, and payments** code alike. It **never edits your
code and never blocks a push** — it's a second pair of eyes on the way out.

```
▶ LLM review of: /path/to/your/repo
llm-diff-review: reviewing with claude (opus)
- src/pay.ts:42 :: refund path swallows the gateway error and returns success — caller treats a failed refund as done (high)
- src/pay.ts:88 :: no idempotency key on capture, so a retried request double-charges (high)
- src/user.ts:​31 :: CWE-89 / A03: SQL injection — req.query.id concatenated into the query (high)
- src/api.ts:​64 :: [RUNTIME] SSRF: fetch(url) from user input — confirm with `nuclei`/ZAP; test payload http://169.254.169.254/ (medium)
- src/pay.ts:​7 :: dead import left after removing the retry helper (low)
```

…or just `CLEAN`.

---

## Providers — bring your own key

The reviewer runs on an **agentic CLI** (one that can read your repo to trace the flow), and reads that CLI's
API key from the environment. Install whichever you have:

| Provider | CLI | Key (env var) | Default model |
|---|---|---|---|
| **Claude** | [`claude`](https://claude.com/claude-code) | `ANTHROPIC_API_KEY` (or an authenticated Claude CLI) | `opus` |
| **Gemini** | [`gemini`](https://github.com/google-gemini/gemini-cli) | `GEMINI_API_KEY` | `gemini-2.5-pro` |

It **auto-detects** `claude`, then `gemini`. Force one, or change the model:

```sh
export LLM_REVIEW_PROVIDER=gemini      # or: claude
export LLM_REVIEW_MODEL=gemini-2.5-pro # optional; otherwise the provider default
```

> Why a CLI and not a raw API call? Tracing the flow into dependent services means *reading files* — the CLIs
> can do that (read-only); a plain HTTP API call cannot. Both CLIs read their key from the environment, so
> anyone can run this with the key they already have.

---

## Requirements

- One provider CLI from the table above, installed and holding a valid key.
- **Node.js** (a modern version) on your `PATH`.
  - Version-manager node (nvm/asdf/volta)? Point the tool at it:
    `export LLM_REVIEW_NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin"`
- **git** (only needed for the one-line install).

If no provider or node is found, the reviewer prints a short skip note and exits cleanly — it never blocks you.

---

## Install

### One-liner (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash
```

Clones the repo into `~/.local/share/llm-review`, puts an `llm-review` command in `~/.local/bin`, and seeds a
(gitignored) config. Re-run any time to update.

### From a clone

```sh
git clone https://github.com/Sathish889/reviewer.git
cd reviewer
./install.sh
```

If `~/.local/bin` isn't on your `PATH`, add it: `export PATH="$HOME/.local/bin:$PATH"`.

Override install locations with `LLM_REVIEW_BIN` (default `~/.local/bin`) and `LLM_REVIEW_HOME`
(default `~/.local/share/llm-review`, where the one-liner clones).

---

## Usage

From inside any git repo:

```sh
llm-review                    # review your current changes
```

"Current changes" means, in order: uncommitted + staged (`git diff HEAD`) → else unpushed commits
(`@{upstream}..HEAD`) → else vs the origin default branch. Or point it explicitly:

```sh
llm-review .            origin/main    # review what you'd push vs origin/main (baseRef...HEAD)
llm-review ~/code/myapp                # review a repo by path
llm-review ~/code                      # a parent folder containing a single git repo also works
```

### As a pre-push hook (optional)

`.git/hooks/pre-push` (make it executable):

```sh
#!/usr/bin/env bash
llm-review "$(git rev-parse --show-toplevel)" \
  "$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || echo origin/main)" || true
```

The trailing `|| true` keeps it **advisory** — it prints findings but never blocks the push.

---

## What it checks

The reviewer works through a deliberate method rather than skimming the diff:

1. **Subject, architecture & dependencies** — where the change sits (UI / API / domain / data / integration /
   infra), and which other modules and services it affects. It follows the change across those boundaries into
   related repos and dependency folders.
2. **Flow, old vs new** — traces callers and callees and compares before/after behavior to catch **regressions**
   and backward-compatibility breaks (the class reviewers miss most).
3. **Comprehensive pass** — every path incl. errors and edges, with coverage tuned to the stack:
   - **Web** (rendering, state, routing, XSS, API consistency) · **Mobile** (lifecycle, threading, offline,
     permissions) · **Backend/Cloud** (authz on every entry point, injection, transactions, idempotency,
     migrations, IAM) · **Terminal/CLI** (args, exit codes, signals, pipes) · **Payments** (amount/currency/
     rounding, idempotent retries, capture/void/refund state, no double-charge, no logged secrets — treated as
     high severity).
4. **Security testing (SAST · risk · posture · runtime test-plan)** — a dedicated pass over every changed
   function, endpoint, and data flow: injection, XSS, SSRF, path traversal, (de)serialization/XXE, auth &
   **authorization incl. IDOR/BOLA**, crypto misuse, hardcoded secrets, sensitive-data exposure, CSRF/CORS,
   ReDoS/DoS, prototype pollution, and IaC/config. It runs a lightweight **STRIDE** threat model, tags each
   finding with its **CWE + OWASP Top-10** category, flags risky dependencies, and — for issues only a running
   app can confirm (**DAST / IAST / pentest / CVE-scan**) — emits a `[RUNTIME]` test-plan with the exact
   payload and tool instead of staying silent.
5. **Requirements** — if you point it at a spec, it verifies the change actually satisfies it and flags gaps
   (see [Requirements](#reviewing-against-requirements)).

It reports contract drift against a source-of-truth repo, cross-service integration breaks, concurrency bugs,
swallowed errors, missing test coverage, and dead code. Findings come ordered most-severe first, and it aims to
leave **nothing** a careful staff engineer or a downstream bot/human would legitimately catch.

---

## How it works

`bin/llm-review` resolves the git repo and hands the diff to `lib/llm-diff-review.mjs`, which builds the review
prompt and runs it through your provider CLI in **read-only** mode (Claude: `--permission-mode plan` with only
`Read`/`Grep`/`Glob`; Gemini: read-only tools, no `--yolo`). It can inspect the codebase to confirm a finding,
but never changes anything. Three things keep it fast and honest on real diffs:

- **Generated files are excluded.** Build output (`dist`, `build`, `.next`, `coverage`, `vendor`),
  `node_modules`, minified files, source maps, and lockfiles are dropped from the diff — plus anything you add
  under `excludes`. Reviewing derived output wastes tokens and drowns the real change.
- **Large diffs are chunked, never silently truncated.** The diff is split per file and reviewed in batches;
  findings are merged, most-severe first. Anything that can't be covered (too many chunks, an oversized file, a
  timed-out chunk) is **reported** as a finding — never dropped quietly.
- **The timeout is a hard wall-clock bound.** The provider runs in its own process group and, on timeout, the
  whole group is killed — so a slow review can never hang past the cap.

---

## Configuration (optional)

Everything works with **no config**. To customize, copy the example (the installer does this for you):

```sh
cp llm-review.config.example.json llm-review.config.json   # gitignored — safe for machine paths
```

| Field | Meaning |
|---|---|
| `provider` | `claude` or `gemini` (default: auto-detect). |
| `model` | Model for the chosen provider (default: the provider's default). |
| `providers` | Per-provider overrides `{ bin, model, extraArgs[] }` — for CLI-version drift. |
| `requirementsFile` | Path (relative to repo) to a spec to review against. |
| `excludes[]` | Extra git pathspecs to drop from the diff. |
| `crossRepo[]` | When the repo path matches `match` (regex), also give read-only access to `related` repos and steer with `hint`. First match wins. |
| `crossRepo[].contractOnly` | Only pull related repos in when the diff looks contract-relevant — keeps unrelated changes fast. |

Lookup order (first hit wins): `$LLM_REVIEW_CONFIG` → `<repo>/llm-review.config.json` →
`<repo>/.llm-review.config.json` → `~/.config/llm-review/config.json`. Your `llm-review.config.json` is
**gitignored** — absolute paths and hints never get committed.

### Cross-repo review

Verify a diff against a **source of truth** or an integrated repo, not just itself: point a docs repo at its
backend, a frontend at its API contracts, a payments service at its ledger — and the reviewer opens those repos
(read-only) to catch contract drift and integration breaks a single-repo diff can't see. See
`llm-review.config.example.json` for worked examples.

### Reviewing against requirements

Give the reviewer the intended behavior and it checks the code actually delivers it:

```sh
LLM_REVIEW_REQUIREMENTS=docs/spec.md llm-review          # a file
LLM_REVIEW_REQUIREMENTS="refunds must be idempotent" llm-review   # inline text
```

Or set `requirementsFile` in the config, or just keep a `REQUIREMENTS.md` in the repo — it's picked up
automatically. Unmet or contradicted requirements become findings.

---

## Tuning (environment variables)

| Var | Default | Effect |
|---|---|---|
| `LLM_REVIEW_PROVIDER` | auto | `claude` or `gemini` |
| `LLM_REVIEW_MODEL`    | provider default | model id |
| `LLM_REVIEW_REQUIREMENTS` | — | requirements file path or inline text |
| `REVIEW_TIMEOUT_MS`   | `300000` (5 min) | hard per-chunk time cap |
| `REVIEW_CHUNK_CHARS`  | `200000` | target max diff chars per review chunk |
| `REVIEW_FILE_CAP`     | `400000` | a single file's diff bigger than this is truncated (with a note) |
| `REVIEW_MAX_CHUNKS`   | `12` | max review chunks; files beyond are reported as "not reviewed" |
| `LLM_REVIEW_NODE_BIN` | — | prepend this dir to `PATH` (for nvm/asdf/volta node) |
| `LLM_REVIEW_BIN_CMD`  | — | override the provider command name |
| `LLM_REVIEW_CONFIG`   | — | explicit path to a config file |

Example — Gemini, a big diff with more room per chunk:

```sh
LLM_REVIEW_PROVIDER=gemini REVIEW_CHUNK_CHARS=90000 REVIEW_TIMEOUT_MS=600000 llm-review . origin/main
```

---

## Uninstall

```sh
rm ~/.local/bin/llm-review              # the command
rm -rf ~/.local/share/llm-review        # the clone (if you used the one-liner)
```

…and remove any `.git/hooks/pre-push` you added.

---

## License

MIT.

# llm-review

An advisory, **Claude-backed code reviewer** for any git repo. Run it before you push (or wire it into a
pre-push hook) and it reviews your diff for *real* problems — bugs, regressions, security issues, data loss,
broken error handling, breaking/contract changes, dead code — and prints one finding per line.

It **never edits your code and never blocks a push.** It's a second pair of eyes on the way out.

```
▶ LLM review of: /path/to/your/repo
- src/pay.ts:42 :: refund path swallows the gateway error and returns success (high)
- src/pay.ts:88 :: `amount` no longer validated as > 0 before charge (medium)
- src/pay.ts:​7  :: dead import left after removing the retry helper (low)
```

…or just `CLEAN`.

---

## Requirements

- **[`claude`](https://claude.com/claude-code) CLI**, installed and authenticated. This is what does the review.
- **Node.js** (a modern version) on your `PATH`.
  - If your `node` lives under a version manager (nvm/asdf/volta), point the tool at it:
    `export LLM_REVIEW_NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin"`
- **git** (only needed for the one-line install).

If `claude` or `node` is missing, the reviewer prints a short skip note and exits cleanly — it never blocks you.

---

## Install

### One-liner (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash
```

This clones the repo into `~/.local/share/llm-review`, puts an `llm-review` command in `~/.local/bin`, and
seeds a (gitignored) config. Re-run it any time to update.

### From a clone

```sh
git clone https://github.com/Sathish889/reviewer.git
cd reviewer
./install.sh
```

### Install locations (override with env vars)

| Var | Default | What it is |
|---|---|---|
| `LLM_REVIEW_BIN`  | `~/.local/bin`               | where the `llm-review` command is linked |
| `LLM_REVIEW_HOME` | `~/.local/share/llm-review`  | where the one-liner clones the repo |

If `~/.local/bin` isn't on your `PATH`, add it to your shell profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

---

## Usage

From inside any git repo:

```sh
llm-review                    # review your current changes
```

What "current changes" means, in order:

1. uncommitted + staged changes (`git diff HEAD`); if none →
2. unpushed commits (`git diff @{upstream}..HEAD`); if none →
3. commits vs the origin default branch (`origin/main` / `origin/master`).

You can also point it explicitly:

```sh
llm-review .            origin/main    # review what you'd push vs origin/main (baseRef...HEAD)
llm-review ~/code/myapp                # review a repo by path
llm-review ~/code                      # a parent folder containing a single git repo also works
```

### As a pre-push hook (optional)

Drop this in `.git/hooks/pre-push` (and `chmod +x` it) in any repo:

```sh
#!/usr/bin/env bash
llm-review "$(git rev-parse --show-toplevel)" \
  "$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || echo origin/main)" || true
```

The trailing `|| true` keeps it **advisory** — it prints findings but never blocks the push.

---

## How it works

`bin/llm-review` (a small bash wrapper) resolves the git repo and hands the diff to
`lib/llm-diff-review.mjs`, which builds a thorough review prompt and runs it through the `claude` CLI in
**read-only, plan** mode (`Read`/`Grep`/`Glob` only — it can inspect the codebase to confirm a finding, but
cannot change anything). The review follows a 3-step method: map the **flow** (all callers/callees of what
changed) → compare **old vs new behavior** (catch regressions) → a **comprehensive pass** over every path
including errors and edge cases.

Three things keep it fast and honest on real-world diffs:

- **Generated files are excluded.** Build output (`dist`, `build`, `.next`, `coverage`), `node_modules`,
  minified files, source maps, and lockfiles are dropped from the diff before review — plus anything you add
  under `excludes` in the config. Reviewing derived output wastes tokens and drowns the real change.
- **Large diffs are chunked, never silently truncated.** The diff is split per file and reviewed in batches;
  findings are merged and ordered most-severe first. If anything can't be covered (too many chunks, an
  oversized single file, or a chunk that times out), it's **reported** as a finding — never dropped quietly.
- **The timeout is a hard wall-clock bound.** `claude` runs in its own process group and, on timeout, the whole
  group is killed — so a slow review can never hang past the cap.

---

## Configuration (optional)

Everything works with **no config** — it just reviews the one repo. To customize, copy the example
(the installer does this for you) and edit it:

```sh
cp llm-review.config.example.json llm-review.config.json   # gitignored — safe for machine paths
```

| Field | Meaning |
|---|---|
| `model` | Claude model to review with (default `sonnet`). |
| `excludes[]` | Extra git pathspecs to drop from the diff, on top of the built-in defaults (generated docs, snapshots, compiled output, …). |
| `crossRepo[]` | Rules: when the repo path matches `match` (regex), also give the reviewer read-only access to `related` repos and steer it with `hint`. First match wins. |
| `crossRepo[].contractOnly` | If `true`, only pull related repos in when the diff looks contract-relevant (endpoints/params/schema/migrations) — keeps unrelated changes fast and cheap. |

Config is looked up (first hit wins):
`$LLM_REVIEW_CONFIG` → `<repo>/llm-review.config.json` → `<repo>/.llm-review.config.json` → `~/.config/llm-review/config.json`.

`llm-review.config.json` is **gitignored** — your absolute paths and repo-specific hints never get committed.

### Cross-repo review

The killer feature: verify a diff against a **source of truth** or an integrated repo, not just itself. Point
a docs repo at its backend, a frontend at its API contracts, a service at its consumers — and the reviewer will
open those repos (read-only) to catch contract drift a single-repo diff can't see. See
`llm-review.config.example.json` for worked examples.

---

## Tuning (environment variables)

| Var | Default | Effect |
|---|---|---|
| `REVIEW_TIMEOUT_MS`  | `300000` (5 min) | hard per-chunk time cap |
| `REVIEW_CHUNK_CHARS` | `200000` | target max diff chars per review chunk |
| `REVIEW_FILE_CAP`    | `400000` | a single file's diff bigger than this is truncated (with a note) |
| `REVIEW_MAX_CHUNKS`  | `12` | max review chunks; files beyond are reported as "not reviewed" |
| `LLM_REVIEW_NODE_BIN`| — | prepend this dir to `PATH` (for nvm/asdf/volta node) |
| `LLM_REVIEW_CONFIG`  | — | explicit path to a config file |

Example — give a big diff more room:

```sh
REVIEW_CHUNK_CHARS=90000 REVIEW_TIMEOUT_MS=600000 llm-review . origin/main
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

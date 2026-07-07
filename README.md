# llm-review

An advisory, Claude-backed **pre-push code reviewer** for any git repo. Run it before you push and
it reviews your diff for real problems — bugs, security issues, data loss, broken error handling,
contract/API breaks, dead code — and prints one finding per line. It never edits anything and never
blocks a push; it's a second pair of eyes on the way out.

```
▶ LLM review of: /path/to/your/repo
- src/pay.ts:42 :: refund path swallows the gateway error and returns success (high)
- src/pay.ts:88 :: `amount` no longer validated as > 0 before charge (medium)
```
…or just `CLEAN`.

## How it works

`bin/llm-review` (a small bash wrapper) resolves the git repo and hands the diff to
`lib/llm-diff-review.mjs`, which builds a tight, high-precision review prompt and runs it through the
`claude` CLI in read-only, plan permission mode. It's deliberately **conservative** — tuned so a false
positive is treated as worse than a missed nit.

Which diff it reviews:
- **`llm-review`** — your uncommitted + staged changes; if none, your unpushed commits; else vs the origin default branch.
- **`llm-review <path> <baseRef>`** — reviews `<baseRef>...HEAD` (what a pre-push hook is about to push).

## Requirements

- The [`claude`](https://claude.com/claude-code) CLI, authenticated.
- A modern `node` on your `PATH`. If yours lives under nvm/asdf/volta, set `LLM_REVIEW_NODE_BIN` to that
  bin dir (e.g. in your shell profile): `export LLM_REVIEW_NODE_BIN="$HOME/.nvm/versions/node/v20.20.2/bin"`.

## Install

```sh
git clone <your-repo-url> llm-review && cd llm-review
./install.sh                 # symlinks `llm-review` into ~/.local/bin and seeds a local config
```

Then, from inside any repo:

```sh
llm-review                   # review current changes
llm-review . origin/main     # review what you'd push vs origin/main
```

### As a pre-push hook (optional)

`.git/hooks/pre-push` in any repo:

```sh
#!/usr/bin/env bash
llm-review "$(git rev-parse --show-toplevel)" "$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || echo origin/main)" || true
```

(`|| true` keeps it advisory — it prints findings but never blocks the push.)

## Configuration (optional)

Everything works with no config — it just reviews the one repo. To get **cross-repo** review (verify a
diff against a source-of-truth or an integrated repo), copy the example and edit it:

```sh
cp llm-review.config.example.json llm-review.config.json   # gitignored — safe for machine paths
```

| field | meaning |
|---|---|
| `model` | Claude model to review with (default `sonnet`). |
| `crossRepo[]` | Rules: when the repo path matches `match` (regex), also give the reviewer read-only access to `related` repos and steer it with `hint`. First match wins. |
| `crossRepo[].contractOnly` | If `true`, only pull related repos in when the diff looks API/contract-relevant — keeps unrelated changes fast and cheap. |

Config is looked up (first hit wins): `$LLM_REVIEW_CONFIG` → `<repo>/llm-review.config.json` →
`<repo>/.llm-review.config.json` → `~/.config/llm-review/config.json`.

`llm-review.config.json` is **gitignored** — your absolute paths and repo-specific hints never get committed.

## License

MIT (or your choice — add a LICENSE file before publishing).

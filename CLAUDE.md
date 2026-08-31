# llm-review-kit

A multi-engine AI code reviewer and QA gate for git. `lib/llm-diff-review.mjs` is the engine,
`bin/llm-review` the CLI, `hooks/` the git hooks, `install.sh` the installer.

## Token discipline — read this before running anything

This tool costs money per run. **Load the `llm-review` skill before running the reviewer, changing
its budget, or editing the engine or hooks.** The short version:

- **Never run a real review to test a change.** Use a fake provider on PATH (see the skill).
- Default to `--minimal`. `--thorough` is opt-in by name and is the only path to the top tier.
- Never pin a model in config or `LLM_REVIEW_MODEL` — it silently overrides the budget profile.
- Never raise `REVIEW_MAX_CALLS` / `REVIEW_HARD_CEILING` to make a run complete. An unreviewed file is
  a reported coverage gap and exit 3, not a reason to spend more.
- Never retry a timeout with the same payload.

## Non-negotiable behaviour

A review that did not happen must never look like a clean one. Under a gate (`REVIEW_FAIL_ON` set):
`0` = reviewed and clean, `2` = findings at/above threshold, `3` = **could not verify**. No provider
installed, an unparseable answer, a failed pass, a truncated file, or a file the budget never reached
all produce `3`. Anything that would turn one of those into `0` is a bug, not an optimisation.

## Testing

```bash
./test/run.sh              # the full suite, entirely offline, no API calls
./test/run.sh engine       # or: chain | hooks
```

Run it before and after any change to the engine, the hooks, or the installer. Everything is testable
offline with a fake provider — no API calls. Exercise each path by having the
fake print findings, print prose, print `CLEAN`, exit non-zero, or sleep past the timeout, and assert
on the exit code. The hooks are testable end to end with an isolated `HOME` and `GIT_CONFIG_GLOBAL`
plus `LLM_REVIEW_{BIN,HOOKS_DIR,STATE,SCAN_DIRS}` overrides, so a test never touches the real install.

## Style

Match the surrounding code: dense, commented where the *reason* is non-obvious, no ceremony. Comments
explain why a thing is the way it is — usually the failure it prevents — not what the line does.

#!/usr/bin/env bash
# llm-review installer.
#
#   Local checkout:   ./install.sh
#   One-liner:        curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash
#
# It puts an `llm-review` command on your PATH (~/.local/bin) and seeds a gitignored config.
# Re-runnable and idempotent. Nothing here needs sudo.
set -euo pipefail

REPO_URL="${LLM_REVIEW_REPO:-https://github.com/Sathish889/reviewer.git}"
BIN_DIR="${LLM_REVIEW_BIN:-$HOME/.local/bin}"
SRC_DIR="${LLM_REVIEW_HOME:-$HOME/.local/share/llm-review}"

# Where do the kit files live? If this script sits next to lib/ + bin/ (a git checkout), install from there.
# Otherwise (curl | bash — the script arrives on stdin, no lib/ beside it), clone/update the repo into SRC_DIR.
SELF="${BASH_SOURCE[0]:-}"
SELF_DIR=""
[ -n "$SELF" ] && [ -f "$SELF" ] && SELF_DIR="$(cd -P "$(dirname "$SELF")" >/dev/null 2>&1 && pwd)"

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/lib/llm-diff-review.mjs" ]; then
  DIR="$SELF_DIR"
  echo "• installing from local checkout: $DIR"
else
  command -v git >/dev/null 2>&1 || { echo "✗ git is required for the one-liner install"; exit 1; }
  if [ -d "$SRC_DIR/.git" ]; then
    echo "• updating existing copy: $SRC_DIR"
    git -C "$SRC_DIR" pull --ff-only --quiet || echo "  (could not fast-forward — using the copy on disk)"
  else
    echo "• cloning $REPO_URL → $SRC_DIR"
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone --depth 1 --quiet "$REPO_URL" "$SRC_DIR"
  fi
  DIR="$SRC_DIR"
fi

mkdir -p "$BIN_DIR"
chmod +x "$DIR/bin/llm-review"
ln -sf "$DIR/bin/llm-review" "$BIN_DIR/llm-review"
echo "✓ linked: $BIN_DIR/llm-review -> $DIR/bin/llm-review"

# Seed a local (gitignored) config from the example if none exists yet. Cross-repo review is optional — the
# tool works with no config at all.
if [ ! -f "$DIR/llm-review.config.json" ]; then
  cp "$DIR/llm-review.config.example.json" "$DIR/llm-review.config.json"
  echo "✓ created $DIR/llm-review.config.json (edit it; it's gitignored)"
else
  echo "• $DIR/llm-review.config.json already exists — left as-is"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "! $BIN_DIR is not on your PATH — add this to your shell profile:"; echo "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

command -v claude >/dev/null 2>&1 || echo "! the 'claude' CLI is not on PATH — llm-review needs it (https://claude.com/claude-code)"
command -v node   >/dev/null 2>&1 || echo "! 'node' is not on PATH — install Node.js (or set LLM_REVIEW_NODE_BIN to your node bin dir)"

echo "✓ done. Try:  cd <a git repo> && llm-review"

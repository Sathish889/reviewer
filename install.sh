#!/usr/bin/env bash
# Install: symlink the `llm-review` command onto your PATH (~/.local/bin) and seed a local config.
# Re-runnable. Uninstall = remove the symlink it prints.
set -euo pipefail

DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
BIN_DIR="${1:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"

ln -sf "$DIR/bin/llm-review" "$BIN_DIR/llm-review"
chmod +x "$DIR/bin/llm-review"
echo "✓ linked: $BIN_DIR/llm-review -> $DIR/bin/llm-review"

# Seed a local (gitignored) config from the example if none exists yet.
if [ ! -f "$DIR/llm-review.config.json" ]; then
  cp "$DIR/llm-review.config.example.json" "$DIR/llm-review.config.json"
  echo "✓ created llm-review.config.json (edit it; it's gitignored)"
else
  echo "• llm-review.config.json already exists — left as-is"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) echo "! $BIN_DIR is not on your PATH — add:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

command -v claude >/dev/null 2>&1 || echo "! the 'claude' CLI is not on PATH — the reviewer needs it to run"
echo "Done. Try:  cd <a git repo> && llm-review"

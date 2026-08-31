#!/usr/bin/env bash
# llm-review installer — works on any machine, from a checkout or straight off the internet.
#
#   CLI only (default, changes nothing about your git):
#     curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash
#
#   FULL ENFORCEMENT — review every commit, BLOCK commits and pushes with high-severity findings:
#     curl -fsSL https://raw.githubusercontent.com/Sathish889/reviewer/main/install.sh | bash -s -- --enforce
#
#   Review everything but never block:
#     curl -fsSL .../install.sh | bash -s -- --advisory
#
#   Other flags:  --wire-repos   --status   --uninstall   --no-hooks   --help
#
#   --wire-repos also installs a hook shim INTO each repo that sets its own core.hooksPath (husky,
#   lefthook, .githooks) — the global hooks cannot reach those. Without it they are only listed.
#
# Everything lands under $HOME (~/.local/bin, ~/.local/share, ~/.config). Nothing needs sudo.
# Re-runnable and idempotent: existing global hooks are backed up before being replaced.
set -euo pipefail

REPO_SLUG="${LLM_REVIEW_SLUG:-Sathish889/reviewer}"
REPO_URL="${LLM_REVIEW_REPO:-https://github.com/${REPO_SLUG}.git}"
REF="${LLM_REVIEW_REF:-main}"          # pin a tag, branch or sha for a reproducible install
BIN_DIR="${LLM_REVIEW_BIN:-$HOME/.local/bin}"
SRC_DIR="${LLM_REVIEW_HOME:-$HOME/.local/share/llm-review}"
HOOKS_DEST="${LLM_REVIEW_HOOKS_DIR:-$HOME/.config/git/hooks}"
STATE_DIR="${LLM_REVIEW_STATE:-$HOME/.local/state/llm-review}"
# Where to look for repos that override core.hooksPath locally (those silently opt out of the global hooks).
SCAN_DIRS="${LLM_REVIEW_SCAN_DIRS:-$HOME/Documents $HOME/Projects $HOME/src $HOME/code $HOME/dev $HOME/work}"

MODE=cli          # cli | advisory | enforce
DO_UNINSTALL=0
DO_STATUS=0
WIRE_REPOS=0      # writing hook shims into OTHER repos is opt-in — see --wire-repos

while [ $# -gt 0 ]; do
  case "$1" in
    --enforce)   MODE=enforce ;;
    --advisory)  MODE=advisory ;;
    --hooks)     MODE=advisory ;;
    --no-hooks|--cli) MODE=cli ;;
    --wire-repos) WIRE_REPOS=1 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    --status)    DO_STATUS=1 ;;
    -h|--help)
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}" 2>/dev/null
      echo "Flags: --enforce | --advisory | --no-hooks | --wire-repos | --status | --uninstall"
      exit 0 ;;
    *) echo "! unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok  %s\n' "$*"; }
warn() { printf '  !!  %s\n' "$*"; }

# ---------------------------------------------------------------- status
if [ "$DO_STATUS" = "1" ]; then
  say "llm-review status"
  say ""
  printf '  cli:            '; command -v llm-review >/dev/null 2>&1 && printf '%s\n' "$(command -v llm-review)" || printf 'NOT on PATH\n'
  printf '  provider:       '
  { command -v claude >/dev/null 2>&1 && printf 'claude '; } || true
  { command -v gemini >/dev/null 2>&1 && printf 'gemini '; } || true
  command -v claude >/dev/null 2>&1 || command -v gemini >/dev/null 2>&1 || printf 'NONE — reviews cannot run'
  printf '\n'
  printf '  global hooks:   %s\n' "$(git config --global core.hooksPath 2>/dev/null || echo '(not set)')"
  printf '  pre-commit gate:%s\n'  " $(git config --global --bool review.llmPrecommit 2>/dev/null || echo 'off')  (strict: $(git config --global --bool review.llmPrecommitStrict 2>/dev/null || echo 'default on'))"
  printf '  pre-push gate:  %s\n'  "$(git config --global --bool review.llmPrepush 2>/dev/null || echo 'on (default)')  (blocking: $(git config --global --bool review.llmPrepushBlock 2>/dev/null || echo 'on (default)'))"
  printf '  ledger:         %s\n' "$( [ -f "$STATE_DIR/reviewed.log" ] && echo "$(wc -l < "$STATE_DIR/reviewed.log" | tr -d ' ') reviewed, $( [ -f "$STATE_DIR/bypass.log" ] && wc -l < "$STATE_DIR/bypass.log" | tr -d ' ' || echo 0) bypassed" || echo 'empty' )"
  say ""
  say "Repos that override core.hooksPath locally (the global hooks do NOT run there):"
  found=0
  for d in $SCAN_DIRS; do
    [ -d "$d" ] || continue
    while IFS= read -r g; do
      r="$(dirname "$g")"
      lp="$(git -C "$r" config --local core.hooksPath 2>/dev/null || true)"
      [ -n "$lp" ] || continue
      found=1
      case "$lp" in /*) hd="$lp" ;; *) hd="$r/$lp" ;; esac      # git allows an absolute hooksPath
      # Same husky retarget as the installer: core.hooksPath points at husky's generated runner dir,
      # but the hook we install lives one level up in .husky/<name>.
      case "$lp" in */.husky/_|.husky/_) hd="$(dirname "$hd")" ;; esac
      wired=""
      for h in post-commit pre-commit pre-push; do
        [ -f "$hd/$h" ] && grep -q 'review-commit\|config/git/hooks' "$hd/$h" 2>/dev/null && wired="$wired $h"
      done
      shown="$lp"; case "$lp" in */.husky/_|.husky/_) shown="$(dirname "$lp")" ;; esac
      printf '  - %s  ->  %s  [%s]\n' "$r" "$shown" "${wired:- NOT wired}"
    done < <(find "$d" -maxdepth 4 -name .git -type d 2>/dev/null)
  done
  [ "$found" = "0" ] && say "  (none found)"
  exit 0
fi

# ---------------------------------------------------------------- uninstall
if [ "$DO_UNINSTALL" = "1" ]; then
  say "Uninstalling llm-review"
  if [ "$(git config --global core.hooksPath 2>/dev/null || true)" = "$HOOKS_DEST" ]; then
    git config --global --unset core.hooksPath && ok "cleared global core.hooksPath"
  fi
  for k in review.llm review.llmPrecommit review.llmPrecommitStrict review.llmPrepush \
           review.llmPrepushBlock review.llmPrepushStrict review.llmPostcommit review.llmBudget \
           review.llmMaxRefsPerPush review.llmFirstPushFileLimit; do
    git config --global --unset "$k" 2>/dev/null && ok "cleared $k" || true
  done
  [ -L "$BIN_DIR/llm-review" ] && rm -f "$BIN_DIR/llm-review" && ok "removed $BIN_DIR/llm-review"

  # Shims we wrote into other repos point at $HOOKS_DEST. Moving that aside without removing them
  # leaves an `exec` at a path that no longer exists — a non-zero pre-commit/pre-push, which BLOCKS
  # every commit and push in those repos. Remove ours (they carry our marker) before the dir goes.
  for d in $SCAN_DIRS; do
    [ -d "$d" ] || continue
    while IFS= read -r g; do
      r="$(dirname "$g")"
      lp="$(git -C "$r" config --local core.hooksPath 2>/dev/null || true)"
      [ -n "$lp" ] || continue
      case "$lp" in /*) hd="$lp" ;; *) hd="$r/$lp" ;; esac      # git allows an absolute hooksPath
      case "$lp" in */.husky/_|.husky/_) hd="$(dirname "$hd")" ;; esac
      for hook in post-commit pre-commit pre-push; do
        [ -f "$hd/$hook" ] || continue
        grep -q 'installed by llm-review' "$hd/$hook" 2>/dev/null || continue
        rm -f "$hd/$hook" && ok "removed shim $hd/$hook"
      done
    done < <(find "$d" -maxdepth 4 -name .git -type d 2>/dev/null)
  done
  if [ -d "$HOOKS_DEST" ]; then
    mv "$HOOKS_DEST" "$HOOKS_DEST.removed.$(date +%Y%m%d%H%M%S)" && ok "moved hooks aside (not deleted)"
  fi
  say ""
  say "Left in place on purpose: $SRC_DIR, $STATE_DIR (the review ledger), ~/.config/llm-review/config.json"
  exit 0
fi

# ---------------------------------------------------------------- locate the kit
# If this script sits next to lib/ + bin/ (a git checkout), install from there. Otherwise (curl | bash —
# the script arrives on stdin, with no lib/ beside it), clone/update the repo into SRC_DIR.
SELF="${BASH_SOURCE[0]:-}"
SELF_DIR=""
[ -n "$SELF" ] && [ -f "$SELF" ] && SELF_DIR="$(cd -P "$(dirname "$SELF")" >/dev/null 2>&1 && pwd)"

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/lib/llm-diff-review.mjs" ]; then
  DIR="$SELF_DIR"
  say "• installing from local checkout: $DIR"
else
  # Download a TARBALL, not a clone. A clone needs git installed, drags a .git directory onto every
  # machine, and leaves the install looking like a working copy someone might commit into by mistake.
  # A tarball needs only curl and tar, which any machine that ran the one-liner already has.
  #
  # LLM_REVIEW_REF pins what is fetched (tag, branch or sha). LLM_REVIEW_TARBALL points the download
  # at a mirror, proxy or file:// path. LLM_REVIEW_REPO overrides the repo, and the slug is derived
  # from it so that setting one does not leave the other pointing at the default.
  case "$REPO_URL" in
    *github.com[:/]*)
      DERIVED="${REPO_URL#*github.com}"; DERIVED="${DERIVED#[:/]}"
      REPO_SLUG="${DERIVED%.git}" ;;
  esac
  TARBALL="${LLM_REVIEW_TARBALL:-https://codeload.github.com/${REPO_SLUG}/tar.gz/${REF}}"

  TMP="$(mktemp -d)"
  NEW="$TMP/payload"; mkdir -p "$NEW"
  trap 'rm -rf "$TMP"' EXIT
  say "• downloading ${REPO_SLUG}@${REF}"

  fetched=0
  if command -v curl >/dev/null 2>&1; then
    # --no-same-owner so a hostile archive cannot ask for ownership it should not get. Extraction goes
    # into a scratch directory that is validated below before anything replaces the real install.
    if curl -fsSL "$TARBALL" \
       | tar xz -C "$NEW" --strip-components=1 --no-same-owner 2>/dev/null; then
      fetched=1
    fi
  fi
  if [ "$fetched" = "0" ] && command -v git >/dev/null 2>&1; then
    warn "download failed — falling back to git"
    rm -rf "$NEW"; mkdir -p "$NEW"                       # never merge into a half-extracted payload
    if [ -n "${LLM_REVIEW_REF:-}" ]; then
      # A pinned ref is a promise about WHAT gets installed. Falling back to the default branch when
      # the ref cannot be fetched would install something else and still report success, which is
      # worse than failing: the install looks reproducible and is not.
      git clone --depth 1 --quiet --branch "$REF" "$REPO_URL" "$NEW/clone" || {
        echo "x could not fetch ref '$REF' — refusing to install a different version instead."
        echo "  Check the tag/branch/sha exists, or unset LLM_REVIEW_REF for the default branch."
        exit 1
      }
    else
      git clone --depth 1 --quiet "$REPO_URL" "$NEW/clone" \
        || { echo "x git clone failed"; exit 1; }
    fi
    rm -rf "$NEW/clone/.git"
    (cd "$NEW/clone" && tar cf - .) | (cd "$NEW" && tar xf -)
    rm -rf "$NEW/clone"
    fetched=1
  fi
  [ "$fetched" = "1" ] || { echo "x could not download: need either curl or git on PATH"; exit 1; }

  # VALIDATE before trusting it. The download source is env-overridable and unsigned, so treat the
  # payload as untrusted input: it must contain the files we expect, and it must not contain a symlink
  # that points outside itself (the classic way an archive writes somewhere it was never given).
  for want in lib/llm-diff-review.mjs bin/llm-review install.sh hooks/_chain; do
    [ -f "$NEW/$want" ] || { echo "x download looks wrong — $want is missing"; exit 1; }
  done
  while IFS= read -r link; do
    target="$(readlink "$link")"
    case "$target" in
      /*|*..*)
        echo "x refusing this download: $link points outside the payload ($target)"
        exit 1 ;;
    esac
  done < <(find "$NEW" -type l 2>/dev/null)

  # SWAP, keeping the old copy until the new one is in place. Removing the old install before the move
  # is confirmed means a failure at that moment leaves no install at all.
  mkdir -p "$(dirname "$SRC_DIR")"
  OLD=""
  if [ -d "$SRC_DIR" ]; then
    # The user's config is gitignored and machine-local; replacing the directory would throw away
    # their provider, cross-repo and style settings.
    [ -f "$SRC_DIR/llm-review.config.json" ] \
      && cp "$SRC_DIR/llm-review.config.json" "$TMP/keep-config"
    OLD="$SRC_DIR.previous.$$"
    mv "$SRC_DIR" "$OLD" || {
      echo "x could not move the existing install aside — leaving it untouched"; exit 1
    }
  fi
  if ! mv "$NEW" "$SRC_DIR"; then
    echo "x could not install to $SRC_DIR"
    [ -n "$OLD" ] && mv "$OLD" "$SRC_DIR" && echo "  restored the previous install"
    exit 1
  fi
  [ -n "$OLD" ] && rm -rf "$OLD"
  if [ -f "$TMP/keep-config" ]; then
    mv "$TMP/keep-config" "$SRC_DIR/llm-review.config.json"
    say "  kept your existing llm-review.config.json"
  fi
  rm -rf "$TMP"; trap - EXIT
  DIR="$SRC_DIR"
fi

# ---------------------------------------------------------------- the CLI
mkdir -p "$BIN_DIR" "$STATE_DIR"
chmod +x "$DIR/bin/llm-review"
ln -sf "$DIR/bin/llm-review" "$BIN_DIR/llm-review"
ok "linked $BIN_DIR/llm-review -> $DIR/bin/llm-review"

# Seed a local (gitignored) config from the example if none exists yet. Cross-repo review is optional —
# the tool works with no config at all.
if [ ! -f "$DIR/llm-review.config.json" ]; then
  cp "$DIR/llm-review.config.example.json" "$DIR/llm-review.config.json"
  ok "created $DIR/llm-review.config.json (edit it; it is gitignored)"
else
  say "  •  $DIR/llm-review.config.json already exists — left as-is"
fi

# ---------------------------------------------------------------- the git hooks
if [ "$MODE" != "cli" ]; then
  [ -d "$DIR/hooks" ] || { echo "x $DIR/hooks is missing — cannot install hooks"; exit 1; }

  # Back up whatever is already there. A previous hand-rolled install may live in this directory, and
  # silently replacing someone's hooks is the one thing an installer must never do.
  if [ -d "$HOOKS_DEST" ] && [ -n "$(ls -A "$HOOKS_DEST" 2>/dev/null || true)" ]; then
    BK="$HOOKS_DEST.backup.$(date +%Y%m%d%H%M%S)"
    cp -R "$HOOKS_DEST" "$BK"
    ok "backed up existing hooks -> $BK"
  fi

  mkdir -p "$HOOKS_DEST"
  for f in "$DIR/hooks"/*; do
    install -m 0755 "$f" "$HOOKS_DEST/$(basename "$f")"
  done
  ok "installed $(ls -1 "$DIR/hooks" | wc -l | tr -d ' ') hook(s) -> $HOOKS_DEST"

  # core.hooksPath makes git ignore .git/hooks entirely — which is why every hook here chains back to
  # the repo's own hook first (see hooks/_chain).
  git config --global core.hooksPath "$HOOKS_DEST"
  ok "git config --global core.hooksPath $HOOKS_DEST"

  git config --global review.llm true
  if [ "$MODE" = "enforce" ]; then
    git config --global review.llmPrecommit true
    git config --global review.llmPrecommitStrict true
    git config --global review.llmPrepush true
    git config --global review.llmPrepushBlock true
    ok "ENFORCE mode: commits and pushes are BLOCKED on high-severity findings"
    ok "ENFORCE mode: strict — a commit is also blocked when the review cannot complete"
  else
    git config --global review.llmPrecommit false
    git config --global review.llmPrepush true
    git config --global review.llmPrepushBlock false
    ok "ADVISORY mode: every commit and push is reviewed, nothing is ever blocked"
  fi

  # Repos with their OWN core.hooksPath never see the global hooks — the single most common way this
  # install silently stops working. Wire each one directly (never to the global post-commit, which
  # would chain back to the repo hook and recurse forever).
  say ""
  if [ "$WIRE_REPOS" = "0" ]; then
    say "• repos that override core.hooksPath locally (the global hooks do NOT run there):"
    n=0
    for d in $SCAN_DIRS; do
      [ -d "$d" ] || continue
      while IFS= read -r g; do
        r="$(dirname "$g")"
        lp="$(git -C "$r" config --local core.hooksPath 2>/dev/null || true)"
        [ -n "$lp" ] || continue
        n=$((n+1)); say "    - $r  ($lp)"
      done < <(find "$d" -maxdepth 4 -name .git -type d 2>/dev/null)
    done
    [ "$n" = "0" ] && say "    (none found)" || say "    Wire them up with:  $DIR/install.sh --$MODE --wire-repos   (writes a hook shim into each)"
  else
  say "• wiring repos that override core.hooksPath locally..."
  for d in $SCAN_DIRS; do
    [ -d "$d" ] || continue
    while IFS= read -r g; do
      r="$(dirname "$g")"
      lp="$(git -C "$r" config --local core.hooksPath 2>/dev/null || true)"
      [ -n "$lp" ] || continue
      case "$lp" in /*) hd="$lp" ;; *) hd="$r/$lp" ;; esac      # git allows an absolute hooksPath
      [ -d "$hd" ] || { warn "$r: local core.hooksPath -> $lp does NOT exist (its hooks never run at all)"; continue; }
      # HUSKY: core.hooksPath points at .husky/_, which holds husky's OWN generated runners — writing
      # there fights husky and gets clobbered on its next install. The hook a user is meant to own is
      # .husky/<name>, one level up, which the runner invokes. Retarget to that.
      case "$lp" in
        */.husky/_|.husky/_) hd="$(dirname "$hd")"; lp="$(dirname "$lp")" ;;
      esac
      for hook in post-commit pre-commit pre-push; do
        tgt="$hd/$hook"
        if [ -f "$tgt" ] && grep -q 'llm-review\|review-commit' "$tgt" 2>/dev/null; then continue; fi
        if [ -f "$tgt" ]; then
          warn "$r: $lp/$hook exists and is not ours — add this line to it yourself:"
          case "$hook" in
            post-commit) say "        \"$HOOKS_DEST/review-commit\"" ;;
            *)           say "        \"$HOOKS_DEST/$hook\" \"\$@\"" ;;
          esac
          continue
        fi
        # review-commit / the gate hooks are called DIRECTLY — not via the global post-commit, which
        # chains repo hooks and would recurse straight back into this file.
        # `exec` only if the target is still there. If llm-review is uninstalled or moved, a stale shim
        # must not turn into a non-zero hook that blocks every commit in someone's repo.
        if [ "$hook" = "post-commit" ]; then
          printf '#!/usr/bin/env bash\n# installed by llm-review: this repo sets its own core.hooksPath, so the global hook never runs here.\n[ -x "%s/review-commit" ] || exit 0\nexec "%s/review-commit"\n' "$HOOKS_DEST" "$HOOKS_DEST" > "$tgt"
        else
          printf '#!/usr/bin/env bash\n# installed by llm-review: this repo sets its own core.hooksPath, so the global hook never runs here.\n[ -x "%s/%s" ] || exit 0\nexec "%s/%s" "$@"\n' "$HOOKS_DEST" "$hook" "$HOOKS_DEST" "$hook" > "$tgt"
        fi
        chmod +x "$tgt"
        ok "wired $r -> $lp/$hook"
        # If the hooks dir is tracked, keep our shim out of the user's commits and off teammates' machines.
        if git -C "$r" ls-files --error-unmatch "$lp" >/dev/null 2>&1; then
          gi="$(git -C "$r" rev-parse --absolute-git-dir)/info/exclude"
          grep -qxF "$lp/$hook" "$gi" 2>/dev/null || printf '%s\n' "$lp/$hook" >> "$gi"
        fi
      done
    done < <(find "$d" -maxdepth 4 -name .git -type d 2>/dev/null)
  done
  fi
fi

# ---------------------------------------------------------------- environment sanity
say ""
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) warn "$BIN_DIR is not on your PATH — add to your shell profile:"; say "        export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
command -v claude >/dev/null 2>&1 || command -v gemini >/dev/null 2>&1 || \
  warn "no reviewer CLI found — install 'claude' (https://claude.com/claude-code) or the Gemini CLI. Reviews cannot run without one."
command -v node >/dev/null 2>&1 || warn "'node' is not on PATH — install Node.js (or set LLM_REVIEW_NODE_BIN to your node bin dir)"

say ""
say "Done."
if [ "$MODE" = "enforce" ]; then
  say "  Commits are now reviewed and BLOCKED on high-severity findings, in every repo on this machine."
  say "  Bypass once:  git commit --no-verify   (recorded in $STATE_DIR/bypass.log)"
  say "  Turn blocking off:  git config --global review.llmPrecommit false"
elif [ "$MODE" = "advisory" ]; then
  say "  Every commit and push is reviewed. Nothing is blocked."
  say "  Switch to blocking later:  git config --global review.llmPrecommit true"
else
  say "  Try:  cd <a git repo> && llm-review"
  say "  Enable the automatic gates:  $DIR/install.sh --enforce   (or --advisory)"
fi
say "  Check anytime:  llm-review --status"

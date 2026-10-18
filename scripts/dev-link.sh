#!/usr/bin/env bash
# Run Hermetic straight from this checkout: links the Hermes plugin folders to the repo,
# so edits here are what Hermes loads. Anything already installed is moved aside first.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HH="${HERMES_HOME:-$HOME/.hermes}"
BACKUP="$HH/hermetic-pre-link-$(date +%Y%m%d-%H%M%S)"

link() {
  local target="$1" src="$2"
  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    mkdir -p "$BACKUP"
    mv "$target" "$BACKUP/$(basename "$(dirname "$target")")"
    echo "moved the old $target to $BACKUP"
  fi
  mkdir -p "$(dirname "$target")"
  ln -s "$src" "$target"
  echo "linked $target -> $src"
}

link "$HH/plugins/hermetic" "$REPO"
link "$HH/desktop-plugins/hermetic" "$REPO/desktop"
echo "Done. Restart Hermes (menu: Quit and Keep Windows) so the backend loads from the repo."

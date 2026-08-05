#!/bin/bash
# Install the `clean` command for the current user.
#
# Adds ~/bin to PATH (if needed) and creates a `clean` symlink there. No sudo,
# nothing outside the home directory, and re-running it is harmless.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/bin"
LINK="$BIN_DIR/clean"
MARKER="# diskclean: added by install.sh"

say() { printf '  %s\n' "$1"; }

printf '\n'

# 1. The symlink.
mkdir -p "$BIN_DIR"
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  current="$(readlink "$LINK" 2>/dev/null || echo '')"
  if [ "$current" = "$DIR/diskclean" ]; then
    say "clean -> already linked"
  else
    say "Refusing to overwrite existing $LINK"
    say "It points to: ${current:-a real file}"
    say "Remove it yourself, then re-run this installer."
    exit 1
  fi
else
  ln -s "$DIR/diskclean" "$LINK"
  say "Linked $LINK -> $DIR/diskclean"
fi

# 2. PATH, for whichever shell config exists.
case "${SHELL##*/}" in
  zsh)  RC="$HOME/.zshrc" ;;
  bash) RC="$HOME/.bash_profile" ;;
  *)    RC="" ;;
esac

if [ -z "$RC" ]; then
  say "Unknown shell ($SHELL). Add this to your shell config by hand:"
  say '  export PATH="$HOME/bin:$PATH"'
elif grep -qs "$MARKER" "$RC"; then
  say "PATH entry already present in $(basename "$RC")"
elif printf '%s' ":$PATH:" | grep -q ":$BIN_DIR:"; then
  say "$BIN_DIR is already on PATH"
else
  {
    printf '\n%s\n' "$MARKER"
    printf '%s\n' 'export PATH="$HOME/bin:$PATH"'
  } >> "$RC"
  say "Added \$HOME/bin to PATH in $(basename "$RC")"
fi

printf '\n'
say "Done. Open a new terminal (or run: source $RC) then type:"
printf '\n    clean\n\n'

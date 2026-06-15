#!/usr/bin/env bash
# Installs the Your Code Review Assistant native-messaging host for the local
# Chromium-based browsers found on this machine (Edge, Chrome, Chromium, Brave).
#
# It bakes the absolute node + claude paths into a wrapper script (the browser
# launches the host with a minimal PATH, so we can't rely on `node`/`claude` being
# resolvable), then writes the host manifest with allowed_origins pinned to the
# extension's fixed ID.
set -euo pipefail

HOST_NAME="com.ycra.reviewer"
# Extension ids allowed to talk to the host. Both are known + fixed, so they're allowed by
# default and neither dev nor store users need to pass anything:
#   - DEV_EXT_ID   — load-unpacked / self-build id (from the repo's fixed manifest key)
#   - STORE_EXT_ID — Chrome Web Store id (assigned to the published listing; same for every install)
# Pass an *additional* id as the first arg or via YCRA_EXT_ID to allow another origin too.
DEV_EXT_ID="cafladkeojdkaaehgajijjehaclhkdch"
STORE_EXT_ID="hlfjhmhgkpibcjpflejijbcbpapinifj"
EXTRA_EXT_ID="${1:-${YCRA_EXT_ID:-}}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE_BIN="$(command -v node || true)"
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$NODE_BIN" ]; then echo "Error: 'node' not found on PATH." >&2; exit 1; fi
if [ -z "$CLAUDE_BIN" ]; then echo "Error: 'claude' CLI not found on PATH." >&2; exit 1; fi

# Wrapper the browser will exec — pins absolute node + claude paths.
WRAPPER="$DIR/reviewer-host.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
export YCRA_CLAUDE_BIN="$CLAUDE_BIN"
exec "$NODE_BIN" "$DIR/reviewer-host.mjs"
EOF
chmod +x "$WRAPPER"

# Allow both known ids by default; append the optional extra id if one was given.
ORIGINS="\"chrome-extension://$DEV_EXT_ID/\", \"chrome-extension://$STORE_EXT_ID/\""
[ -n "$EXTRA_EXT_ID" ] && ORIGINS="$ORIGINS, \"chrome-extension://$EXTRA_EXT_ID/\""

read -r -d '' MANIFEST <<EOF || true
{
  "name": "$HOST_NAME",
  "description": "Your Code Review Assistant native host",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
EOF

installed_any=0
install_to() {
  local browser_dir="$1"
  [ -d "$browser_dir" ] || return 0 # browser not installed; skip
  local target="$browser_dir/NativeMessagingHosts"
  mkdir -p "$target"
  printf '%s\n' "$MANIFEST" > "$target/$HOST_NAME.json"
  echo "  ✓ $target/$HOST_NAME.json"
  installed_any=1
}

echo "Installing native host '$HOST_NAME' …"
echo "  node:    $NODE_BIN"
echo "  claude:  $CLAUDE_BIN"
echo "  ext ids: $DEV_EXT_ID (dev), $STORE_EXT_ID (store)${EXTRA_EXT_ID:+, $EXTRA_EXT_ID (extra)}"

case "$(uname -s)" in
  Darwin)
    base="$HOME/Library/Application Support"
    install_to "$base/Microsoft Edge"
    install_to "$base/Google/Chrome"
    install_to "$base/Chromium"
    install_to "$base/BraveSoftware/Brave-Browser"
    ;;
  Linux)
    install_to "$HOME/.config/microsoft-edge"
    install_to "$HOME/.config/google-chrome"
    install_to "$HOME/.config/chromium"
    install_to "$HOME/.config/BraveSoftware/Brave-Browser"
    ;;
  *)
    echo "Unsupported OS '$(uname -s)'. For Windows, register the manifest under" >&2
    echo "HKCU\\Software\\<Browser>\\NativeMessagingHosts\\$HOST_NAME pointing at a .json manifest." >&2
    exit 1
    ;;
esac

if [ "$installed_any" -eq 0 ]; then
  echo "No supported browser profile directories found. Nothing installed." >&2
  exit 1
fi

echo "Done. Fully quit and reopen the browser so it picks up the new host."

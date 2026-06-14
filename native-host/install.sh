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
# Extension id to pin in allowed_origins. Defaults to the fixed dev id (load-unpacked /
# self-build). A store install gets a different, store-assigned id — pass it as the first
# arg or via YCRA_EXT_ID:  ./install.sh <store-extension-id>
EXT_ID="${1:-${YCRA_EXT_ID:-cafladkeojdkaaehgajijjehaclhkdch}}"
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

read -r -d '' MANIFEST <<EOF || true
{
  "name": "$HOST_NAME",
  "description": "Your Code Review Assistant native host",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
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
echo "  node:   $NODE_BIN"
echo "  claude: $CLAUDE_BIN"

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

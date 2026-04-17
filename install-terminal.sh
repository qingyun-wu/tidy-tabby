#!/bin/bash
#
# Tidy Tabby — Install Native Messaging Host
#
# Run this once to enable the Terminal tab.
# It registers the native host so Chrome can auto-launch
# the terminal process — no manual server needed.
#
# Usage: ./install-terminal.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.tidytabby.terminal"
HOST_SCRIPT="$SCRIPT_DIR/native-host/tidy-tabby-terminal.py"

# Make host script executable
chmod +x "$HOST_SCRIPT"

# Detect Chrome native messaging hosts directory
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    HOSTS_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux"* ]]; then
    # Linux
    HOSTS_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
else
    echo "Unsupported OS: $OSTYPE"
    echo "See https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging for manual setup."
    exit 1
fi

mkdir -p "$HOSTS_DIR"

# Get extension ID — ask user if needed
EXTENSION_ID="${1:-}"
if [ -z "$EXTENSION_ID" ]; then
    echo ""
    echo "Tidy Tabby Terminal — Native Messaging Setup"
    echo "============================================="
    echo ""
    echo "To complete setup, I need your extension ID."
    echo ""
    echo "  1. Open chrome://extensions"
    echo "  2. Find 'Tidy Tabby'"
    echo "  3. Copy the ID (looks like: abcdefghijklmnopqrstuvwxyz)"
    echo ""
    read -p "Paste your extension ID: " EXTENSION_ID
fi

if [ -z "$EXTENSION_ID" ]; then
    echo "Error: No extension ID provided."
    exit 1
fi

# Write the native messaging host manifest
MANIFEST_PATH="$HOSTS_DIR/$HOST_NAME.json"
cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "Tidy Tabby Terminal — native shell access for the browser",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF

echo ""
echo "Installed native messaging host:"
echo "  Manifest: $MANIFEST_PATH"
echo "  Host:     $HOST_SCRIPT"
echo ""
echo "Done! Reload the extension in chrome://extensions,"
echo "then open a new tab and click Terminal > Connect."

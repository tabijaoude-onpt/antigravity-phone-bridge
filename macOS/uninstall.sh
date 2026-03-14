#!/bin/bash
# OnPoint Bridge v5.0 — Uninstall
set -e

LAUNCHAGENTS="$HOME/Library/LaunchAgents"
WRAPPER_APP="/Applications/Antigravity (OnPoint).app"

echo ""
echo "⬡  OnPoint Bridge — Uninstall"
echo "═══════════════════════════════"

# Remove bridge Launch Agent
PLIST="$LAUNCHAGENTS/com.onpoint.bridge.plist"
if [ -f "$PLIST" ]; then
    launchctl unload -w "$PLIST" 2>/dev/null || true
    rm "$PLIST"
    echo "✅  Bridge server auto-start removed."
else
    echo "ℹ️   Bridge agent not found (already removed)."
fi

# Remove wrapper app (if desired)
if [ -d "$WRAPPER_APP" ]; then
    rm -rf "$WRAPPER_APP"
    echo "✅  Antigravity launcher removed from /Applications."
fi

echo ""
echo "   Your bridge folder files are untouched."
echo "   To reinstall: ./install.sh"
echo ""

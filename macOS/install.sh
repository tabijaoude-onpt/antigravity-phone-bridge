#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  OnPoint Bridge v5.0 — Installer
#
#  What this does:
#    1. Installs npm dependencies
#    2. Registers bridge server as a Launch Agent (auto-starts at login)
#    3. Creates "Antigravity (OnPoint).app" — a dock icon that opens
#       Antigravity with CDP enabled so the bridge can connect
#    4. Starts the bridge server immediately (no reboot needed)
# ═══════════════════════════════════════════════════════════════════
set -e

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHAGENTS="$HOME/Library/LaunchAgents"
NODE_PATH="$(which node 2>/dev/null || echo '/usr/local/bin/node')"
ANTIGRAVITY_BIN="/Applications/Antigravity.app/Contents/MacOS/Electron"
WRAPPER_APP="/Applications/Antigravity (OnPoint).app"

echo ""
echo "⬡  OnPoint Bridge v5.0 — Installer"
echo "════════════════════════════════════"

# ── Guard: Node.js ────────────────────────────────────────────────────────────
if ! which node &>/dev/null; then
    echo "❌  Node.js not found."
    echo "    Install: https://nodejs.org  or  brew install node"
    exit 1
fi
NODE_PATH="$(which node)"

# ── Guard: Antigravity ────────────────────────────────────────────────────────
if [ ! -f "$ANTIGRAVITY_BIN" ]; then
    echo "❌  Antigravity.app not found at /Applications/Antigravity.app"
    exit 1
fi

mkdir -p "$LAUNCHAGENTS"

# ── Step 1: npm install ───────────────────────────────────────────────────────
echo ""
echo "📦  [1/3] Installing npm dependencies..."
cd "$BRIDGE_DIR"
npm install --silent
echo "    ✅  Done."

# ── Step 2: Register Bridge Server Launch Agent ───────────────────────────────
echo ""
echo "🌐  [2/3] Registering bridge server (auto-starts at login)..."
BRIDGEPLIST_DEST="$LAUNCHAGENTS/com.onpoint.bridge.plist"

sed -e "s|BRIDGE_DIR_PLACEHOLDER|$BRIDGE_DIR|g" \
    -e "s|NODE_PATH_PLACEHOLDER|$NODE_PATH|g" \
    "$BRIDGE_DIR/com.onpoint.bridge.plist" > "$BRIDGEPLIST_DEST"

launchctl unload "$BRIDGEPLIST_DEST" 2>/dev/null || true
launchctl load -w "$BRIDGEPLIST_DEST"
echo "    ✅  Bridge will auto-start at every login."

# ── Step 3: Create Antigravity CDP Wrapper App ────────────────────────────────
# This is a tiny .app you can drag to your Dock.
# Clicking it opens Antigravity exactly like normal — but with port 9222 enabled.
echo ""
echo "🖥️   [3/3] Creating Antigravity launcher for your Dock..."

# Build the AppleScript app
osascript - "$ANTIGRAVITY_BIN" "$WRAPPER_APP" <<'APPLESCRIPT'
on run argv
    set agBin to item 1 of argv
    set outPath to item 2 of argv
    set appScript to "do shell script \"/Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=9222 --remote-allow-origins=* &> /dev/null &\""
    
    -- Compile the wrapper .app using osacompile
    do shell script "mkdir -p " & quoted form of (outPath & "/Contents/MacOS")
    do shell script "mkdir -p " & quoted form of (outPath & "/Contents/Resources")
    
    -- Write the launcher script
    set scriptContent to "#!/bin/bash
/Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=9222 --remote-allow-origins='*' &"
    
    do shell script "echo " & quoted form of scriptContent & " > " & quoted form of (outPath & "/Contents/MacOS/launcher")
    do shell script "chmod +x " & quoted form of (outPath & "/Contents/MacOS/launcher")
    
    -- Write Info.plist
    set infoPlist to "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundleName</key>
    <string>Antigravity</string>
    <key>CFBundleDisplayName</key>
    <string>Antigravity</string>
    <key>CFBundleIdentifier</key>
    <string>com.onpoint.antigravity-launcher</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
</dict>
</plist>"
    do shell script "echo " & quoted form of infoPlist & " > " & quoted form of (outPath & "/Contents/Info.plist")
    
    -- Copy Antigravity's icon so the dock icon looks identical
    do shell script "cp /Applications/Antigravity.app/Contents/Resources/electron.icns " & quoted form of (outPath & "/Contents/Resources/AppIcon.icns") & " 2>/dev/null || true"
end run
APPLESCRIPT

echo "    ✅  Created: $WRAPPER_APP"

# ── Done ──────────────────────────────────────────────────────────────────────
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "YOUR-MAC-IP")

echo ""
echo "════════════════════════════════════════════════════"
echo "🎉  ALL SET"
echo ""
echo "   NEXT STEP (one time only):"
echo "   Drag  \"Antigravity (OnPoint)\"  from /Applications"
echo "   into your Dock to replace the current Antigravity icon."
echo "   Click it exactly like you always did — it just works."
echo ""
echo "   📱  Phone URL: http://$LOCAL_IP:3000"
echo "       Open this in your phone's browser."
echo "       Leave it open. It will auto-connect when you"
echo "       open Antigravity."
echo ""
echo "   To uninstall:  ./uninstall.sh"
echo "════════════════════════════════════════════════════"
echo ""

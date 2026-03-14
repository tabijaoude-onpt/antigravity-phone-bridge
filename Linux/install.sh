#!/bin/bash
# OnPoint AG-Bridge — Linux Installer
# Tested on Ubuntu/Debian, Fedora, Arch
set -e

BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(which node 2>/dev/null || echo '')"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/onpoint-ag-bridge.service"
DESKTOP_DIR="$HOME/.local/share/applications"
ANTIGRAVITY_BIN="$(which antigravity 2>/dev/null || ls /opt/Antigravity/antigravity /usr/bin/antigravity "$HOME/.local/bin/antigravity" 2>/dev/null | head -1 || echo '')"

echo ""
echo "⬡  OnPoint AG-Bridge — Linux Installer"
echo "════════════════════════════════════════"

# Guard: Node.js
if [ -z "$NODE_PATH" ]; then
    echo "❌  Node.js not found."
    echo "    Ubuntu/Debian: sudo apt install nodejs npm"
    echo "    Fedora:        sudo dnf install nodejs"
    echo "    Arch:          sudo pacman -S nodejs npm"
    exit 1
fi

# ── 1. npm install ────────────────────────────────────────────────────────────
echo ""
echo "📦  [1/3] Installing dependencies..."
cd "$BRIDGE_DIR"
npm install --silent
echo "    ✅  Done."

# ── 2. systemd user service (auto-start at login, no root needed) ─────────────
echo ""
echo "🔧  [2/3] Registering systemd user service..."
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=OnPoint AG-Bridge
After=network.target

[Service]
Type=simple
ExecStart=$NODE_PATH $BRIDGE_DIR/server.js
WorkingDirectory=$BRIDGE_DIR
Restart=always
RestartSec=3
Environment=PATH=/usr/local/bin:/usr/bin:/bin
StandardOutput=append:$BRIDGE_DIR/bridge.log
StandardError=append:$BRIDGE_DIR/bridge-error.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable onpoint-ag-bridge
systemctl --user start  onpoint-ag-bridge
loginctl enable-linger "$USER" 2>/dev/null || true  # keep service running after logout
echo "    ✅  Bridge auto-starts at every login."

# ── 3. Antigravity launcher .desktop file ─────────────────────────────────────
echo ""
echo "🖥️   [3/3] Creating Antigravity launcher..."
mkdir -p "$DESKTOP_DIR"

if [ -n "$ANTIGRAVITY_BIN" ]; then
    cat > "$DESKTOP_DIR/antigravity-onpoint.desktop" << EOF
[Desktop Entry]
Version=1.0
Name=Antigravity (OnPoint)
Comment=Antigravity with AG-Bridge CDP enabled
Exec=$ANTIGRAVITY_BIN --remote-debugging-port=9222 --remote-allow-origins=*
Icon=antigravity
Terminal=false
Type=Application
Categories=Development;
EOF
    chmod +x "$DESKTOP_DIR/antigravity-onpoint.desktop"
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    echo "    ✅  'Antigravity (OnPoint)' added to your app launcher."
else
    echo "    ⚠️   Antigravity not found in PATH — skipping launcher."
    echo "    You can launch manually with:"
    echo "    antigravity --remote-debugging-port=9222 --remote-allow-origins='*'"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")

echo ""
echo "════════════════════════════════════════"
echo "🎉  ALL SET"
echo ""
echo "   📱  Phone URL: http://$LOCAL_IP:3000"
echo ""
echo "   Use 'Antigravity (OnPoint)' from your app"
echo "   launcher instead of the regular Antigravity."
echo ""
echo "   To uninstall:  ./uninstall-linux.sh"
echo "════════════════════════════════════════"
echo ""

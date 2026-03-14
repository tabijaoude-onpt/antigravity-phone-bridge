#!/bin/bash
# OnPoint AG-Bridge — Linux Uninstaller
set -e
systemctl --user stop    onpoint-ag-bridge 2>/dev/null || true
systemctl --user disable onpoint-ag-bridge 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/onpoint-ag-bridge.service"
rm -f "$HOME/.local/share/applications/antigravity-onpoint.desktop"
systemctl --user daemon-reload
echo "⬡  OnPoint AG-Bridge removed. Run ./install-linux.sh to reinstall."

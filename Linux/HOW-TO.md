# Linux AG-Bridge

This folder contains the Linux-specific version of the Antigravity Phone Bridge.
The Linux implementation leverages X11 utilities (`xdotool`, `xclip`) to focus and stimulate inputs to electron frames, and traditional `systemd`/`systemctl` to manage background daemon services like Ollama.

## Installation
Run the following installer script from the Terminal (may prompt for sudo):
```bash
./install.sh
```
This script will:
- Stop any running Bridge systemd service.
- Copy necessary files `/usr/share/antigravity`.
- Configure `systemctl` background units.
- Enable headless boot launch settings.

## Uninstallation
Run the uninstaller script:
```bash
./uninstall.sh
```

## Prerequisites
- Node.js installed.
- `xdotool` and `xclip` installed.
- Systemd based Linux.

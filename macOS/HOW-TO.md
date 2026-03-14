# macOS AG-Bridge

This folder contains the macOS-specific version of the Antigravity Phone Bridge.
The macOS implementation relies on `osascript` (AppleScript) for focusing windows securely, macOS native `pbcopy`/`pbpaste` for manipulating the clipboard to send keys, and macOS BSD `ps` arguments.

## Installation
Run the following installer script from the Terminal:
```bash
./install.sh
```
This script will:
- Stop any running Bridge processes.
- Set up the environment.
- Register a background macOS `launchctl` agent (`com.onpoint.bridge`).
- Automatically start the service in the background on every login.

## Uninstallation
Run the uninstaller script:
```bash
./uninstall.sh
```

## Prerequisites
- Node.js installed.
- Antigravity standard Application installation (`/Applications/Antigravity.app`).
- Ollama installed (optional, uses standard `.dmg` logic for macOS).

# Antigravity Phone Bridge

This repository contains the bridge server that allows you to connect your phone or browser to the Local Antigravity AI IDE running on your computer. It streams the screen, handles OS-level window interactions, and proxies LLM requests to local models.

Because Antigravity runs as a native desktop application, this bridge relies heavily on your operating system's native window manager and clipboard tools to inject code and read state.

As a result, there are **three distinct versions** of the bridge, depending on your desktop OS. 

Please navigate to your operating system's folder and follow the `HOW-TO.md` inside:

- **[macOS](./macOS)**: Uses `osascript` (AppleScript) and `pbcopy`/`pbpaste`.
- **[Linux](./Linux)**: Uses `xdotool` and `xclip` under X11.
- **[Windows](./Windows)**: Uses `powershell` clipboard and Win32 C# APIs.

Each folder contains the exact `server.js` optimized for that platform, alongside the correct installer and uninstaller scripts.

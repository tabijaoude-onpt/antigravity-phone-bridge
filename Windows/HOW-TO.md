# Windows AG-Bridge

This folder contains the Windows-specific version of the Antigravity Phone Bridge. 
The Windows implementation relies on `powershell.exe`, Windows native clipboard (`Set-Clipboard`), Win32 APIs (via inline C# definitions format) to manage window focus and simulate keys (`^v`, `Enter`), and BSD process controls for Node.

## Installation
Right-click on `install.ps1` and select **Run with PowerShell**, or open an Administrator PowerShell and run:
```powershell
.\install.ps1
```
This script handles copying the code to the standard location and configuring the Windows background service.

## Uninstallation
Run `uninstall.ps1` from an Administrator PowerShell prompt.

## Prerequisites
- Node.js installed
- Ollama installed (optional, automatically managed if installed normally to path)
- Antigravity standard Windows installation path (`C:\Program Files\Antigravity\Antigravity.exe` or local AppData)

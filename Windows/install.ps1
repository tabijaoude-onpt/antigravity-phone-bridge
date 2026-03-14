# OnPoint AG-Bridge — Windows Installer
# Run this once in PowerShell as Administrator:
#   Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
#   .\install-windows.ps1

$BridgeDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodePath   = (Get-Command node -ErrorAction SilentlyContinue).Source
$AgPath     = "$env:LOCALAPPDATA\Programs\Antigravity\Antigravity.exe"
$TaskName   = "OnPointAGBridge"
$LauncherPs = "$BridgeDir\launch-antigravity.ps1"
$LauncherBat= "$BridgeDir\Launch Antigravity (OnPoint).bat"

Write-Host ""
Write-Host "*** OnPoint AG-Bridge — Windows Installer ***" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan

# Guard: Node.js
if (-not $NodePath) {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# ── 1. npm install ────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[1/3] Installing dependencies..."
Set-Location $BridgeDir
npm install --silent
Write-Host "      OK" -ForegroundColor Green

# ── 2. Register Task Scheduler (auto-start at login) ─────────────────────────
Write-Host ""
Write-Host "[2/3] Registering auto-start task..."

$Action  = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$BridgeDir\server.js`"" -WorkingDirectory $BridgeDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings= New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Remove old task if it exists
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal | Out-Null

# Start it now without rebooting
Start-ScheduledTask -TaskName $TaskName
Write-Host "      OK — Bridge will auto-start at every login." -ForegroundColor Green

# ── 3. Create Antigravity CDP launcher ────────────────────────────────────────
Write-Host ""
Write-Host "[3/3] Creating Antigravity launcher..."

# Find Antigravity if not at default path
if (-not (Test-Path $AgPath)) {
    $found = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Filter "Antigravity.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $AgPath = $found.FullName }
}

# PowerShell launcher (used by .bat)
@"
Start-Process -FilePath '$AgPath' -ArgumentList '--remote-debugging-port=9222', '--remote-allow-origins=*'
"@ | Set-Content -Path $LauncherPs -Encoding UTF8

# .bat file — double-click to open Antigravity with CDP (pin this to taskbar/Start)
@"
@echo off
powershell -WindowStyle Hidden -File "%~dp0launch-antigravity.ps1"
"@ | Set-Content -Path $LauncherBat -Encoding ASCII

Write-Host "      OK — Created: $LauncherBat" -ForegroundColor Green

# ── Done ──────────────────────────────────────────────────────────────────────
$LocalIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback' } | Select-Object -First 1).IPAddress

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "ALL SET" -ForegroundColor Green
Write-Host ""
Write-Host "  NEXT STEP (one time):"
Write-Host "  Right-click 'Launch Antigravity (OnPoint).bat'"
Write-Host "  -> Send to -> Desktop (shortcut)"
Write-Host "  Pin that shortcut to your Taskbar."
Write-Host "  Use it instead of the regular Antigravity icon."
Write-Host ""
Write-Host "  Phone URL: http://${LocalIP}:3000" -ForegroundColor Yellow
Write-Host ""
Write-Host "  To uninstall: .\uninstall-windows.ps1"
Write-Host "================================================" -ForegroundColor Cyan

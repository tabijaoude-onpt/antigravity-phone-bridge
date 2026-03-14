# OnPoint AG-Bridge — Windows Uninstaller
$TaskName = "OnPointAGBridge"

Write-Host ""
Write-Host "*** OnPoint AG-Bridge — Uninstall ***" -ForegroundColor Cyan
Stop-ScheduledTask   -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed Task Scheduler entry." -ForegroundColor Green
Write-Host "Your bridge files are untouched. Re-run install-windows.ps1 to reinstall."
Write-Host ""

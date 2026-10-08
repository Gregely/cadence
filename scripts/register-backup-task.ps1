# Register a daily Windows Task Scheduler job that runs scripts\backup.ps1.
# Run once in Windows PowerShell 5.1 (no administrator rights needed):
#   powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1 -At "03:17" -Dest "D:\cadence-backups"
param(
    [string]$At = "03:17",
    [string]$Dest = "",
    [string]$TaskName = "Cadence backup"
)

$ErrorActionPreference = "Stop"
$Script = Join-Path $PSScriptRoot "backup.ps1"
$Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`""
if ($Dest -ne "") { $Arguments = "$Arguments -Dest `"$Dest`"" }

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Arguments -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$Trigger = New-ScheduledTaskTrigger -Daily -At $At
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Daily SQLite online backup of Cadence (keeps 30)" -Force | Out-Null
Write-Host "Registered '$TaskName' to run daily at $At."
Write-Host "Run it now with:  Start-ScheduledTask -TaskName '$TaskName'"

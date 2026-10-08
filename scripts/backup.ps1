# Back up the Cadence database (Windows PowerShell 5.1 or later).
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -Db D:\cadence\cadence.sqlite3 -Dest D:\cadence-backups -Keep 30
# Exits with a non-zero code if the backup fails, so Task Scheduler shows it.
param(
    [string]$Db = "",
    [string]$Dest = "",
    [int]$Keep = 30
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    $Python = "python"
}

$Arguments = @("-m", "cadence.backup", "--keep", "$Keep")
if ($Db -ne "") { $Arguments += @("--db", $Db) }
if ($Dest -ne "") { $Arguments += @("--dest", $Dest) }

Push-Location $Root
try {
    & $Python @Arguments
    $Code = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $Code

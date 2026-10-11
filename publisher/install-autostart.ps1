# Makes Windows start the publisher (minimized) every time this user signs in.
# Run once:   powershell -ExecutionPolicy Bypass -File publisher\install-autostart.ps1
# Undo:       powershell -ExecutionPolicy Bypass -File publisher\install-autostart.ps1 -Remove
# It only adds one shortcut to this user's Startup folder; no administrator rights needed.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'hz-publisher.lnk'

if ($Remove) {
    if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Confirm:$false }
    Write-Host 'Autostart removed.'
    exit 0
}

$target = Join-Path $PSScriptRoot 'start-publisher.cmd'
if (-not (Test-Path $target)) { throw "Not found: $target" }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$shortcut.WindowStyle = 7
$shortcut.Description = 'Hengzhao publisher'
$shortcut.Save()
Write-Host "Autostart installed: $shortcutPath"

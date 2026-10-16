# Makes Windows start the publisher and the public-address tunnel (both minimized) every time this user signs in.
# Run once:   powershell -ExecutionPolicy Bypass -File publisher\install-autostart.ps1
# Undo:       powershell -ExecutionPolicy Bypass -File publisher\install-autostart.ps1 -Remove
# It only adds shortcuts to this user's Startup folder; no administrator rights needed.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$items = @(
    @{ Name = 'hz-publisher.lnk'; Target = 'start-publisher.cmd'; Description = 'Hengzhao publisher' },
    @{ Name = 'hz-tunnel.lnk'; Target = 'start-tunnel.cmd'; Description = 'Hengzhao public address' }
)

foreach ($item in $items) {
    $shortcutPath = Join-Path $startup $item.Name
    if ($Remove) {
        if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Confirm:$false }
        continue
    }
    $target = Join-Path $PSScriptRoot $item.Target
    if (-not (Test-Path $target)) { throw "Not found: $target" }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = Split-Path $PSScriptRoot -Parent
    $shortcut.WindowStyle = 7
    $shortcut.Description = $item.Description
    $shortcut.Save()
    Write-Host "Autostart installed: $shortcutPath"
}
if ($Remove) { Write-Host 'Autostart removed.' }

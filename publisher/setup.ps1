# Publisher environment setup (Windows). Safe to run again.
# Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM and can swallow lines.
# What it does: creates the Python virtualenv; downloads the open-source uploader social-auto-upload
# into vendor/ pinned to one commit; installs dependencies and the automation browser; points the
# uploader's login-state folder at publisher/state/ (never committed).
# Usage, from the repository root:  powershell -ExecutionPolicy Bypass -File publisher\setup.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $here 'vendor\social-auto-upload'
$venv = Join-Path $here '.venv'
$state = Join-Path $here 'state'
# Regression-test on the test account before changing this pin.
$sauCommit = '0012d2c355f88f683cc38dde2a2db209e14091bc'

if (-not (Test-Path (Join-Path $vendor '.git'))) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $vendor) | Out-Null
    git clone --quiet https://github.com/dreammis/social-auto-upload.git $vendor
}
git -C $vendor fetch --quiet origin $sauCommit
git -C $vendor checkout --quiet --detach $sauCommit
Write-Output "social-auto-upload pinned at $((git -C $vendor rev-parse --short HEAD))"

# The uploader needs conf.py in its root; BASE_DIR must be its own folder (it loads utils/stealth.min.js from there).
Copy-Item (Join-Path $here 'sau_conf.py') (Join-Path $vendor 'conf.py') -Force

# Login state (cookies) really lives in publisher/state/cookies; the uploader folder gets a junction to it.
New-Item -ItemType Directory -Force (Join-Path $state 'cookies') | Out-Null
$link = Join-Path $vendor 'cookies'
if (-not (Test-Path $link)) { cmd /c mklink /J "$link" "$(Join-Path $state 'cookies')" | Out-Null }

if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) { py -3.12 -m venv $venv }
$python = Join-Path $venv 'Scripts\python.exe'
& $python -m pip install --quiet --upgrade pip
& $python -m pip install --quiet -e $vendor
& $python -m pip install --quiet -r (Join-Path $here 'requirements.txt')
& $python -m patchright install chromium
Write-Output 'setup complete'

@echo off
rem Connects this PC's system (http://localhost:3000) to its fixed public address through a Cloudflare tunnel.
rem The tunnel key is HZ_TUNNEL_TOKEN in the project's .env (never committed). Close this window to take the address offline.
rem If the connection drops, it is started again after 15 seconds. install-autostart.ps1 runs this at sign-in.
chcp 65001 >nul
title HZ public address
cd /d "%~dp0.."
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "HZ_TUNNEL_TOKEN=" .env`) do set "TUNNEL_TOKEN=%%b"
if "%TUNNEL_TOKEN%"=="" (
  echo HZ_TUNNEL_TOKEN is missing from .env
  pause
  exit /b 1
)
set "CLOUDFLARED=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not exist "%CLOUDFLARED%" set "CLOUDFLARED=cloudflared"
:run
"%CLOUDFLARED%" tunnel --no-autoupdate run
echo Tunnel stopped, restarting in 15 seconds.
timeout /t 15 /nobreak >nul
goto run

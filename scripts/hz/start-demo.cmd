@echo off
rem Opens a temporary public link to the system for a demo. Close this window to take the link down.
rem The link changes every time. Everyone who opens it still has to sign in.
chcp 65001 >nul
title 恒兆演示链接
cd /d "%~dp0..\.."
tasklist /FI "IMAGENAME eq Docker Desktop.exe" 2>nul | find /I "Docker Desktop.exe" >nul
if errorlevel 1 if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
echo 正在确认系统已经启动...
:wait
curl -s -o nul -m 5 http://localhost:3000/login.html
if errorlevel 1 (
  docker compose -p hz-leasing up -d >nul 2>&1
  timeout /t 5 /nobreak >nul
  goto wait
)
echo.
echo 系统已启动。下面出现的 https://xxxx.trycloudflare.com 就是演示链接，发给对方即可。
echo 关掉这个窗口，链接立刻失效。
echo.
cloudflared tunnel --url http://localhost:3000 --no-autoupdate
pause

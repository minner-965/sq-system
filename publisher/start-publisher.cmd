@echo off
rem Starts the publisher and keeps it running. Close this window (or press Ctrl+C) to stop publishing.
rem It only posts content that has been confirmed in the "内容发布" page and has reached its scheduled time.
rem Updated program files: it exits with code 75 and is started again here at once.
rem Any other failure: it is started again after 15 seconds. A clean exit (code 0) ends the loop.
rem install-autostart.ps1 makes Windows run this file minimized at sign-in.
chcp 65001 >nul
title 恒兆发布程序
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."
rem The system itself runs in Docker. Start Docker Desktop if it is not running yet; the publisher waits for the database.
tasklist /FI "IMAGENAME eq Docker Desktop.exe" 2>nul | find /I "Docker Desktop.exe" >nul
if errorlevel 1 if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
:run
"%~dp0.venv\Scripts\python.exe" "%~dp0hz_publisher.py" run
if %errorlevel%==75 goto run
if %errorlevel%==0 goto done
echo 发布程序意外停止，15 秒后自动重新启动。
timeout /t 15 /nobreak >nul
goto run
:done
timeout /t 10 >nul

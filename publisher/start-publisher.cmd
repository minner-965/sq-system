@echo off
rem Starts the publisher. Keep this window open; close it (or press Ctrl+C) to stop publishing.
rem It only posts content that has been confirmed in the "内容发布" page and has reached its scheduled time.
rem When the program files are updated it exits with code 75 and is started again here, so the window never needs reopening.
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."
:run
"%~dp0.venv\Scripts\python.exe" "%~dp0hz_publisher.py" run
if %errorlevel%==75 goto run
pause

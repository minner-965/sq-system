@echo off
rem Starts the publisher. Keep this window open; close it (or press Ctrl+C) to stop publishing.
rem It only posts content that has been confirmed in the "内容发布" page and has reached its scheduled time.
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."
"%~dp0.venv\Scripts\python.exe" "%~dp0hz_publisher.py" run
pause

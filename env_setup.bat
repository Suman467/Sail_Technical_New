@echo off
REM Install the framework dependencies and Chromium.
REM Run this file from the project root.
call npm install
if errorlevel 1 exit /b 1
call npx playwright install chromium
if errorlevel 1 exit /b 1
echo Setup complete.

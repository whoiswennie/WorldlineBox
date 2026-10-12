@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" -Action Setup
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" echo Environment setup failed. Read the error above.
if not defined WORLDLINEBOX_BATCH_NO_PAUSE pause
exit /b %RESULT%

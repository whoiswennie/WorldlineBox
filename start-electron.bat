@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 世界线 Electron Launcher

cd /d "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot enter the project directory: %~dp0
    goto :failed
)

set "START_NO_PAUSE=0"
set "START_SMOKE=0"
for %%A in (%*) do (
    if /i "%%~A"=="--no-pause" set "START_NO_PAUSE=1"
    if /i "%%~A"=="--smoke-test" set "START_SMOKE=1"
)

set "PROJECT_NODE=%CD%\node_modules\node\bin\node.exe"
if not exist "%PROJECT_NODE%" goto :repair
if not exist "%CD%\apps\desktop\lib\main.mjs" goto :repair
goto :ready

:repair
echo [Repair] The built development environment is missing or incomplete.
call "%~dp0deploy.bat" --no-pause
if errorlevel 1 goto :failed

:ready
set "PATH=%CD%\node_modules\.bin;%CD%\node_modules\node\bin;%PATH%"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

set "PNPM_MODE="
where pnpm.cmd >nul 2>&1 && set "PNPM_MODE=pnpm"
if not defined PNPM_MODE (
    where corepack.cmd >nul 2>&1 && set "PNPM_MODE=corepack"
)
if not defined PNPM_MODE (
    echo [ERROR] pnpm or Corepack was not found.
    goto :failed
)

echo ==========================================
echo 世界线 Electron Launcher
echo Project Node:
"%PROJECT_NODE%" --version
echo ==========================================
echo.

echo [Prepare] Synchronizing the locked workspace dependencies...
call :pnpm install --frozen-lockfile
if errorlevel 1 goto :failed
echo.

if "%START_SMOKE%"=="1" (
    echo [Smoke] Starting the built Desktop shell and checking bounded exit...
    call :pnpm --filter worldline-box-desktop run smoke
) else (
    echo [Start] Rebuilding changed packages and starting the Desktop profile...
    call :pnpm run build
    if errorlevel 1 goto :failed
    call :pnpm exec electron .
)
set "APP_EXIT=%ERRORLEVEL%"
if not "%APP_EXIT%"=="0" goto :failed

echo.
echo Application closed normally.
if "%START_NO_PAUSE%"=="0" pause
exit /b 0

:pnpm
if /i "%PNPM_MODE%"=="pnpm" (
    call pnpm.cmd %*
) else (
    call corepack.cmd pnpm %*
)
exit /b %ERRORLEVEL%

:failed
set "START_EXIT=%ERRORLEVEL%"
if "%START_EXIT%"=="0" set "START_EXIT=1"
echo.
echo The launcher stopped. Review the error above.
if "%START_NO_PAUSE%"=="0" pause
exit /b %START_EXIT%

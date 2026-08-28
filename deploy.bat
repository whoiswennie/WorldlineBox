@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 世界线 Deployment

cd /d "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot enter the project directory: %~dp0
    goto :failed
)

set "DEPLOY_NO_PAUSE=0"
for %%A in (%*) do if /i "%%~A"=="--no-pause" set "DEPLOY_NO_PAUSE=1"

echo ==========================================
echo 世界线 Environment Deployment
echo ==========================================
echo Working directory: %CD%
echo.

where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] A bootstrap Node.js installation is required.
    echo Install Node.js 22 LTS or newer, then run this file again.
    goto :failed
)

node.exe -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||a===22&&b>=0?0:1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Bootstrap Node.js 22 or newer is required.
    goto :failed
)

set "PNPM_MODE="
where pnpm.cmd >nul 2>&1 && set "PNPM_MODE=pnpm"
if not defined PNPM_MODE (
    where corepack.cmd >nul 2>&1 && set "PNPM_MODE=corepack"
)
if not defined PNPM_MODE (
    echo [ERROR] pnpm or Corepack was not found.
    echo Install pnpm 11.7.0 or enable Corepack, then retry.
    goto :failed
)

set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

echo [1/5] Installing the locked workspace dependencies...
call :pnpm install --frozen-lockfile
if errorlevel 1 goto :failed

set "PROJECT_NODE=%CD%\node_modules\node\bin\node.exe"
if not exist "%PROJECT_NODE%" (
    echo [ERROR] The project-pinned Node runtime was not installed:
    echo   %PROJECT_NODE%
    goto :failed
)
set "PATH=%CD%\node_modules\.bin;%CD%\node_modules\node\bin;%PATH%"
echo Project Node runtime:
"%PROJECT_NODE%" --version
"%PROJECT_NODE%" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a===22&&b>=19)||(a>=24&&a<27)?0:1)"
if errorlevel 1 (
    echo [ERROR] The project Node runtime does not satisfy package.json engines.
    goto :failed
)

set "ELECTRON_EXE=%CD%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
    echo [Repair] Electron binaries are missing. Rebuilding the locked Electron package...
    call :pnpm rebuild electron
    if errorlevel 1 goto :failed
    if not exist "%ELECTRON_EXE%" (
        echo [ERROR] Electron rebuild completed without producing:
        echo   %ELECTRON_EXE%
        goto :failed
    )
)

echo.
echo [2/5] Verifying runtime identity and removed legacy surfaces...
call :pnpm run verify:runtime-brand
if errorlevel 1 goto :failed

echo.
echo [3/5] Building Host, Client, Web, CLI and Desktop...
call :pnpm run build
if errorlevel 1 goto :failed

echo.
echo [4/5] Assembling and probing the deployed Cordis runtime...
call :pnpm run package:runtime
if errorlevel 1 goto :failed

echo.
echo [5/5] Running the Desktop smoke test...
call :pnpm --filter worldline-box-desktop run smoke
if errorlevel 1 goto :failed

echo.
echo ==========================================
echo Deployment completed successfully.
echo You can now run start-electron.bat or build-exe.bat.
echo ==========================================
if "%DEPLOY_NO_PAUSE%"=="0" pause
exit /b 0

:pnpm
if /i "%PNPM_MODE%"=="pnpm" (
    call pnpm.cmd %*
) else (
    call corepack.cmd pnpm %*
)
exit /b %ERRORLEVEL%

:failed
set "DEPLOY_EXIT=%ERRORLEVEL%"
if "%DEPLOY_EXIT%"=="0" set "DEPLOY_EXIT=1"
echo.
echo Deployment failed. Review the error above.
if "%DEPLOY_NO_PAUSE%"=="0" pause
exit /b %DEPLOY_EXIT%

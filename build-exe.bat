@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
title Worldline EXE Build

cd /d "%~dp0"
if not "!ERRORLEVEL!"=="0" (
    echo [ERROR] Cannot enter the project directory: %~dp0
    goto :failed
)

set "BUILD_NO_PAUSE=0"
set "BUILD_FAST=0"
for %%A in (%*) do if /i "%%~A"=="--no-pause" set "BUILD_NO_PAUSE=1"
for %%A in (%*) do if /i "%%~A"=="--fast" set "BUILD_FAST=1"

set "PROJECT_NODE=%CD%\node_modules\node\bin\node.exe"
if not exist "%PROJECT_NODE%" (
    echo [Repair] The project environment is not installed. Running deploy.bat...
    call "%~dp0deploy.bat" --no-pause
    if not "!ERRORLEVEL!"=="0" goto :failed
)

set "PATH=%CD%\node_modules\.bin;%CD%\node_modules\node\bin;%PATH%"
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
if "%BUILD_FAST%"=="1" (
    set "DESKTOP_RELEASE=%CD%\release\desktop-fast"
) else (
    set "DESKTOP_RELEASE=%CD%\release\desktop"
)

set "PRODUCT_NAME="
set "PRODUCT_NAME_FILE=%TEMP%\worldline-product-name-!RANDOM!-!RANDOM!.tmp"
"%PROJECT_NODE%" -p "require('./apps/desktop/package.json').build.productName" > "!PRODUCT_NAME_FILE!"
if not "!ERRORLEVEL!"=="0" goto :failed
set /p "PRODUCT_NAME="<"!PRODUCT_NAME_FILE!"
del /q "!PRODUCT_NAME_FILE!" >nul 2>&1
if not defined PRODUCT_NAME (
    echo [ERROR] The desktop product name could not be read.
    goto :failed
)

set "PNPM_MODE="
where pnpm.cmd >nul 2>&1 && set "PNPM_MODE=pnpm"
if not defined PNPM_MODE (
    where corepack.cmd >nul 2>&1 && set "PNPM_MODE=corepack"
)
if not defined PNPM_MODE (
    echo [ERROR] pnpm or Corepack was not found.
    goto :failed
)

set "ELECTRON_EXE=%CD%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
    echo [Repair] Electron binaries are missing. Rebuilding the locked Electron package...
    call :pnpm rebuild electron
    if not "!ERRORLEVEL!"=="0" goto :failed
    if not exist "%ELECTRON_EXE%" (
        echo [ERROR] Electron rebuild completed without producing:
        echo   %ELECTRON_EXE%
        goto :failed
    )
)

echo ==========================================
echo Worldline Windows Installer Build
echo Project Node:
"%PROJECT_NODE%" --version
echo ==========================================
echo.

echo [1/3] Building and assembling the production runtime...
call :pnpm --config.confirmModulesPurge=false install --frozen-lockfile
if not "!ERRORLEVEL!"=="0" goto :failed
call :pnpm run build
if not "!ERRORLEVEL!"=="0" goto :failed
call :pnpm run package:runtime
if not "!ERRORLEVEL!"=="0" goto :failed
pushd "%CD%\apps\desktop"
if not "!ERRORLEVEL!"=="0" goto :failed
if "%BUILD_FAST%"=="1" (
    echo [Fast mode] Building the unpacked desktop application for the custom installer.
    "%PROJECT_NODE%" "..\..\node_modules\electron-builder\cli.js" --win --dir --config.directories.output=../../release/desktop-fast
) else (
    echo [Release mode] Building the unpacked desktop application for the custom installer.
    "%PROJECT_NODE%" "..\..\node_modules\electron-builder\cli.js" --win --dir
)
set "BUILDER_EXIT=!ERRORLEVEL!"
popd
if not "!BUILDER_EXIT!"=="0" (
    set "BUILD_EXIT=!BUILDER_EXIT!"
    goto :failed
)

echo.
echo [2/3] Running the unpacked EXE smoke test...
set "UNPACKED_EXE=!DESKTOP_RELEASE!\win-unpacked\!PRODUCT_NAME!.exe"
if not exist "%UNPACKED_EXE%" (
    echo [ERROR] Packaged application executable was not found:
    echo   %UNPACKED_EXE%
    goto :failed
)
"%PROJECT_NODE%" "%CD%\scripts\smoke-packaged-desktop.mjs" "!DESKTOP_RELEASE!\win-unpacked"
if not "!ERRORLEVEL!"=="0" goto :failed

echo.
echo [3/3] Building the native WorldlineBox installer and uninstaller...
set "APP_VERSION="
set "VERSION_FILE=%TEMP%\worldline-app-version-!RANDOM!-!RANDOM!.tmp"
"%PROJECT_NODE%" -p "require('./apps/desktop/package.json').version" > "!VERSION_FILE!"
if not "!ERRORLEVEL!"=="0" goto :failed
set /p "APP_VERSION="<"!VERSION_FILE!"
del /q "!VERSION_FILE!" >nul 2>&1
if not defined APP_VERSION (
    echo [ERROR] The desktop application version could not be read.
    goto :failed
)
set "INSTALLER_EXE=!DESKTOP_RELEASE!\WorldlineBox-Setup-!APP_VERSION!.exe"
"%PROJECT_NODE%" "%CD%\scripts\build-custom-installer.mjs" --input "!DESKTOP_RELEASE!\win-unpacked" --output "!INSTALLER_EXE!" --version "!APP_VERSION!"
if not "!ERRORLEVEL!"=="0" goto :failed
if not exist "!INSTALLER_EXE!" (
    echo [ERROR] The custom WorldlineBox installer was not generated.
    echo   !INSTALLER_EXE!
    goto :failed
)
"%PROJECT_NODE%" "%CD%\scripts\generate-update-manifest.mjs" --installer "!INSTALLER_EXE!" --output "%CD%\latest.yml" --version "!APP_VERSION!"
if not "!ERRORLEVEL!"=="0" goto :failed
if not exist "%CD%\latest.yml" (
    echo [ERROR] The root update manifest was not generated.
    goto :failed
)

echo.
echo ==========================================
echo Windows installer generated successfully:
echo !INSTALLER_EXE!
echo Update manifest generated successfully:
echo %CD%\latest.yml
echo ==========================================
if "%BUILD_NO_PAUSE%"=="0" pause
exit /b 0

:pnpm
if /i "%PNPM_MODE%"=="pnpm" (
    call pnpm.cmd %*
) else (
    call corepack.cmd pnpm %*
)
exit /b %ERRORLEVEL%

:failed
if not defined BUILD_EXIT set "BUILD_EXIT=%ERRORLEVEL%"
if "%BUILD_EXIT%"=="0" set "BUILD_EXIT=1"
echo.
echo EXE packaging failed. Review the error above.
if "%BUILD_NO_PAUSE%"=="0" pause
exit /b %BUILD_EXIT%

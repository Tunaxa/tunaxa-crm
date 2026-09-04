@echo off
setlocal
cd /d "%~dp0"
title Tunaxa CRM

where node >nul 2>nul
if errorlevel 1 goto node_missing

where npm >nul 2>nul
if errorlevel 1 goto npm_missing

if not exist "node_modules\vite\bin\vite.js" goto install
if not exist "node_modules\express\package.json" goto install
if not exist "node_modules\multer\package.json" goto install
if not exist "node_modules\react\package.json" goto install
if not exist "node_modules\react-dom\package.json" goto install
if not exist "node_modules\react-router-dom\package.json" goto install
goto run

:install
echo Preparing Tunaxa...
call npm install --no-audit --no-fund
if errorlevel 1 goto install_failed

:run
node start.js
if errorlevel 1 (
  echo.
  echo Tunaxa stopped because of an error.
  pause
)
exit /b

:node_missing
echo Node.js 18 or newer is required.
echo Install Node.js, then open start.bat again.
pause
exit /b 1

:npm_missing
echo npm was not found with Node.js.
echo Reinstall Node.js, then open start.bat again.
pause
exit /b 1

:install_failed
echo.
echo Dependencies could not be installed.
echo Check your internet connection and try start.bat again.
pause
exit /b 1

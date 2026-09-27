@echo off
setlocal
title Chess AI Tutor
cd /d "%~dp0"

if not defined PORT set "PORT=3717"
set "URL=http://127.0.0.1:%PORT%"

echo.
echo  ==============================
echo    Chess AI Tutor
echo  ==============================
echo.

rem --- Node.js is required ---
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed.
  echo  Install the LTS version from https://nodejs.org/ and then run this file again.
  echo.
  pause
  exit /b 1
)

rem --- Already running? Just open the browser. ---
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Uri '%URL%/api/status' -TimeoutSec 2; if ($r.PSObject.Properties.Name -contains 'stockfish') { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  echo  The tutor is already running. Opening %URL%
  if not defined NO_BROWSER start "" "%URL%"
  timeout /t 3 >nul
  exit /b 0
)

rem --- First run: install packages ---
if not exist "node_modules\chess.js" (
  echo  Installing packages. This only happens once...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo  npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo.
)

rem --- First run: download Stockfish and piece images ---
set "NEED_SETUP="
if not exist "bin\stockfish" set "NEED_SETUP=1"
if not exist "public\pieces\wK.svg" set "NEED_SETUP=1"
if defined NEED_SETUP (
  echo  Downloading the Stockfish engine. This only happens once...
  call npm run setup
  if errorlevel 1 (
    echo.
    echo  Setup failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo.
)

rem --- Open the browser as soon as the server answers ---
if not defined NO_BROWSER (
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri '%URL%/api/status' -TimeoutSec 1 | Out-Null; Start-Process '%URL%'; break } catch { Start-Sleep -Milliseconds 500 } }"
)

echo  Starting at %URL%
echo  Keep this window open while you use the tutor. Close it to stop.
echo.
node server\index.js
echo.
echo  The server stopped.
pause

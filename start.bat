@echo off
setlocal
cd /d "%~dp0"
title Lumen Studio - Close this window to stop
set "LUMEN_NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%LUMEN_NODE%" set "LUMEN_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%LUMEN_NODE%" set "LUMEN_NODE=node"
"%LUMEN_NODE%" scripts/dev.mjs --open
set "LUMEN_EXIT=%errorlevel%"
if not "%LUMEN_EXIT%"=="0" (
 echo.
 echo Startup failed. Node.js 20.3 or later is required. Check the error above.
 pause
)
exit /b %LUMEN_EXIT%

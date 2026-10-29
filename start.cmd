@echo off
cd /d "%~dp0"
title Lumen Studio - Close this window to stop
set "LUMEN_NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%LUMEN_NODE%" set "LUMEN_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%LUMEN_NODE%" set "LUMEN_NODE=node"
"%LUMEN_NODE%" scripts/dev.mjs --open
if errorlevel 1 (
 echo.
 echo Startup failed. Check the error above.
 pause
)

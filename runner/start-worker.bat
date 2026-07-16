@echo off
setlocal
chcp 65001 >nul

rem openclaw-tunnel Windows runner launcher.
rem Edit these values here, or set them in the environment before running this file.

cd /d "%~dp0"

set "RUNTIME_ENV=%~dp0..\.runtime\runner.env"
if exist "%RUNTIME_ENV%" (
  echo Starting openclaw-tunnel runner with scoped runtime config
  node "--env-file=%RUNTIME_ENV%" worker.js
  if errorlevel 1 exit /b 1
  exit /b 0
)

if "%WORKER_URL%"=="" set "WORKER_URL=http://127.0.0.1:3456"
if "%CLAUDE_PATH%"=="" set "CLAUDE_PATH=claude"
if "%CODEX_PATH%"=="" set "CODEX_PATH=codex"
if "%GEMINI_PATH%"=="" set "GEMINI_PATH=gemini"
if "%CC_TIMEOUT%"=="" set "CC_TIMEOUT=1200000"
if "%RUNNER_SESSION_CACHE_FILE%"=="" set "RUNNER_SESSION_CACHE_FILE=%TEMP%\openclaw-runner-session-cache.json"
if "%CC_LOG_PATH%"=="" set "CC_LOG_PATH=%TEMP%\cc-live.log"
if "%WORKER_DIRECT_CALLBACK%"=="" set "WORKER_DIRECT_CALLBACK=false"

if "%WORKER_TOKEN%"=="" (
  echo WORKER_TOKEN is required. Set it before running start-worker.bat.
  echo Example:
  echo   set "WORKER_TOKEN=your-token"
  exit /b 1
)

if not exist "%TEMP%" mkdir "%TEMP%"

echo Starting openclaw-tunnel runner
echo WORKER_URL=%WORKER_URL%
echo RUNNER_SESSION_CACHE_FILE=%RUNNER_SESSION_CACHE_FILE%
node worker.js

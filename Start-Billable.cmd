@echo off
setlocal
cd /d "%~dp0"
node -e "const [a,b,c]=process.versions.node.split('.').map(Number);if(a!==24||b<14||(b===14&&c<1))process.exit(1)" >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 LTS version 24.14.1 or later in the 24 series, then open this file again.
  echo https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\better-sqlite3" (
  rem Prebuilt SQLite binaries are bundled; install scripts would try to compile them. See .npmrc.
  call npm ci --ignore-scripts
  if errorlevel 1 goto failed
)
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 goto failed
)
echo Open http://127.0.0.1:4318 in your browser. Keep this window open.
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Billable could not start. Read the message above and README.md.
pause
exit /b 1

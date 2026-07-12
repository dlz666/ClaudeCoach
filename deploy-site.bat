@echo off
cd /d "%~dp0"

echo ============================================
echo   ClaudeCoach Lecture Site
echo ============================================
echo.

REM ---- build ----
echo [1/2] Building...
node scripts\build-readonly-site.mjs
if errorlevel 1 (
    echo.
    echo [ERROR] build failed
    pause
    goto :eof
)

REM ---- deploy ----
echo.
echo [2/2] Deploying...
call wrangler pages deploy dist-site --project-name claudecoach-lectures --branch production

echo.
echo ============================================
echo   Done! https://lectures.dev-leisure.com
echo ============================================
echo.
pause

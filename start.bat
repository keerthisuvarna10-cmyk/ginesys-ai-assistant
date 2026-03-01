@echo off
title Ginesys AI Assistant
cd /d "%~dp0"

echo.
echo ==========================================
echo   Ginesys AI Assistant
echo ==========================================
echo.

:: Kill any existing process on port 3000 silently
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 " 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:start
echo [%time%] Starting server...
node src/server.js
echo.
echo [%time%] Server stopped. Restarting in 2 seconds...
timeout /t 2 /nobreak >nul
goto start

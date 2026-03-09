@echo off
cd /d "%~dp0"
title MAERS install_deps

echo ==========================================
echo   MAERS - Install Dependencies
echo ==========================================
echo.

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [Error] Python not found!
    echo Please install Python and check "Add Python to PATH"
    echo Download: https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)

python install_deps.py

echo.
pause

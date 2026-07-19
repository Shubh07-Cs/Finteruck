@echo off
title Setup and Launch
cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

if not exist .env (
    echo Creating .env template...
    copy .env.example .env
    echo.
    echo WARNING: .env file created!
    echo Please open .env and insert your API keys, then run this script again.
    echo.
    pause
    exit /b
)

echo Starting stealth app...
cscript //nologo start-stealth.vbs

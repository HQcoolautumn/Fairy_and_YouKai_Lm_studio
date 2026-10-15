@echo off
title FAIRY // LOCAL MODEL LINK
cd /d "%~dp0"
echo.
echo   =====================================================
echo      FAIRY // LOCAL MODEL LINK   -   starting...
echo.
echo      Requirement: LM Studio is running and its local
echo      server is ON (default port 1234).
echo      The UI opens as a fullscreen window; press ESC
echo      to leave fullscreen.
echo   =====================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-fairy.ps1"
if errorlevel 1 (
  echo.
  echo   Retrying in compatibility mode...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "& { Set-ExecutionPolicy -Scope Process Bypass -Force; & '%~dp0start-fairy.ps1' }"
)
echo.
echo   Finished. If nothing opened, read README.txt here.
pause

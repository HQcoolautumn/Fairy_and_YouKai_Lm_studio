@echo off
title Stop FAIRY
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-fairy.ps1"
pause

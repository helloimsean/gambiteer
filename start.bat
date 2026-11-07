@echo off
rem Gambiteer: double-click this file to start the app.
rem It runs start.ps1 with Windows PowerShell, bypassing the script execution policy for this run only.
rem Arguments are passed on, for example:  start.bat -Rebuild   or   start.bat -Port 8001 -NoBrowser
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
exit /b %ERRORLEVEL%

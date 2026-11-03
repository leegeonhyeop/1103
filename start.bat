@echo off
cd /d "%~dp0"
echo Restaurant map server: http://localhost:3000
echo Close this window to stop the server.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process http://localhost:3000"
node server.js
pause

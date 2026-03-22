@echo off
:reinicio
echo [AUTO-RESTART] Iniciando bot... %DATE% %TIME%
node index.js
echo [AUTO-RESTART] El bot se detuvo con codigo %ERRORLEVEL%. Reiniciando en 5 segundos...
timeout /t 5 /nobreak >nul
goto reinicio

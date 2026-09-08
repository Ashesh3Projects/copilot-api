@echo off
echo ================================================
echo GitHub Copilot API Server with Operator Dashboard
echo ================================================
echo.

if not exist node_modules (
    echo Installing dependencies...
    bun install
    echo.
)

echo Both Turso variables are optional. Without them, SQLite uses the local data directory.
echo For first setup, run: bun src/main.ts admin --setup-code

echo Starting server...
echo The operator dashboard will open automatically after the server starts
echo.

start "" "http://127.0.0.1:4141/dashboard"
bun run dev start --host 127.0.0.1

pause

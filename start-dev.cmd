@echo off
rem CodeConClave: double-click to start the API, the web app and the demo MCP server.
rem Close this window (or press Ctrl+C) to stop everything.
cd /d "%~dp0"
node scripts\dev-all.mjs %*
pause

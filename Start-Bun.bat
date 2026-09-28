@echo off
REM Force Neconyan to use Bun instead of Node.js.
setlocal
set "NECONYAN_USE_NODE="
set "NECONYAN_USE_BUN=1"
call "%~dp0Start.bat" %*
set "_exit=%errorlevel%"
endlocal & exit /b %_exit%

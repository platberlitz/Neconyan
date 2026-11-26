@echo off
setlocal
pushd "%~dp0"
echo ========================================================================================================================
echo WARNING: Cloudflare Tunnel!
echo ========================================================================================================================
echo This script downloads and runs a pinned, checksum-verified cloudflared.exe from Cloudflare to set up an HTTPS tunnel to your Neconyan!
echo Using the randomly generated temporary tunnel URL, anyone can access your Neconyan over the Internet while the tunnel
echo is active. Keep the URL safe and secure your Neconyan installation by setting a username and password in config.yaml!
echo.
echo See https://platberlitz.github.io/neconyan-docs/start/phone/ for Neconyan connection and remote-access guidance.
echo.
echo By continuing you confirm that you're aware of the potential dangers of having a tunnel open and take all responsibility
echo to properly use and secure it!
echo.
echo To abort, press Ctrl+C or close this window now!
echo.
pause
set "CLOUDFLARED_VERSION=2026.11.2"
set "CLOUDFLARED_SHA256=555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113"
set "CLOUDFLARED_URL=https://github.com/cloudflare/cloudflared/releases/download/%CLOUDFLARED_VERSION%/cloudflared-windows-amd64.exe"
if not exist "%~dp0cloudflared.exe" (
    curl -fsSL -o "%~dp0cloudflared.exe.download" "%CLOUDFLARED_URL%"
    if errorlevel 1 (
        echo Could not download cloudflared %CLOUDFLARED_VERSION%.
        del "%~dp0cloudflared.exe.download" > nul 2>&1
        goto end
    )
    move /Y "%~dp0cloudflared.exe.download" "%~dp0cloudflared.exe" > nul
)
set "CLOUDFLARED_ACTUAL="
for /f "usebackq delims=" %%H in (`powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath '%~dp0cloudflared.exe').Hash.ToLowerInvariant()"`) do set "CLOUDFLARED_ACTUAL=%%H"
if /I not "%CLOUDFLARED_ACTUAL%"=="%CLOUDFLARED_SHA256%" (
    echo cloudflared.exe does not match the pinned SHA-256 checksum for %CLOUDFLARED_VERSION%. Refusing to run it.
    echo Delete cloudflared.exe and run this script again to download a fresh copy.
    goto end
)
"%~dp0cloudflared.exe" tunnel --url localhost:4433

:end
popd
endlocal

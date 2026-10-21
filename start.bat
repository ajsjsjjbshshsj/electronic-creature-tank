@echo off
REM start.bat —— 双击启动：起服务器 + 开浏览器（spec §3.1）。
REM spec §1 原则 5：十年后双击它还能打开，所以这里不依赖任何需要安装的东西。
chcp 65001 >nul
cd /d "%~dp0"
set "PORT=8123"

REM 服务器开在独立窗口里：它的日志不和这个窗口混，关掉那个窗口就等于停服务器。
REM -NoBrowser 是因为浏览器由下面这行在服务器**起来之后**打开；
REM 让 server.ps1 自己开的话它会先于监听就绪，浏览器拿到连接拒绝，用户得手动刷新。
start "电子生物缸 · 服务器（关掉此窗口即停止）" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port %PORT% -NoBrowser

timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%/"

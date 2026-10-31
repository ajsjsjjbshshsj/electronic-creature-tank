@echo off
REM enable-lan.bat —— 双击它：弹 UAC → 跑 enable-lan.ps1 → 开通局域网/Tailscale 访问。
REM 为什么单独一个 .bat：.ps1 双击默认是"用记事本打开"，而这里需要的恰恰是"以管理员运行"。
REM 这个脚本**不做**任何静默提权：UAC 弹窗必须由你点"是"。
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','%~dp0enable-lan.ps1'"

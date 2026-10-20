@echo off
chcp 65001 >nul
title 页签 WebMarker 一键注册
echo ==========================================
echo   页签 WebMarker - 自动注册本地服务
echo ==========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto-register.ps1"
echo.
echo 脚本执行结束。
pause

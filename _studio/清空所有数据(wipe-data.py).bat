@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================================
echo        MAERS 核心数据销毁工具 (WIPE ALL DATA)
echo ========================================================
echo.
echo 警告：此脚本将删除所有：
echo 1. 笔记、随笔、文献内容
echo 2. 相册记录及所有物理图片
echo 3. 音乐播放列表
echo.
echo 此操作不可撤销，请谨慎操作！！！
echo.

pause

python wipe-data.py

echo.
echo 如果操作已执行，请手动刷新管理后台页面。
pause

@echo off
chcp 65001
echo 正在启动数据清理程序...
cd /d "%~dp0"
python zclean_data.py
pause

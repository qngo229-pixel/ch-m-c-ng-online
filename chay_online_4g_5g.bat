@echo off
chcp 65001 > nul
title Chấm Công Online 4G / 5G
cls
echo ===============================================================
echo   🌐 KHỞI CHẠY CHẤM CÔNG DÙNG MẠNG 4G / 5G / INTERNET
echo   ⚡ Không cần chung mạng Wi-Fi - Nhân viên chấm công mọi nơi
echo ===============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LỖI] Chưa tìm thấy Node.js trên máy tính!
    pause
    exit /b
)

:: Khởi chạy máy chủ Node.js trong cửa sổ riêng biệt
start "MayChu_ChamCong_Port3000" cmd /c "node server.js"

echo [1/2] Đã khởi chạy máy chủ nội bộ trên cổng 3000.
echo [2/2] Đang tạo đường link HTTPS công khai cho mạng 4G / 5G...
echo.
echo ===============================================================
echo  👉 ĐƯỜNG LINK HTTPS SẼ HIỂN THỊ DƯỚI ĐÂY:
echo     (Hãy copy đường link có dạng https://.... gửi cho nhân viên qua Zalo)
echo ===============================================================
echo.

:: Kết nối đường hầm OpenSSH tích hợp sẵn của Windows
ssh -o StrictHostKeyChecking=no -R 80:localhost:3000 nokey@localhost.run
if %errorlevel% neq 0 (
    echo.
    echo [Dự phòng] Đang chuyển sang máy chủ đường hầm Pinggy...
    ssh -o StrictHostKeyChecking=no -p 443 -R 0:localhost:3000 a.pinggy.io
)

pause

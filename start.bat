@echo off
chcp 65001 > nul
title Ứng Dụng Chấm Công GPS 15 Người
cls
echo ===============================================================
echo   🏢 HỆ THỐNG CHẤM CÔNG GPS 15 NGƯỜI GỌN NHẸ
echo   ⚡ 1 Nút Chạm - Tự Đổi Vào/Ra Ca - Mã Hóa PIN - Nhớ 30 Ngày
echo ===============================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LỖI] Chưa tìm thấy Node.js trên máy tính!
    echo Vui lòng cài đặt Node.js từ https://nodejs.org trước khi chạy.
    echo.
    pause
    exit /b
)

echo Đang khởi động máy chủ chấm công...
echo.
node server.js
if %errorlevel% neq 0 (
    echo.
    echo [LỖI] Máy chủ đã dừng lại với mã lỗi %errorlevel%.
    pause
)

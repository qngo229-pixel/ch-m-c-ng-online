@echo off
chcp 65001 > nul
title Đẩy Mã Nguồn Lên GitHub - cham-cong-online
cls
echo ===============================================================
echo   🚀 TỰ ĐỘNG ĐẨY MÃ NGUỒN LÊN GITHUB
echo   📂 Kho lưu trữ: https://github.com/qngo229-pixel/ch-m-c-ng-online.git
echo ===============================================================
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [THÔNG BÁO] Máy tính của bạn hiện chưa cài đặt Git.
    echo.
    echo Bạn có 2 lựa chọn:
    echo 1. Tải Git về cài đặt từ: https://git-scm.com/download/win
    echo 2. HOẶC tải file trực tiếp trên web GitHub (không cần cài gì):
    echo    👉 https://github.com/qngo229-pixel/ch-m-c-ng-online/upload
    echo.
    echo Đang mở trình duyệt đến trang tải file của GitHub để bạn kéo thả file vào...
    start https://github.com/qngo229-pixel/ch-m-c-ng-online/upload
    pause
    exit /b
)

echo [1/4] Khởi tạo Git repository nội bộ...
if not exist ".git" (
    git init
)

echo [2/4] Cấu hình liên kết đến GitHub...
git remote remove origin >nul 2>nul
git remote add origin https://github.com/qngo229-pixel/ch-m-c-ng-online.git
git branch -M main

echo [3/4] Gom toàn bộ file mã nguồn...
git add .

echo [4/4] Đóng gói và đẩy lên GitHub...
git commit -m "Khoi tao ung dung cham cong GPS kem chup anh mat 15 nguoi" >nul 2>nul
echo.
echo ===============================================================
echo 👉 Đang đẩy mã nguồn lên GitHub...
echo (Nếu có cửa sổ hỏi đăng nhập GitHub xuất hiện, hãy nhấn Xác nhận)
echo ===============================================================
echo.
git push -u origin main

if %errorlevel% equ 0 (
    echo.
    echo ===============================================================
    echo 🎉 THÀNH CÔNG! Đã đẩy toàn bộ mã nguồn lên GitHub!
    echo 👉 Xem ngay tại: https://github.com/qngo229-pixel/ch-m-c-ng-online
    echo ===============================================================
) else (
    echo.
    echo [LƯU Ý] Nếu đẩy bằng lệnh gặp lỗi xác thực, bạn có thể tải trực tiếp
    echo bằng cách mở link sau và kéo thả file vào:
    echo 👉 https://github.com/qngo229-pixel/ch-m-c-ng-online/upload
)

echo.
pause

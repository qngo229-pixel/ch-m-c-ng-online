# 🏢 Ứng Dụng Chấm Công GPS 15 Người (4G/5G, Gọn Nhẹ & Chống Gian Lận)

Ứng dụng web chấm công nội bộ gọn nhẹ dành cho đội ngũ **15 nhân viên**, thiết kế tối ưu cho điện thoại và máy tính, **hoạt động ngay tức thì** mà không cần cài đặt các thư viện rườm rà (Zero external dependencies - chạy thuần trên Node.js và SQLite tích hợp).

---

## 🌟 Điểm Nổi Bật & Cải Tiến Mới Nhất

1. **Chấm công mọi nơi qua mạng 4G / 5G (Không cần chung Wi-Fi)**:
   - Hỗ trợ đường hầm HTTPS trực tiếp qua file `chay_online_4g_5g.bat`.
   - Nhân viên ở bất kỳ đâu (đi công tác, tại chi nhánh, ngoài đường, ở nhà) chỉ cần bật mạng **4G hoặc 5G** là chấm công được ngay mà không cần kết nối vào Wi-Fi văn phòng.
2. **Bảo mật tuyệt đối - Chống gian lận chấm công hộ**:
   - Màn hình đăng nhập đã **loại bỏ hoàn toàn các nút/thông tin tài khoản mẫu**, không nhân viên nào có thể nhìn thấy số điện thoại hay mã PIN của đồng nghiệp.
   - Mỗi nhân viên chỉ đăng nhập trên điện thoại của chính mình **1 lần duy nhất (máy nhớ 30 ngày)**.
   - **Mã hóa Scrypt**: Mật khẩu PIN (4-6 số) được băm một chiều với Salt ngẫu nhiên 16 bytes.
   - **Khóa 5 phút khi nhập sai 5 lần**: Ngăn chặn hoàn toàn hành vi đoán mò hoặc dò mã PIN của người khác.
3. **Tối ưu hóa định vị GPS trên điện thoại di động**:
   - **Cơ chế đánh thức trước (Pre-warm GPS)**: Tự động kích hoạt chip GPS ngầm ngay khi mở app, giúp lúc bấm nút lấy được vị trí siêu nhanh (dưới 1 giây).
   - **Định vị 2 lớp thông minh**: Ưu tiên bắt vệ tinh GPS độ chính xác cao (±3m - ±15m). Nếu nhân viên đứng trong nhà/tòa nhà che khuất vệ tinh, hệ thống tự động chuyển sang chế độ hỗ trợ trạm phát sóng 4G/5G để không bao giờ bị đơ hoặc lỗi timeout.
   - Hiển thị phản hồi trực tiếp: `🛰️ Đang kết nối vệ tinh GPS...` ➔ `📍 Đang lưu tọa độ & sai số`.
4. **Một nút bấm duy nhất - Tự động đảo ca**:
   - Nếu chưa vào ca: Nút hiển thị màu xanh lá 🟢 **"VÀO CA"**.
   - Nếu đang trong ca: Nút tự động chuyển sang màu cam/đỏ 🔴 **"RA CA"**.
   - Có âm thanh chúc mừng (Web Audio) và rung phản hồi (Haptic) trên điện thoại.
5. **Giao diện Quản lý (Admin Panel)**:
   - **Xem lịch sử của toàn bộ 15 người**: Bảng dữ liệu hiển thị rõ ràng từng lượt chấm công.
   - **Mỗi dòng có link bản đồ**: Nút `📍 Xem bản đồ` mở trực tiếp vị trí trên Google Maps (`https://www.google.com/maps?q=lat,lng`).
   - **Xuất Excel (CSV)**: Tải file báo cáo chuẩn UTF-8 BOM, mở bằng Excel hiển thị tiếng Việt chuẩn 100%.
   - **Quản lý nhân sự**: Thêm nhân viên, Đổi PIN, Khóa / Mở khóa tài khoản ngay lập tức.

---

## 🚀 Hướng Dẫn Khởi Chạy

### 👉 Cách 1: Chấm công qua mạng di động 4G / 5G (Khuyên dùng)
1. Nhấp đúp vào file **`chay_online_4g_5g.bat`**.
2. Cửa sổ dòng lệnh sẽ hiển thị một đường link HTTPS công khai (ví dụ: `https://xxxx.lhr.life`).
3. Quản lý chỉ cần copy link đó gửi cho nhân viên qua Zalo. Nhân viên dùng **4G hoặc 5G** bấm vào là chấm công được ngay!

### 👉 Cách 2: Chấm công nội bộ máy tính / Wi-Fi văn phòng
1. Nhấp đúp vào file **`start.bat`**.
2. Truy cập trên máy tính: `http://localhost:3000`.

---

## 🔑 Tài Khoản Quản Lý Mặc Định (Chỉ Quản Lý Giữ)

* **Số điện thoại:** `0901234567`
* **Mã PIN:** `123456`

*(Sau khi đăng nhập, Quản lý vào tab **"Quản lý"** để tạo danh sách 15 nhân viên và cấp PIN riêng cho từng người).*

---

## 📱 Hướng Dẫn Cài Đặt Lên Màn Hình Điện Thoại (PWA)

* **Trên iPhone (Safari):** Bấm nút Chia sẻ (Share) ➔ Chọn **"Thêm vào Màn hình chính" (Add to Home Screen)**.
* **Trên Android (Chrome):** Bấm menu 3 chấm ➔ Chọn **"Cài đặt ứng dụng"** hoặc **"Thêm vào Màn hình chính"**.

App sẽ xuất hiện như một ứng dụng native ngoài màn hình chính, không cần mở trình duyệt mỗi ngày.

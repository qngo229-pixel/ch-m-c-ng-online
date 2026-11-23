// ==========================================
// ỨNG DỤNG CHẤM CÔNG GPS 15 NGƯỜI - CLIENT SCRIPT
// ==========================================

const API = {
  login: '/api/login',
  logout: '/api/logout',
  me: '/api/me',
  attendance: '/api/attendance',
  myHistory: '/api/attendance/my-history',
  adminStats: '/api/admin/stats',
  adminAttendance: '/api/admin/attendance',
  adminUsers: '/api/admin/users',
  adminExportCsv: '/api/admin/export-csv'
};

// State toàn cục
let state = {
  token: localStorage.getItem('chamcong_token') || null,
  user: null,
  nextAction: 'IN',
  lastAttendance: null,
  isPunching: false,
  lockInterval: null,
  allUsersList: [] // Dùng cho dropdown lọc
};

// ==========================================
// 1. ÂM THANH & RUNG PHẢN HỒI (HAPTIC)
// ==========================================
function playSuccessSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    
    // Hợp âm 3 nốt vui tươi (C5 -> E5 -> G5)
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, now + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.08);
      osc.stop(now + idx * 0.08 + 0.3);
    });
  } catch (e) {
    // Trình duyệt có thể chặn audio nếu chưa tương tác
  }

  // Rung phản hồi trên điện thoại
  if ('vibrate' in navigator) {
    try { navigator.vibrate([80, 40, 120]); } catch (e) {}
  }
}

function playErrorSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = 180;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (e) {}

  if ('vibrate' in navigator) {
    try { navigator.vibrate([200]); } catch (e) {}
  }
}

// ==========================================
// 2. THÔNG BÁO TOAST
// ==========================================
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ==========================================
// 3. TIỆN ÍCH GỌI API (CÓ KÈM TOKEN 30 NGÀY)
// ==========================================
async function apiRequest(url, method = 'GET', data = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const options = { method, headers };
  if (data && (method === 'POST' || method === 'PUT' || method === 'DELETE')) {
    options.body = JSON.stringify(data);
  }

  try {
    const res = await fetch(url, options);
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Nếu hết hạn token
      if (res.status === 401 && state.token && !url.includes('/api/login')) {
        showToast('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'error');
        logout();
        throw new Error('Phiên đã hết hạn');
      }
      throw new Error(json.error || `Lỗi HTTP ${res.status}`);
    }

    return json;
  } catch (err) {
    throw err;
  }
}

// ==========================================
// 4. ĐỒNG HỒ THỜI GIAN THỰC
// ==========================================
function initClock() {
  const timeEl = document.getElementById('live-time');
  const dateEl = document.getElementById('live-date');

  function update() {
    const now = new Date();
    // Giờ:Phút:Giây
    timeEl.textContent = now.toLocaleTimeString('vi-VN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // Thứ X, ngày dd tháng mm năm yyyy
    const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
    const dayName = days[now.getDay()];
    dateEl.textContent = `${dayName}, ngày ${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  }

  update();
  setInterval(update, 1000);
}

// ==========================================
// 5. ĐĂNG NHẬP & QUẢN LÝ PHIÊN (30 NGÀY)
// ==========================================
// Chuyển đổi hiện/ẩn mã PIN
document.getElementById('btn-toggle-pin').addEventListener('click', () => {
  const pinInput = document.getElementById('login-pin');
  const btn = document.getElementById('btn-toggle-pin');
  if (pinInput.type === 'password') {
    pinInput.type = 'text';
    btn.textContent = '🔒';
  } else {
    pinInput.type = 'password';
    btn.textContent = '👁️';
  }
});

// Xử lý gửi Form đăng nhập
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('login-phone').value.trim();
  const pin = document.getElementById('login-pin').value.trim();
  const alertEl = document.getElementById('login-alert');
  const submitBtn = document.getElementById('btn-submit-login');

  alertEl.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span>Đang xác thực...</span>';

  try {
    const res = await apiRequest(API.login, 'POST', { phone, pin });
    playSuccessSound();

    state.token = res.token;
    state.user = res.user;

    // Lưu vào máy để nhớ 30 ngày
    const remember = document.getElementById('login-remember').checked;
    if (remember) {
      localStorage.setItem('chamcong_token', res.token);
    }

    showToast(`Xin chào ${res.user.name}! Đăng nhập thành công.`, 'success');
    renderAppForUser();
  } catch (err) {
    playErrorSound();
    alertEl.textContent = err.message;
    alertEl.classList.remove('hidden');

    // Nếu thông báo khóa 5 phút, bắt đầu đếm ngược trực quan
    if (err.message.includes('khóa')) {
      handleLockCountdown(alertEl, err.message);
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>ĐĂNG NHẬP</span> ➔';
  }
});

function handleLockCountdown(alertEl, initialMsg) {
  if (state.lockInterval) clearInterval(state.lockInterval);
  let seconds = 300; // 5 phút mặc định

  // Trích xuất số giây nếu backend trả về
  const match = initialMsg.match(/(\d+)\s*giây/);
  if (match) {
    const m = initialMsg.match(/(\d+)\s*phút/);
    const mins = m ? parseInt(m[1], 10) : 0;
    seconds = mins * 60 + parseInt(match[1], 10);
  }

  state.lockInterval = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(state.lockInterval);
      alertEl.textContent = 'Đã hết thời gian khóa 5 phút. Bạn có thể thử đăng nhập lại ngay.';
      alertEl.className = 'alert alert-info';
    } else {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      alertEl.textContent = `⏳ Tài khoản bị tạm khóa 5 phút do nhập sai PIN 5 lần. Thử lại sau: ${mins}m ${secs < 10 ? '0' : ''}${secs}s (hoặc liên hệ Quản lý).`;
      alertEl.className = 'alert alert-danger';
    }
  }, 1000);
}

function logout() {
  if (state.token) {
    apiRequest(API.logout, 'POST').catch(() => {});
  }
  localStorage.removeItem('chamcong_token');
  state.token = null;
  state.user = null;
  state.lastAttendance = null;
  state.nextAction = 'IN';

  document.getElementById('view-attendance').classList.add('hidden');
  document.getElementById('view-admin').classList.add('hidden');
  document.getElementById('header-user').classList.add('hidden');
  document.getElementById('view-login').classList.remove('hidden');
  document.getElementById('login-pin').value = '';
}

document.getElementById('btn-logout').addEventListener('click', logout);

// ==========================================
// 6. HIỂN THỊ GIAO DIỆN SAU KHI ĐĂNG NHẬP
// ==========================================
async function renderAppForUser() {
  document.getElementById('view-login').classList.add('hidden');
  document.getElementById('header-user').classList.remove('hidden');

  document.getElementById('header-user-name').textContent = state.user.name;
  document.getElementById('header-user-role').textContent = `${state.user.role === 'admin' ? 'Quản lý' : 'Nhân viên'} • ${state.user.phone}`;

  const adminBtn = document.getElementById('btn-toggle-admin-view');
  if (state.user.role === 'admin') {
    adminBtn.classList.remove('hidden');
    adminBtn.onclick = toggleAdminView;
  } else {
    adminBtn.classList.add('hidden');
  }

  // Luôn bắt đầu từ màn hình chấm công
  showAttendanceView();

  // Đánh thức trước chip GPS để sẵn sàng khi bấm nút
  prewarmGPS();

  // Tải trạng thái ca và lịch sử gần nhất
  await syncUserStatus();
  loadMyHistory();
}

async function syncUserStatus() {
  try {
    const res = await apiRequest(API.me);
    state.user = res.user;
    state.lastAttendance = res.lastAttendance;
    state.nextAction = res.nextAction;

    updatePunchButtonUI();
  } catch (err) {
    console.error('Lỗi đồng bộ trạng thái:', err);
  }
}

// Cập nhật giao diện nút chấm công duy nhất
function updatePunchButtonUI() {
  const btn = document.getElementById('btn-punch');
  const icon = document.getElementById('punch-icon');
  const text = document.getElementById('punch-text');
  const subtext = document.getElementById('punch-subtext');
  const statusChip = document.getElementById('current-shift-status');

  btn.classList.remove('loading');

  if (state.nextAction === 'IN') {
    // Trạng thái: Chuẩn bị Vào ca
    btn.className = 'punch-btn btn-in';
    icon.textContent = '☀️';
    text.textContent = 'VÀO CA';
    subtext.textContent = 'Chạm để lấy GPS & Giờ';

    statusChip.className = 'status-chip out-shift';
    if (state.lastAttendance && state.lastAttendance.type === 'OUT') {
      statusChip.textContent = `⚪ Đã ra ca lúc ${state.lastAttendance.datetime_str}`;
    } else {
      statusChip.textContent = '⚪ Hiện tại chưa vào ca';
    }
  } else {
    // Trạng thái: Chuẩn bị Ra ca
    btn.className = 'punch-btn btn-out';
    icon.textContent = '🌙';
    text.textContent = 'RA CA';
    subtext.textContent = 'Chạm để lấy GPS & Giờ';

    statusChip.className = 'status-chip in-shift';
    const inTime = state.lastAttendance ? state.lastAttendance.datetime_str : '';
    statusChip.textContent = `🟢 Đang trong ca làm việc (Vào lúc ${inTime})`;
  }
}

// ==========================================
// 7. THAO TÁC NÚT CHẤM CÔNG (TỐI ƯU HÓA GPS CHO DI ĐỘNG 4G/5G)
// ==========================================

// Hàm lấy GPS tối ưu: Vệ tinh chính xác cao + Tự động dự phòng 4G/5G nếu ở trong nhà
function getOptimizedMobileGPS(onProgress) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error('Trình duyệt của bạn không hỗ trợ định vị GPS.'));
    }

    // Kiểm tra bảo mật HTTPS khi chạy qua mạng ngoài (4G/5G)
    if (window.isSecureContext === false && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return reject(new Error('Định vị GPS trên mạng di động 4G/5G yêu cầu kết nối HTTPS bảo mật. Hãy mở qua link HTTPS.'));
    }

    let resolved = false;

    // Bước 1: Thử lấy GPS vệ tinh độ chính xác cao (ưu tiên hàng đầu)
    if (onProgress) onProgress('🛰️ Đang kết nối vệ tinh GPS...');

    const highAccuracyOptions = {
      enableHighAccuracy: true,
      timeout: 8000, // Chờ tối đa 8 giây cho vệ tinh
      maximumAge: 2000
    };

    // Bước 2: Tự động chuyển sang định vị mạng di động 4G/5G nếu vệ tinh bị che khuất trong nhà
    const fallbackOptions = {
      enableHighAccuracy: false,
      timeout: 6000,
      maximumAge: 15000
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (resolved) return;
        resolved = true;
        resolve(pos.coords);
      },
      (err) => {
        // Nếu người dùng chủ động từ chối cấp quyền (code 1: PERMISSION_DENIED)
        if (err.code === 1) {
          if (resolved) return;
          resolved = true;
          return reject(new Error('Bạn đã từ chối quyền Vị trí. Hãy bật Cho phép vị trí trong cài đặt trình duyệt để chấm công!'));
        }

        // Nếu vệ tinh chậm do ở trong nhà/tòa nhà, tự động chuyển sang chế độ fallback mạng di động
        if (onProgress) onProgress('📡 Đang định vị hỗ trợ 4G/5G...');

        navigator.geolocation.getCurrentPosition(
          (fallbackPos) => {
            if (resolved) return;
            resolved = true;
            resolve(fallbackPos.coords);
          },
          (fallbackErr) => {
            if (resolved) return;
            resolved = true;
            let msg = 'Không thể lấy vị trí GPS.';
            if (fallbackErr.code === 1) msg = 'Vui lòng cấp quyền truy cập Vị trí cho trình duyệt.';
            else if (fallbackErr.code === 2) msg = 'Vị trí hiện không khả dụng. Hãy bật GPS/Vị trí trên điện thoại.';
            else if (fallbackErr.code === 3) msg = 'Hết thời gian chờ GPS. Vui lòng ra nơi thoáng hơn và thử lại.';
            reject(new Error(msg));
          },
          fallbackOptions
        );
      },
      highAccuracyOptions
    );
  });
}

// Đánh thức trước chip GPS của điện thoại (Pre-warm GPS để bấm là có ngay)
function prewarmGPS() {
  if (navigator.geolocation && (window.isSecureContext !== false || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    try {
      navigator.geolocation.getCurrentPosition(() => {}, () => {}, {
        enableHighAccuracy: false,
        timeout: 3000,
        maximumAge: 60000
      });
    } catch (e) {}
  }
}

// ==========================================
// 7. TIỆN ÍCH CAMERA XÁC THỰC KHUÔN MẶT & CHẤM CÔNG
// ==========================================
let cameraStream = null;
let currentFacingMode = 'user'; // Camera trước mặc định
let capturedPhotoBase64 = null;

function playShutterSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(900, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.09);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  } catch (e) {}
}

async function startCameraStream() {
  const loading = document.getElementById('camera-loading');
  const video = document.getElementById('camera-video');
  const preview = document.getElementById('camera-preview-img');

  loading.classList.remove('hidden');
  preview.classList.add('hidden');
  video.classList.remove('hidden');

  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Trình duyệt không hỗ trợ WebRTC camera. Vui lòng bấm "Chọn ảnh" bên dưới.');
    }

    const constraints = {
      video: {
        facingMode: currentFacingMode,
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraStream = stream;
    video.srcObject = stream;
    await video.play();
    loading.classList.add('hidden');
  } catch (err) {
    loading.classList.add('hidden');
    showToast('Không mở được camera trực tiếp: ' + err.message, 'error', 4000);
  }
}

function openCameraModal() {
  capturedPhotoBase64 = null;
  document.getElementById('modal-camera').classList.add('show');
  startCameraStream();
}

function closeCameraModal() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  document.getElementById('modal-camera').classList.remove('show');
}

// Chuyển đổi camera trước / sau
document.getElementById('btn-switch-cam').addEventListener('click', () => {
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  startCameraStream();
});

// Chụp ảnh từ luồng camera
document.getElementById('btn-snap-photo').addEventListener('click', () => {
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');

  if (!video.videoWidth) {
    showToast('Camera chưa sẵn sàng hoặc không thể chụp.', 'error');
    return;
  }

  const width = video.videoWidth || 480;
  const height = video.videoHeight || 360;
  const scale = Math.min(480 / width, 480 / height, 1);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const ctx = canvas.getContext('2d');
  if (currentFacingMode === 'user') {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Xuất định dạng JPEG nén chất lượng cao gọn nhẹ
  capturedPhotoBase64 = canvas.toDataURL('image/jpeg', 0.75);
  playShutterSound();

  // Đóng modal camera và thực hiện chấm công kèm ảnh
  closeCameraModal();
  executePunchWithPhoto(capturedPhotoBase64);
});

// Dự phòng chụp ảnh bằng input file chuẩn hệ điều hành (cho máy không hỗ trợ WebRTC)
document.getElementById('camera-fallback-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.getElementById('camera-canvas');
      const scale = Math.min(480 / img.width, 480 / img.height, 1);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      capturedPhotoBase64 = canvas.toDataURL('image/jpeg', 0.75);
      playShutterSound();
      closeCameraModal();
      executePunchWithPhoto(capturedPhotoBase64);
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
});

// Khi nhấn nút chấm công lớn: Mở camera để chụp ảnh xác thực trước
document.getElementById('btn-punch').addEventListener('click', () => {
  if (state.isPunching) return;
  openCameraModal();
});

// Thực hiện chấm công kèm tọa độ GPS và ảnh khuôn mặt vừa chụp
async function executePunchWithPhoto(photoBase64) {
  const btn = document.getElementById('btn-punch');
  const text = document.getElementById('punch-text');
  const subtext = document.getElementById('punch-subtext');
  const icon = document.getElementById('punch-icon');

  state.isPunching = true;
  btn.classList.add('loading');
  icon.textContent = '📡';
  text.textContent = 'ĐANG ĐỊNH VỊ...';
  subtext.textContent = 'Đang lấy tọa độ GPS';

  try {
    const coords = await getOptimizedMobileGPS((progressMsg) => {
      subtext.textContent = progressMsg;
    });

    const { latitude, longitude, accuracy } = coords;

    text.textContent = 'ĐANG LƯU...';
    subtext.textContent = `Sai số: ±${Math.round(accuracy)}m`;

    const res = await apiRequest(API.attendance, 'POST', {
      type: state.nextAction,
      latitude,
      longitude,
      accuracy,
      photo: photoBase64
    });

    playSuccessSound();
    showToast(res.message, 'success', 4000);

    // Hiển thị thẻ kết quả chấm công vừa hoàn tất
    showPunchResult(res.record);

    // Cập nhật trạng thái nút
    state.nextAction = res.nextAction;
    state.lastAttendance = res.record;
    updatePunchButtonUI();

    // Tải lại lịch sử cá nhân
    loadMyHistory();

  } catch (err) {
    playErrorSound();
    showToast(err.message, 'error', 5000);
    updatePunchButtonUI();
    if (err.message.includes('quyền') || err.message.includes('Vị trí') || err.message.includes('HTTPS')) {
      openGpsModal();
    }
  } finally {
    state.isPunching = false;
  }
}

function showPunchResult(record) {
  const card = document.getElementById('punch-result-card');
  const typeEl = document.getElementById('res-type');
  const timeEl = document.getElementById('res-time');
  const gpsEl = document.getElementById('res-gps');
  const accEl = document.getElementById('res-acc');
  const mapLink = document.getElementById('res-map-link');
  const photoRow = document.getElementById('res-photo-row');
  const photoImg = document.getElementById('res-photo-img');

  typeEl.textContent = record.type === 'IN' ? '✅ Vào ca thành công' : '👋 Ra ca thành công';
  typeEl.className = record.type === 'IN' ? 'result-value text-success' : 'result-value text-danger';

  timeEl.textContent = record.datetime_str;
  gpsEl.textContent = `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`;
  accEl.textContent = `± ${record.accuracy}m`;

  if (record.photo_url) {
    photoImg.src = record.photo_url;
    photoRow.classList.remove('hidden');
  } else {
    photoRow.classList.add('hidden');
  }

  mapLink.href = record.mapUrl;
  card.classList.remove('hidden');
}

// Tiện ích xem ảnh phóng to
function openPhotoViewer(src, title) {
  if (!src) return;
  document.getElementById('photo-viewer-img').src = src;
  document.getElementById('photo-viewer-title').textContent = title || 'Ảnh Chấm Công';
  document.getElementById('modal-photo-viewer').classList.add('show');
}

// ==========================================
// 8. LỊCH SỬ CHẤM CÔNG CÁ NHÂN
// ==========================================
async function loadMyHistory() {
  const listEl = document.getElementById('my-history-list');
  try {
    const res = await apiRequest(API.myHistory);
    if (!res.history || res.history.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p>Chưa có dữ liệu chấm công.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = res.history.map(item => `
      <div class="history-item">
        <div class="history-main">
          ${item.photo_url
            ? `<img src="${item.photo_url}" class="face-thumb" onclick="openPhotoViewer('${item.photo_url}', '${item.typeText} lúc ${item.datetime_str}')" title="Bấm xem ảnh lớn">`
            : `<span class="face-thumb-empty">👤</span>`
          }
          <div class="history-details">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="badge ${item.type === 'IN' ? 'badge-in' : 'badge-out'}">
                ${item.type === 'IN' ? 'Vào ca' : 'Ra ca'}
              </span>
              <span class="history-time">${item.datetime_str}</span>
            </div>
            <span class="history-gps">GPS: ${item.latitude.toFixed(4)}, ${item.longitude.toFixed(4)} (±${item.accuracy}m)</span>
          </div>
        </div>
        <a href="${item.mapUrl}" target="_blank" class="btn-map" title="Xem trên Google Maps">
          📍 Bản đồ
        </a>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<p style="color: var(--text-dim); text-align: center; padding: 10px;">Lỗi tải lịch sử: ${err.message}</p>`;
  }
}

document.getElementById('btn-refresh-my-history').addEventListener('click', loadMyHistory);

// ==========================================
// 9. CHUYỂN ĐỔI GIAO DIỆN (CHẤM CÔNG <-> QUẢN LÝ)
// ==========================================
function showAttendanceView() {
  document.getElementById('view-admin').classList.add('hidden');
  document.getElementById('view-attendance').classList.remove('hidden');
  const btn = document.getElementById('btn-toggle-admin-view');
  if (btn) btn.textContent = '⚙️ Quản lý';
}

function showAdminView() {
  document.getElementById('view-attendance').classList.add('hidden');
  document.getElementById('view-admin').classList.remove('hidden');
  const btn = document.getElementById('btn-toggle-admin-view');
  if (btn) btn.textContent = '🕒 Chấm công';

  loadAdminStats();
  loadAdminHistory();
  loadAdminUsers();
}

function toggleAdminView() {
  const adminView = document.getElementById('view-admin');
  if (adminView.classList.contains('hidden')) {
    showAdminView();
  } else {
    showAttendanceView();
  }
}

function switchAdminTab(tab) {
  const historyTab = document.getElementById('admin-tab-history');
  const staffTab = document.getElementById('admin-tab-staff');
  const btnHistory = document.getElementById('tab-btn-history');
  const btnStaff = document.getElementById('tab-btn-staff');

  if (tab === 'history') {
    historyTab.classList.remove('hidden');
    staffTab.classList.add('hidden');
    btnHistory.classList.add('active');
    btnStaff.classList.remove('active');
    loadAdminHistory();
  } else {
    historyTab.classList.add('hidden');
    staffTab.classList.remove('hidden');
    btnHistory.classList.remove('active');
    btnStaff.classList.add('active');
    loadAdminUsers();
  }
}

// ==========================================
// 10. BẢNG QUẢN LÝ: THỐNG KÊ & LỊCH SỬ 15 NGƯỜI
// ==========================================
async function loadAdminStats() {
  try {
    const res = await apiRequest(API.adminStats);
    document.getElementById('stat-total-users').textContent = res.stats.allUsersCount;
    document.getElementById('stat-in-shift').textContent = res.stats.usersInShift;
    document.getElementById('stat-today-punches').textContent = res.stats.todayPunches;
    document.getElementById('stat-locked-users').textContent = res.stats.lockedUsers;
  } catch (err) {
    console.error('Lỗi tải thống kê:', err);
  }
}

async function loadAdminHistory() {
  const tbody = document.getElementById('admin-history-tbody');
  const dateVal = document.getElementById('filter-date').value;
  const userVal = document.getElementById('filter-user').value;
  const typeVal = document.getElementById('filter-type').value;

  tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 24px; color: var(--text-dim);">Đang tải dữ liệu...</td></tr>`;

  try {
    const url = `${API.adminAttendance}?date=${dateVal}&userId=${userVal}&type=${typeVal}`;
    const res = await apiRequest(url);

    if (!res.records || res.records.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 24px; color: var(--text-dim);">Không có lượt chấm công nào phù hợp với bộ lọc.</td></tr>`;
      return;
    }

    tbody.innerHTML = res.records.map(r => `
      <tr>
        <td style="text-align: center;">
          ${r.photo_url
            ? `<img src="${r.photo_url}" class="face-thumb" onclick="openPhotoViewer('${r.photo_url}', '${escapeHtml(r.user_name)} - ${r.typeText} lúc ${r.datetime_str}')" title="Bấm xem ảnh lớn">`
            : `<span class="face-thumb-empty" title="Không có ảnh">👤</span>`
          }
        </td>
        <td style="font-weight: 600;">${r.datetime_str}</td>
        <td>
          <b>${r.user_name}</b>
          ${r.user_role === 'admin' ? '<span class="badge badge-admin" style="font-size: 0.65rem; margin-left: 4px;">Admin</span>' : ''}
        </td>
        <td><code>${r.user_phone}</code></td>
        <td>
          <span class="badge ${r.type === 'IN' ? 'badge-in' : 'badge-out'}">
            ${r.type === 'IN' ? 'Vào ca' : 'Ra ca'}
          </span>
        </td>
        <td>
          <div>${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}</div>
          <small style="color: var(--text-dim);">Sai số: ±${r.accuracy}m</small>
        </td>
        <td>
          <a href="${r.mapUrl}" target="_blank" class="btn-map">
            📍 Xem bản đồ
          </a>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger" style="padding: 20px;">Lỗi: ${err.message}</td></tr>`;
  }
}

// Bắt sự kiện lọc
document.getElementById('filter-date').addEventListener('change', loadAdminHistory);
document.getElementById('filter-user').addEventListener('change', loadAdminHistory);
document.getElementById('filter-type').addEventListener('change', loadAdminHistory);
document.getElementById('btn-admin-refresh').addEventListener('click', () => {
  loadAdminStats();
  loadAdminHistory();
});

// Xuất file CSV báo cáo cho Excel
document.getElementById('btn-export-csv').addEventListener('click', () => {
  if (!state.token) return;
  // Mở đường dẫn tải về kèm token xác thực
  const url = `${API.adminExportCsv}?token=${encodeURIComponent(state.token)}`;
  window.open(url, '_blank');
});

// ==========================================
// 11. BẢNG QUẢN LÝ: QUẢN LÝ NHÂN VIÊN, ĐỔI PIN, KHÓA
// ==========================================
async function loadAdminUsers() {
  const tbody = document.getElementById('admin-staff-tbody');
  const userSelect = document.getElementById('filter-user');

  tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 24px; color: var(--text-dim);">Đang tải danh sách nhân viên...</td></tr>`;

  try {
    const res = await apiRequest(API.adminUsers);
    state.allUsersList = res.users;

    // Cập nhật dropdown lọc nhân viên ở Tab lịch sử
    const currentSelected = userSelect.value;
    userSelect.innerHTML = `<option value="all">👤 Tất cả nhân viên</option>` +
      res.users.map(u => `<option value="${u.id}">${u.name} (${u.phone})</option>`).join('');
    userSelect.value = currentSelected;

    if (!res.users || res.users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 24px; color: var(--text-dim);">Chưa có nhân viên nào.</td></tr>`;
      return;
    }

    tbody.innerHTML = res.users.map(u => {
      const isLocked = u.is_locked === 1 || u.is_temp_locked === 1;
      const statusBadge = isLocked
        ? `<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444;">🔒 ${u.lock_reason}</span>`
        : `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981;">✓ Hoạt động</span>`;

      const shiftBadge = u.is_in_shift
        ? `<span class="badge badge-in">🟢 Đang trong ca</span>`
        : `<span style="color: var(--text-dim); font-size: 0.8rem;">Chưa vào ca</span>`;

      const isCurrentAdmin = state.user && state.user.id === u.id;

      return `
        <tr>
          <td>
            <b>${u.name}</b>
            ${isCurrentAdmin ? '<small style="color: #60a5fa;"> (Bạn)</small>' : ''}
          </td>
          <td><code>${u.phone}</code></td>
          <td>
            <span class="badge ${u.role === 'admin' ? 'badge-admin' : ''}" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd;">
              ${u.role === 'admin' ? '👑 Quản lý' : 'Nhân viên'}
            </span>
          </td>
          <td>${shiftBadge}</td>
          <td>${statusBadge}</td>
          <td>
            <div class="action-btns">
              <!-- Nút đổi PIN -->
              <button class="btn-sm btn-pin" onclick="openChangePinModal(${u.id}, '${escapeHtml(u.name)}')">
                🔑 Đổi PIN
              </button>

              <!-- Nút Khóa / Mở khóa -->
              ${!isCurrentAdmin ? `
                <button class="btn-sm ${isLocked ? 'btn-unlock' : 'btn-lock'}" onclick="toggleLockUser(${u.id})">
                  ${isLocked ? '🔓 Mở khóa' : '🔒 Khóa'}
                </button>
              ` : ''}

              <!-- Nút Xóa nhân viên -->
              ${!isCurrentAdmin ? `
                <button class="btn-sm btn-delete" onclick="deleteUser(${u.id}, '${escapeHtml(u.name)}')">
                  🗑️
                </button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger" style="padding: 20px;">Lỗi: ${err.message}</td></tr>`;
  }
}

// ------------------------------------------
// MODAL & XỬ LÝ: THÊM NHÂN VIÊN MỚI
// ------------------------------------------
function openAddUserModal() {
  document.getElementById('form-add-user').reset();
  document.getElementById('modal-add-user').classList.add('show');
}

document.getElementById('form-add-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('add-user-name').value.trim();
  const phone = document.getElementById('add-user-phone').value.trim();
  const pin = document.getElementById('add-user-pin').value.trim();
  const role = document.getElementById('add-user-role').value;

  if (!/^\d{4,6}$/.test(pin)) {
    showToast('Mã PIN phải từ 4 đến 6 chữ số!', 'error');
    return;
  }

  try {
    const res = await apiRequest(API.adminUsers, 'POST', { name, phone, pin, role });
    showToast(res.message, 'success');
    closeModal('modal-add-user');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ------------------------------------------
// MODAL & XỬ LÝ: ĐỔI MÃ PIN NHÂN VIÊN
// ------------------------------------------
function openChangePinModal(userId, userName) {
  document.getElementById('change-pin-user-id').value = userId;
  document.getElementById('change-pin-user-name').value = userName;
  document.getElementById('change-pin-val').value = '';
  document.getElementById('modal-change-pin').classList.add('show');
}

document.getElementById('form-change-pin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = document.getElementById('change-pin-user-id').value;
  const pin = document.getElementById('change-pin-val').value.trim();

  if (!/^\d{4,6}$/.test(pin)) {
    showToast('Mã PIN mới phải từ 4 đến 6 chữ số!', 'error');
    return;
  }

  try {
    const res = await apiRequest(`/api/admin/users/${userId}/change-pin`, 'POST', { pin });
    showToast(res.message, 'success');
    closeModal('modal-change-pin');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ------------------------------------------
// KHÓA / MỞ KHÓA TÀI KHOẢN
// ------------------------------------------
async function toggleLockUser(userId) {
  try {
    const res = await apiRequest(`/api/admin/users/${userId}/toggle-lock`, 'POST');
    showToast(res.message, 'info');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ------------------------------------------
// XÓA NHÂN VIÊN
// ------------------------------------------
async function deleteUser(userId, userName) {
  if (!confirm(`Bạn có chắc chắn muốn xóa nhân viên "${userName}"?\nToàn bộ lịch sử chấm công của người này cũng sẽ bị xóa vĩnh viễn.`)) {
    return;
  }

  try {
    const res = await apiRequest(`/api/admin/users/${userId}`, 'DELETE');
    showToast(res.message, 'success');
    loadAdminUsers();
    loadAdminStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ------------------------------------------
// MODAL TIỆN ÍCH
// ------------------------------------------
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('show');
}

function openGpsModal() {
  document.getElementById('modal-gps-help').classList.add('show');
}

function escapeHtml(str) {
  return String(str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ==========================================
// 12. KHỞI TẠO ỨNG DỤNG LẦN ĐẦU (AUTO-LOGIN 30 NGÀY)
// ==========================================
async function initApp() {
  initClock();

  // Đăng ký và cập nhật Service Worker cho PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.update();
    }).catch(() => {});
  }

  // Tự động kiểm tra phiên đăng nhập đã lưu trong máy
  if (state.token) {
    try {
      const res = await apiRequest(API.me);
      state.user = res.user;
      state.lastAttendance = res.lastAttendance;
      state.nextAction = res.nextAction;

      renderAppForUser();
      return;
    } catch (err) {
      // Token hết hạn hoặc không hợp lệ -> xóa đi để đăng nhập mới
      localStorage.removeItem('chamcong_token');
      state.token = null;
    }
  }

  // Nếu chưa đăng nhập, hiển thị màn hình đăng nhập
  document.getElementById('view-login').classList.remove('hidden');
}

window.addEventListener('DOMContentLoaded', initApp);

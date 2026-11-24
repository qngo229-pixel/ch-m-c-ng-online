// ============================================================
// ỨNG DỤNG CHẤM CÔNG GPS 15 NGƯỜI - PHIÊN BẢN GITHUB PAGES + FIREBASE
// ============================================================

// ==========================================
// 1. TIỆN ÍCH MẬT MÃ (PBKDF2-SHA256 + SALT) & THỜI GIAN VN
// ==========================================
function createSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function createToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(pin)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function getVnTimeStr(timestamp = Date.now()) {
  const d = new Date(timestamp);
  return d.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getVnDateKey(timestamp = Date.now()) {
  const d = new Date(timestamp);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d); // YYYY-MM-DD
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==========================================
// 2. TẦNG DỮ LIỆU: FIREBASE CLOUD FIRESTORE (HOẶC XEM TRƯỚC CỤC BỘ)
// ==========================================
let dbMode = 'local'; // 'firebase' | 'local'
let fsDb = null;
let fsApi = null;

function isFirebaseConfigured() {
  const cfg = window.FIREBASE_CONFIG;
  return Boolean(
    cfg &&
    cfg.apiKey &&
    cfg.projectId &&
    String(cfg.apiKey).trim().length > 10 &&
    !String(cfg.apiKey).includes('DIEN_')
  );
}

// --- Lưu trữ cục bộ dự phòng (chỉ chạy trước khi gắn Firebase) ---
const LOCAL_KEYS = {
  users: 'cc_local_users_v1',
  sessions: 'cc_local_sessions_v1',
  attendance: 'cc_local_attendance_v1',
  photos: 'cc_local_photos_v1'
};

function readLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    console.warn('LocalStorage quota warning:', e);
  }
}

async function initDatabase() {
  const banner = document.getElementById('cloud-status-banner');
  const bannerText = document.getElementById('cloud-status-text');

  if (isFirebaseConfigured()) {
    try {
      const appMod = await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js');
      const fsMod = await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js');
      const fbApp = appMod.initializeApp(window.FIREBASE_CONFIG);
      fsDb = fsMod.getFirestore(fbApp);
      fsApi = fsMod;
      dbMode = 'firebase';
      banner.classList.add('hidden');
    } catch (err) {
      console.error('Lỗi kết nối Firebase:', err);
      dbMode = 'local';
      banner.classList.remove('hidden');
      bannerText.textContent = '⚠️ Không thể kết nối Firebase (' + err.message + '). Đang chạy chế độ cục bộ.';
    }
  } else {
    dbMode = 'local';
    banner.classList.remove('hidden');
    bannerText.textContent = '⚠️ Chưa gắn mã Firebase — Dữ liệu chỉ lưu tạm trên thiết bị này. Gửi firebaseConfig để đồng bộ cả 15 nhân viên 24/7.';
  }

  await ensureDefaultAdmin();
}

// --- Các hàm CRUD trừu tượng hóa Firestore / Local ---
const DB = {
  async getUser(phone) {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDoc(fsApi.doc(fsDb, 'users', phone));
      return snap.exists() ? snap.data() : null;
    }
    const users = readLocal(LOCAL_KEYS.users, {});
    return users[phone] || null;
  },

  async saveUser(userObj) {
    if (dbMode === 'firebase') {
      await fsApi.setDoc(fsApi.doc(fsDb, 'users', userObj.phone), userObj);
      return;
    }
    const users = readLocal(LOCAL_KEYS.users, {});
    users[userObj.phone] = userObj;
    writeLocal(LOCAL_KEYS.users, users);
  },

  async updateUser(phone, fields) {
    if (dbMode === 'firebase') {
      await fsApi.updateDoc(fsApi.doc(fsDb, 'users', phone), fields);
      return;
    }
    const users = readLocal(LOCAL_KEYS.users, {});
    if (users[phone]) {
      users[phone] = { ...users[phone], ...fields };
      writeLocal(LOCAL_KEYS.users, users);
    }
  },

  async deleteUser(phone) {
    if (dbMode === 'firebase') {
      // Xóa user
      await fsApi.deleteDoc(fsApi.doc(fsDb, 'users', phone));
      // Xóa sessions của user
      const sessSnap = await fsApi.getDocs(
        fsApi.query(fsApi.collection(fsDb, 'sessions'), fsApi.where('user_id', '==', phone))
      );
      for (const d of sessSnap.docs) {
        await fsApi.deleteDoc(d.ref);
      }
      // Xóa attendance & ảnh của user
      const attSnap = await fsApi.getDocs(
        fsApi.query(fsApi.collection(fsDb, 'attendance'), fsApi.where('user_id', '==', phone))
      );
      for (const d of attSnap.docs) {
        await fsApi.deleteDoc(d.ref);
        try {
          await fsApi.deleteDoc(fsApi.doc(fsDb, 'attendance_photos', d.id));
        } catch {}
      }
      return;
    }

    const users = readLocal(LOCAL_KEYS.users, {});
    delete users[phone];
    writeLocal(LOCAL_KEYS.users, users);

    const sessions = readLocal(LOCAL_KEYS.sessions, {});
    Object.keys(sessions).forEach(k => {
      if (sessions[k].user_id === phone) delete sessions[k];
    });
    writeLocal(LOCAL_KEYS.sessions, sessions);

    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    const removedIds = new Set(allAtt.filter(a => a.user_id === phone).map(a => a.id));
    writeLocal(LOCAL_KEYS.attendance, allAtt.filter(a => a.user_id !== phone));

    const photos = readLocal(LOCAL_KEYS.photos, {});
    removedIds.forEach(id => delete photos[id]);
    writeLocal(LOCAL_KEYS.photos, photos);
  },

  async getAllUsers() {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDocs(fsApi.collection(fsDb, 'users'));
      return snap.docs.map(d => d.data());
    }
    const users = readLocal(LOCAL_KEYS.users, {});
    return Object.values(users);
  },

  async saveSession(sessionObj) {
    if (dbMode === 'firebase') {
      await fsApi.setDoc(fsApi.doc(fsDb, 'sessions', sessionObj.token), sessionObj);
      return;
    }
    const sessions = readLocal(LOCAL_KEYS.sessions, {});
    sessions[sessionObj.token] = sessionObj;
    writeLocal(LOCAL_KEYS.sessions, sessions);
  },

  async getSession(token) {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDoc(fsApi.doc(fsDb, 'sessions', token));
      return snap.exists() ? snap.data() : null;
    }
    const sessions = readLocal(LOCAL_KEYS.sessions, {});
    return sessions[token] || null;
  },

  async deleteSession(token) {
    if (dbMode === 'firebase') {
      await fsApi.deleteDoc(fsApi.doc(fsDb, 'sessions', token));
      return;
    }
    const sessions = readLocal(LOCAL_KEYS.sessions, {});
    delete sessions[token];
    writeLocal(LOCAL_KEYS.sessions, sessions);
  },

  async deleteUserSessions(phone) {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDocs(
        fsApi.query(fsApi.collection(fsDb, 'sessions'), fsApi.where('user_id', '==', phone))
      );
      for (const d of snap.docs) {
        await fsApi.deleteDoc(d.ref);
      }
      return;
    }
    const sessions = readLocal(LOCAL_KEYS.sessions, {});
    Object.keys(sessions).forEach(k => {
      if (sessions[k].user_id === phone) delete sessions[k];
    });
    writeLocal(LOCAL_KEYS.sessions, sessions);
  },

  async addAttendance(record, fullPhotoDataUrl) {
    if (dbMode === 'firebase') {
      await fsApi.setDoc(fsApi.doc(fsDb, 'attendance', record.id), record);
      if (fullPhotoDataUrl) {
        await fsApi.setDoc(fsApi.doc(fsDb, 'attendance_photos', record.id), {
          photo: fullPhotoDataUrl,
          user_id: record.user_id,
          timestamp: record.timestamp
        });
      }
      return;
    }
    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    allAtt.unshift(record);
    writeLocal(LOCAL_KEYS.attendance, allAtt.slice(0, 300));

    if (fullPhotoDataUrl) {
      const photos = readLocal(LOCAL_KEYS.photos, {});
      photos[record.id] = fullPhotoDataUrl;
      // Giữ tối đa 40 ảnh full ở local preview để không đầy localStorage
      const keys = Object.keys(photos);
      if (keys.length > 40) delete photos[keys[0]];
      writeLocal(LOCAL_KEYS.photos, photos);
    }
  },

  async getUserAttendance(phone, maxCount = 30) {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDocs(
        fsApi.query(fsApi.collection(fsDb, 'attendance'), fsApi.where('user_id', '==', phone))
      );
      const list = snap.docs.map(d => d.data());
      list.sort((a, b) => b.timestamp - a.timestamp);
      return list.slice(0, maxCount);
    }
    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    return allAtt
      .filter(a => a.user_id === phone)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxCount);
  },

  async getAllAttendance(maxCount = 300) {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDocs(
        fsApi.query(
          fsApi.collection(fsDb, 'attendance'),
          fsApi.orderBy('timestamp', 'desc'),
          fsApi.limit(maxCount)
        )
      );
      return snap.docs.map(d => d.data());
    }
    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    return [...allAtt].sort((a, b) => b.timestamp - a.timestamp).slice(0, maxCount);
  },

  async getFullPhoto(attId) {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDoc(fsApi.doc(fsDb, 'attendance_photos', attId));
      return snap.exists() ? snap.data().photo : null;
    }
    const photos = readLocal(LOCAL_KEYS.photos, {});
    return photos[attId] || null;
  }
};

// Tự động tạo tài khoản Quản lý ban đầu nếu CSDL còn trống
async function ensureDefaultAdmin() {
  const banner = document.getElementById('cloud-status-banner');
  const bannerText = document.getElementById('cloud-status-text');
  try {
    const users = await DB.getAllUsers();
    if (users.length === 0) {
      const salt = createSalt();
      const pinHash = await hashPin('123456', salt);
      await DB.saveUser({
        id: '0901234567',
        name: 'Quản trị viên (Admin)',
        phone: '0901234567',
        pin_hash: pinHash,
        pin_salt: salt,
        role: 'admin',
        is_locked: 0,
        failed_attempts: 0,
        lock_until: null,
        created_at: Date.now()
      });
    }
  } catch (err) {
    console.error('Lỗi kết nối/khởi tạo Firestore:', err);
    if (dbMode === 'firebase' && banner && bannerText) {
      banner.classList.remove('hidden');
      const code = err.code || '';
      const msg = err.message || '';
      if (code === 'permission-denied' || msg.includes('Missing or insufficient permissions')) {
        bannerText.textContent = '⚠️ Firebase Firestore đang chặn quyền đọc/ghi. Vào Firebase Console → Firestore Database → tab Rules → cập nhật Rules rồi bấm Publish.';
      } else if (code === 'not-found' || msg.includes('does not exist')) {
        bannerText.textContent = '⚠️ Chưa bật Firestore Database. Vào Firebase Console → Build → Firestore Database → bấm Create database.';
      } else {
        bannerText.textContent = '⚠️ Lỗi kết nối Firebase Firestore: ' + msg;
      }
    }
  }
}

// ==========================================
// 3. STATE TOÀN CỤC & ÂM THANH / THÔNG BÁO
// ==========================================
const state = {
  token: localStorage.getItem('chamcong_token') || null,
  user: null,
  nextAction: 'IN',
  lastAttendance: null,
  isPunching: false,
  lockInterval: null,
  allUsersList: [],
  adminRecordsCache: []
};

function playSuccessSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
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
  } catch {}
  if ('vibrate' in navigator) {
    try { navigator.vibrate([80, 40, 120]); } catch {}
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
  } catch {}
  if ('vibrate' in navigator) {
    try { navigator.vibrate([200]); } catch {}
  }
}

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
  } catch {}
}

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ==========================================
// 4. ĐỒNG HỒ THỜI GIAN THỰC
// ==========================================
function initClock() {
  const timeEl = document.getElementById('live-time');
  const dateEl = document.getElementById('live-date');

  function update() {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('vi-VN', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
    dateEl.textContent = `${days[now.getDay()]}, ngày ${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  }
  update();
  setInterval(update, 1000);
}

// ==========================================
// 5. ĐĂNG NHẬP, MÃ HÓA PIN, KHÓA 5 PHÚT, NHỚ 30 NGÀY
// ==========================================
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

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('login-phone').value.trim();
  const pin = document.getElementById('login-pin').value.trim();
  const alertEl = document.getElementById('login-alert');
  const submitBtn = document.getElementById('btn-submit-login');

  alertEl.classList.add('hidden');
  alertEl.className = 'alert alert-danger hidden';

  if (!phone || !pin) {
    alertEl.textContent = 'Vui lòng nhập đầy đủ Số điện thoại và Mã PIN.';
    alertEl.classList.remove('hidden');
    return;
  }
  if (!/^\d{4,6}$/.test(pin)) {
    alertEl.textContent = 'Mã PIN phải từ 4 đến 6 chữ số.';
    alertEl.classList.remove('hidden');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span>Đang xác thực...</span>';

  try {
    const user = await DB.getUser(phone);
    if (!user) {
      throw new Error('Số điện thoại hoặc mã PIN không đúng.');
    }

    const now = Date.now();

    if (user.is_locked === 1) {
      throw new Error('Tài khoản của bạn đã bị Quản lý khóa. Vui lòng liên hệ Quản lý.');
    }

    if (user.lock_until && user.lock_until > now) {
      const remainingSec = Math.ceil((user.lock_until - now) / 1000);
      const mins = Math.floor(remainingSec / 60);
      const secs = remainingSec % 60;
      const timeStr = mins > 0 ? `${mins} phút ${secs} giây` : `${secs} giây`;
      throw new Error(`Tài khoản tạm bị khóa do nhập sai PIN 5 lần. Thử lại sau ${timeStr} hoặc nhờ Quản lý mở khóa.`);
    }

    // Nếu đã hết thời gian khóa 5 phút -> reset
    let currentAttempts = user.failed_attempts || 0;
    if (user.lock_until && user.lock_until <= now) {
      await DB.updateUser(phone, { failed_attempts: 0, lock_until: null });
      currentAttempts = 0;
    }

    const computedHash = await hashPin(pin, user.pin_salt);
    const isMatch = safeEqual(computedHash, user.pin_hash);

    if (!isMatch) {
      const newAttempts = currentAttempts + 1;
      if (newAttempts >= 5) {
        const lockUntil = now + 5 * 60 * 1000; // Khóa 5 phút
        await DB.updateUser(phone, { failed_attempts: newAttempts, lock_until: lockUntil });
        throw new Error('Mã PIN không đúng! Bạn đã nhập sai 5 lần. Tài khoản bị tạm khóa 5 phút.');
      } else {
        await DB.updateUser(phone, { failed_attempts: newAttempts });
        throw new Error(`Mã PIN không đúng! (Còn ${5 - newAttempts} lần thử trước khi bị khóa 5 phút).`);
      }
    }

    // Đăng nhập thành công -> reset đếm sai
    if (currentAttempts > 0 || user.lock_until) {
      await DB.updateUser(phone, { failed_attempts: 0, lock_until: null });
    }

    // Tạo phiên nhớ 30 ngày
    const token = createToken();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    await DB.saveSession({
      token,
      user_id: user.phone,
      expires_at: expiresAt,
      created_at: now
    });

    state.token = token;
    state.user = {
      id: user.phone,
      name: user.name,
      phone: user.phone,
      role: user.role
    };

    const remember = document.getElementById('login-remember').checked;
    if (remember) {
      localStorage.setItem('chamcong_token', token);
    } else {
      localStorage.removeItem('chamcong_token');
    }

    playSuccessSound();
    showToast(`Xin chào ${user.name}! Đăng nhập thành công.`, 'success');
    await renderAppForUser();
  } catch (err) {
    playErrorSound();
    alertEl.textContent = err.message;
    alertEl.classList.remove('hidden');
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
  let seconds = 300;
  const secMatch = initialMsg.match(/(\d+)\s*giây/);
  if (secMatch) {
    const minMatch = initialMsg.match(/(\d+)\s*phút/);
    const mins = minMatch ? parseInt(minMatch[1], 10) : 0;
    seconds = mins * 60 + parseInt(secMatch[1], 10);
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

async function logout() {
  if (state.token) {
    DB.deleteSession(state.token).catch(() => {});
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

async function verifySessionToken(token) {
  if (!token) return null;
  const sess = await DB.getSession(token);
  if (!sess || sess.expires_at <= Date.now()) return null;
  const user = await DB.getUser(sess.user_id);
  if (!user || user.is_locked === 1) return null;
  return {
    id: user.phone,
    name: user.name,
    phone: user.phone,
    role: user.role
  };
}

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

  showAttendanceView();
  prewarmGPS();

  await syncUserStatus();
  await loadMyHistory();
}

async function syncUserStatus() {
  if (!state.user) return;
  try {
    const history = await DB.getUserAttendance(state.user.phone, 1);
    const last = history.length > 0 ? history[0] : null;
    state.lastAttendance = last;
    state.nextAction = (!last || last.type === 'OUT') ? 'IN' : 'OUT';
    updatePunchButtonUI();
  } catch (err) {
    console.error('Lỗi đồng bộ trạng thái ca:', err);
  }
}

function updatePunchButtonUI() {
  const btn = document.getElementById('btn-punch');
  const icon = document.getElementById('punch-icon');
  const text = document.getElementById('punch-text');
  const subtext = document.getElementById('punch-subtext');
  const statusChip = document.getElementById('current-shift-status');

  btn.classList.remove('loading');

  if (state.nextAction === 'IN') {
    btn.className = 'punch-btn btn-in';
    icon.textContent = '☀️';
    text.textContent = 'VÀO CA';
    subtext.textContent = 'Chụp mặt & Lấy GPS';

    statusChip.className = 'status-chip out-shift';
    if (state.lastAttendance && state.lastAttendance.type === 'OUT') {
      statusChip.textContent = `⚪ Đã ra ca lúc ${state.lastAttendance.datetime_str}`;
    } else {
      statusChip.textContent = '⚪ Hiện tại chưa vào ca';
    }
  } else {
    btn.className = 'punch-btn btn-out';
    icon.textContent = '🌙';
    text.textContent = 'RA CA';
    subtext.textContent = 'Chụp mặt & Lấy GPS';

    statusChip.className = 'status-chip in-shift';
    const inTime = state.lastAttendance ? state.lastAttendance.datetime_str : '';
    statusChip.textContent = `🟢 Đang trong ca làm việc (Vào lúc ${inTime})`;
  }
}

// ==========================================
// 7. GPS TỐI ƯU DI ĐỘNG + CAMERA CHỤP ẢNH MẶT
// ==========================================
function getOptimizedMobileGPS(onProgress) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error('Trình duyệt của bạn không hỗ trợ định vị GPS.'));
    }

    if (window.isSecureContext === false && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return reject(new Error('Định vị GPS trên 4G/5G yêu cầu đường dẫn bảo mật HTTPS.'));
    }

    let resolved = false;
    if (onProgress) onProgress('🛰️ Đang kết nối vệ tinh GPS...');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (resolved) return;
        resolved = true;
        resolve(pos.coords);
      },
      (err) => {
        if (err.code === 1) {
          if (resolved) return;
          resolved = true;
          return reject(new Error('Bạn đã từ chối quyền Vị trí. Vui lòng cho phép quyền Vị trí trên trình duyệt để chấm công!'));
        }

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
            else if (fallbackErr.code === 3) msg = 'Hết thời gian chờ GPS. Vui lòng thử lại ở nơi thoáng hơn.';
            reject(new Error(msg));
          },
          { enableHighAccuracy: false, timeout: 6000, maximumAge: 15000 }
        );
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 2000 }
    );
  });
}

function prewarmGPS() {
  if (navigator.geolocation && (window.isSecureContext !== false || location.hostname === 'localhost')) {
    try {
      navigator.geolocation.getCurrentPosition(() => {}, () => {}, {
        enableHighAccuracy: false,
        timeout: 3000,
        maximumAge: 60000
      });
    } catch {}
  }
}

// --- Camera & tạo 2 ảnh gọn nhẹ (ảnh thu nhỏ ~3KB + ảnh rõ ~20KB) ---
let cameraStream = null;
let currentFacingMode = 'user';

function createThumbnailFromCanvas(sourceCanvas) {
  const thumb = document.createElement('canvas');
  const size = 96;
  thumb.width = size;
  thumb.height = size;
  const ctx = thumb.getContext('2d');
  const minSide = Math.min(sourceCanvas.width, sourceCanvas.height);
  const sx = (sourceCanvas.width - minSide) / 2;
  const sy = (sourceCanvas.height - minSide) / 2;
  ctx.drawImage(sourceCanvas, sx, sy, minSide, minSide, 0, 0, size, size);
  return thumb.toDataURL('image/jpeg', 0.65);
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
      throw new Error('Trình duyệt không hỗ trợ mở camera trực tiếp. Hãy bấm "📁 Chọn ảnh" bên dưới.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: currentFacingMode, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
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

document.getElementById('btn-switch-cam').addEventListener('click', () => {
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  startCameraStream();
});

document.getElementById('btn-snap-photo').addEventListener('click', () => {
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');

  if (!video.videoWidth) {
    showToast('Camera chưa sẵn sàng. Bạn có thể bấm "📁 Chọn ảnh" để chụp bằng máy ảnh điện thoại.', 'error');
    return;
  }

  const width = video.videoWidth || 480;
  const height = video.videoHeight || 360;
  const scale = Math.min(440 / width, 440 / height, 1);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const ctx = canvas.getContext('2d');
  if (currentFacingMode === 'user') {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const fullPhoto = canvas.toDataURL('image/jpeg', 0.72);
  const thumbPhoto = createThumbnailFromCanvas(canvas);
  playShutterSound();

  closeCameraModal();
  executePunchWithPhoto(fullPhoto, thumbPhoto);
});

document.getElementById('camera-fallback-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.getElementById('camera-canvas');
      const scale = Math.min(440 / img.width, 440 / img.height, 1);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const fullPhoto = canvas.toDataURL('image/jpeg', 0.72);
      const thumbPhoto = createThumbnailFromCanvas(canvas);
      playShutterSound();

      closeCameraModal();
      executePunchWithPhoto(fullPhoto, thumbPhoto);
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('btn-punch').addEventListener('click', () => {
  if (state.isPunching) return;
  openCameraModal();
});

async function executePunchWithPhoto(fullPhoto, thumbPhoto) {
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
    // Kiểm tra lại tài khoản có bị khóa giữa chừng không
    const freshUser = await verifySessionToken(state.token);
    if (!freshUser) {
      showToast('Phiên đăng nhập không hợp lệ hoặc tài khoản đã bị khóa.', 'error');
      await logout();
      return;
    }

    const coords = await getOptimizedMobileGPS((progressMsg) => {
      subtext.textContent = progressMsg;
    });

    const lat = Number(coords.latitude);
    const lng = Number(coords.longitude);
    const accValue = Math.round((Number(coords.accuracy) || 0) * 10) / 10;

    text.textContent = 'ĐANG LƯU...';
    subtext.textContent = `Sai số: ±${Math.round(accValue)}m`;

    // Kiểm tra lần chấm gần nhất để đảo Vào ca <-> Ra ca chuẩn xác
    const recent = await DB.getUserAttendance(state.user.phone, 1);
    const last = recent.length > 0 ? recent[0] : null;
    const actionType = (!last || last.type === 'OUT') ? 'IN' : 'OUT';

    const now = Date.now();
    const attId = `att_${now}_${Math.random().toString(36).slice(2, 7)}`;
    const record = {
      id: attId,
      user_id: state.user.phone,
      user_name: state.user.name,
      user_phone: state.user.phone,
      user_role: state.user.role,
      type: actionType,
      typeText: actionType === 'IN' ? 'Vào ca' : 'Ra ca',
      timestamp: now,
      datetime_str: getVnTimeStr(now),
      date_key: getVnDateKey(now),
      latitude: lat,
      longitude: lng,
      accuracy: accValue,
      mapUrl: `https://www.google.com/maps?q=${lat},${lng}`,
      photo_thumb: thumbPhoto || '',
      has_photo: Boolean(fullPhoto)
    };

    await DB.addAttendance(record, fullPhoto);

    playSuccessSound();
    showToast(
      actionType === 'IN' ? '✅ Chấm công VÀO CA thành công!' : '👋 Chấm công RA CA thành công!',
      'success',
      4000
    );

    showPunchResult(record, fullPhoto);

    state.lastAttendance = record;
    state.nextAction = actionType === 'IN' ? 'OUT' : 'IN';
    updatePunchButtonUI();
    await loadMyHistory();
  } catch (err) {
    playErrorSound();
    showToast(err.message || 'Lỗi chấm công.', 'error', 5000);
    updatePunchButtonUI();
    if (err.message && (err.message.includes('quyền') || err.message.includes('Vị trí') || err.message.includes('HTTPS'))) {
      openGpsModal();
    }
  } finally {
    state.isPunching = false;
  }
}

function showPunchResult(record, fullPhoto) {
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
  mapLink.href = record.mapUrl;

  const previewSrc = fullPhoto || record.photo_thumb;
  if (previewSrc) {
    photoImg.src = previewSrc;
    photoImg.onclick = () => openPhotoViewer(record.id, previewSrc, `${record.typeText} lúc ${record.datetime_str}`);
    photoRow.classList.remove('hidden');
  } else {
    photoRow.classList.add('hidden');
  }

  card.classList.remove('hidden');
}

async function openPhotoViewer(attId, fallbackSrc, title) {
  const imgEl = document.getElementById('photo-viewer-img');
  const titleEl = document.getElementById('photo-viewer-title');
  const detailsEl = document.getElementById('photo-viewer-details');

  titleEl.textContent = title || 'Ảnh Chấm Công';
  imgEl.src = fallbackSrc || '';
  detailsEl.textContent = 'Đang tải ảnh độ nét cao...';
  document.getElementById('modal-photo-viewer').classList.add('show');

  if (attId) {
    try {
      const full = await DB.getFullPhoto(attId);
      if (full) imgEl.src = full;
      detailsEl.textContent = '';
    } catch {
      detailsEl.textContent = '';
    }
  } else {
    detailsEl.textContent = '';
  }
}

// ==========================================
// 8. LỊCH SỬ CHẤM CÔNG CÁ NHÂN
// ==========================================
async function loadMyHistory() {
  const listEl = document.getElementById('my-history-list');
  if (!state.user) return;
  try {
    const history = await DB.getUserAttendance(state.user.phone, 30);
    if (!history || history.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p>Chưa có dữ liệu chấm công.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = history.map(item => `
      <div class="history-item">
        <div class="history-main">
          ${item.photo_thumb
            ? `<img src="${item.photo_thumb}" class="face-thumb" data-att-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.typeText + ' lúc ' + item.datetime_str)}" title="Bấm xem ảnh lớn">`
            : `<span class="face-thumb-empty">👤</span>`
          }
          <div class="history-details">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="badge ${item.type === 'IN' ? 'badge-in' : 'badge-out'}">
                ${item.type === 'IN' ? 'Vào ca' : 'Ra ca'}
              </span>
              <span class="history-time">${escapeHtml(item.datetime_str)}</span>
            </div>
            <span class="history-gps">GPS: ${Number(item.latitude).toFixed(4)}, ${Number(item.longitude).toFixed(4)} (±${item.accuracy}m)</span>
          </div>
        </div>
        <a href="${escapeHtml(item.mapUrl)}" target="_blank" class="btn-map" title="Xem trên Google Maps">
          📍 Bản đồ
        </a>
      </div>
    `).join('');

    listEl.querySelectorAll('.face-thumb').forEach(img => {
      img.addEventListener('click', () => {
        openPhotoViewer(img.dataset.attId, img.src, img.dataset.title);
      });
    });
  } catch (err) {
    listEl.innerHTML = `<p style="color: var(--text-dim); text-align: center; padding: 10px;">Lỗi tải lịch sử: ${escapeHtml(err.message)}</p>`;
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

async function showAdminView() {
  document.getElementById('view-attendance').classList.add('hidden');
  document.getElementById('view-admin').classList.remove('hidden');
  const btn = document.getElementById('btn-toggle-admin-view');
  if (btn) btn.textContent = '🕒 Chấm công';

  await loadAdminData();
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
    renderAdminHistoryTable();
  } else {
    historyTab.classList.add('hidden');
    staffTab.classList.remove('hidden');
    btnHistory.classList.remove('active');
    btnStaff.classList.add('active');
    renderAdminStaffTable();
  }
}

// ==========================================
// 10. BẢNG QUẢN LÝ: THỐNG KÊ, LỊCH SỬ 15 NGƯỜI & QUẢN TRỊ NHÂN VIÊN
// ==========================================
async function loadAdminData() {
  if (!state.user || state.user.role !== 'admin') return;
  try {
    const [users, records] = await Promise.all([
      DB.getAllUsers(),
      DB.getAllAttendance(300)
    ]);

    users.sort((a, b) => {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return (a.created_at || 0) - (b.created_at || 0);
    });

    state.allUsersList = users;
    state.adminRecordsCache = records;

    // Tính thống kê
    const now = Date.now();
    const todayKey = getVnDateKey(now);
    const lockedCount = users.filter(u => u.is_locked === 1 || (u.lock_until && u.lock_until > now)).length;
    const todayPunches = records.filter(r => (r.date_key || getVnDateKey(r.timestamp)) === todayKey).length;

    // Xác định ai đang trong ca (lần chấm gần nhất là IN)
    const lastPunchByUser = new Map();
    for (const r of records) {
      if (!lastPunchByUser.has(r.user_id)) {
        lastPunchByUser.set(r.user_id, r);
      }
    }
    let inShiftCount = 0;
    lastPunchByUser.forEach(r => {
      if (r.type === 'IN') inShiftCount++;
    });

    document.getElementById('stat-total-users').textContent = users.length;
    document.getElementById('stat-in-shift').textContent = inShiftCount;
    document.getElementById('stat-today-punches').textContent = todayPunches;
    document.getElementById('stat-locked-users').textContent = lockedCount;

    // Cập nhật dropdown lọc nhân viên
    const userSelect = document.getElementById('filter-user');
    const currentSelected = userSelect.value;
    userSelect.innerHTML = `<option value="all">👤 Tất cả nhân viên</option>` +
      users.map(u => `<option value="${escapeHtml(u.phone)}">${escapeHtml(u.name)} (${escapeHtml(u.phone)})</option>`).join('');
    if ([...userSelect.options].some(o => o.value === currentSelected)) {
      userSelect.value = currentSelected;
    }

    renderAdminHistoryTable();
    renderAdminStaffTable(lastPunchByUser);
  } catch (err) {
    showToast('Lỗi tải dữ liệu quản trị: ' + err.message, 'error');
  }
}

function renderAdminHistoryTable() {
  const tbody = document.getElementById('admin-history-tbody');
  const dateVal = document.getElementById('filter-date').value;
  const userVal = document.getElementById('filter-user').value;
  const typeVal = document.getElementById('filter-type').value;
  const todayKey = getVnDateKey();

  const filtered = state.adminRecordsCache.filter(r => {
    if (dateVal === 'today' && (r.date_key || getVnDateKey(r.timestamp)) !== todayKey) return false;
    if (userVal !== 'all' && r.user_id !== userVal) return false;
    if (typeVal !== 'all' && r.type !== typeVal) return false;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding: 24px; color: var(--text-dim);">Không có lượt chấm công nào phù hợp với bộ lọc.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td style="text-align: center;">
        ${r.photo_thumb
          ? `<img src="${r.photo_thumb}" class="face-thumb" data-att-id="${escapeHtml(r.id)}" data-title="${escapeHtml(r.user_name + ' - ' + r.typeText + ' lúc ' + r.datetime_str)}" title="Bấm xem ảnh lớn">`
          : `<span class="face-thumb-empty" title="Không có ảnh">👤</span>`
        }
      </td>
      <td style="font-weight: 600;">${escapeHtml(r.datetime_str)}</td>
      <td>
        <b>${escapeHtml(r.user_name)}</b>
        ${r.user_role === 'admin' ? '<span class="badge badge-admin" style="font-size: 0.65rem; margin-left: 4px;">Admin</span>' : ''}
      </td>
      <td><code>${escapeHtml(r.user_phone)}</code></td>
      <td>
        <span class="badge ${r.type === 'IN' ? 'badge-in' : 'badge-out'}">
          ${r.type === 'IN' ? 'Vào ca' : 'Ra ca'}
        </span>
      </td>
      <td>
        <div>${Number(r.latitude).toFixed(5)}, ${Number(r.longitude).toFixed(5)}</div>
        <small style="color: var(--text-dim);">Sai số: ±${r.accuracy}m</small>
      </td>
      <td>
        <a href="${escapeHtml(r.mapUrl)}" target="_blank" class="btn-map">
          📍 Xem bản đồ
        </a>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.face-thumb').forEach(img => {
    img.addEventListener('click', () => {
      openPhotoViewer(img.dataset.attId, img.src, img.dataset.title);
    });
  });
}

function renderAdminStaffTable(lastPunchMap = null) {
  const tbody = document.getElementById('admin-staff-tbody');
  const users = state.allUsersList;

  if (!lastPunchMap) {
    lastPunchMap = new Map();
    for (const r of state.adminRecordsCache) {
      if (!lastPunchMap.has(r.user_id)) lastPunchMap.set(r.user_id, r);
    }
  }

  if (!users || users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 24px; color: var(--text-dim);">Chưa có nhân viên nào.</td></tr>`;
    return;
  }

  const now = Date.now();
  tbody.innerHTML = users.map(u => {
    const isTempLocked = Boolean(u.lock_until && u.lock_until > now);
    const isLocked = u.is_locked === 1 || isTempLocked;
    let lockReason = 'Hoạt động';
    if (u.is_locked === 1) lockReason = 'Bị Quản lý khóa';
    else if (isTempLocked) {
      const sec = Math.ceil((u.lock_until - now) / 1000);
      lockReason = `Tạm khóa sai PIN (${sec}s)`;
    }

    const statusBadge = isLocked
      ? `<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444;">🔒 ${escapeHtml(lockReason)}</span>`
      : `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981;">✓ Hoạt động</span>`;

    const lastPunch = lastPunchMap.get(u.phone);
    const shiftBadge = (lastPunch && lastPunch.type === 'IN')
      ? `<span class="badge badge-in">🟢 Đang trong ca</span>`
      : `<span style="color: var(--text-dim); font-size: 0.8rem;">Chưa vào ca</span>`;

    const isCurrentAdmin = state.user && state.user.phone === u.phone;

    return `
      <tr>
        <td>
          <b>${escapeHtml(u.name)}</b>
          ${isCurrentAdmin ? '<small style="color: #60a5fa;"> (Bạn)</small>' : ''}
        </td>
        <td><code>${escapeHtml(u.phone)}</code></td>
        <td>
          <span class="badge ${u.role === 'admin' ? 'badge-admin' : ''}" style="background: rgba(59, 130, 246, 0.15); color: #93c5fd;">
            ${u.role === 'admin' ? '👑 Quản lý' : 'Nhân viên'}
          </span>
        </td>
        <td>${shiftBadge}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="action-btns">
            <button class="btn-sm btn-pin" data-action="pin" data-phone="${escapeHtml(u.phone)}" data-name="${escapeHtml(u.name)}">
              🔑 Đổi PIN
            </button>
            ${!isCurrentAdmin ? `
              <button class="btn-sm ${isLocked ? 'btn-unlock' : 'btn-lock'}" data-action="lock" data-phone="${escapeHtml(u.phone)}">
                ${isLocked ? '🔓 Mở khóa' : '🔒 Khóa'}
              </button>
              <button class="btn-sm btn-delete" data-action="delete" data-phone="${escapeHtml(u.phone)}" data-name="${escapeHtml(u.name)}">
                🗑️
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const phone = btn.dataset.phone;
      const name = btn.dataset.name;
      if (action === 'pin') openChangePinModal(phone, name);
      else if (action === 'lock') toggleLockUser(phone);
      else if (action === 'delete') deleteUser(phone, name);
    });
  });
}

document.getElementById('filter-date').addEventListener('change', renderAdminHistoryTable);
document.getElementById('filter-user').addEventListener('change', renderAdminHistoryTable);
document.getElementById('filter-type').addEventListener('change', renderAdminHistoryTable);
document.getElementById('btn-admin-refresh').addEventListener('click', loadAdminData);

// Xuất file CSV chuẩn UTF-8 BOM trực tiếp trên trình duyệt
document.getElementById('btn-export-csv').addEventListener('click', () => {
  const rows = state.adminRecordsCache;
  if (!rows || rows.length === 0) {
    showToast('Chưa có dữ liệu chấm công để xuất Excel.', 'info');
    return;
  }

  let csv = '\uFEFF';
  csv += 'STT,Họ và Tên,Số Điện Thoại,Hành Động,Thời Gian,Vĩ Độ,Kinh Độ,Sai Số (m),Link Google Maps,Có Ảnh Mặt\n';
  rows.forEach((r, idx) => {
    const typeStr = r.type === 'IN' ? 'Vào ca' : 'Ra ca';
    const mapUrl = `https://www.google.com/maps?q=${r.latitude},${r.longitude}`;
    const nameEscaped = `"${(r.user_name || '').replace(/"/g, '""')}"`;
    const timeEscaped = `"${r.datetime_str}"`;
    const hasPhoto = r.has_photo ? 'Có' : 'Không';
    csv += `${idx + 1},${nameEscaped},${r.user_phone},${typeStr},${timeEscaped},${r.latitude},${r.longitude},${r.accuracy},"${mapUrl}",${hasPhoto}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lich-su-cham-cong-${getVnDateKey()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Đã tải file Excel (CSV) thành công!', 'success');
});

// --- Thêm nhân viên ---
function openAddUserModal() {
  document.getElementById('form-add-user').reset();
  document.getElementById('modal-add-user').classList.add('show');
}

document.getElementById('form-add-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('add-user-name').value.trim();
  const phone = document.getElementById('add-user-phone').value.trim();
  const pin = document.getElementById('add-user-pin').value.trim();
  const role = document.getElementById('add-user-role').value === 'admin' ? 'admin' : 'employee';

  if (!name) return showToast('Họ tên nhân viên không được để trống!', 'error');
  if (!/^\d{9,11}$/.test(phone)) return showToast('Số điện thoại phải từ 9 đến 11 chữ số!', 'error');
  if (!/^\d{4,6}$/.test(pin)) return showToast('Mã PIN phải từ 4 đến 6 chữ số!', 'error');

  try {
    const existing = await DB.getUser(phone);
    if (existing) {
      return showToast(`Số điện thoại ${phone} đã được đăng ký!`, 'error');
    }

    const salt = createSalt();
    const pinHash = await hashPin(pin, salt);
    await DB.saveUser({
      id: phone,
      name,
      phone,
      pin_hash: pinHash,
      pin_salt: salt,
      role,
      is_locked: 0,
      failed_attempts: 0,
      lock_until: null,
      created_at: Date.now()
    });

    showToast('Thêm nhân viên thành công!', 'success');
    closeModal('modal-add-user');
    await loadAdminData();
  } catch (err) {
    showToast('Lỗi thêm nhân viên: ' + err.message, 'error');
  }
});

// --- Đổi PIN ---
function openChangePinModal(phone, userName) {
  document.getElementById('change-pin-user-id').value = phone;
  document.getElementById('change-pin-user-name').value = `${userName} (${phone})`;
  document.getElementById('change-pin-val').value = '';
  document.getElementById('modal-change-pin').classList.add('show');
}

document.getElementById('form-change-pin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('change-pin-user-id').value;
  const pin = document.getElementById('change-pin-val').value.trim();

  if (!/^\d{4,6}$/.test(pin)) {
    return showToast('Mã PIN mới phải từ 4 đến 6 chữ số!', 'error');
  }

  try {
    const salt = createSalt();
    const pinHash = await hashPin(pin, salt);
    await DB.updateUser(phone, {
      pin_hash: pinHash,
      pin_salt: salt,
      failed_attempts: 0,
      lock_until: null
    });
    showToast('Đã đổi PIN và gỡ bỏ khóa tạm thời thành công!', 'success');
    closeModal('modal-change-pin');
    await loadAdminData();
  } catch (err) {
    showToast('Lỗi đổi PIN: ' + err.message, 'error');
  }
});

// --- Khóa / Mở khóa ---
async function toggleLockUser(phone) {
  if (state.user && state.user.phone === phone) {
    return showToast('Bạn không thể tự khóa tài khoản của chính mình.', 'error');
  }
  try {
    const u = await DB.getUser(phone);
    if (!u) return showToast('Không tìm thấy nhân viên.', 'error');

    const now = Date.now();
    const isCurrentlyLocked = u.is_locked === 1 || (u.lock_until && u.lock_until > now);
    const shouldLock = !isCurrentlyLocked;

    if (shouldLock) {
      await DB.updateUser(phone, { is_locked: 1 });
      await DB.deleteUserSessions(phone);
      showToast(`Đã KHÓA tài khoản "${u.name}".`, 'info');
    } else {
      await DB.updateUser(phone, { is_locked: 0, failed_attempts: 0, lock_until: null });
      showToast(`Đã MỞ KHÓA tài khoản "${u.name}".`, 'success');
    }
    await loadAdminData();
  } catch (err) {
    showToast('Lỗi khóa/mở khóa: ' + err.message, 'error');
  }
}

// --- Xóa nhân viên ---
async function deleteUser(phone, userName) {
  if (!confirm(`Bạn có chắc chắn muốn xóa nhân viên "${userName}"?\nToàn bộ lịch sử chấm công của người này sẽ bị xóa vĩnh viễn.`)) {
    return;
  }
  try {
    await DB.deleteUser(phone);
    showToast(`Đã xóa nhân viên "${userName}".`, 'success');
    await loadAdminData();
  } catch (err) {
    showToast('Lỗi xóa nhân viên: ' + err.message, 'error');
  }
}

// --- Modal helpers ---
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('show');
}

function openGpsModal() {
  document.getElementById('modal-gps-help').classList.add('show');
}

// Gắn các hàm gọi từ HTML onclick vào window (vì script là ES module)
window.openGpsModal = openGpsModal;
window.closeModal = closeModal;
window.switchAdminTab = switchAdminTab;
window.showAttendanceView = showAttendanceView;
window.openAddUserModal = openAddUserModal;
window.openChangePinModal = openChangePinModal;
window.toggleLockUser = toggleLockUser;
window.deleteUser = deleteUser;
window.closeCameraModal = closeCameraModal;
window.openPhotoViewer = openPhotoViewer;

// ==========================================
// 11. KHỞI TẠO ỨNG DỤNG (AUTO-LOGIN 30 NGÀY)
// ==========================================
async function initApp() {
  initClock();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(reg => reg.update()).catch(() => {});
  }

  await initDatabase();

  if (state.token) {
    try {
      const user = await verifySessionToken(state.token);
      if (user) {
        state.user = user;
        await renderAppForUser();
        return;
      }
    } catch (err) {
      console.error('Lỗi kiểm tra phiên:', err);
    }
    localStorage.removeItem('chamcong_token');
    state.token = null;
  }

  document.getElementById('view-login').classList.remove('hidden');
}

window.addEventListener('DOMContentLoaded', initApp);

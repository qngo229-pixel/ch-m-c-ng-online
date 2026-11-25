// ============================================================
// ỨNG DỤNG CHẤM CÔNG GPS - 30 NHÂN SỰ, CHỤP MẶT, NGHỈ PHÉP & GIẢI TRÌNH
// ============================================================

const MAX_USERS = 30;
const OFFICE_LOCATION = {
  lat: 18.78474399853969,
  lng: 105.33180761722444,
  mapUrl: 'https://www.google.com/maps?q=18.78474399853969,105.33180761722444'
};

// ==========================================
// 1. TIỆN ÍCH MẬT MÃ (PBKDF2-SHA256 + SALT), KHOẢNG CÁCH & THỜI GIAN VN
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

// Tính khoảng cách đường chim bay (Haversine) tính bằng mét
function calcDistanceMeters(lat1, lng1, lat2 = OFFICE_LOCATION.lat, lng2 = OFFICE_LOCATION.lng) {
  const R = 6371000; // bán kính Trái Đất (m)
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function formatDistance(meters) {
  const m = Math.round(Number(meters) || 0);
  if (m >= 1000) {
    return `${(m / 1000).toFixed(2)} km`;
  }
  return `${m} m`;
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

function formatVnDateOnly(isoDateStr) {
  if (!isoDateStr || !isoDateStr.includes('-')) return isoDateStr || '';
  const [y, m, d] = isoDateStr.split('-');
  return `${d}/${m}/${y}`;
}

function calcDaysInclusive(fromDate, toDate) {
  if (!fromDate || !toDate) return 1;
  const a = new Date(fromDate + 'T00:00:00');
  const b = new Date(toDate + 'T00:00:00');
  const diff = Math.round((b - a) / (24 * 3600 * 1000)) + 1;
  return diff > 0 ? diff : 1;
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
// 2. TẦNG DỮ LIỆU: FIREBASE CLOUD FIRESTORE (HOẶC LOCAL PREVIEW ?mode=local)
// ==========================================
let dbMode = 'local'; // 'firebase' | 'local'
let fsDb = null;
let fsApi = null;

function isForcedLocalMode() {
  try {
    return new URLSearchParams(window.location.search).get('mode') === 'local';
  } catch {
    return false;
  }
}

function isFirebaseConfigured() {
  if (isForcedLocalMode()) return false;
  const cfg = window.FIREBASE_CONFIG;
  return Boolean(
    cfg &&
    cfg.apiKey &&
    cfg.projectId &&
    String(cfg.apiKey).trim().length > 10 &&
    !String(cfg.apiKey).includes('DIEN_')
  );
}

const LOCAL_KEYS = {
  users: 'cc_local_users_v1',
  sessions: 'cc_local_sessions_v1',
  attendance: 'cc_local_attendance_v1',
  photos: 'cc_local_photos_v1',
  requests: 'cc_local_requests_v1',
  radius: 'cc_office_radius_m'
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

// ==========================================
// 2B. LƯU ẢNH VÀO GOOGLE DRIVE (MIỄN PHÍ 15GB - GIẢM 98% DUNG LƯỢNG FIREBASE)
// ==========================================
function isDriveConfigured() {
  if (isForcedLocalMode()) return false;
  const cfg = window.DRIVE_UPLOAD_CONFIG;
  return Boolean(cfg && cfg.scriptUrl && String(cfg.scriptUrl).trim().startsWith('https://script.google.com/'));
}

function updateDriveStorageBadge() {
  const badge = document.getElementById('drive-storage-badge');
  if (!badge) return;
  if (isDriveConfigured()) {
    badge.className = 'badge badge-approved';
    badge.textContent = '☁️ Thư mục ảnh Drive ↗';
    if (window.DRIVE_UPLOAD_CONFIG.folderUrl) {
      badge.href = window.DRIVE_UPLOAD_CONFIG.folderUrl;
    }
  } else {
    badge.className = 'badge badge-explain';
    badge.textContent = '🔥 Lưu ảnh: Firebase';
    badge.removeAttribute('href');
  }
}

async function uploadPhotoToDrive(dataUrl, { userName, dateKey, timeTag, actionType }) {
  if (!isDriveConfigured() || !dataUrl) return null;
  const cfg = window.DRIVE_UPLOAD_CONFIG;
  const safeUser = makeSafeFilename(userName || 'NV');
  const typeTag = actionType === 'IN' ? 'VaoCa' : 'RaCa';
  const monthKey = (dateKey || getVnDateKey()).slice(0, 7); // YYYY-MM
  const filename = `${dateKey}_${timeTag}_${safeUser}_${typeTag}.jpg`;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 16000) : null;

  try {
    // Dùng text/plain để tránh CORS preflight OPTIONS trên Google Apps Script
    const res = await fetch(cfg.scriptUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      signal: controller ? controller.signal : undefined,
      body: JSON.stringify({
        action: 'upload',
        secret: cfg.secret || '',
        photo: dataUrl,
        monthKey,
        filename
      })
    });
    const json = await res.json();
    if (json && json.ok && json.fileId) {
      return json;
    }
    console.warn('Google Drive upload warning:', json && json.error);
    return null;
  } catch (err) {
    console.warn('Google Drive upload fallback to Firebase:', err.message);
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function deleteDrivePhotos(fileIds) {
  if (!isDriveConfigured() || !fileIds || fileIds.length === 0) return;
  const cfg = window.DRIVE_UPLOAD_CONFIG;
  const cleanIds = [...new Set(fileIds.filter(Boolean))];
  if (cleanIds.length === 0) return;
  try {
    await fetch(cfg.scriptUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'delete',
        secret: cfg.secret || '',
        fileIds: cleanIds
      })
    });
  } catch (err) {
    console.warn('Không thể xóa file trên Google Drive:', err.message);
  }
}

async function initDatabase() {
  const banner = document.getElementById('cloud-status-banner');
  const bannerText = document.getElementById('cloud-status-text');

  // Khôi phục bán kính mặc định
  const savedRadius = parseInt(localStorage.getItem(LOCAL_KEYS.radius) || '200', 10);
  state.officeRadius = [100, 200, 300, 500].includes(savedRadius) ? savedRadius : 200;
  updateOfficeRadiusUI();
  updateDriveStorageBadge();

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
    bannerText.textContent = isForcedLocalMode()
      ? '🧪 Chế độ thử nghiệm Local độc lập (?mode=local) — Dữ liệu chỉ lưu trên trình duyệt này, không ảnh hưởng Firebase thật.'
      : '⚠️ Chưa gắn mã Firebase — Đang chạy chế độ cục bộ trên thiết bị này.';
  }

  await ensureDefaultAdmin();
}

const DB = {
  // --- USERS ---
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
      await fsApi.deleteDoc(fsApi.doc(fsDb, 'users', phone));
      const sessSnap = await fsApi.getDocs(
        fsApi.query(fsApi.collection(fsDb, 'sessions'), fsApi.where('user_id', '==', phone))
      );
      for (const d of sessSnap.docs) await fsApi.deleteDoc(d.ref);

      const attSnap = await fsApi.getDocs(
        fsApi.query(fsApi.collection(fsDb, 'attendance'), fsApi.where('user_id', '==', phone))
      );
      for (const d of attSnap.docs) {
        await fsApi.deleteDoc(d.ref);
        try { await fsApi.deleteDoc(fsApi.doc(fsDb, 'attendance_photos', d.id)); } catch {}
      }

      try {
        const reqSnap = await fsApi.getDocs(
          fsApi.query(fsApi.collection(fsDb, 'requests'), fsApi.where('user_id', '==', phone))
        );
        for (const d of reqSnap.docs) await fsApi.deleteDoc(d.ref);
      } catch {}
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

    const reqs = readLocal(LOCAL_KEYS.requests, []);
    writeLocal(LOCAL_KEYS.requests, reqs.filter(r => r.user_id !== phone));
  },

  async getAllUsers() {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDocs(fsApi.collection(fsDb, 'users'));
      return snap.docs.map(d => d.data());
    }
    const users = readLocal(LOCAL_KEYS.users, {});
    return Object.values(users);
  },

  // --- SESSIONS ---
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
      for (const d of snap.docs) await fsApi.deleteDoc(d.ref);
      return;
    }
    const sessions = readLocal(LOCAL_KEYS.sessions, {});
    Object.keys(sessions).forEach(k => {
      if (sessions[k].user_id === phone) delete sessions[k];
    });
    writeLocal(LOCAL_KEYS.sessions, sessions);
  },

  // --- ATTENDANCE & PHOTOS ---
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
    writeLocal(LOCAL_KEYS.attendance, allAtt.slice(0, 500));

    if (fullPhotoDataUrl) {
      const photos = readLocal(LOCAL_KEYS.photos, {});
      photos[record.id] = fullPhotoDataUrl;
      const keys = Object.keys(photos);
      if (keys.length > 40) delete photos[keys[0]];
      writeLocal(LOCAL_KEYS.photos, photos);
    }
  },

  async updateAttendancePhoto(attId, fields, fallbackFullPhoto = null, userId = '', timestamp = Date.now()) {
    if (!attId) return;
    if (dbMode === 'firebase') {
      await fsApi.updateDoc(fsApi.doc(fsDb, 'attendance', attId), fields);
      if (fallbackFullPhoto) {
        await fsApi.setDoc(fsApi.doc(fsDb, 'attendance_photos', attId), {
          photo: fallbackFullPhoto,
          user_id: userId,
          timestamp
        });
      }
      return;
    }
    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    const idx = allAtt.findIndex(a => a.id === attId);
    if (idx !== -1) {
      allAtt[idx] = { ...allAtt[idx], ...fields };
      writeLocal(LOCAL_KEYS.attendance, allAtt);
    }
    if (fallbackFullPhoto) {
      const photos = readLocal(LOCAL_KEYS.photos, {});
      photos[attId] = fallbackFullPhoto;
      writeLocal(LOCAL_KEYS.photos, photos);
    }
  },

  async updateAttendance(attId, fields) {
    if (!attId || !fields) return;
    if (dbMode === 'firebase') {
      await fsApi.updateDoc(fsApi.doc(fsDb, 'attendance', attId), fields);
      return;
    }
    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    const idx = allAtt.findIndex(a => a.id === attId);
    if (idx !== -1) {
      allAtt[idx] = { ...allAtt[idx], ...fields };
      writeLocal(LOCAL_KEYS.attendance, allAtt);
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

  async getAllAttendance(maxCount = 500) {
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
  },

  async deleteSinglePhoto(attId) {
    if (!attId) return;
    if (dbMode === 'firebase') {
      let driveId = '';
      try {
        const snap = await fsApi.getDoc(fsApi.doc(fsDb, 'attendance', attId));
        if (snap.exists()) driveId = snap.data().photo_drive_id || '';
      } catch {}
      if (driveId) await deleteDrivePhotos([driveId]);

      try {
        await fsApi.deleteDoc(fsApi.doc(fsDb, 'attendance_photos', attId));
      } catch {}
      try {
        await fsApi.updateDoc(fsApi.doc(fsDb, 'attendance', attId), {
          photo_thumb: '',
          photo_full_url: '',
          photo_drive_id: '',
          photo_drive_view_url: '',
          photo_download_url: '',
          has_photo: false
        });
      } catch {}
      return;
    }

    const photos = readLocal(LOCAL_KEYS.photos, {});
    delete photos[attId];
    writeLocal(LOCAL_KEYS.photos, photos);

    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    allAtt.forEach(item => {
      if (item.id === attId) {
        item.photo_thumb = '';
        item.photo_full_url = '';
        item.photo_drive_id = '';
        item.photo_drive_view_url = '';
        item.photo_download_url = '';
        item.has_photo = false;
      }
    });
    writeLocal(LOCAL_KEYS.attendance, allAtt);
  },

  async cleanupOldPhotos(days = 90) {
    const deleteAll = Number(days) === 0;
    const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
    const cleanedIds = new Set();
    const driveIdsToDelete = [];

    if (dbMode === 'firebase') {
      const photoSnap = deleteAll
        ? await fsApi.getDocs(fsApi.collection(fsDb, 'attendance_photos'))
        : await fsApi.getDocs(
            fsApi.query(fsApi.collection(fsDb, 'attendance_photos'), fsApi.where('timestamp', '<', cutoff))
          );
      for (const d of photoSnap.docs) {
        await fsApi.deleteDoc(d.ref);
        cleanedIds.add(d.id);
      }

      const attSnap = deleteAll
        ? await fsApi.getDocs(fsApi.collection(fsDb, 'attendance'))
        : await fsApi.getDocs(
            fsApi.query(fsApi.collection(fsDb, 'attendance'), fsApi.where('timestamp', '<', cutoff))
          );
      for (const d of attSnap.docs) {
        const data = d.data();
        if (data.photo_drive_id) driveIdsToDelete.push(data.photo_drive_id);
        if (data.photo_thumb || data.has_photo || data.photo_drive_id) {
          await fsApi.updateDoc(d.ref, {
            photo_thumb: '',
            photo_full_url: '',
            photo_drive_id: '',
            photo_drive_view_url: '',
            photo_download_url: '',
            has_photo: false
          });
          cleanedIds.add(d.id);
        }
      }
      if (driveIdsToDelete.length > 0) await deleteDrivePhotos(driveIdsToDelete);
      return cleanedIds.size;
    }

    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    const photos = readLocal(LOCAL_KEYS.photos, {});
    allAtt.forEach(item => {
      if (deleteAll || item.timestamp < cutoff) {
        if (photos[item.id]) {
          delete photos[item.id];
          cleanedIds.add(item.id);
        }
        if (item.photo_thumb || item.has_photo) {
          cleanedIds.add(item.id);
        }
        item.photo_thumb = '';
        item.photo_full_url = '';
        item.photo_drive_id = '';
        item.photo_drive_view_url = '';
        item.photo_download_url = '';
        item.has_photo = false;
      }
    });
    writeLocal(LOCAL_KEYS.attendance, allAtt);
    writeLocal(LOCAL_KEYS.photos, photos);
    return cleanedIds.size;
  },

  async deleteAttendanceRecord(attId) {
    if (!attId) return;
    if (dbMode === 'firebase') {
      let driveId = '';
      try {
        const snap = await fsApi.getDoc(fsApi.doc(fsDb, 'attendance', attId));
        if (snap.exists()) driveId = snap.data().photo_drive_id || '';
      } catch {}
      if (driveId) await deleteDrivePhotos([driveId]);

      await fsApi.deleteDoc(fsApi.doc(fsDb, 'attendance', attId));
      try {
        await fsApi.deleteDoc(fsApi.doc(fsDb, 'attendance_photos', attId));
      } catch {}
      return;
    }

    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    writeLocal(LOCAL_KEYS.attendance, allAtt.filter(item => item.id !== attId));
    const photos = readLocal(LOCAL_KEYS.photos, {});
    delete photos[attId];
    writeLocal(LOCAL_KEYS.photos, photos);
  },

  async cleanupAttendanceRecords(days = 90) {
    const deleteAll = Number(days) === 0;
    const cutoff = Date.now() - Number(days) * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    const driveIdsToDelete = [];

    if (dbMode === 'firebase') {
      const attSnap = deleteAll
        ? await fsApi.getDocs(fsApi.collection(fsDb, 'attendance'))
        : await fsApi.getDocs(
            fsApi.query(fsApi.collection(fsDb, 'attendance'), fsApi.where('timestamp', '<', cutoff))
          );
      for (const d of attSnap.docs) {
        const data = d.data();
        if (data.photo_drive_id) driveIdsToDelete.push(data.photo_drive_id);
        await fsApi.deleteDoc(d.ref);
        deletedCount++;
      }

      const photoSnap = deleteAll
        ? await fsApi.getDocs(fsApi.collection(fsDb, 'attendance_photos'))
        : await fsApi.getDocs(
            fsApi.query(fsApi.collection(fsDb, 'attendance_photos'), fsApi.where('timestamp', '<', cutoff))
          );
      for (const d of photoSnap.docs) {
        await fsApi.deleteDoc(d.ref);
      }
      if (driveIdsToDelete.length > 0) await deleteDrivePhotos(driveIdsToDelete);
      return deletedCount;
    }

    const allAtt = readLocal(LOCAL_KEYS.attendance, []);
    const photos = readLocal(LOCAL_KEYS.photos, {});
    const remaining = [];
    allAtt.forEach(item => {
      if (deleteAll || item.timestamp < cutoff) {
        delete photos[item.id];
        deletedCount++;
      } else {
        remaining.push(item);
      }
    });
    writeLocal(LOCAL_KEYS.attendance, remaining);
    writeLocal(LOCAL_KEYS.photos, photos);
    return deletedCount;
  },

  // --- LEAVE & EXPLANATION REQUESTS ---
  async addRequest(reqObj) {
    if (dbMode === 'firebase') {
      await fsApi.setDoc(fsApi.doc(fsDb, 'requests', reqObj.id), reqObj);
      return;
    }
    const list = readLocal(LOCAL_KEYS.requests, []);
    list.unshift(reqObj);
    writeLocal(LOCAL_KEYS.requests, list.slice(0, 300));
  },

  async getUserRequests(phone) {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDocs(
        fsApi.query(fsApi.collection(fsDb, 'requests'), fsApi.where('user_id', '==', phone))
      );
      const list = snap.docs.map(d => d.data());
      list.sort((a, b) => b.created_at - a.created_at);
      return list;
    }
    const list = readLocal(LOCAL_KEYS.requests, []);
    return list.filter(r => r.user_id === phone).sort((a, b) => b.created_at - a.created_at);
  },

  async getAllRequests(maxCount = 300) {
    if (dbMode === 'firebase') {
      const snap = await fsApi.getDocs(
        fsApi.query(
          fsApi.collection(fsDb, 'requests'),
          fsApi.orderBy('created_at', 'desc'),
          fsApi.limit(maxCount)
        )
      );
      return snap.docs.map(d => d.data());
    }
    const list = readLocal(LOCAL_KEYS.requests, []);
    return [...list].sort((a, b) => b.created_at - a.created_at).slice(0, maxCount);
  },

  async updateRequest(reqId, fields) {
    if (dbMode === 'firebase') {
      await fsApi.updateDoc(fsApi.doc(fsDb, 'requests', reqId), fields);
      return;
    }
    const list = readLocal(LOCAL_KEYS.requests, []);
    const idx = list.findIndex(r => r.id === reqId);
    if (idx !== -1) {
      list[idx] = { ...list[idx], ...fields };
      writeLocal(LOCAL_KEYS.requests, list);
    }
  },

  async deleteRequest(reqId) {
    if (dbMode === 'firebase') {
      await fsApi.deleteDoc(fsApi.doc(fsDb, 'requests', reqId));
      return;
    }
    const list = readLocal(LOCAL_KEYS.requests, []);
    writeLocal(LOCAL_KEYS.requests, list.filter(r => r.id !== reqId));
  }
};

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

      // Chỉ tạo thêm các tài khoản mẫu đủ chức danh ở chế độ Local (?mode=local) để test nhanh
      if (dbMode === 'local') {
        const localSamples = [
          { phone: '0900000001', name: 'Tổ trưởng (Thử nghiệm)', role: 'leader' },
          { phone: '0900000002', name: 'Tổ phó (Thử nghiệm)', role: 'deputy' },
          { phone: '0900000003', name: 'Công nhân (Thử nghiệm)', role: 'worker' },
          { phone: '0900000004', name: 'Công nhân dịch vụ (Thử nghiệm)', role: 'service_worker' },
          { phone: '0900000005', name: 'Nhân viên (Thử nghiệm)', role: 'employee' }
        ];
        let offset = 1;
        for (const s of localSamples) {
          const sSalt = createSalt();
          const sHash = await hashPin('123456', sSalt);
          await DB.saveUser({
            id: s.phone,
            name: s.name,
            phone: s.phone,
            pin_hash: sHash,
            pin_salt: sSalt,
            role: s.role,
            is_locked: 0,
            failed_attempts: 0,
            lock_until: null,
            created_at: Date.now() + offset++
          });
        }
      }
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
  selectedShiftMode: 'normal', // 'normal' | 'overtime' | 'holiday'
  lastAttendance: null,
  isPunching: false,
  lockInterval: null,
  officeRadius: 200,
  galleryMode: false,
  currentViewer: { attId: '', src: '', filename: 'chamcong.jpg' },
  allUsersList: [],
  adminRecordsCache: [],
  adminRequestsCache: [],
  myRequestsCache: []
};

const VALID_ROLES = ['admin', 'leader', 'deputy', 'worker', 'service_worker', 'employee'];

function normalizeRole(role) {
  return VALID_ROLES.includes(role) ? role : 'employee';
}

function isAdmin() {
  return Boolean(state.user && state.user.role === 'admin');
}

function isLeader() {
  return Boolean(state.user && state.user.role === 'leader');
}

function isDeputy() {
  return Boolean(state.user && state.user.role === 'deputy');
}

function isSupervisorReadOnly() {
  return isLeader() || isDeputy();
}

function canViewDashboard() {
  return isAdmin() || isSupervisorReadOnly();
}

// Quy tắc LCT/PCT khi tan ca:
// Nhân viên (employee) & Công nhân dịch vụ (service_worker) KHÔNG cần ghi LCT/PCT khi kết thúc ca
// Công nhân (worker), Tổ phó (deputy), Tổ trưởng (leader), Admin CÓ hiện bảng ghi LCT/PCT & km
function requiresCheckoutLct(role) {
  const r = normalizeRole(role);
  return r !== 'employee' && r !== 'service_worker';
}

function getRoleLabel(role) {
  switch (normalizeRole(role)) {
    case 'admin': return 'Quản lý (Admin)';
    case 'leader': return 'Tổ trưởng (Chỉ xem)';
    case 'deputy': return 'Tổ phó (Chỉ xem)';
    case 'worker': return 'Công nhân';
    case 'service_worker': return 'Công nhân dịch vụ';
    default: return 'Nhân viên';
  }
}

function getRoleShortLabel(role) {
  switch (normalizeRole(role)) {
    case 'admin': return 'Admin';
    case 'leader': return 'Tổ trưởng';
    case 'deputy': return 'Tổ phó';
    case 'worker': return 'Công nhân';
    case 'service_worker': return 'CN dịch vụ';
    default: return 'Nhân viên';
  }
}

function renderRoleBadge(role) {
  const r = normalizeRole(role);
  const clsMap = {
    admin: 'badge-admin',
    leader: 'badge-leader',
    deputy: 'badge-deputy',
    worker: 'badge-worker',
    service_worker: 'badge-service',
    employee: 'badge-employee'
  };
  return `<span class="badge ${clsMap[r] || 'badge-employee'}" style="font-size: 0.65rem; margin-left: 4px;">${escapeHtml(getRoleShortLabel(r))}</span>`;
}

function buildUserRoleMap() {
  const map = new Map();
  (state.allUsersList || []).forEach(u => map.set(u.phone, normalizeRole(u.role)));
  return map;
}

function applyDashboardRoleUI() {
  const adminOnly = isAdmin();
  const supervisorOnly = isSupervisorReadOnly();

  const banner = document.getElementById('leader-readonly-banner');
  if (banner) banner.classList.toggle('hidden', !supervisorOnly);
  const bannerText = document.getElementById('leader-readonly-banner-text');
  if (bannerText && supervisorOnly) {
    const title = isDeputy() ? 'Tổ phó' : 'Tổ trưởng';
    bannerText.innerHTML = `<b>Chế độ ${title} (Chỉ xem):</b> Bạn có thể xem số lượng chấm công, ảnh chụp, tổng hợp tháng &amp; đơn xin nghỉ — không thể chấm bù, duyệt đơn, tích nghỉ bù hoặc xóa dữ liệu.`;
  }

  const tabStaff = document.getElementById('tab-btn-staff');
  if (tabStaff) tabStaff.classList.toggle('hidden', !adminOnly);

  const reqLabel = document.getElementById('tab-btn-requests-label');
  if (reqLabel) reqLabel.textContent = adminOnly ? '📝 Duyệt đơn' : '📝 Xem đơn nghỉ';

  const cleanupBtn = document.getElementById('btn-admin-cleanup');
  if (cleanupBtn) cleanupBtn.classList.toggle('hidden', !adminOnly);

  const manualPunchBtn = document.getElementById('btn-admin-manual-punch');
  if (manualPunchBtn) manualPunchBtn.classList.toggle('hidden', !adminOnly);

  const radiusSel = document.getElementById('admin-radius-select');
  if (radiusSel) radiusSel.disabled = !adminOnly;

  const stdModeSel = document.getElementById('summary-standard-mode');
  if (stdModeSel) stdModeSel.disabled = !adminOnly;

  const thAction = document.getElementById('th-history-action');
  if (thAction) thAction.textContent = adminOnly ? 'Bản Đồ / Xóa' : 'Bản Đồ';
}

const WORK_SCHEDULE = {
  inHour: 7,
  inMinute: 30,
  outHour: 18,
  outMinute: 30
};

// Tự động tính công chuẩn của tháng theo tuần làm việc T2 -> CN (6 công/tuần, trừ Chủ Nhật)
// VD: Tháng 30 ngày (4 CN) = 26 công | Tháng 31 ngày (4 CN) = 27 công | Tháng 31 ngày (5 CN) = 26 công
function getMonthWorkStandard(monthKey, modeOverride = null) {
  const [y, m] = String(monthKey || getVnDateKey().slice(0, 7)).split('-').map(Number);
  const totalDays = (y && m) ? new Date(y, m, 0).getDate() : 30;
  let sundayCount = 0;
  for (let d = 1; d <= totalDays; d++) {
    if (new Date(y, m - 1, d).getDay() === 0) sundayCount++;
  }
  const calendarWorkDays = Math.max(1, totalDays - sundayCount);
  const savedMode = modeOverride || localStorage.getItem(`cc_std_mode_${monthKey}`) || 'auto_cal';
  const mode = ['auto_cal', 'fixed_26', 'fixed_27'].includes(savedMode) ? savedMode : 'auto_cal';

  let standardDays = calendarWorkDays;
  if (mode === 'fixed_26') standardDays = 26;
  else if (mode === 'fixed_27') standardDays = 27;

  return {
    monthKey,
    totalDays,
    sundayCount,
    calendarWorkDays,
    standardDays,
    mode
  };
}

function isSundayIso(isoDateStr) {
  if (!isoDateStr) return false;
  const d = new Date(isoDateStr + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.getUTCDay() === 0;
}

// Gom ngày dương lịch (YYYY-MM-DD) về ngày Thứ 2 đầu tuần (tuần T2 -> CN)
function getMonSunWeekKey(isoDateStr) {
  const d = new Date(isoDateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return isoDateStr;
  const day = d.getUTCDay(); // 0=CN, 1=T2 ... 6=T7
  const diffToMon = day === 0 ? -6 : (1 - day);
  d.setUTCDate(d.getUTCDate() + diffToMon);
  return d.toISOString().slice(0, 10);
}

function getShiftModeLabel(mode) {
  if (mode === 'overtime') return 'Tăng ca';
  if (mode === 'holiday') return 'Trực lễ';
  if (mode === 'crm') return 'Trực CRM';
  return 'Ca thường';
}

function renderVnFlagSvg(sizeClass = 'vn-flag-sm') {
  return `<svg viewBox="0 0 36 24" class="vn-flag-svg ${sizeClass}" aria-hidden="true"><rect width="36" height="24" rx="3" fill="#da251d"/><path d="M0 0 H36 V10 Q27 14 18 10 Q9 6 0 10 Z" fill="rgba(255,255,255,0.14)"/><polygon points="18,4.5 19.8,10 25.6,10 20.9,13.4 22.7,18.9 18,15.5 13.3,18.9 15.1,13.4 10.4,10 16.2,10" fill="#ffea00"/></svg>`;
}

function renderEngineerSvg(sizeClass = 'eng-icon-sm') {
  return `<svg viewBox="0 0 48 48" class="eng-icon-svg ${sizeClass}" aria-hidden="true"><path d="M9 44 C9 34 15 30 24 30 C33 30 39 34 39 44 Z" fill="#1d4ed8"/><rect x="15" y="34" width="3" height="10" rx="1" fill="#fde047"/><rect x="30" y="34" width="3" height="10" rx="1" fill="#fde047"/><circle cx="24" cy="23" r="7.5" fill="#fde6c4"/><path d="M13 20 C13 11 18 7 24 7 C30 7 35 11 35 20 Z" fill="#f59e0b"/><rect x="10.5" y="18.5" width="27" height="3.2" rx="1.6" fill="#fbbf24"/><polygon points="25.2,9.5 21.2,14.5 24,14.5 22.8,18.2 27,13.2 24.2,13.2" fill="#163a8c"/></svg>`;
}

function renderShiftModeBadge(mode) {
  if (mode === 'overtime') return '<span class="badge badge-overtime">⚡ Tăng ca</span>';
  if (mode === 'holiday') return `<span class="badge badge-holiday">${renderVnFlagSvg('vn-flag-sm')} Trực lễ</span>`;
  if (mode === 'crm') return `<span class="badge badge-crm">${renderEngineerSvg('eng-icon-sm')} Trực CRM</span>`;
  return '';
}

function getVnMinutesOfDay(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(new Date(timestamp));
  const h = Number((parts.find(p => p.type === 'hour') || {}).value || 0);
  const m = Number((parts.find(p => p.type === 'minute') || {}).value || 0);
  return (h === 24 ? 0 : h) * 60 + m;
}

function formatMinutesShort(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m >= 60) {
    const hh = Math.floor(m / 60);
    const mm = m % 60;
    return mm > 0 ? `${hh}h${String(mm).padStart(2, '0')}p` : `${hh}h`;
  }
  return `${m}p`;
}

function getPunctualityInfo(r) {
  // Chỉ áp dụng Đi muộn (> 07:30) & Về sớm (< 18:30) cho Ca thường (normal)
  if (!r || (r.shift_mode && r.shift_mode !== 'normal') || !r.timestamp) return null;
  const mins = getVnMinutesOfDay(r.timestamp);
  const stdIn = WORK_SCHEDULE.inHour * 60 + WORK_SCHEDULE.inMinute;   // 07:30
  const stdOut = WORK_SCHEDULE.outHour * 60 + WORK_SCHEDULE.outMinute; // 18:30
  if (r.type === 'IN' && mins > stdIn) {
    const diff = mins - stdIn;
    return { kind: 'late', minutes: diff, label: `Muộn ${formatMinutesShort(diff)}` };
  }
  if (r.type === 'OUT' && mins < stdOut) {
    const diff = stdOut - mins;
    return { kind: 'early', minutes: diff, label: `Về sớm ${formatMinutesShort(diff)}` };
  }
  return null;
}

function renderPunctualityBadge(r) {
  const info = getPunctualityInfo(r);
  if (!info) return '';
  if (info.kind === 'late') {
    return `<span class="badge badge-late" title="Giờ vào chuẩn: 07:30">⏰ ${info.label}</span>`;
  }
  return `<span class="badge badge-early" title="Giờ ra chuẩn: 18:30">⚠️ ${info.label}</span>`;
}

function hasLctReport(r) {
  if (!r) return false;
  return Boolean((r.lct_code && String(r.lct_code).trim()) || (r.lct_location && String(r.lct_location).trim()) || (Number(r.travel_km) > 0));
}

function formatLctCodeDisplay(r) {
  if (!r || !r.lct_code) return '';
  const code = String(r.lct_code).trim();
  const typePrefix = (r.lct_type === 'PCT' || r.lct_type === 'LCT') ? r.lct_type : '';
  if (typePrefix && !code.toUpperCase().startsWith(typePrefix)) {
    return `${typePrefix}: ${code}`;
  }
  return code;
}

function renderLctInfoHtml(r) {
  if (!hasLctReport(r)) return '';
  const codeTxt = formatLctCodeDisplay(r);
  const locTxt = String(r.lct_location || '').trim();
  const kmVal = Number(r.travel_km) > 0 ? (Math.round(Number(r.travel_km) * 10) / 10) : 0;

  return `
    <div class="lct-info-box">
      <div class="lct-info-row">
        ${codeTxt ? `<span>📋 <b>${escapeHtml(codeTxt)}</b></span>` : ''}
        ${kmVal > 0 ? `<span class="badge badge-km">🛵 ${kmVal} km</span>` : ''}
      </div>
      ${locTxt ? `<div>📍 <b>Địa điểm:</b> ${escapeHtml(locTxt)}</div>` : ''}
    </div>
  `;
}

function renderManualBadge(r) {
  if (!r || !r.is_manual) return '';
  return `<span class="badge badge-manual" title="Chấm bù bởi ${escapeHtml(r.created_by_admin || 'Admin')}">✍️ Admin chấm bù</span>`;
}

function updateOfficeRadiusUI() {
  const label = document.getElementById('office-radius-label');
  if (label) label.textContent = `${state.officeRadius}m`;
  const sel = document.getElementById('admin-radius-select');
  if (sel) sel.value = String(state.officeRadius);
}

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
        const lockUntil = now + 5 * 60 * 1000;
        await DB.updateUser(phone, { failed_attempts: newAttempts, lock_until: lockUntil });
        throw new Error('Mã PIN không đúng! Bạn đã nhập sai 5 lần. Tài khoản bị tạm khóa 5 phút.');
      } else {
        await DB.updateUser(phone, { failed_attempts: newAttempts });
        throw new Error(`Mã PIN không đúng! (Còn ${5 - newAttempts} lần thử trước khi bị khóa 5 phút).`);
      }
    }

    if (currentAttempts > 0 || user.lock_until) {
      await DB.updateUser(phone, { failed_attempts: 0, lock_until: null });
    }

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
      role: user.role,
      comp_off_by_month: user.comp_off_by_month || {}
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
    submitBtn.innerHTML = '<span>⚡ ĐĂNG NHẬP VÀO CA</span> ➔';
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
    role: user.role,
    comp_off_by_month: user.comp_off_by_month || {}
  };
}

// ==========================================
// 6. HIỂN THỊ GIAO DIỆN SAU KHI ĐĂNG NHẬP
// ==========================================
async function renderAppForUser() {
  document.getElementById('view-login').classList.add('hidden');
  document.getElementById('header-user').classList.remove('hidden');

  document.getElementById('header-user-name').textContent = state.user.name;
  document.getElementById('header-user-role').textContent = `${getRoleLabel(state.user.role)} • ${state.user.phone}`;

  const adminBtn = document.getElementById('btn-toggle-admin-view');
  if (canViewDashboard()) {
    adminBtn.classList.remove('hidden');
    adminBtn.onclick = toggleAdminView;
  } else {
    adminBtn.classList.add('hidden');
  }

  applyDashboardRoleUI();

  // Đặt sẵn ngày hôm nay cho form Nghỉ phép / Giải trình
  const today = getVnDateKey();
  document.getElementById('req-from-date').value = today;
  document.getElementById('req-to-date').value = today;
  document.getElementById('req-explain-date').value = today;

  switchEmployeeTab('punch');
  prewarmGPS();

  if (isSupervisorReadOnly()) {
    switchAdminTab('history');
    await Promise.all([
      showAdminView(),
      syncUserStatus(),
      loadMyHistory(),
      loadMyRequests()
    ]);
  } else {
    showAttendanceView();
    await Promise.all([
      syncUserStatus(),
      loadMyHistory(),
      loadMyRequests()
    ]);
  }
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

function selectShiftMode(mode) {
  if (state.nextAction === 'OUT') {
    showToast('Bạn đang trong ca hiện tại — hãy bấm Ra ca trước khi đổi chế độ ca mới.', 'info');
    return;
  }
  state.selectedShiftMode = ['normal', 'overtime', 'holiday', 'crm'].includes(mode) ? mode : 'normal';
  updatePunchButtonUI();
}

function updatePunchButtonUI() {
  const btn = document.getElementById('btn-punch');
  const wrapper = document.getElementById('punch-btn-wrapper');
  const icon = document.getElementById('punch-icon');
  const text = document.getElementById('punch-text');
  const subtext = document.getElementById('punch-subtext');
  const statusChip = document.getElementById('current-shift-status');

  const isOut = state.nextAction === 'OUT';
  const activeMode = (isOut && state.lastAttendance && state.lastAttendance.shift_mode)
    ? state.lastAttendance.shift_mode
    : state.selectedShiftMode;
  const modeLabel = getShiftModeLabel(activeMode);

  // Cập nhật 4 nút chọn chế độ ca (khóa khi đang ở trong ca để tránh bấm nhầm)
  document.querySelectorAll('#shift-mode-selector .shift-pill').forEach(pill => {
    const pMode = pill.dataset.mode;
    pill.classList.toggle('active', pMode === activeMode);
    pill.disabled = isOut && pMode !== activeMode;
  });

  btn.classList.remove('loading');
  if (wrapper) {
    wrapper.classList.remove('mode-out', 'mode-overtime-ring', 'mode-holiday-ring', 'mode-crm-ring');
  }

  if (!isOut) {
    let btnClass = 'punch-btn btn-in';
    let btnIcon = '☀️';
    let btnLabel = 'VÀO CA';
    let subLabel = `${modeLabel} • Chụp mặt & GPS`;

    if (activeMode === 'overtime') {
      btnClass += ' mode-overtime';
      if (wrapper) wrapper.classList.add('mode-overtime-ring');
      btnIcon = '⚡';
      btnLabel = 'VÀO TĂNG CA';
    } else if (activeMode === 'holiday') {
      btnClass += ' mode-holiday';
      if (wrapper) wrapper.classList.add('mode-holiday-ring');
      btnIcon = 'VN_FLAG';
      btnLabel = 'VÀO TRỰC LỄ';
    } else if (activeMode === 'crm') {
      btnClass += ' mode-crm';
      if (wrapper) wrapper.classList.add('mode-crm-ring');
      btnIcon = 'ENGINEER';
      btnLabel = 'VÀO TRỰC CRM';
      subLabel = 'Trực CRM cả ngày • Ảnh & GPS';
    }

    btn.className = btnClass;
    if (btnIcon === 'VN_FLAG') {
      icon.innerHTML = renderVnFlagSvg('vn-flag-lg');
    } else if (btnIcon === 'ENGINEER') {
      icon.innerHTML = renderEngineerSvg('eng-icon-lg');
    } else {
      icon.textContent = btnIcon;
    }
    text.textContent = btnLabel;
    subtext.textContent = subLabel;

    statusChip.className = 'status-chip out-shift';
    if (state.lastAttendance && state.lastAttendance.type === 'OUT') {
      const lastMode = getShiftModeLabel(state.lastAttendance.shift_mode);
      statusChip.textContent = `⚪ Đã ra ca (${lastMode}) lúc ${state.lastAttendance.datetime_str}`;
    } else {
      statusChip.textContent = '⚪ Hiện tại chưa vào ca';
    }
  } else {
    btn.className = 'punch-btn btn-out';
    if (wrapper) wrapper.classList.add('mode-out');
    icon.textContent = '🌙';
    text.textContent = activeMode === 'overtime'
      ? 'RA TĂNG CA'
      : (activeMode === 'holiday' ? 'RA TRỰC LỄ' : (activeMode === 'crm' ? 'RA TRỰC CRM' : 'RA CA'));
    subtext.textContent = activeMode === 'crm' ? 'Kết thúc Trực CRM • Ảnh & GPS' : `${modeLabel} • Chụp mặt & GPS`;

    statusChip.className = 'status-chip in-shift';
    const inTime = state.lastAttendance ? state.lastAttendance.datetime_str : '';
    if (activeMode === 'holiday') {
      statusChip.innerHTML = `${renderVnFlagSvg('vn-flag-sm')} <span>Đang TRỰC LỄ (Vào lúc ${escapeHtml(inTime)})</span>`;
    } else if (activeMode === 'crm') {
      statusChip.innerHTML = `${renderEngineerSvg('eng-icon-sm')} <span>Đang TRỰC CRM cả ngày (Vào lúc ${escapeHtml(inTime)})</span>`;
    } else {
      const modePrefix = activeMode === 'overtime' ? '⚡ Đang TĂNG CA' : '🟢 Đang trong ca làm việc';
      statusChip.textContent = `${modePrefix} (Vào lúc ${inTime})`;
    }
  }
}

function switchEmployeeTab(tab) {
  const punchDiv = document.getElementById('emp-tab-punch');
  const reqDiv = document.getElementById('emp-tab-request');
  const btnPunch = document.getElementById('emp-tab-btn-punch');
  const btnReq = document.getElementById('emp-tab-btn-request');

  if (tab === 'punch') {
    punchDiv.classList.remove('hidden');
    reqDiv.classList.add('hidden');
    btnPunch.classList.add('active');
    btnReq.classList.remove('active');
  } else {
    punchDiv.classList.add('hidden');
    reqDiv.classList.remove('hidden');
    btnPunch.classList.remove('active');
    btnReq.classList.add('active');
    loadMyRequests();
  }
}

// ==========================================
// 7. GPS SIÊU TỐC (SONG SONG VỆ TINH + 4G/5G + KHÓA TRƯỚC KHI MỞ CAMERA) & ĐẨY ẢNH NỀN
// ==========================================
const gpsState = {
  cachedCoords: null,
  cachedAt: 0,
  activePromise: null,
  lastWarmupAt: 0
};

const pendingLocalPhotos = new Map();
let pendingDriveUploads = 0;

window.addEventListener('beforeunload', (e) => {
  if (pendingDriveUploads > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function warmupDriveScript() {
  if (!isDriveConfigured()) return;
  const now = Date.now();
  if (now - gpsState.lastWarmupAt < 90000) return; // Đánh thức tối đa 1 lần / 90 giây
  gpsState.lastWarmupAt = now;
  try {
    fetch(window.DRIVE_UPLOAD_CONFIG.scriptUrl.trim(), {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store'
    }).catch(() => {});
  } catch {}
}

function cacheGpsCoords(coords) {
  if (!coords || typeof coords.latitude !== 'number' || typeof coords.longitude !== 'number') return;
  const now = Date.now();
  const prevAcc = gpsState.cachedCoords ? (Number(gpsState.cachedCoords.accuracy) || 9999) : 9999;
  const nextAcc = Number(coords.accuracy) || 9999;
  if (!gpsState.cachedCoords || (now - gpsState.cachedAt) > 8000 || nextAcc <= prevAcc) {
    gpsState.cachedCoords = {
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: Math.round(nextAcc * 10) / 10
    };
    gpsState.cachedAt = now;
  }
  updateCameraGpsPill();
}

function getFreshCachedGps(maxAgeMs = 25000, maxAccM = 180) {
  if (!gpsState.cachedCoords) return null;
  if ((Date.now() - gpsState.cachedAt) > maxAgeMs) return null;
  if ((gpsState.cachedCoords.accuracy || 0) > maxAccM) return null;
  return gpsState.cachedCoords;
}

function updateCameraGpsPill(mode = null) {
  const pill = document.getElementById('camera-gps-pill');
  if (!pill) return;

  const cached = getFreshCachedGps(35000, 5000);
  if (cached && mode !== 'error') {
    const distM = calcDistanceMeters(cached.latitude, cached.longitude);
    const inOffice = distM <= state.officeRadius;
    const accTxt = cached.accuracy ? `±${Math.round(cached.accuracy)}m` : '';
    pill.className = `camera-gps-pill ${inOffice ? 'gps-ready' : 'gps-warn'}`;
    pill.textContent = inOffice
      ? `✅ GPS đã sẵn sàng (${accTxt ? accTxt + ' • ' : ''}Tại công ty ${formatDistance(distM)})`
      : `📍 GPS sẵn sàng (${accTxt ? accTxt + ' • ' : ''}Cách công ty ${formatDistance(distM)})`;
    return;
  }

  if (mode === 'error') {
    pill.className = 'camera-gps-pill gps-warn';
    pill.textContent = '⚠️ Chưa lấy được GPS — hãy bật Vị trí rồi bấm chụp';
  } else {
    pill.className = 'camera-gps-pill gps-loading';
    pill.textContent = '🛰️ Đang khóa trước vị trí GPS...';
  }
}

function getOptimizedMobileGPS(onProgress, { preferCache = true } = {}) {
  // 1. Nếu đã khóa sẵn vị trí trong lúc mở app / mở camera (< 25s) -> trả về NGAY LẬP TỨC (0ms)!
  if (preferCache) {
    const cached = getFreshCachedGps(25000, 180);
    if (cached) return Promise.resolve(cached);
  }

  // 2. Nếu đang có lượt lấy GPS chạy sẵn từ lúc mở camera -> dùng chung không gọi trùng!
  if (gpsState.activePromise) {
    return gpsState.activePromise;
  }

  const p = new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error('Trình duyệt của bạn không hỗ trợ định vị GPS.'));
    }

    if (window.isSecureContext === false && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      return reject(new Error('Định vị GPS trên 4G/5G yêu cầu đường dẫn bảo mật HTTPS.'));
    }

    let settled = false;
    let highDone = false;
    let fastDone = false;
    let fastFallbackTimer = null;
    let fastBestCoords = null;
    let lastError = null;

    if (onProgress) onProgress('🛰️ Đang định vị GPS & 4G/5G song song...');

    const finishSuccess = (coords) => {
      cacheGpsCoords(coords);
      if (settled) return;
      settled = true;
      if (fastFallbackTimer) clearTimeout(fastFallbackTimer);
      resolve({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy || 0
      });
    };

    const maybeReject = (err) => {
      if (settled) return;
      if (err && err.code === 1) {
        settled = true;
        if (fastFallbackTimer) clearTimeout(fastFallbackTimer);
        return reject(new Error('Bạn đã từ chối quyền Vị trí. Vui lòng cho phép quyền Vị trí trên trình duyệt để chấm công!'));
      }
      lastError = err || lastError;
      if (highDone && fastDone) {
        if (fastBestCoords) {
          return finishSuccess(fastBestCoords);
        }
        settled = true;
        if (fastFallbackTimer) clearTimeout(fastFallbackTimer);
        let msg = 'Không thể lấy vị trí GPS.';
        if (lastError && lastError.code === 2) msg = 'Vị trí hiện không khả dụng. Hãy bật GPS/Vị trí trên điện thoại.';
        else if (lastError && lastError.code === 3) msg = 'Hết thời gian chờ GPS. Vui lòng thử lại ở nơi thoáng hơn.';
        reject(new Error(msg));
      }
    };

    // Luồng A: GPS Vệ tinh chính xác cao (chạy song song)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        highDone = true;
        finishSuccess(pos.coords);
      },
      (err) => {
        highDone = true;
        if (fastBestCoords && !settled && (!err || err.code !== 1)) {
          finishSuccess(fastBestCoords);
          return;
        }
        maybeReject(err);
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }
    );

    // Luồng B: Định vị nhanh qua sóng 4G/5G & Wi-Fi (chạy song song)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        fastDone = true;
        fastBestCoords = pos.coords;
        cacheGpsCoords(pos.coords);
        if (settled) return;
        // Nếu vệ tinh đã xong/lỗi -> chốt ngay. Nếu 4G/5G đã khá chuẩn (<=80m) chỉ đợi vệ tinh tối đa 400ms, ngược lại tối đa 2s!
        if (highDone) {
          finishSuccess(pos.coords);
        } else {
          const waitForHighMs = (pos.coords.accuracy && pos.coords.accuracy <= 80) ? 400 : 2000;
          if (onProgress) onProgress('📡 Đã có vị trí, đang tinh chỉnh độ chính xác...');
          fastFallbackTimer = setTimeout(() => {
            if (!settled && fastBestCoords) finishSuccess(fastBestCoords);
          }, waitForHighMs);
        }
      },
      (err) => {
        fastDone = true;
        maybeReject(err);
      },
      { enableHighAccuracy: false, timeout: 4500, maximumAge: 25000 }
    );
  }).finally(() => {
    gpsState.activePromise = null;
  });

  gpsState.activePromise = p;
  return p;
}

function prewarmGPS() {
  warmupDriveScript();
  if (navigator.geolocation && (window.isSecureContext !== false || location.hostname === 'localhost')) {
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => cacheGpsCoords(pos.coords),
        () => {},
        { enableHighAccuracy: false, timeout: 3500, maximumAge: 30000 }
      );
    } catch {}
  }
}

let cameraStream = null;
let currentFacingMode = 'user';

function createThumbnailFromCanvas(sourceCanvas) {
  const thumb = document.createElement('canvas');
  const size = 88;
  thumb.width = size;
  thumb.height = size;
  const ctx = thumb.getContext('2d');
  const minSide = Math.min(sourceCanvas.width, sourceCanvas.height);
  const sx = (sourceCanvas.width - minSide) / 2;
  const sy = (sourceCanvas.height - minSide) / 2;
  ctx.drawImage(sourceCanvas, sx, sy, minSide, minSide, 0, 0, size, size);
  return thumb.toDataURL('image/jpeg', 0.55);
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

function setQuickWorkNote(noteText) {
  const input = document.getElementById('camera-work-note');
  if (!input) return;
  input.value = noteText || '';
  input.focus();
}

function openCameraModal() {
  document.getElementById('modal-camera').classList.add('show');

  // Đặt gợi ý ghi chú phù hợp theo chế độ ca đang chọn
  const noteInput = document.getElementById('camera-work-note');
  if (noteInput) {
    noteInput.value = '';
    const activeMode = (state.nextAction === 'OUT' && state.lastAttendance && state.lastAttendance.shift_mode)
      ? state.lastAttendance.shift_mode
      : state.selectedShiftMode;
    if (activeMode === 'crm') {
      noteInput.placeholder = '👷 Ghi chú Trực CRM (VD: Trực CRM cả ngày hôm nay...)';
    } else if (activeMode === 'overtime') {
      noteInput.placeholder = '⚡ Nội dung Tăng ca (VD: Xử lý sự cố MBA, kéo dây...)';
    } else if (activeMode === 'holiday') {
      noteInput.placeholder = '★ Nội dung Trực lễ (VD: Trực vận hành lưới điện lễ...)';
    } else {
      noteInput.placeholder = '💬 Ghi chú công việc (không bắt buộc, VD: Đi hiện trường...)';
    }
  }

  // Chạy song song 3 việc ngay khi mở Camera: mở video + đánh thức Google Drive + khóa trước GPS!
  startCameraStream();
  warmupDriveScript();
  updateCameraGpsPill('loading');
  if (navigator.geolocation && (window.isSecureContext !== false || location.hostname === 'localhost')) {
    getOptimizedMobileGPS(null, { preferCache: true })
      .then(() => updateCameraGpsPill())
      .catch(() => updateCameraGpsPill('error'));
  }
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
  const scale = Math.min(400 / width, 400 / height, 1);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const ctx = canvas.getContext('2d');
  if (currentFacingMode === 'user') {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const fullPhoto = canvas.toDataURL('image/jpeg', 0.68);
  const thumbPhoto = createThumbnailFromCanvas(canvas);
  const workNote = (document.getElementById('camera-work-note')?.value || '').trim();
  playShutterSound();

  closeCameraModal();
  executePunchWithPhoto(fullPhoto, thumbPhoto, workNote);
});

document.getElementById('camera-fallback-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const workNote = (document.getElementById('camera-work-note')?.value || '').trim();
  const reader = new FileReader();
  reader.onload = (evt) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.getElementById('camera-canvas');
      const scale = Math.min(400 / img.width, 400 / img.height, 1);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const fullPhoto = canvas.toDataURL('image/jpeg', 0.68);
      const thumbPhoto = createThumbnailFromCanvas(canvas);
      playShutterSound();

      closeCameraModal();
      executePunchWithPhoto(fullPhoto, thumbPhoto, workNote);
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
});

document.getElementById('btn-punch').addEventListener('click', () => {
  if (state.isPunching) return;
  openCameraModal();
});

function getRecordDistance(r) {
  if (typeof r.distance_m === 'number' && !isNaN(r.distance_m)) {
    return r.distance_m;
  }
  return calcDistanceMeters(Number(r.latitude), Number(r.longitude));
}

function renderZoneBadge(distanceM) {
  const inOffice = distanceM <= state.officeRadius;
  const distText = formatDistance(distanceM);
  return inOffice
    ? `<span class="zone-badge zone-ok">✓ Tại công ty (${distText})</span>`
    : `<span class="zone-badge zone-far">⚠️ Cách công ty ${distText}</span>`;
}

function updateResultSyncUI(attId, statusText, isDone = false) {
  const row = document.getElementById('res-sync-row');
  const el = document.getElementById('res-sync-status');
  if (!row || !el) return;
  if (row.dataset.attId && row.dataset.attId !== attId) return;
  row.classList.remove('hidden');
  el.textContent = statusText;
  el.className = `result-value ${isDone ? 'sync-status-done' : 'sync-status-pending'}`;
}

async function syncPhotoToDriveInBackground(record, fullPhoto, { dateKey, timeTag }) {
  if (!fullPhoto || !record || !record.id) return;
  pendingDriveUploads++;
  pendingLocalPhotos.set(record.id, fullPhoto);

  try {
    const driveResult = await uploadPhotoToDrive(fullPhoto, {
      userName: record.user_name,
      dateKey,
      timeTag,
      actionType: record.type
    });

    if (driveResult && driveResult.fileId) {
      await DB.updateAttendancePhoto(record.id, {
        photo_thumb: driveResult.thumbUrl,
        photo_full_url: driveResult.fullUrl,
        photo_drive_id: driveResult.fileId,
        photo_drive_view_url: driveResult.viewUrl,
        photo_download_url: driveResult.downloadUrl,
        photo_storage: 'drive',
        has_photo: true
      });
      updateResultSyncUI(record.id, '☁️ Đã lưu ảnh .jpg lên Google Drive ✓', true);
    } else {
      // Dự phòng nếu Google Drive lỗi/mất mạng -> lưu ảnh sang Firebase để không mất ảnh
      await DB.updateAttendancePhoto(
        record.id,
        { photo_storage: 'firestore', has_photo: true },
        fullPhoto,
        record.user_id,
        record.timestamp
      );
      updateResultSyncUI(record.id, '🔥 Đã lưu ảnh dự phòng trên Firebase ✓', true);
    }
    loadMyHistory().catch(() => {});
  } catch (err) {
    console.warn('Lỗi đồng bộ ảnh nền:', err.message);
    try {
      await DB.updateAttendancePhoto(
        record.id,
        { photo_storage: 'firestore', has_photo: true },
        fullPhoto,
        record.user_id,
        record.timestamp
      );
      updateResultSyncUI(record.id, '🔥 Đã lưu ảnh dự phòng trên Firebase ✓', true);
    } catch {}
  } finally {
    pendingDriveUploads = Math.max(0, pendingDriveUploads - 1);
    setTimeout(() => pendingLocalPhotos.delete(record.id), 120000);
  }
}

async function executePunchWithPhoto(fullPhoto, thumbPhoto, workNote = '') {
  const btn = document.getElementById('btn-punch');
  const text = document.getElementById('punch-text');
  const subtext = document.getElementById('punch-subtext');
  const icon = document.getElementById('punch-icon');

  state.isPunching = true;
  btn.classList.add('loading');
  icon.textContent = '⚡';
  text.textContent = 'ĐANG CHẤM CÔNG...';
  subtext.textContent = 'Đang xác thực & khóa tọa độ';

  try {
    // Chạy SONG SONG cả 3 bước: kiểm tra phiên + lấy GPS (thường 0ms vì đã khóa lúc mở camera) + kiểm tra ca trước
    const [freshUser, coords, recent] = await Promise.all([
      verifySessionToken(state.token),
      getOptimizedMobileGPS((progressMsg) => {
        subtext.textContent = progressMsg;
      }, { preferCache: true }),
      DB.getUserAttendance(state.user.phone, 1)
    ]);

    if (!freshUser) {
      showToast('Phiên đăng nhập không hợp lệ hoặc tài khoản đã bị khóa.', 'error');
      await logout();
      return;
    }

    const lat = Number(coords.latitude);
    const lng = Number(coords.longitude);
    const accValue = Math.round((Number(coords.accuracy) || 0) * 10) / 10;
    const distanceM = calcDistanceMeters(lat, lng);
    const inOffice = distanceM <= state.officeRadius;

    text.textContent = 'ĐANG LƯU CA...';
    subtext.textContent = `Cách công ty ${formatDistance(distanceM)}`;

    const last = recent.length > 0 ? recent[0] : null;
    const actionType = (!last || last.type === 'OUT') ? 'IN' : 'OUT';
    const shiftMode = (actionType === 'OUT' && last && last.shift_mode)
      ? last.shift_mode
      : state.selectedShiftMode;
    const shiftModeLabel = getShiftModeLabel(shiftMode);

    const now = Date.now();
    const dateKey = getVnDateKey(now);
    const timeStr = getVnTimeStr(now);
    const timeTag = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(now)).replace(/:/g, '-');

    const willUploadToDrive = Boolean(fullPhoto && isDriveConfigured());
    const attId = `att_${now}_${Math.random().toString(36).slice(2, 7)}`;
    const record = {
      id: attId,
      user_id: state.user.phone,
      user_name: state.user.name,
      user_phone: state.user.phone,
      user_role: state.user.role,
      type: actionType,
      typeText: actionType === 'IN' ? 'Vào ca' : 'Ra ca',
      shift_mode: shiftMode,
      shift_mode_text: shiftModeLabel,
      is_manual: false,
      note: String(workNote || '').trim(),
      timestamp: now,
      datetime_str: timeStr,
      date_key: dateKey,
      latitude: lat,
      longitude: lng,
      accuracy: accValue,
      distance_m: distanceM,
      in_office: inOffice,
      mapUrl: `https://www.google.com/maps?q=${lat},${lng}`,
      photo_thumb: thumbPhoto || '',
      photo_full_url: '',
      photo_drive_id: '',
      photo_drive_view_url: '',
      photo_download_url: '',
      photo_storage: willUploadToDrive ? 'uploading' : (fullPhoto ? 'firestore' : ''),
      has_photo: Boolean(fullPhoto),
      lct_type: '',
      lct_code: '',
      lct_location: '',
      travel_km: 0
    };

    // Lưu NGAY giờ công + tọa độ + ảnh thu nhỏ (~2.5KB) để nhân viên nhận kết quả tức thì (< 1 giây)!
    // Khi đã bật Drive, KHÔNG ghi fullPhoto vào Firebase mà đẩy ảnh .jpg lên Drive chạy ngầm phía sau.
    await DB.addAttendance(record, willUploadToDrive ? null : fullPhoto);

    playSuccessSound();
    const actionLabel = actionType === 'IN' ? `VÀO ${shiftModeLabel.toUpperCase()}` : `RA ${shiftModeLabel.toUpperCase()}`;
    showToast(`✅ Chấm công ${actionLabel} thành công!`, 'success', 4000);

    showPunchResult(record, fullPhoto, willUploadToDrive);

    state.lastAttendance = record;
    state.nextAction = actionType === 'IN' ? 'OUT' : 'IN';
    if (actionType === 'OUT') state.selectedShiftMode = 'normal';
    updatePunchButtonUI();

    // Sau khi chấm công TAN CA (Ra ca):
    // Chỉ Công nhân, Tổ phó, Tổ trưởng, Admin mới tự động hiện hộp thoại ghi LCT/PCT, địa điểm & km.
    // Nhân viên & Công nhân dịch vụ KHÔNG cần ghi LCT/PCT khi kết thúc ca.
    if (actionType === 'OUT' && requiresCheckoutLct(state.user && state.user.role)) {
      setTimeout(() => {
        openCheckoutReportModal(record, false);
      }, 280);
    }

    // Đẩy ảnh rõ nét (.jpg) lên Google Drive chạy ngầm & tải lại lịch sử không chặn giao diện
    if (willUploadToDrive) {
      syncPhotoToDriveInBackground(record, fullPhoto, { dateKey, timeTag });
    }
    loadMyHistory().catch(() => {});
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

function updateResultLctUI(record) {
  const box = document.getElementById('res-lct-box');
  const editBtn = document.getElementById('btn-res-edit-lct');
  if (!box || !editBtn) return;

  const needLct = requiresCheckoutLct(state.user && state.user.role);
  if (!record || record.type !== 'OUT' || (!needLct && !hasLctReport(record))) {
    box.classList.add('hidden');
    box.innerHTML = '';
    editBtn.classList.add('hidden');
    return;
  }

  editBtn.classList.remove('hidden');
  editBtn.textContent = hasLctReport(record) ? '✏️ Sửa LCT/PCT & km' : '📋 Ghi LCT/PCT & km';
  editBtn.onclick = () => openCheckoutReportModal(record, hasLctReport(record));

  if (hasLctReport(record)) {
    const codeTxt = formatLctCodeDisplay(record);
    const locTxt = String(record.lct_location || '').trim();
    const kmVal = Number(record.travel_km) > 0 ? (Math.round(Number(record.travel_km) * 10) / 10) : 0;
    box.innerHTML = `
      <div class="lct-info-row">
        ${codeTxt ? `<span>📋 <b>${escapeHtml(codeTxt)}</b></span>` : '<span>📋 <b>Báo cáo tan ca</b></span>'}
        ${kmVal > 0 ? `<span class="badge badge-km">🛵 ${kmVal} km</span>` : ''}
      </div>
      ${locTxt ? `<div>📍 <b>Địa điểm:</b> ${escapeHtml(locTxt)}</div>` : ''}
    `;
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}

function selectLctType(type) {
  const validType = ['LCT', 'PCT', 'NONE'].includes(type) ? type : 'LCT';
  document.getElementById('checkout-lct-type').value = validType;
  document.querySelectorAll('.lct-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lct === validType);
  });
  const fieldsWrap = document.getElementById('checkout-lct-fields');
  if (fieldsWrap) {
    fieldsWrap.classList.toggle('hidden', validType === 'NONE');
  }
  const codeInput = document.getElementById('checkout-lct-code');
  if (codeInput) {
    codeInput.placeholder = validType === 'PCT'
      ? 'VD: PCT-08/11/2026 hoặc nhiều số cách dấu phẩy...'
      : 'VD: LCT-125/2026 hoặc nhiều số cách dấu phẩy...';
  }
}

function openCheckoutReportModal(record, isEdit = false) {
  if (!record || !record.id) return;
  document.getElementById('checkout-report-att-id').value = record.id;

  const bannerEl = document.getElementById('checkout-report-banner');
  if (bannerEl) {
    bannerEl.innerHTML = isEdit
      ? `Cập nhật báo cáo <b>LCT/PCT &amp; số km</b> cho lượt Ra ca lúc <b>${escapeHtml(record.datetime_str || '')}</b>.`
      : `Đã chấm công tan ca lúc <b>${escapeHtml(record.datetime_str || '')}</b>! Vui lòng ghi lại số <b>LCT/PCT</b>, địa điểm thực hiện và <b>số km quãng đường</b> hôm nay.`;
  }

  const initType = record.lct_type || 'LCT';
  selectLctType(initType);
  document.getElementById('checkout-lct-code').value = record.lct_code || '';
  document.getElementById('checkout-lct-location').value = record.lct_location || '';
  document.getElementById('checkout-distance-km').value = Number(record.travel_km) > 0 ? String(record.travel_km) : '';

  document.getElementById('modal-checkout-report').classList.add('show');
}

document.getElementById('form-checkout-report').addEventListener('submit', async (e) => {
  e.preventDefault();
  const attId = document.getElementById('checkout-report-att-id').value;
  if (!attId) return;

  const lctType = document.getElementById('checkout-lct-type').value || 'LCT';
  const lctCode = lctType === 'NONE' ? '' : document.getElementById('checkout-lct-code').value.trim();
  const lctLocation = lctType === 'NONE' ? '' : document.getElementById('checkout-lct-location').value.trim();
  const rawKm = document.getElementById('checkout-distance-km').value.trim();
  const parsedKm = rawKm === '' ? 0 : Math.max(0, Math.round(Number(rawKm) * 10) / 10);

  if (isNaN(parsedKm)) {
    return showToast('Số km quãng đường không hợp lệ!', 'error');
  }
  if (!lctCode && !lctLocation && parsedKm === 0) {
    return showToast('Vui lòng nhập số LCT/PCT, địa điểm hoặc số km (hoặc bấm "Bỏ qua").', 'info');
  }

  const btn = document.getElementById('btn-save-checkout-report');
  btn.disabled = true;
  btn.textContent = '⏳ Đang lưu...';

  try {
    const fields = {
      lct_type: lctType,
      lct_code: lctCode,
      lct_location: lctLocation,
      travel_km: parsedKm,
      lct_updated_at: Date.now()
    };
    await DB.updateAttendance(attId, fields);

    if (state.lastAttendance && state.lastAttendance.id === attId) {
      state.lastAttendance = { ...state.lastAttendance, ...fields };
      updateResultLctUI(state.lastAttendance);
    }

    playSuccessSound();
    showToast('✅ Đã lưu báo cáo LCT/PCT & số km thành công!', 'success', 4000);
    closeModal('modal-checkout-report');
    loadMyHistory().catch(() => {});
    if (canViewDashboard() && !document.getElementById('view-admin').classList.contains('hidden')) {
      loadAdminData().catch(() => {});
    }
  } catch (err) {
    playErrorSound();
    showToast('Lỗi lưu báo cáo LCT/PCT: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Lưu báo cáo';
  }
});

function showPunchResult(record, fullPhoto, isUploadingDrive = false) {
  const card = document.getElementById('punch-result-card');
  const typeEl = document.getElementById('res-type');
  const timeEl = document.getElementById('res-time');
  const distEl = document.getElementById('res-distance');
  const gpsEl = document.getElementById('res-gps');
  const accEl = document.getElementById('res-acc');
  const mapLink = document.getElementById('res-map-link');
  const photoRow = document.getElementById('res-photo-row');
  const photoImg = document.getElementById('res-photo-img');
  const syncRow = document.getElementById('res-sync-row');
  const syncStatus = document.getElementById('res-sync-status');

  const modeLabel = getShiftModeLabel(record.shift_mode);
  typeEl.textContent = record.type === 'IN' ? `✅ Vào ca (${modeLabel})` : `👋 Ra ca (${modeLabel})`;
  typeEl.className = record.type === 'IN' ? 'result-value text-success' : 'result-value text-danger';

  timeEl.textContent = record.datetime_str;
  distEl.innerHTML = renderZoneBadge(getRecordDistance(record));
  gpsEl.textContent = `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`;
  accEl.textContent = `± ${record.accuracy}m`;
  mapLink.href = record.mapUrl;

  if (syncRow && syncStatus) {
    syncRow.dataset.attId = record.id || '';
    if (isUploadingDrive) {
      syncRow.classList.remove('hidden');
      syncStatus.textContent = '☁️ Đang đẩy ảnh .jpg lên Google Drive...';
      syncStatus.className = 'result-value sync-status-pending';
    } else {
      syncRow.classList.add('hidden');
    }
  }

  updateResultLctUI(record);

  const previewSrc = fullPhoto || record.photo_thumb;
  if (previewSrc) {
    photoImg.src = previewSrc;
    photoImg.onclick = () => openPhotoViewer(record.id, previewSrc, `${record.typeText} lúc ${record.datetime_str}`, record);
    photoRow.classList.remove('hidden');
  } else {
    photoRow.classList.add('hidden');
  }

  card.classList.remove('hidden');
}

function makeSafeFilename(rawName) {
  return String(rawName || 'chamcong')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'chamcong';
}

function downloadDataUrlAsJpg(dataUrlOrLink, filename) {
  if (!dataUrlOrLink) {
    return showToast('Không có ảnh để tải về.', 'error');
  }
  if (String(dataUrlOrLink).startsWith('http')) {
    window.open(dataUrlOrLink, '_blank');
    showToast('⬇️ Đang tải ảnh từ Google Drive...', 'success');
    return;
  }
  const a = document.createElement('a');
  a.href = dataUrlOrLink;
  a.download = filename.endsWith('.jpg') ? filename : `${filename}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('⬇️ Đã tải ảnh về máy thành công!', 'success');
}

async function openPhotoViewer(attId, fallbackSrc, title, meta = null) {
  const imgEl = document.getElementById('photo-viewer-img');
  const titleEl = document.getElementById('photo-viewer-title');
  const detailsEl = document.getElementById('photo-viewer-details');
  const mapLinkEl = document.getElementById('photo-viewer-map-link');
  const driveLinkEl = document.getElementById('photo-viewer-drive-link');
  const dlBtn = document.getElementById('btn-download-photo');
  const delBtn = document.getElementById('btn-delete-viewer-photo');

  titleEl.textContent = title || 'Ảnh Chấm Công';
  const localPendingSrc = attId ? pendingLocalPhotos.get(attId) : '';
  const initialSrc = localPendingSrc || ((meta && meta.photo_full_url) ? meta.photo_full_url : (fallbackSrc || ''));
  imgEl.src = initialSrc;

  const safeName = makeSafeFilename(title || attId || 'anh_cham_cong');
  state.currentViewer = {
    attId: attId || '',
    src: (meta && meta.photo_download_url) ? meta.photo_download_url : initialSrc,
    filename: `${safeName}.jpg`
  };
  dlBtn.disabled = !initialSrc;

  if (delBtn) {
    if (state.user && state.user.role === 'admin' && attId) {
      delBtn.classList.remove('hidden');
    } else {
      delBtn.classList.add('hidden');
    }
  }

  if (driveLinkEl) {
    if (meta && meta.photo_drive_view_url) {
      driveLinkEl.href = meta.photo_drive_view_url;
      driveLinkEl.classList.remove('hidden');
    } else {
      driveLinkEl.classList.add('hidden');
    }
  }

  if (meta && meta.mapUrl) {
    mapLinkEl.href = meta.mapUrl;
    mapLinkEl.classList.remove('hidden');
  } else {
    mapLinkEl.classList.add('hidden');
  }

  const storageTag = (meta && meta.photo_drive_id) ? ' • ☁️ Google Drive' : '';
  const metaHtml = meta
    ? `<div style="margin-bottom: 4px;">${renderZoneBadge(getRecordDistance(meta))} • Sai số GPS: ±${meta.accuracy}m${storageTag}</div>`
    : '';
  document.getElementById('modal-photo-viewer').classList.add('show');

  // Nếu đã có ảnh nét trong bộ nhớ tạm hoặc ảnh lưu trên Google Drive -> không cần đọc từ Firebase attendance_photos!
  if (localPendingSrc || (meta && meta.photo_full_url)) {
    detailsEl.innerHTML = metaHtml;
    return;
  }

  detailsEl.innerHTML = metaHtml + '<span style="color: var(--text-dim);">Đang tải ảnh độ nét cao...</span>';
  if (attId) {
    try {
      const full = await DB.getFullPhoto(attId);
      if (full) {
        imgEl.src = full;
        state.currentViewer.src = full;
        dlBtn.disabled = false;
      }
      detailsEl.innerHTML = metaHtml;
    } catch {
      detailsEl.innerHTML = metaHtml;
    }
  } else {
    detailsEl.innerHTML = metaHtml;
  }
}

document.getElementById('btn-download-photo').addEventListener('click', () => {
  downloadDataUrlAsJpg(state.currentViewer.src, state.currentViewer.filename);
});

document.getElementById('btn-delete-viewer-photo').addEventListener('click', async () => {
  if (!isAdmin()) {
    return showToast('Tài khoản Tổ trưởng / Tổ phó chỉ có quyền xem, không được xóa ảnh!', 'error');
  }
  const attId = state.currentViewer.attId;
  if (!attId) return;
  if (!confirm('Xác nhận xóa ảnh khuôn mặt này?\n(Giờ chấm công và tọa độ GPS vẫn được giữ nguyên)')) return;
  try {
    await DB.deleteSinglePhoto(attId);
    closeModal('modal-photo-viewer');
    showToast('✅ Đã xóa ảnh khỏi hệ thống!', 'success');
    await Promise.all([loadAdminData(), loadMyHistory()]);
  } catch (err) {
    showToast('Lỗi xóa ảnh: ' + err.message, 'error');
  }
});

// ==========================================
// 8. LỊCH SỬ CHẤM CÔNG CÁ NHÂN
// ==========================================
async function loadMyHistory() {
  const listEl = document.getElementById('my-history-list');
  const monthStrip = document.getElementById('my-month-work-strip');
  if (!state.user) return;
  try {
    const allRecent = await DB.getUserAttendance(state.user.phone, 75);
    const history = (allRecent || []).slice(0, 30);

    // Hiển thị tiến độ công chuẩn tháng hiện tại (6 công/tuần T2–CN -> 26 hoặc 27 công) & ngày nghỉ bù
    if (monthStrip) {
      const curMonth = getVnDateKey().slice(0, 7);
      const stdInfo = getMonthWorkStandard(curMonth);
      const workedSet = new Set();
      (allRecent || []).forEach(r => {
        const dk = r.date_key || getVnDateKey(r.timestamp);
        if (dk.startsWith(curMonth)) workedSet.add(dk);
      });
      const workedDays = workedSet.size;
      const excessDays = Math.max(0, workedDays - stdInfo.standardDays);
      const savedComp = (state.user.comp_off_by_month && state.user.comp_off_by_month[curMonth]) || null;

      let extraBadge = '';
      if (savedComp && savedComp.approved && Number(savedComp.days) > 0) {
        extraBadge = `<span class="badge badge-compoff-done">🎁 Nghỉ bù được cộng: +${savedComp.days} ngày</span>`;
      } else if (excessDays > 0) {
        extraBadge = `<span class="badge badge-excess">🔥 Thừa +${excessDays} công (chờ cộng nghỉ bù)</span>`;
      }

      monthStrip.innerHTML = `
        <span>📊 Tháng ${formatMonthLabel(curMonth)}: <b>${workedDays} / ${stdInfo.standardDays} công chuẩn</b></span>
        ${extraBadge}
      `;
      monthStrip.classList.remove('hidden');
    }

    if (!history || history.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <p>Chưa có dữ liệu chấm công.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = history.map(item => {
      const distM = getRecordDistance(item);
      return `
        <div class="history-item">
          <div class="history-main">
            ${item.photo_thumb
              ? `<img src="${item.photo_thumb}" class="face-thumb" data-att-id="${escapeHtml(item.id)}" data-title="${escapeHtml(item.typeText + ' lúc ' + item.datetime_str)}" title="Bấm xem ảnh lớn">`
              : `<span class="face-thumb-empty">👤</span>`
            }
            <div class="history-details">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span class="badge ${item.type === 'IN' ? 'badge-in' : 'badge-out'}">
                  ${item.type === 'IN' ? 'Vào ca' : 'Ra ca'}
                </span>
                ${renderShiftModeBadge(item.shift_mode)}
                ${renderPunctualityBadge(item)}
                ${renderManualBadge(item)}
                <span class="history-time">${escapeHtml(item.datetime_str)}</span>
              </div>
              <span class="history-gps">
                ${renderZoneBadge(distM)}
                ${item.is_manual ? '' : `<span>±${item.accuracy}m</span>`}
              </span>
              ${item.note ? `<div class="manual-note-text">💬 ${escapeHtml(item.note)}</div>` : ''}
              ${renderLctInfoHtml(item)}
              ${item.type === 'OUT' && (requiresCheckoutLct(state.user && state.user.role) || hasLctReport(item)) ? `
                <div style="margin-top: 4px;">
                  <button type="button" class="btn-lct-mini" data-edit-lct-id="${escapeHtml(item.id)}">
                    ${hasLctReport(item) ? '✏️ Sửa LCT/PCT & km' : '📋 Ghi LCT/PCT & km'}
                  </button>
                </div>
              ` : ''}
            </div>
          </div>
          <a href="${escapeHtml(item.mapUrl)}" target="_blank" class="btn-map" title="Xem trên Google Maps">
            📍 Bản đồ
          </a>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.face-thumb').forEach(img => {
      img.addEventListener('click', () => {
        const rec = history.find(h => h.id === img.dataset.attId) || null;
        openPhotoViewer(img.dataset.attId, img.src, img.dataset.title, rec);
      });
    });

    listEl.querySelectorAll('button[data-edit-lct-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const rec = history.find(h => h.id === btn.dataset.editLctId);
        if (rec) openCheckoutReportModal(rec, hasLctReport(rec));
      });
    });
  } catch (err) {
    listEl.innerHTML = `<p style="color: var(--text-dim); text-align: center; padding: 10px;">Lỗi tải lịch sử: ${escapeHtml(err.message)}</p>`;
  }
}

document.getElementById('btn-refresh-my-history').addEventListener('click', loadMyHistory);

// ==========================================
// 9. TIỆN ÍCH NGHỈ PHÉP & GIẢI TRÌNH (NHÂN VIÊN GỬI + ADMIN DUYỆT)
// ==========================================
function selectRequestCategory(cat) {
  document.getElementById('req-category').value = cat;
  const btnLeave = document.getElementById('btn-req-type-leave');
  const btnExplain = document.getElementById('btn-req-type-explain');
  const leaveDates = document.getElementById('req-leave-dates');
  const explainFields = document.getElementById('req-explain-fields');

  if (cat === 'leave') {
    btnLeave.classList.add('active');
    btnExplain.classList.remove('active');
    leaveDates.classList.remove('hidden');
    explainFields.classList.add('hidden');
  } else {
    btnLeave.classList.remove('active');
    btnExplain.classList.add('active');
    leaveDates.classList.add('hidden');
    explainFields.classList.remove('hidden');
  }
}

document.getElementById('req-from-date').addEventListener('change', (e) => {
  const toEl = document.getElementById('req-to-date');
  if (!toEl.value || toEl.value < e.target.value) {
    toEl.value = e.target.value;
  }
});

document.getElementById('form-submit-request').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.user) return;

  const category = document.getElementById('req-category').value;
  const reason = document.getElementById('req-reason').value.trim();
  const submitBtn = document.getElementById('btn-submit-request');

  if (!reason || reason.length < 4) {
    return showToast('Vui lòng ghi rõ lý do nghỉ phép hoặc giải trình!', 'error');
  }

  let fromDate = '';
  let toDate = '';
  let shiftNote = '';

  if (category === 'leave') {
    fromDate = document.getElementById('req-from-date').value;
    toDate = document.getElementById('req-to-date').value;
    if (!fromDate || !toDate) return showToast('Vui lòng chọn ngày nghỉ phép.', 'error');
    if (toDate < fromDate) return showToast('Ngày kết thúc không được nhỏ hơn ngày bắt đầu!', 'error');
  } else {
    fromDate = document.getElementById('req-explain-date').value || getVnDateKey();
    toDate = fromDate;
    shiftNote = document.getElementById('req-explain-shift').value;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span>Đang gửi đơn...</span>';

  try {
    const now = Date.now();
    const reqObj = {
      id: `req_${now}_${Math.random().toString(36).slice(2, 7)}`,
      user_id: state.user.phone,
      user_name: state.user.name,
      user_phone: state.user.phone,
      category, // 'leave' | 'explanation'
      from_date: fromDate,
      to_date: toDate,
      days_count: category === 'leave' ? calcDaysInclusive(fromDate, toDate) : 1,
      shift_note: shiftNote,
      reason,
      status: 'pending', // 'pending' | 'approved' | 'rejected'
      admin_note: '',
      reviewed_by: '',
      reviewed_at: null,
      reviewed_time_str: '',
      created_at: now,
      created_time_str: getVnTimeStr(now)
    };

    await DB.addRequest(reqObj);
    playSuccessSound();
    showToast('✅ Đã gửi đơn thành công! Chờ Quản lý kiểm tra và duyệt.', 'success', 4000);
    document.getElementById('req-reason').value = '';
    await loadMyRequests();
  } catch (err) {
    playErrorSound();
    const msg = (err.code === 'permission-denied' || (err.message || '').includes('permissions'))
      ? 'Firebase Rules chưa mở quyền cho mục "requests". Hãy cập nhật Rules theo hướng dẫn!'
      : ('Lỗi gửi đơn: ' + err.message);
    showToast(msg, 'error', 5500);
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>📨 Gửi Quản Lý Duyệt</span>';
  }
});

function formatRequestTimeSpan(r) {
  if (r.category === 'leave') {
    const days = r.days_count || calcDaysInclusive(r.from_date, r.to_date);
    if (r.from_date === r.to_date) {
      return `Ngày ${formatVnDateOnly(r.from_date)} (${days} ngày)`;
    }
    return `${formatVnDateOnly(r.from_date)} ➔ ${formatVnDateOnly(r.to_date)} (${days} ngày)`;
  }
  return `Ngày ${formatVnDateOnly(r.from_date)}${r.shift_note ? ' • ' + r.shift_note : ''}`;
}

function renderRequestStatusBadge(status) {
  if (status === 'approved') return '<span class="badge badge-approved">✅ Admin đã duyệt OK</span>';
  if (status === 'rejected') return '<span class="badge badge-rejected">❌ Không được duyệt</span>';
  return '<span class="badge badge-pending">⏳ Chờ Admin duyệt</span>';
}

function renderRequestCategoryBadge(category) {
  if (category === 'leave') return '<span class="badge badge-leave">🏖️ Nghỉ phép</span>';
  return '<span class="badge badge-explain">📋 Giải trình</span>';
}

async function loadMyRequests() {
  const listEl = document.getElementById('my-requests-list');
  const badgeEl = document.getElementById('emp-pending-badge');
  if (!state.user) return;

  try {
    const list = await DB.getUserRequests(state.user.phone);
    state.myRequestsCache = list;

    const pendingCount = list.filter(r => r.status === 'pending').length;
    if (pendingCount > 0) {
      badgeEl.textContent = pendingCount;
      badgeEl.classList.remove('hidden');
    } else {
      badgeEl.classList.add('hidden');
    }

    if (list.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✉️</div>
          <p>Bạn chưa gửi đơn nghỉ phép hay giải trình nào.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = list.map(r => `
      <div class="request-card">
        <div class="request-card-top">
          <div class="request-meta">
            ${renderRequestCategoryBadge(r.category)}
            <strong style="font-size: 0.88rem; color: #fff;">${escapeHtml(formatRequestTimeSpan(r))}</strong>
          </div>
          ${renderRequestStatusBadge(r.status)}
        </div>

        <div class="request-reason-box"><strong>Lý do:</strong> ${escapeHtml(r.reason)}</div>

        ${r.admin_note ? `
          <div class="request-admin-note ${r.status === 'rejected' ? 'rejected' : ''}">
            <strong>Phản hồi Quản lý (${escapeHtml(r.reviewed_by || 'Admin')}):</strong> ${escapeHtml(r.admin_note)}
          </div>
        ` : ''}

        <div class="request-card-footer">
          <span>Gửi lúc: ${escapeHtml(r.created_time_str || getVnTimeStr(r.created_at))}${r.reviewed_time_str ? ' • Duyệt lúc: ' + escapeHtml(r.reviewed_time_str) : ''}</span>
          ${r.status === 'pending' ? `
            <button class="btn-sm btn-delete" data-cancel-req="${escapeHtml(r.id)}">🗑️ Hủy đơn</button>
          ` : ''}
        </div>
      </div>
    `).join('');

    listEl.querySelectorAll('button[data-cancel-req]').forEach(btn => {
      btn.addEventListener('click', () => cancelMyRequest(btn.dataset.cancelReq));
    });
  } catch (err) {
    const msg = (err.code === 'permission-denied' || (err.message || '').includes('permissions'))
      ? 'Firebase Rules chưa mở quyền đọc mục "requests".'
      : err.message;
    listEl.innerHTML = `<p style="color: var(--text-dim); text-align: center; padding: 14px;">⚠️ ${escapeHtml(msg)}</p>`;
  }
}

async function cancelMyRequest(reqId) {
  if (!confirm('Bạn có chắc muốn hủy đơn đang chờ duyệt này?')) return;
  try {
    await DB.deleteRequest(reqId);
    showToast('Đã hủy đơn thành công.', 'info');
    await loadMyRequests();
  } catch (err) {
    showToast('Lỗi hủy đơn: ' + err.message, 'error');
  }
}

document.getElementById('btn-refresh-my-requests').addEventListener('click', loadMyRequests);

// ==========================================
// 10. CHUYỂN ĐỔI GIAO DIỆN (CHẤM CÔNG <-> QUẢN LÝ)
// ==========================================
function showAttendanceView() {
  document.getElementById('view-admin').classList.add('hidden');
  document.getElementById('view-attendance').classList.remove('hidden');
  const btn = document.getElementById('btn-toggle-admin-view');
  if (btn) btn.textContent = isSupervisorReadOnly() ? '👁️ Giám sát' : '⚙️ Quản lý';
}

async function showAdminView() {
  if (!canViewDashboard()) return;
  document.getElementById('view-attendance').classList.add('hidden');
  document.getElementById('view-admin').classList.remove('hidden');
  const btn = document.getElementById('btn-toggle-admin-view');
  if (btn) btn.textContent = '🕒 Chấm công';

  applyDashboardRoleUI();
  if (!isAdmin() && !document.getElementById('admin-tab-staff').classList.contains('hidden')) {
    switchAdminTab('history');
  }

  await loadAdminData();
}

function toggleAdminView() {
  if (!canViewDashboard()) return;
  const adminView = document.getElementById('view-admin');
  if (adminView.classList.contains('hidden')) {
    showAdminView();
  } else {
    showAttendanceView();
  }
}

function switchAdminTab(tab) {
  if (tab === 'staff' && !isAdmin()) {
    tab = 'history';
  }
  const historyTab = document.getElementById('admin-tab-history');
  const summaryTab = document.getElementById('admin-tab-summary');
  const reqTab = document.getElementById('admin-tab-requests');
  const staffTab = document.getElementById('admin-tab-staff');

  const btnHistory = document.getElementById('tab-btn-history');
  const btnSummary = document.getElementById('tab-btn-summary');
  const btnReq = document.getElementById('tab-btn-requests');
  const btnStaff = document.getElementById('tab-btn-staff');

  historyTab.classList.add('hidden');
  if (summaryTab) summaryTab.classList.add('hidden');
  reqTab.classList.add('hidden');
  staffTab.classList.add('hidden');

  btnHistory.classList.remove('active');
  if (btnSummary) btnSummary.classList.remove('active');
  btnReq.classList.remove('active');
  btnStaff.classList.remove('active');

  if (tab === 'history') {
    historyTab.classList.remove('hidden');
    btnHistory.classList.add('active');
    renderAdminHistoryTable();
  } else if (tab === 'summary') {
    if (summaryTab) summaryTab.classList.remove('hidden');
    if (btnSummary) btnSummary.classList.add('active');
    renderMonthlySummaryTable();
  } else if (tab === 'requests') {
    reqTab.classList.remove('hidden');
    btnReq.classList.add('active');
    renderAdminRequestsList();
  } else {
    staffTab.classList.remove('hidden');
    btnStaff.classList.add('active');
    renderAdminStaffTable();
  }
}

// ==========================================
// 11. BẢNG QUẢN LÝ: THỐNG KÊ, LỊCH SỬ 30 NGƯỜI, TỔNG HỢP THÁNG, DUYỆT ĐƠN & NHÂN SỰ
// ==========================================
async function loadAdminData() {
  if (!canViewDashboard()) return;
  try {
    const [users, records, requests] = await Promise.all([
      DB.getAllUsers(),
      DB.getAllAttendance(2500),
      DB.getAllRequests(500).catch(err => {
        console.warn('Không tải được requests:', err.message);
        return [];
      })
    ]);

    const roleOrder = { admin: 0, leader: 1, deputy: 2, worker: 3, service_worker: 4, employee: 5 };
    users.sort((a, b) => {
      const ra = roleOrder[a.role] ?? 5;
      const rb = roleOrder[b.role] ?? 5;
      if (ra !== rb) return ra - rb;
      return (a.created_at || 0) - (b.created_at || 0);
    });

    state.allUsersList = users;
    state.adminRecordsCache = records;
    state.adminRequestsCache = requests;

    const now = Date.now();
    const todayKey = getVnDateKey(now);
    const lockedCount = users.filter(u => u.is_locked === 1 || (u.lock_until && u.lock_until > now)).length;
    const todayRecords = records.filter(r => (r.date_key || getVnDateKey(r.timestamp)) === todayKey);
    const todayInCount = todayRecords.filter(r => r.type === 'IN').length;
    const todayOutCount = todayRecords.filter(r => r.type === 'OUT').length;
    const todayPunches = todayRecords.length;
    const pendingRequestsCount = requests.filter(r => r.status === 'pending').length;

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

    document.getElementById('stat-total-users').textContent = `${users.length}/${MAX_USERS}`;
    document.getElementById('stat-in-shift').textContent = inShiftCount;
    const statTodayIn = document.getElementById('stat-today-in');
    const statTodayOut = document.getElementById('stat-today-out');
    if (statTodayIn) statTodayIn.textContent = todayInCount;
    if (statTodayOut) statTodayOut.textContent = todayOutCount;
    document.getElementById('stat-today-punches').textContent = `Tổng: ${todayPunches} lượt hôm nay`;
    document.getElementById('stat-pending-requests').textContent = pendingRequestsCount;
    document.getElementById('stat-locked-users').textContent = lockedCount;

    const staffCountBadge = document.getElementById('staff-count-badge');
    if (staffCountBadge) staffCountBadge.textContent = `${users.length}/${MAX_USERS}`;

    const adminPendingBadge = document.getElementById('admin-pending-badge');
    if (pendingRequestsCount > 0) {
      adminPendingBadge.textContent = pendingRequestsCount;
      adminPendingBadge.classList.remove('hidden');
    } else {
      adminPendingBadge.classList.add('hidden');
    }

    // Cập nhật dropdown lọc nhân viên ở cả Tab Lịch sử & Tab Duyệt đơn
    const userOptionsHtml = `<option value="all">👤 Tất cả nhân viên</option>` +
      users.map(u => `<option value="${escapeHtml(u.phone)}">${escapeHtml(u.name)} (${escapeHtml(u.phone)})</option>`).join('');

    ['filter-user', 'filter-req-user'].forEach(selId => {
      const sel = document.getElementById(selId);
      if (!sel) return;
      const prev = sel.value;
      sel.innerHTML = userOptionsHtml;
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    });

    const monthInput = document.getElementById('summary-month-input');
    if (monthInput && !monthInput.value) {
      monthInput.value = todayKey.slice(0, 7);
    }

    renderForgotCheckoutPanel(lastPunchByUser, users);
    updateEndOfMonthBanner();
    renderAdminHistoryTable();
    renderMonthlySummaryTable();
    renderAdminRequestsList();
    if (isAdmin()) {
      renderAdminStaffTable(lastPunchByUser);
    }
  } catch (err) {
    showToast('Lỗi tải dữ liệu quản trị: ' + err.message, 'error');
  }
}

document.getElementById('admin-radius-select').addEventListener('change', (e) => {
  if (!isAdmin()) {
    updateOfficeRadiusUI();
    return showToast('Chỉ Admin mới được chỉnh bán kính công ty!', 'error');
  }
  const val = parseInt(e.target.value, 10) || 200;
  state.officeRadius = val;
  localStorage.setItem(LOCAL_KEYS.radius, String(val));
  updateOfficeRadiusUI();
  renderAdminHistoryTable();
  loadMyHistory();
  showToast(`Đã cập nhật bán kính công ty hợp lệ: ${val} mét.`, 'info');
});

function renderAdminHistoryTable() {
  const tbody = document.getElementById('admin-history-tbody');
  const galleryEl = document.getElementById('admin-photo-gallery');
  const dateVal = document.getElementById('filter-date').value;
  const userVal = document.getElementById('filter-user').value;
  const roleSel = document.getElementById('filter-role');
  const roleVal = roleSel ? roleSel.value : 'all';
  const typeVal = document.getElementById('filter-type').value;
  const shiftModeVal = document.getElementById('filter-shift-mode').value;
  const todayKey = getVnDateKey();
  const userRoleMap = buildUserRoleMap();

  const filtered = state.adminRecordsCache.filter(r => {
    if (dateVal === 'today' && (r.date_key || getVnDateKey(r.timestamp)) !== todayKey) return false;
    if (userVal !== 'all' && r.user_id !== userVal) return false;
    if (roleVal !== 'all') {
      const recRole = userRoleMap.get(r.user_id) || normalizeRole(r.user_role);
      if (recRole !== roleVal) return false;
    }
    if (typeVal !== 'all' && r.type !== typeVal) return false;
    if (shiftModeVal !== 'all' && (r.shift_mode || 'normal') !== shiftModeVal) return false;
    return true;
  });

  // Cập nhật chế độ Thư viện ảnh dạng lưới song song
  renderAdminPhotoGallery(filtered, galleryEl, userRoleMap);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 24px; color: var(--text-dim);">Không có lượt chấm công nào phù hợp với bộ lọc.</td></tr>`;
    return;
  }

  const adminOnly = isAdmin();
  tbody.innerHTML = filtered.map(r => {
    const distM = getRecordDistance(r);
    const recRole = userRoleMap.get(r.user_id) || normalizeRole(r.user_role);
    const roleTag = renderRoleBadge(recRole);
    return `
      <tr>
        <td style="text-align: center;">
          ${r.photo_thumb
            ? `<img src="${r.photo_thumb}" class="face-thumb" data-att-id="${escapeHtml(r.id)}" data-title="${escapeHtml(r.user_name + ' - ' + r.typeText + ' lúc ' + r.datetime_str)}" title="Bấm xem ảnh lớn & tải về">`
            : `<span class="face-thumb-empty" title="${r.is_manual ? 'Admin chấm bù' : 'Không có ảnh'}">${r.is_manual ? '✍️' : '👤'}</span>`
          }
        </td>
        <td style="font-weight: 600; white-space: nowrap;">${escapeHtml(r.datetime_str)}</td>
        <td>
          <div>
            <b>${escapeHtml(r.user_name)}</b>
            ${roleTag}
          </div>
          <small style="color: var(--text-dim);"><code>${escapeHtml(r.user_phone)}</code></small>
        </td>
        <td>
          <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start;">
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
              <span class="badge ${r.type === 'IN' ? 'badge-in' : 'badge-out'}">
                ${r.type === 'IN' ? 'Vào ca' : 'Ra ca'}
              </span>
              ${renderShiftModeBadge(r.shift_mode)}
              ${renderPunctualityBadge(r)}
            </div>
            ${renderManualBadge(r)}
            ${r.note ? `<div class="manual-note-text">💬 ${escapeHtml(r.note)}</div>` : ''}
            ${renderLctInfoHtml(r)}
          </div>
        </td>
        <td>
          <div style="margin-bottom: 4px;">${renderZoneBadge(distM)}</div>
          <small style="color: var(--text-dim);">${Number(r.latitude).toFixed(5)}, ${Number(r.longitude).toFixed(5)}${r.is_manual ? '' : ` (±${r.accuracy}m)`}</small>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: nowrap;">
            <a href="${escapeHtml(r.mapUrl)}" target="_blank" class="btn-map">
              📍 Bản đồ
            </a>
            ${adminOnly ? `
              <button type="button" class="btn-sm btn-lock" data-del-att-id="${escapeHtml(r.id)}" data-del-att-label="${escapeHtml(r.user_name + ' - ' + r.typeText + ' lúc ' + r.datetime_str)}" title="Xóa hẳn dòng chấm công này">
                🗑️
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.face-thumb').forEach(img => {
    img.addEventListener('click', () => {
      const rec = filtered.find(item => item.id === img.dataset.attId) || null;
      openPhotoViewer(img.dataset.attId, img.src, img.dataset.title, rec);
    });
  });

  tbody.querySelectorAll('button[data-del-att-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!isAdmin()) {
        return showToast('Tài khoản Tổ trưởng / Tổ phó chỉ có quyền xem, không được xóa dữ liệu chấm công!', 'error');
      }
      const attId = btn.dataset.delAttId;
      const label = btn.dataset.delAttLabel;
      if (!confirm(`Xóa VĨNH VIỄN dòng chấm công này?\n\n${label}\n(Cả giờ chấm công, GPS và ảnh kèm theo sẽ bị xóa khỏi hệ thống)`)) {
        return;
      }
      btn.disabled = true;
      try {
        await DB.deleteAttendanceRecord(attId);
        playSuccessSound();
        showToast('✅ Đã xóa hẳn dòng chấm công!', 'success');
        await Promise.all([loadAdminData(), syncUserStatus(), loadMyHistory()]);
      } catch (err) {
        playErrorSound();
        showToast('Lỗi xóa dòng chấm công: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function renderAdminPhotoGallery(filtered, galleryEl, userRoleMap = null) {
  if (!galleryEl) return;
  const adminOnly = isAdmin();
  const roleMap = userRoleMap || buildUserRoleMap();
  const withPhotos = (filtered || []).filter(r => Boolean(r.photo_thumb));
  if (withPhotos.length === 0) {
    galleryEl.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-icon">✨</div>
        <p>Hiện không còn ảnh chấm công nào trong bộ lọc này.<br><small style="color: var(--text-dim);">Bấm <b>"📋 Dạng bảng"</b> để xem danh sách giờ Vào/Ra chi tiết.</small></p>
      </div>
    `;
    return;
  }

  galleryEl.innerHTML = withPhotos.map(r => {
    const distM = getRecordDistance(r);
    const recRole = roleMap.get(r.user_id) || normalizeRole(r.user_role);
    const titleStr = `${r.user_name} - ${r.typeText} lúc ${r.datetime_str}`;
    return `
      <div class="gallery-card">
        <div class="gallery-img-wrap" data-view-id="${escapeHtml(r.id)}" data-title="${escapeHtml(titleStr)}">
          <img src="${r.photo_thumb}" class="gallery-img" alt="${escapeHtml(r.user_name)}">
          <span class="badge ${r.type === 'IN' ? 'badge-in' : 'badge-out'} gallery-type-overlay">
            ${r.type === 'IN' ? 'Vào ca' : 'Ra ca'}
          </span>
        </div>
        <div class="gallery-body">
          <div class="gallery-name">${escapeHtml(r.user_name)} ${renderRoleBadge(recRole)}</div>
          <div class="gallery-time">🕒 ${escapeHtml(r.datetime_str)}</div>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">${renderZoneBadge(distM)} ${renderShiftModeBadge(r.shift_mode)} ${renderPunctualityBadge(r)}</div>
          ${r.note ? `<div class="manual-note-text">💬 ${escapeHtml(r.note)}</div>` : ''}
          ${renderLctInfoHtml(r)}
          <div class="gallery-footer">
            <a href="${escapeHtml(r.mapUrl)}" target="_blank" class="btn-map" style="padding: 4px 8px; font-size: 0.72rem;">📍 Bản đồ</a>
            <div style="display: flex; gap: 4px;">
              <button type="button" class="btn-sm btn-unlock" data-quick-dl="${escapeHtml(r.id)}" data-dl-name="${escapeHtml(r.user_name + '_' + r.date_key + '_' + r.type)}">
                ⬇️ Tải
              </button>
              ${adminOnly ? `
                <button type="button" class="btn-sm btn-lock" data-quick-del-photo="${escapeHtml(r.id)}" title="Chỉ xóa ảnh này (giữ giờ công)">
                  🗑️
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  galleryEl.querySelectorAll('.gallery-img-wrap').forEach(box => {
    box.addEventListener('click', () => {
      const rec = withPhotos.find(item => item.id === box.dataset.viewId);
      if (rec && rec.photo_thumb) {
        openPhotoViewer(rec.id, rec.photo_thumb, box.dataset.title, rec);
      }
    });
  });

  galleryEl.querySelectorAll('button[data-quick-dl]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const attId = btn.dataset.quickDl;
      const rec = withPhotos.find(item => item.id === attId);
      const fname = makeSafeFilename(btn.dataset.dlName || attId);
      if (rec && rec.photo_download_url) {
        downloadDataUrlAsJpg(rec.photo_download_url, fname);
        return;
      }
      btn.disabled = true;
      btn.textContent = '⏳...';
      try {
        const full = await DB.getFullPhoto(attId);
        downloadDataUrlAsJpg(full || (rec && rec.photo_thumb), fname);
      } catch {
        downloadDataUrlAsJpg(rec && rec.photo_thumb, fname);
      } finally {
        btn.disabled = false;
        btn.textContent = '⬇️ Tải';
      }
    });
  });

  galleryEl.querySelectorAll('button[data-quick-del-photo]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!isAdmin()) {
        return showToast('Tài khoản Tổ trưởng / Tổ phó chỉ có quyền xem, không được xóa ảnh!', 'error');
      }
      const attId = btn.dataset.quickDelPhoto;
      if (!confirm('Xóa ảnh này khỏi hệ thống? (Giờ chấm công và tọa độ GPS vẫn giữ nguyên)')) return;
      btn.disabled = true;
      try {
        await DB.deleteSinglePhoto(attId);
        showToast('✅ Đã xóa ảnh!', 'success');
        await Promise.all([loadAdminData(), loadMyHistory()]);
      } catch (err) {
        showToast('Lỗi xóa ảnh: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

document.getElementById('btn-toggle-gallery').addEventListener('click', () => {
  state.galleryMode = !state.galleryMode;
  const tableWrap = document.getElementById('admin-history-table-wrap');
  const galleryEl = document.getElementById('admin-photo-gallery');
  const btn = document.getElementById('btn-toggle-gallery');

  if (state.galleryMode) {
    tableWrap.classList.add('hidden');
    galleryEl.classList.remove('hidden');
    btn.textContent = '📋 Dạng bảng';
  } else {
    galleryEl.classList.add('hidden');
    tableWrap.classList.remove('hidden');
    btn.textContent = '🖼️ Ảnh';
  }
});

// --- CẢNH BÁO QUÊN CHẤM RA CA + BẢNG CÔNG TỔNG HỢP THÁNG ---
function renderForgotCheckoutPanel(lastPunchByUser, users) {
  const panel = document.getElementById('forgot-checkout-panel');
  const titleEl = document.getElementById('forgot-checkout-title');
  const listEl = document.getElementById('forgot-checkout-list');
  if (!panel || !listEl) return;

  const now = Date.now();
  const todayKey = getVnDateKey(now);
  const nowVnMins = getVnMinutesOfDay(now);
  const stdOutMins = WORK_SCHEDULE.outHour * 60 + WORK_SCHEDULE.outMinute; // 18:30
  const userByPhone = new Map((users || []).map(u => [u.phone, u]));

  const forgotList = [];
  lastPunchByUser.forEach((rec, phone) => {
    if (!rec || rec.type !== 'IN') return;
    const recDate = rec.date_key || getVnDateKey(rec.timestamp);
    const isPastDay = recDate < todayKey;
    const isPastCheckoutToday = recDate === todayKey && nowVnMins > stdOutMins;
    if (isPastDay || isPastCheckoutToday) {
      const u = userByPhone.get(phone);
      forgotList.push({
        phone,
        name: (u && u.name) || rec.user_name || phone,
        rec,
        recDate,
        isPastDay
      });
    }
  });

  if (forgotList.length === 0) {
    panel.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }

  forgotList.sort((a, b) => a.rec.timestamp - b.rec.timestamp);
  titleEl.textContent = `⚠️ Cảnh báo: ${forgotList.length} nhân sự chưa chấm Ra ca (quá giờ 18:30 / ngày trước)`;
  const adminOnly = isAdmin();

  listEl.innerHTML = forgotList.map(item => `
    <div class="forgot-item">
      <div class="forgot-item-info">
        <b>${escapeHtml(item.name)}</b> (<code>${escapeHtml(item.phone)}</code>)
        ${renderShiftModeBadge(item.rec.shift_mode)}
        <span style="color: #fcd34d;">• Vào lúc ${escapeHtml(item.rec.datetime_str)} ${item.isPastDay ? '(chưa ra ca từ hôm trước)' : '(đã quá 18:30)'}</span>
      </div>
      ${adminOnly ? `
        <button type="button" class="btn-sm btn-unlock" data-forgot-phone="${escapeHtml(item.phone)}" data-forgot-date="${escapeHtml(item.recDate)}" data-forgot-mode="${escapeHtml(item.rec.shift_mode || 'normal')}">
          ✍️ Chấm bù Ra ca
        </button>
      ` : `
        <span class="readonly-tag">👁️ Nhắc nhân viên</span>
      `}
    </div>
  `).join('');

  listEl.querySelectorAll('button[data-forgot-phone]').forEach(btn => {
    btn.addEventListener('click', () => {
      openAdminPunchModal(btn.dataset.forgotPhone, {
        type: 'OUT',
        shiftMode: btn.dataset.forgotMode || 'normal',
        date: btn.dataset.forgotDate || todayKey,
        time: '18:30',
        note: 'Admin chấm bù Ra ca (nhân viên quên chấm)'
      });
    });
  });

  panel.classList.remove('hidden');
}

function countApprovedLeaveDaysInMonth(requests, userPhone, monthKey) {
  let days = 0;
  for (const r of requests) {
    if (r.user_id !== userPhone || r.category !== 'leave' || r.status !== 'approved') continue;
    if (!r.from_date) continue;
    const startStr = r.from_date;
    const endStr = r.to_date || r.from_date;
    const startDt = new Date(startStr + 'T00:00:00Z');
    const endDt = new Date(endStr + 'T00:00:00Z');
    if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) continue;
    for (let d = new Date(startDt); d <= endDt && days < 62; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (iso.startsWith(monthKey)) days++;
    }
  }
  return days;
}

function computeMonthlySummary(monthKey) {
  const users = state.allUsersList || [];
  const allRecords = state.adminRecordsCache || [];
  const allRequests = state.adminRequestsCache || [];

  const todayKey = getVnDateKey();
  const nowVnMins = getVnMinutesOfDay(Date.now());
  const stdInMins = WORK_SCHEDULE.inHour * 60 + WORK_SCHEDULE.inMinute;
  const stdOutMins = WORK_SCHEDULE.outHour * 60 + WORK_SCHEDULE.outMinute;
  const stdInfo = getMonthWorkStandard(monthKey);

  const monthRecords = allRecords.filter(r => (r.date_key || getVnDateKey(r.timestamp)).startsWith(monthKey));

  return users.map(u => {
    const uRecs = monthRecords
      .filter(r => r.user_id === u.phone)
      .sort((a, b) => a.timestamp - b.timestamp);

    const byDate = new Map();
    for (const r of uRecs) {
      const dk = r.date_key || getVnDateKey(r.timestamp);
      if (!byDate.has(dk)) byDate.set(dk, []);
      byDate.get(dk).push(r);
    }

    const workedDates = new Set();
    const normalDates = new Set();
    const crmDates = new Set();
    let normalHours = 0;
    let crmHours = 0;
    let overtimeShifts = 0;
    let overtimeHours = 0;
    let holidayShifts = 0;
    let holidayHours = 0;
    let lateCount = 0;
    let lateMinutes = 0;
    let earlyCount = 0;
    let earlyMinutes = 0;
    let forgotOutCount = 0;
    let lctCount = 0;
    let totalKm = 0;

    byDate.forEach((dayRecs, dk) => {
      workedDates.add(dk);

      // 1. Đếm ngày công & số ca theo từng chế độ
      let firstNormalIn = null;
      let lastNormalOut = null;

      for (const r of dayRecs) {
        const mode = r.shift_mode || 'normal';
        if (mode === 'normal') {
          normalDates.add(dk);
          if (r.type === 'IN' && !firstNormalIn) firstNormalIn = r;
          if (r.type === 'OUT') lastNormalOut = r;
        } else if (mode === 'crm') {
          crmDates.add(dk);
        } else if (mode === 'overtime') {
          if (r.type === 'IN') overtimeShifts++;
        } else if (mode === 'holiday') {
          if (r.type === 'IN') holidayShifts++;
        }

        if ((r.lct_code && String(r.lct_code).trim()) || (r.lct_location && String(r.lct_location).trim())) {
          lctCount++;
        }
        if (Number(r.travel_km) > 0) {
          totalKm += Number(r.travel_km);
        }
      }

      // 2. Tính đi muộn (>07:30) / về sớm (<18:30) theo lượt đầu & cuối Ca thường trong ngày
      if (firstNormalIn) {
        const mins = getVnMinutesOfDay(firstNormalIn.timestamp);
        if (mins > stdInMins) {
          lateCount++;
          lateMinutes += (mins - stdInMins);
        }
      }
      if (lastNormalOut) {
        const mins = getVnMinutesOfDay(lastNormalOut.timestamp);
        if (mins < stdOutMins) {
          earlyCount++;
          earlyMinutes += (stdOutMins - mins);
        }
      }

      // 3. Ghép cặp IN -> OUT để tính tổng giờ làm cho từng chế độ ca
      let openIn = null;
      for (const r of dayRecs) {
        if (r.type === 'IN') {
          openIn = r;
        } else if (r.type === 'OUT' && openIn) {
          const diffH = Math.max(0, Math.min(24, (r.timestamp - openIn.timestamp) / 3600000));
          const mode = openIn.shift_mode || r.shift_mode || 'normal';
          if (mode === 'overtime') overtimeHours += diffH;
          else if (mode === 'holiday') holidayHours += diffH;
          else if (mode === 'crm') crmHours += diffH;
          else normalHours += diffH;
          openIn = null;
        }
      }

      // 4. Đếm quên chấm Ra ca (cuối ngày vẫn còn openIn, bỏ qua hôm nay trước 18:30)
      if (openIn) {
        const isPastDay = dk < todayKey;
        const isPastOutToday = dk === todayKey && nowVnMins > stdOutMins;
        if (isPastDay || isPastOutToday) {
          forgotOutCount++;
        }
      }
    });

    // 5. Tính tuần làm việc T2 -> CN (6 công/tuần), số Chủ Nhật đi làm & số công vượt định mức tháng (26/27 công)
    const weekDaysMap = new Map();
    let sundayWorkedDays = 0;
    workedDates.forEach(dk => {
      if (isSundayIso(dk)) sundayWorkedDays++;
      const wk = getMonSunWeekKey(dk);
      weekDaysMap.set(wk, (weekDaysMap.get(wk) || 0) + 1);
    });
    let weeksOver6 = 0;
    weekDaysMap.forEach(cnt => {
      if (cnt > 6) weeksOver6++;
    });

    const workedDays = workedDates.size;
    const excessDays = Math.max(0, workedDays - stdInfo.standardDays);
    const savedComp = (u.comp_off_by_month && u.comp_off_by_month[monthKey]) || null;
    const compOffApproved = Boolean(savedComp && savedComp.approved);
    const compOffDays = (savedComp && typeof savedComp.days === 'number')
      ? savedComp.days
      : (excessDays > 0 ? excessDays : sundayWorkedDays);

    const approvedLeaveDays = countApprovedLeaveDaysInMonth(allRequests, u.phone, monthKey);

    return {
      user: u,
      workedDays,
      standardDays: stdInfo.standardDays,
      excessDays,
      sundayWorkedDays,
      weeksOver6,
      compOffApproved,
      compOffDays: Math.round(Number(compOffDays || 0) * 10) / 10,
      normalDays: normalDates.size,
      normalHours: Math.round(normalHours * 10) / 10,
      crmDays: crmDates.size,
      crmHours: Math.round(crmHours * 10) / 10,
      overtimeShifts,
      overtimeHours: Math.round(overtimeHours * 10) / 10,
      holidayShifts,
      holidayHours: Math.round(holidayHours * 10) / 10,
      approvedLeaveDays,
      lateCount,
      lateMinutes,
      earlyCount,
      earlyMinutes,
      forgotOutCount,
      lctCount,
      totalKm: Math.round(totalKm * 10) / 10
    };
  });
}

async function saveUserCompOff(phone, monthKey, approved, days) {
  if (!isAdmin()) {
    return showToast('Tài khoản Tổ trưởng / Tổ phó chỉ có quyền xem, không được tích cộng nghỉ bù!', 'error');
  }
  const targetUser = (state.allUsersList || []).find(u => u.phone === phone);
  if (!targetUser) return;

  const cleanDays = Math.max(0, Math.min(31, Math.round((Number(days) || 0) * 10) / 10));
  const nextMap = {
    ...(targetUser.comp_off_by_month || {}),
    [monthKey]: {
      approved: Boolean(approved),
      days: cleanDays,
      updated_by: state.user ? state.user.name : 'Admin',
      updated_at: Date.now()
    }
  };

  try {
    await DB.updateUser(phone, { comp_off_by_month: nextMap });
    targetUser.comp_off_by_month = nextMap;
    if (state.user && state.user.phone === phone) {
      state.user.comp_off_by_month = nextMap;
      loadMyHistory().catch(() => {});
    }
    playSuccessSound();
    showToast(
      approved
        ? `✅ Đã tích cộng +${cleanDays} ngày nghỉ bù tháng ${formatMonthLabel(monthKey)} cho ${targetUser.name}!`
        : `Đã bỏ tích cộng nghỉ bù tháng ${formatMonthLabel(monthKey)} cho ${targetUser.name}.`,
      approved ? 'success' : 'info'
    );
    renderMonthlySummaryTable();
  } catch (err) {
    playErrorSound();
    showToast('Lỗi lưu ngày nghỉ bù: ' + err.message, 'error');
  }
}

function renderMonthlySummaryTable() {
  const tbody = document.getElementById('admin-summary-tbody');
  const monthInput = document.getElementById('summary-month-input');
  if (!tbody || !monthInput) return;

  const monthKey = monthInput.value || getVnDateKey().slice(0, 7);
  if (!monthInput.value) monthInput.value = monthKey;

  const stdInfo = getMonthWorkStandard(monthKey);
  const stdTitle = document.getElementById('summary-calendar-title');
  const stdSub = document.getElementById('summary-calendar-sub');
  const stdSel = document.getElementById('summary-standard-mode');
  if (stdTitle) {
    stdTitle.textContent = `Tháng ${formatMonthLabel(monthKey)}: ${stdInfo.totalDays} ngày • ${stdInfo.sundayCount} Chủ Nhật → Công chuẩn: ${stdInfo.standardDays} công`;
  }
  if (stdSub) {
    stdSub.textContent = `Tuần T2–CN (6 công/tuần, nghỉ CN) • Lịch thực tế có ${stdInfo.calendarWorkDays} ngày T2–T7. Làm vượt ${stdInfo.standardDays} công sẽ tự động hiện số công thừa để tích cộng nghỉ bù.`;
  }
  if (stdSel) {
    stdSel.value = stdInfo.mode;
    stdSel.disabled = !isAdmin();
  }

  const rows = computeMonthlySummary(monthKey);

  // Cập nhật các thẻ tổng kết nhanh toàn đội
  let totNormal = 0, totCrm = 0, totOt = 0, totHol = 0, totLate = 0, totEarly = 0, totForgot = 0, totLct = 0, totKm = 0;
  let excessPeople = 0, totApprovedCompOff = 0, totExcessDays = 0;
  rows.forEach(r => {
    totNormal += r.normalDays;
    totCrm += r.crmDays;
    totOt += r.overtimeShifts;
    totHol += r.holidayShifts;
    totLate += r.lateCount;
    totEarly += r.earlyCount;
    totForgot += r.forgotOutCount;
    totLct += r.lctCount;
    totKm += r.totalKm;
    if (r.excessDays > 0) {
      excessPeople++;
      totExcessDays += r.excessDays;
    }
    if (r.compOffApproved && r.compOffDays > 0) {
      totApprovedCompOff += r.compOffDays;
    }
  });
  totKm = Math.round(totKm * 10) / 10;
  totApprovedCompOff = Math.round(totApprovedCompOff * 10) / 10;

  const elStd = document.getElementById('sum-standard-days');
  const elComp = document.getElementById('sum-total-compoff');
  const elNorm = document.getElementById('sum-total-normal');
  const elCrm = document.getElementById('sum-total-crm');
  const elOtHol = document.getElementById('sum-total-ot-hol');
  const elAlerts = document.getElementById('sum-total-alerts');
  const elKm = document.getElementById('sum-total-km');
  if (elStd) elStd.textContent = `${stdInfo.standardDays} công`;
  if (elComp) {
    elComp.textContent = totApprovedCompOff > 0
      ? `+${totApprovedCompOff} ngày bù`
      : (totExcessDays > 0 ? `${excessPeople} NV thừa +${totExcessDays}` : '0 ngày');
  }
  if (elNorm) elNorm.textContent = totNormal;
  if (elCrm) elCrm.textContent = totCrm;
  if (elOtHol) elOtHol.textContent = `${totOt} / ${totHol}`;
  if (elAlerts) elAlerts.textContent = `${totLate} / ${totEarly} / ${totForgot}`;
  if (elKm) elKm.textContent = `${totLct} phiếu • ${totKm} km`;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center" style="padding: 24px; color: var(--text-dim);">Chưa có dữ liệu nhân sự cho tháng ${escapeHtml(monthKey)}.</td></tr>`;
    return;
  }

  const adminOnly = isAdmin();
  tbody.innerHTML = rows.map(r => {
    const roleTag = renderRoleBadge(r.user.role);
    const lctCellHtml = (!requiresCheckoutLct(r.user.role) && r.lctCount === 0 && r.totalKm === 0)
      ? `<div class="summary-cell-sub" style="color: var(--text-dim);">Không cần ghi</div>`
      : `<div class="summary-cell-main" style="color: #fde047;">${r.totalKm} km</div><div class="summary-cell-sub">${r.lctCount} LCT/PCT</div>`;

    const alertParts = [];
    if (r.lateCount > 0) alertParts.push(`<span class="badge badge-late">⏰ Muộn ${r.lateCount} (${formatMinutesShort(r.lateMinutes)})</span>`);
    if (r.earlyCount > 0) alertParts.push(`<span class="badge badge-early">⚠️ Sớm ${r.earlyCount} (${formatMinutesShort(r.earlyMinutes)})</span>`);
    if (r.forgotOutCount > 0) alertParts.push(`<span class="badge badge-pending">❓ Quên ra ${r.forgotOutCount}</span>`);

    // Thông tin phụ dưới cột Tổng công / Chuẩn
    const workSubParts = [];
    if (r.sundayWorkedDays > 0) workSubParts.push(`Làm ${r.sundayWorkedDays} CN`);
    if (r.weeksOver6 > 0) workSubParts.push(`${r.weeksOver6} tuần 7/6`);
    const workSubHtml = workSubParts.length > 0
      ? workSubParts.join(' • ')
      : (r.workedDays >= r.standardDays ? '✓ Đạt định mức' : `Còn ${r.standardDays - r.workedDays} công`);

    // Ô tiện ích Thừa công & Tích cộng ngày nghỉ bù
    const showCompControl = r.excessDays > 0 || r.compOffApproved || r.sundayWorkedDays > 0;
    let compCellHtml = `<span style="color: var(--text-dim); font-size: 0.78rem;">${r.workedDays >= r.standardDays ? '✓ Đủ chuẩn' : 'Chưa vượt công'}</span>`;

    if (showCompControl) {
      const excessBadge = r.excessDays > 0
        ? `<span class="badge badge-excess">🔥 Thừa +${r.excessDays} công</span>`
        : (r.sundayWorkedDays > 0 ? `<span class="badge badge-explain">📅 Làm ${r.sundayWorkedDays} CN</span>` : '');

      if (adminOnly) {
        compCellHtml = `
          <div class="compoff-control">
            ${excessBadge}
            <label class="compoff-check-label ${r.compOffApproved ? 'checked' : ''}">
              <input type="checkbox" data-compoff-check="${escapeHtml(r.user.phone)}" ${r.compOffApproved ? 'checked' : ''}>
              <span>${r.compOffApproved ? '✅ Đã cộng nghỉ bù' : 'Tích cộng nghỉ bù'}</span>
            </label>
            <div class="compoff-days-adjust">
              <span>Số ngày:</span>
              <input type="number" class="compoff-days-input" min="0" max="31" step="0.5" value="${r.compOffDays}" data-compoff-days="${escapeHtml(r.user.phone)}">
              <span>ngày</span>
            </div>
          </div>
        `;
      } else {
        compCellHtml = `
          <div class="compoff-control">
            ${excessBadge}
            ${r.compOffApproved
              ? `<span class="badge badge-compoff-done">✅ Cộng +${r.compOffDays} ngày bù</span>`
              : `<span class="readonly-tag">⏳ Chưa tích bù (${r.compOffDays} ngày)</span>`
            }
          </div>
        `;
      }
    }

    return `
      <tr>
        <td>
          <div><b>${escapeHtml(r.user.name)}</b> ${roleTag}</div>
          <small style="color: var(--text-dim);"><code>${escapeHtml(r.user.phone)}</code></small>
        </td>
        <td>
          <div class="summary-cell-main ${r.workedDays > r.standardDays ? 'text-amber' : (r.workedDays >= r.standardDays ? 'text-success' : '')}">
            ${r.workedDays} / ${r.standardDays} công
          </div>
          <div class="summary-cell-sub">${workSubHtml}</div>
        </td>
        <td>${compCellHtml}</td>
        <td>
          <div class="summary-cell-main text-success">${r.normalDays} ngày</div>
          <div class="summary-cell-sub">${r.normalHours} giờ</div>
        </td>
        <td>
          <div class="summary-cell-main" style="color: #7dd3fc;">${r.crmDays} ngày</div>
          <div class="summary-cell-sub">${r.crmHours > 0 ? r.crmHours + ' giờ' : 'Cả ngày'}</div>
        </td>
        <td>
          <div class="summary-cell-main text-amber">${r.overtimeShifts} TC / ${r.holidayShifts} Lễ</div>
          <div class="summary-cell-sub">${r.overtimeHours}h / ${r.holidayHours}h</div>
        </td>
        <td>
          ${lctCellHtml}
        </td>
        <td>
          <div class="summary-cell-main">${r.approvedLeaveDays} ngày</div>
          <div class="summary-cell-sub">Đã duyệt OK</div>
        </td>
        <td>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            ${alertParts.length > 0 ? alertParts.join('') : '<span style="color: #34d399; font-size: 0.8rem;">✓ Chuẩn giờ</span>'}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Gắn sự kiện cho ô tích cộng nghỉ bù & ô chỉnh số ngày nghỉ bù (chỉ Admin)
  if (adminOnly) {
    tbody.querySelectorAll('input[data-compoff-check]').forEach(cb => {
      cb.addEventListener('change', () => {
        const phone = cb.dataset.compoffCheck;
        const daysInput = tbody.querySelector(`input[data-compoff-days="${CSS.escape(phone)}"]`);
        const daysVal = daysInput ? Number(daysInput.value) : 0;
        saveUserCompOff(phone, monthKey, cb.checked, daysVal);
      });
    });

    tbody.querySelectorAll('input[data-compoff-days]').forEach(inp => {
      inp.addEventListener('change', () => {
        const phone = inp.dataset.compoffDays;
        const cb = tbody.querySelector(`input[data-compoff-check="${CSS.escape(phone)}"]`);
        const isChecked = cb ? cb.checked : true;
        saveUserCompOff(phone, monthKey, isChecked, Number(inp.value));
      });
    });
  }
}

document.getElementById('summary-month-input').addEventListener('change', renderMonthlySummaryTable);
document.getElementById('summary-standard-mode').addEventListener('change', (e) => {
  if (!isAdmin()) {
    renderMonthlySummaryTable();
    return showToast('Chỉ Admin mới có quyền chỉnh định mức công chuẩn tháng!', 'error');
  }
  const monthKey = document.getElementById('summary-month-input').value || getVnDateKey().slice(0, 7);
  localStorage.setItem(`cc_std_mode_${monthKey}`, e.target.value);
  renderMonthlySummaryTable();
  const std = getMonthWorkStandard(monthKey);
  showToast(`Đã đặt định mức tháng ${formatMonthLabel(monthKey)}: ${std.standardDays} công chuẩn.`, 'info');
});
document.getElementById('btn-summary-refresh').addEventListener('click', loadAdminData);

document.getElementById('btn-export-summary-csv').addEventListener('click', () => {
  const monthKey = document.getElementById('summary-month-input').value || getVnDateKey().slice(0, 7);
  const rows = computeMonthlySummary(monthKey);
  if (!rows || rows.length === 0) {
    return showToast('Chưa có dữ liệu tổng hợp tháng để xuất Excel.', 'info');
  }

  let csv = '\uFEFF';
  csv += 'STT,Họ và Tên,Số Điện Thoại,Vai Trò,Tổng Ngày Đi Làm,Công Chuẩn Tháng,Số Công Thừa (+),Đã Tích Cộng Nghỉ Bù,Ngày Nghỉ Bù Được Cộng,Số CN Đi Làm,Ngày Công Thường,Tổng Giờ Thường,Ngày Trực CRM,Giờ Trực CRM,Số Ca Tăng Ca,Tổng Giờ Tăng Ca,Số Ca Trực Lễ,Tổng Giờ Trực Lễ,Số Lượt LCT/PCT,Tổng Quãng Đường (km),Ngày Nghỉ Phép (Đã Duyệt),Số Lần Đi Muộn (>07:30),Tổng Phút Muộn,Số Lần Về Sớm (<18:30),Tổng Phút Sớm,Quên Chấm Ra Ca\n';
  const esc = v => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  rows.forEach((r, idx) => {
    const compStatus = r.compOffApproved ? 'Đã cộng nghỉ bù' : (r.excessDays > 0 ? 'Chưa tích' : '');
    const compDaysOut = r.compOffApproved ? r.compOffDays : 0;
    csv += `${idx + 1},${esc(r.user.name)},${r.user.phone},${esc(getRoleLabel(r.user.role))},${r.workedDays},${r.standardDays},${r.excessDays},${esc(compStatus)},${compDaysOut},${r.sundayWorkedDays},${r.normalDays},${r.normalHours},${r.crmDays},${r.crmHours},${r.overtimeShifts},${r.overtimeHours},${r.holidayShifts},${r.holidayHours},${r.lctCount},${r.totalKm},${r.approvedLeaveDays},${r.lateCount},${r.lateMinutes},${r.earlyCount},${r.earlyMinutes},${r.forgotOutCount}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bang-cong-tong-hop-${monthKey}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast(`✅ Đã tải file CSV Tổng hợp tháng ${monthKey}!`, 'success');
});

// ==========================================
// 11C. XUẤT BỘ FILE EXCEL CUỐI THÁNG CHUẨN (.XLSX - 5 TRANG TÍNH) & NHẮC CUỐI THÁNG
// ==========================================
let xlsxLoadPromise = null;

function ensureXlsxLibrary() {
  if (window.XLSX && window.XLSX.utils) return Promise.resolve(window.XLSX);
  if (xlsxLoadPromise) return xlsxLoadPromise;

  const cdns = [
    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
  ];

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window.XLSX && window.XLSX.utils ? resolve(window.XLSX) : reject(new Error('XLSX không sẵn sàng')));
    s.onerror = () => reject(new Error('Không tải được ' + src));
    document.head.appendChild(s);
  });

  xlsxLoadPromise = loadScript(cdns[0])
    .catch(() => loadScript(cdns[1]))
    .catch((err) => {
      xlsxLoadPromise = null;
      console.warn('Không tải được thư viện Excel .xlsx:', err.message);
      return null;
    });

  return xlsxLoadPromise;
}

function getDaysInMonth(monthKey) {
  const [y, m] = String(monthKey || '').split('-').map(Number);
  if (!y || !m) return 31;
  return new Date(y, m, 0).getDate();
}

function getPreviousMonthKey(monthKey) {
  const [y, m] = String(monthKey || '').split('-').map(Number);
  if (!y || !m) return monthKey;
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

function formatMonthLabel(monthKey) {
  const [y, m] = String(monthKey || '').split('-');
  return (y && m) ? `${m}/${y}` : monthKey;
}

function getApprovedLeaveDateSet(requests, userPhone, monthKey) {
  const set = new Set();
  for (const r of requests) {
    if (r.user_id !== userPhone || r.category !== 'leave' || r.status !== 'approved' || !r.from_date) continue;
    const startDt = new Date(r.from_date + 'T00:00:00Z');
    const endDt = new Date((r.to_date || r.from_date) + 'T00:00:00Z');
    if (isNaN(startDt.getTime()) || isNaN(endDt.getTime())) continue;
    for (let d = new Date(startDt); d <= endDt && set.size < 32; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (iso.startsWith(monthKey)) set.add(iso);
    }
  }
  return set;
}

let currentEomTargetMonth = '';

function updateEndOfMonthBanner() {
  const banner = document.getElementById('eom-export-banner');
  const titleEl = document.getElementById('eom-banner-title');
  const subEl = document.getElementById('eom-banner-sub');
  const exportBtn = document.getElementById('btn-eom-export-now');
  if (!banner) return;

  const todayKey = getVnDateKey(); // YYYY-MM-DD
  const [yStr, mStr, dStr] = todayKey.split('-');
  const dayNum = Number(dStr);
  const currentMonthKey = `${yStr}-${mStr}`;

  let targetMonth = '';
  let titleText = '';

  if (dayNum >= 25) {
    targetMonth = currentMonthKey;
    titleText = `📅 Kỳ chốt công cuối tháng ${formatMonthLabel(targetMonth)} — Xuất trọn bộ Excel (.xlsx)!`;
  } else if (dayNum <= 3) {
    targetMonth = getPreviousMonthKey(currentMonthKey);
    titleText = `📅 Đã sang tháng mới — Xuất Bộ Excel chốt công tháng ${formatMonthLabel(targetMonth)}!`;
  } else {
    banner.classList.add('hidden');
    return;
  }

  const dismissKey = `cc_eom_dismissed_${targetMonth}`;
  if (localStorage.getItem(dismissKey) === '1') {
    banner.classList.add('hidden');
    return;
  }

  currentEomTargetMonth = targetMonth;
  if (titleEl) titleEl.textContent = titleText;
  if (subEl) {
    subEl.textContent = `Gồm đủ 5 trang tính cho tháng ${formatMonthLabel(targetMonth)}: Tổng hợp • Bảng công ngày 01–${getDaysInMonth(targetMonth)} • Bảng kê LCT/PCT & Km • Chi tiết Vào/Ra • Đơn nghỉ phép.`;
  }
  if (exportBtn) {
    exportBtn.textContent = `📗 Xuất Excel Tháng ${formatMonthLabel(targetMonth)} (.xlsx)`;
  }
  banner.classList.remove('hidden');
}

async function exportMonthlyExcelWorkbook(monthKey, triggerBtn = null) {
  const targetMonth = monthKey || document.getElementById('summary-month-input')?.value || getVnDateKey().slice(0, 7);
  const summaryRows = computeMonthlySummary(targetMonth);
  if (!summaryRows || summaryRows.length === 0) {
    return showToast(`Chưa có dữ liệu nhân sự cho tháng ${formatMonthLabel(targetMonth)}.`, 'info');
  }

  const origText = triggerBtn ? triggerBtn.textContent : '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = '⏳ Đang tạo file Excel...';
  }

  try {
    const XLSX = await ensureXlsxLibrary();
    if (!XLSX) {
      showToast('Không tải được thư viện .xlsx (mạng yếu) — tự động chuyển sang tải file CSV!', 'info', 4500);
      document.getElementById('btn-export-summary-csv').click();
      return;
    }

    const monthLabel = formatMonthLabel(targetMonth);
    const stdInfo = getMonthWorkStandard(targetMonth);
    const daysInMonth = stdInfo.totalDays;
    const allRecords = state.adminRecordsCache || [];
    const allRequests = state.adminRequestsCache || [];
    const stdInMins = WORK_SCHEDULE.inHour * 60 + WORK_SCHEDULE.inMinute;

    const monthRecords = allRecords
      .filter(r => (r.date_key || getVnDateKey(r.timestamp)).startsWith(targetMonth))
      .sort((a, b) => a.timestamp - b.timestamp);

    const wb = XLSX.utils.book_new();

    // =========================================================
    // SHEET 1: TỔNG HỢP CÔNG, VƯỢT CÔNG NGHỈ BÙ & QUÃNG ĐƯỜNG CUỐI THÁNG
    // =========================================================
    const s1AoA = [
      [`TỔNG CÔNG TY ĐIỆN LỰC MIỀN BẮC (EVNNPC) — BÁO CÁO TỔNG HỢP CHẤM CÔNG THÁNG ${monthLabel}`],
      [`Xuất lúc: ${getVnTimeStr()}  |  Định mức: ${stdInfo.standardDays} công chuẩn (${stdInfo.totalDays} ngày, ${stdInfo.sundayCount} Chủ Nhật, 6 công/tuần T2–CN)  |  Giờ chuẩn: 07:30 - 18:30`],
      [],
      [
        'STT', 'Họ và Tên', 'Số Điện Thoại', 'Vai Trò',
        'Tổng Ngày Đi Làm', 'Công Chuẩn Tháng', 'Số Công Thừa (+)',
        'Trạng Thái Nghỉ Bù', 'Ngày Nghỉ Bù Cộng', 'Số CN Đi Làm',
        'Ngày Công Thường', 'Giờ Công Thường',
        'Ngày Trực CRM', 'Giờ Trực CRM',
        'Ca Tăng Ca', 'Giờ Tăng Ca',
        'Ca Trực Lễ', 'Giờ Trực Lễ',
        'Số LCT/PCT', 'Tổng Quãng Đường (km)',
        'Nghỉ Phép (Ngày)',
        'Lần Đi Muộn', 'Phút Muộn',
        'Lần Về Sớm', 'Phút Sớm',
        'Quên Chấm Ra'
      ]
    ];

    const totals = {
      workedDays: 0, excessDays: 0, compOffDays: 0, sundayWorkedDays: 0,
      normalDays: 0, normalHours: 0, crmDays: 0, crmHours: 0,
      overtimeShifts: 0, overtimeHours: 0, holidayShifts: 0, holidayHours: 0,
      lctCount: 0, totalKm: 0, approvedLeaveDays: 0,
      lateCount: 0, lateMinutes: 0, earlyCount: 0, earlyMinutes: 0, forgotOutCount: 0
    };

    summaryRows.forEach((r, idx) => {
      const approvedCompDays = r.compOffApproved ? r.compOffDays : 0;
      const compStatus = r.compOffApproved ? 'Đã cộng nghỉ bù' : (r.excessDays > 0 ? 'Chưa tích duyệt' : '');
      s1AoA.push([
        idx + 1,
        r.user.name,
        String(r.user.phone),
        getRoleLabel(r.user.role),
        r.workedDays,
        r.standardDays,
        r.excessDays,
        compStatus,
        approvedCompDays,
        r.sundayWorkedDays,
        r.normalDays,
        r.normalHours,
        r.crmDays,
        r.crmHours,
        r.overtimeShifts,
        r.overtimeHours,
        r.holidayShifts,
        r.holidayHours,
        r.lctCount,
        r.totalKm,
        r.approvedLeaveDays,
        r.lateCount,
        r.lateMinutes,
        r.earlyCount,
        r.earlyMinutes,
        r.forgotOutCount
      ]);
      totals.workedDays += r.workedDays;
      totals.excessDays += r.excessDays;
      totals.compOffDays += approvedCompDays;
      totals.sundayWorkedDays += r.sundayWorkedDays;
      totals.normalDays += r.normalDays;
      totals.normalHours += r.normalHours;
      totals.crmDays += r.crmDays;
      totals.crmHours += r.crmHours;
      totals.overtimeShifts += r.overtimeShifts;
      totals.overtimeHours += r.overtimeHours;
      totals.holidayShifts += r.holidayShifts;
      totals.holidayHours += r.holidayHours;
      totals.lctCount += r.lctCount;
      totals.totalKm += r.totalKm;
      totals.approvedLeaveDays += r.approvedLeaveDays;
      totals.lateCount += r.lateCount;
      totals.lateMinutes += r.lateMinutes;
      totals.earlyCount += r.earlyCount;
      totals.earlyMinutes += r.earlyMinutes;
      totals.forgotOutCount += r.forgotOutCount;
    });

    s1AoA.push([
      '', 'TỔNG CỘNG TOÀN ĐƠN VỊ', '', '',
      totals.workedDays, stdInfo.standardDays, totals.excessDays,
      '', Math.round(totals.compOffDays * 10) / 10, totals.sundayWorkedDays,
      totals.normalDays, Math.round(totals.normalHours * 10) / 10,
      totals.crmDays, Math.round(totals.crmHours * 10) / 10,
      totals.overtimeShifts, Math.round(totals.overtimeHours * 10) / 10,
      totals.holidayShifts, Math.round(totals.holidayHours * 10) / 10,
      totals.lctCount, Math.round(totals.totalKm * 10) / 10,
      totals.approvedLeaveDays,
      totals.lateCount, totals.lateMinutes,
      totals.earlyCount, totals.earlyMinutes,
      totals.forgotOutCount
    ]);

    const ws1 = XLSX.utils.aoa_to_sheet(s1AoA);
    ws1['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 25 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 25 } }
    ];
    ws1['!cols'] = [
      { wch: 5 }, { wch: 24 }, { wch: 14 }, { wch: 18 },
      { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 13 }, { wch: 10 },
      { wch: 12 }, { wch: 12 }, { wch: 11 }, { wch: 11 },
      { wch: 10 }, { wch: 11 }, { wch: 10 }, { wch: 11 },
      { wch: 11 }, { wch: 14 }, { wch: 12 },
      { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 11 }
    ];
    XLSX.utils.book_append_sheet(wb, ws1, 'TongHopThang');

    // =========================================================
    // SHEET 2: BẢNG CHẤM CÔNG MA TRẬN THEO NGÀY 01 -> 31 (ĐÁNH DẤU CN)
    // =========================================================
    const dayHeaders = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dd = String(d).padStart(2, '0');
      const dk = `${targetMonth}-${dd}`;
      dayHeaders.push(isSundayIso(dk) ? `${dd}(CN)` : dd);
    }

    const s2AoA = [
      [`BẢNG CHẤM CÔNG CHI TIẾT THEO NGÀY — THÁNG ${monthLabel} (Chuẩn: ${stdInfo.standardDays} công, trừ ${stdInfo.sundayCount} Chủ Nhật)`],
      ['Ký hiệu: X = Ca thường | X(M) = Ca thường đi muộn | CRM = Trực CRM cả ngày | TC = Tăng ca | L = Trực lễ | P = Nghỉ phép duyệt | (CN) = Chủ Nhật'],
      [],
      ['STT', 'Họ và Tên', 'Số Điện Thoại', ...dayHeaders, 'Tổng Công', 'Chuẩn Tháng', 'Thừa (+)', 'Nghỉ Bù Cộng', 'Nghỉ Phép', 'Tổng Km']
    ];

    summaryRows.forEach((row, idx) => {
      const u = row.user;
      const leaveDates = getApprovedLeaveDateSet(allRequests, u.phone, targetMonth);
      const uMonthRecs = monthRecords.filter(r => r.user_id === u.phone);
      const recsByDay = new Map();
      uMonthRecs.forEach(r => {
        const dk = r.date_key || getVnDateKey(r.timestamp);
        if (!recsByDay.has(dk)) recsByDay.set(dk, []);
        recsByDay.get(dk).push(r);
      });

      const cells = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dk = `${targetMonth}-${String(d).padStart(2, '0')}`;
        const dayList = recsByDay.get(dk) || [];
        const tags = [];

        const normalList = dayList.filter(r => (r.shift_mode || 'normal') === 'normal');
        if (normalList.length > 0) {
          const firstIn = normalList.find(r => r.type === 'IN');
          const isLate = firstIn && getVnMinutesOfDay(firstIn.timestamp) > stdInMins;
          tags.push(isLate ? 'X(M)' : 'X');
        }
        if (dayList.some(r => r.shift_mode === 'crm')) tags.push('CRM');
        if (dayList.some(r => r.shift_mode === 'overtime')) tags.push('TC');
        if (dayList.some(r => r.shift_mode === 'holiday')) tags.push('L');
        if (tags.length === 0 && leaveDates.has(dk)) tags.push('P');

        cells.push(tags.join('+'));
      }

      s2AoA.push([
        idx + 1,
        u.name,
        String(u.phone),
        ...cells,
        row.workedDays,
        row.standardDays,
        row.excessDays,
        row.compOffApproved ? row.compOffDays : 0,
        row.approvedLeaveDays,
        row.totalKm
      ]);
    });

    const ws2 = XLSX.utils.aoa_to_sheet(s2AoA);
    ws2['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: daysInMonth + 8 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: daysInMonth + 8 } }
    ];
    ws2['!cols'] = [
      { wch: 5 }, { wch: 24 }, { wch: 13 },
      ...dayHeaders.map(h => ({ wch: h.includes('CN') ? 7.5 : 6 })),
      { wch: 10 }, { wch: 11 }, { wch: 9 }, { wch: 12 }, { wch: 10 }, { wch: 10 }
    ];
    XLSX.utils.book_append_sheet(wb, ws2, 'BangCong_01_31');

    // =========================================================
    // SHEET 3: BẢNG KÊ CHI TIẾT LCT / PCT & QUÃNG ĐƯỜNG (KM)
    // =========================================================
    const lctRecords = monthRecords.filter(r => hasLctReport(r));
    const s3AoA = [
      [`BẢNG KÊ LCT/PCT, ĐỊA ĐIỂM CÔNG TÁC & QUÃNG ĐƯỜNG (KM) — THÁNG ${monthLabel}`],
      [],
      ['STT', 'Ngày', 'Giờ Chấm', 'Họ và Tên', 'Số Điện Thoại', 'Chế Độ Ca', 'Loại Phiếu', 'Số LCT/PCT', 'Địa Điểm Thực Hiện', 'Quãng Đường (km)', 'Ghi Chú Công Việc']
    ];

    let sheet3KmTotal = 0;
    lctRecords.forEach((r, idx) => {
      const kmVal = Number(r.travel_km) > 0 ? (Math.round(Number(r.travel_km) * 10) / 10) : 0;
      sheet3KmTotal += kmVal;
      s3AoA.push([
        idx + 1,
        formatVnDateOnly(r.date_key || getVnDateKey(r.timestamp)),
        r.datetime_str || '',
        r.user_name || '',
        String(r.user_phone || ''),
        getShiftModeLabel(r.shift_mode),
        r.lct_type === 'PCT' ? 'Phiếu CT (PCT)' : (r.lct_type === 'LCT' ? 'Lệnh CT (LCT)' : 'Khác'),
        formatLctCodeDisplay(r),
        r.lct_location || '',
        kmVal,
        r.note || ''
      ]);
    });

    s3AoA.push([
      '', `TỔNG CỘNG (${lctRecords.length} lượt)`, '', '', '', '', '', '', '',
      Math.round(sheet3KmTotal * 10) / 10, ''
    ]);

    const ws3 = XLSX.utils.aoa_to_sheet(s3AoA);
    ws3['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }];
    ws3['!cols'] = [
      { wch: 5 }, { wch: 12 }, { wch: 20 }, { wch: 22 }, { wch: 14 },
      { wch: 13 }, { wch: 15 }, { wch: 18 }, { wch: 32 }, { wch: 15 }, { wch: 26 }
    ];
    XLSX.utils.book_append_sheet(wb, ws3, 'BangKe_LCT_PCT_Km');

    // =========================================================
    // SHEET 4: CHI TIẾT TỪNG LƯỢT CHẤM CÔNG VÀO / RA TRONG THÁNG
    // =========================================================
    const roleMapXlsx = buildUserRoleMap();
    const s4AoA = [
      [`CHI TIẾT LƯỢT CHẤM CÔNG VÀO / RA — THÁNG ${monthLabel}`],
      [],
      [
        'STT', 'Thời Gian', 'Họ và Tên', 'Số Điện Thoại', 'Chức Danh', 'Hành Động',
        'Chế Độ Ca', 'Trạng Thái Giờ (07:30-18:30)', 'Nguồn Chấm',
        'Khoảng Cách (m)', 'Vị Trí', 'Ghi Chú',
        'Số LCT/PCT', 'Địa Điểm LCT/PCT', 'Quãng Đường (km)',
        'Link Google Maps', 'Link Ảnh Google Drive'
      ]
    ];

    monthRecords.forEach((r, idx) => {
      const punct = getPunctualityInfo(r);
      const punctStr = punct ? punct.label : ((r.shift_mode && r.shift_mode !== 'normal') ? 'Ca đặc thù' : 'Đúng giờ');
      const distM = getRecordDistance(r);
      const recRole = roleMapXlsx.get(r.user_id) || normalizeRole(r.user_role);
      s4AoA.push([
        idx + 1,
        r.datetime_str || '',
        r.user_name || '',
        String(r.user_phone || ''),
        getRoleLabel(recRole),
        r.type === 'IN' ? 'Vào ca' : 'Ra ca',
        getShiftModeLabel(r.shift_mode),
        punctStr,
        r.is_manual ? `Admin chấm bù (${r.created_by_admin || 'Admin'})` : 'Tự chấm',
        distM,
        distM <= state.officeRadius ? 'Tại đơn vị' : 'Ngoài phạm vi',
        r.note || '',
        formatLctCodeDisplay(r),
        r.lct_location || '',
        Number(r.travel_km) > 0 ? (Math.round(Number(r.travel_km) * 10) / 10) : '',
        `https://www.google.com/maps?q=${r.latitude},${r.longitude}`,
        r.photo_drive_view_url || (r.has_photo ? 'Lưu trên Firebase' : '')
      ]);
    });

    const ws4 = XLSX.utils.aoa_to_sheet(s4AoA);
    ws4['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 16 } }];
    ws4['!cols'] = [
      { wch: 5 }, { wch: 20 }, { wch: 22 }, { wch: 14 }, { wch: 18 }, { wch: 10 },
      { wch: 13 }, { wch: 18 }, { wch: 20 }, { wch: 12 }, { wch: 14 },
      { wch: 24 }, { wch: 16 }, { wch: 26 }, { wch: 13 }, { wch: 36 }, { wch: 36 }
    ];
    XLSX.utils.book_append_sheet(wb, ws4, 'ChiTiet_VaoRa');

    // =========================================================
    // SHEET 5: ĐƠN NGHỈ PHÉP & GIẢI TRÌNH TRONG THÁNG
    // =========================================================
    const monthRequests = allRequests.filter(r => {
      const f = String(r.from_date || '');
      const t = String(r.to_date || '');
      const c = r.created_at ? getVnDateKey(r.created_at) : '';
      return f.startsWith(targetMonth) || t.startsWith(targetMonth) || c.startsWith(targetMonth);
    });

    const s5AoA = [
      [`DANH SÁCH ĐƠN NGHỈ PHÉP & GIẢI TRÌNH — THÁNG ${monthLabel}`],
      [],
      ['STT', 'Họ và Tên', 'Số Điện Thoại', 'Loại Đơn', 'Thời Gian Áp Dụng', 'Lý Do', 'Trạng Thái', 'Người Duyệt', 'Ghi Chú Admin', 'Thời Điểm Gửi']
    ];

    monthRequests.forEach((r, idx) => {
      s5AoA.push([
        idx + 1,
        r.user_name || '',
        String(r.user_phone || ''),
        r.category === 'leave' ? 'Nghỉ phép' : 'Giải trình',
        formatRequestTimeSpan(r),
        r.reason || '',
        r.status === 'approved' ? 'Đã duyệt OK' : (r.status === 'rejected' ? 'Từ chối' : 'Chờ duyệt'),
        r.reviewed_by || '',
        r.admin_note || '',
        r.created_time_str || ''
      ]);
    });

    const ws5 = XLSX.utils.aoa_to_sheet(s5AoA);
    ws5['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }];
    ws5['!cols'] = [
      { wch: 5 }, { wch: 22 }, { wch: 14 }, { wch: 13 }, { wch: 26 },
      { wch: 32 }, { wch: 14 }, { wch: 18 }, { wch: 24 }, { wch: 20 }
    ];
    XLSX.utils.book_append_sheet(wb, ws5, 'DonNghiPhep');

    // Xuất file .xlsx trực tiếp
    const [yyyy, mm] = targetMonth.split('-');
    const filename = `BaoCao_ChamCong_EVNNPC_Thang_${mm || '00'}-${yyyy || '2026'}.xlsx`;
    XLSX.writeFile(wb, filename);

    playSuccessSound();
    showToast(`📗 Đã xuất trọn bộ Excel (.xlsx) 5 trang cho tháng ${monthLabel}!`, 'success', 4500);
  } catch (err) {
    playErrorSound();
    showToast('Lỗi xuất file Excel .xlsx: ' + err.message, 'error', 5000);
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = origText;
    }
  }
}

document.getElementById('btn-export-monthly-xlsx').addEventListener('click', (e) => {
  const monthKey = document.getElementById('summary-month-input').value || getVnDateKey().slice(0, 7);
  exportMonthlyExcelWorkbook(monthKey, e.currentTarget);
});

document.getElementById('btn-eom-export-now').addEventListener('click', (e) => {
  const monthKey = currentEomTargetMonth || document.getElementById('summary-month-input').value || getVnDateKey().slice(0, 7);
  exportMonthlyExcelWorkbook(monthKey, e.currentTarget);
});

document.getElementById('btn-eom-dismiss').addEventListener('click', () => {
  if (currentEomTargetMonth) {
    localStorage.setItem(`cc_eom_dismissed_${currentEomTargetMonth}`, '1');
  }
  const banner = document.getElementById('eom-export-banner');
  if (banner) banner.classList.add('hidden');
});

// --- Dọn ảnh / Dọn hẳn dòng dữ liệu chấm công ---
function openCleanupModal() {
  if (!isAdmin()) {
    return showToast('Tài khoản Tổ trưởng / Tổ phó chỉ có quyền xem, không được dọn dữ liệu/ảnh!', 'error');
  }
  document.getElementById('modal-cleanup-photos').classList.add('show');
}

document.getElementById('form-cleanup-photos').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!isAdmin()) {
    return showToast('Chỉ Admin mới có quyền dọn dữ liệu/ảnh!', 'error');
  }
  const mode = document.getElementById('cleanup-mode-select').value;
  const rawVal = document.getElementById('cleanup-days-select').value;
  const days = Number(rawVal);
  if (isNaN(days) || days < 0) return;

  const isFullDelete = mode === 'full_records';
  const timeText = days === 0 ? 'TẤT CẢ (kể cả hôm nay)' : `cũ hơn ${days} ngày`;
  const confirmMsg = isFullDelete
    ? `⚠️ CẢNH BÁO: Xác nhận XÓA HẲN toàn bộ DÒNG CHẤM CÔNG VÀO/RA + ẢNH (${timeText})?\nHành động này không thể hoàn tác!`
    : `Xác nhận xóa tất cả ẢNH KHUÔN MẶT (${timeText})?\n(Lịch sử giờ chấm công & tọa độ GPS vẫn được giữ nguyên 100%)`;

  if (!confirm(confirmMsg)) {
    return;
  }

  const btn = document.getElementById('btn-confirm-cleanup');
  btn.disabled = true;
  btn.textContent = '⏳ Đang xử lý...';

  try {
    const count = isFullDelete
      ? await DB.cleanupAttendanceRecords(days)
      : await DB.cleanupOldPhotos(days);

    playSuccessSound();
    if (count > 0) {
      const msg = isFullDelete
        ? `✅ Đã xóa hẳn ${count} dòng chấm công Vào/Ra & ảnh (${timeText})!`
        : `✅ Đã dọn sạch ${count} ảnh (${timeText}) — giữ nguyên toàn bộ giờ công & GPS!`;
      showToast(msg, 'success', 5000);
    } else {
      showToast(`👍 Không có dữ liệu nào (${timeText}) cần dọn.`, 'info', 4000);
    }
    closeModal('modal-cleanup-photos');
    await Promise.all([loadAdminData(), syncUserStatus(), loadMyHistory()]);
  } catch (err) {
    playErrorSound();
    showToast('Lỗi dọn dữ liệu: ' + err.message, 'error', 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '🧹 Bắt đầu dọn ngay';
  }
});

// --- DANH SÁCH DUYỆT ĐƠN NGHỈ PHÉP & GIẢI TRÌNH (ADMIN) ---
function renderAdminRequestsList() {
  const listEl = document.getElementById('admin-requests-list');
  const statusVal = document.getElementById('filter-req-status').value;
  const catVal = document.getElementById('filter-req-category').value;
  const userVal = document.getElementById('filter-req-user').value;

  const filtered = state.adminRequestsCache.filter(r => {
    if (statusVal !== 'all' && r.status !== statusVal) return false;
    if (catVal !== 'all' && r.category !== catVal) return false;
    if (userVal !== 'all' && r.user_id !== userVal) return false;
    return true;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <p>${statusVal === 'pending' ? 'Không có đơn nào đang chờ duyệt!' : 'Không tìm thấy đơn phù hợp với bộ lọc.'}</p>
      </div>
    `;
    return;
  }

  const adminOnly = isAdmin();
  listEl.innerHTML = filtered.map(r => `
    <div class="request-card">
      <div class="request-card-top">
        <div class="request-meta">
          ${renderRequestCategoryBadge(r.category)}
          <strong style="color: #fff; font-size: 0.94rem;">${escapeHtml(r.user_name)}</strong>
          <code style="color: var(--text-muted); font-size: 0.8rem;">${escapeHtml(r.user_phone)}</code>
          <span style="color: #7dd3fc; font-size: 0.82rem; font-weight: 600;">• ${escapeHtml(formatRequestTimeSpan(r))}</span>
        </div>
        ${renderRequestStatusBadge(r.status)}
      </div>

      <div class="request-reason-box"><strong>Lý do nhân viên ghi:</strong> ${escapeHtml(r.reason)}</div>

      ${r.admin_note ? `
        <div class="request-admin-note ${r.status === 'rejected' ? 'rejected' : ''}">
          <strong>Ghi chú duyệt (${escapeHtml(r.reviewed_by || 'Admin')}):</strong> ${escapeHtml(r.admin_note)}
        </div>
      ` : ''}

      <div class="request-card-footer">
        <span>Gửi lúc: ${escapeHtml(r.created_time_str || getVnTimeStr(r.created_at))}${r.reviewed_time_str ? ' • Xử lý lúc: ' + escapeHtml(r.reviewed_time_str) : ''}</span>
        <div class="action-btns">
          ${adminOnly ? `
            ${r.status !== 'approved' ? `
              <button class="btn-sm btn-unlock" data-review-id="${escapeHtml(r.id)}" data-decision="approved">
                ✅ Duyệt OK
              </button>
            ` : ''}
            ${r.status !== 'rejected' ? `
              <button class="btn-sm btn-lock" data-review-id="${escapeHtml(r.id)}" data-decision="rejected">
                ❌ Từ chối
              </button>
            ` : ''}
          ` : `
            <span class="readonly-tag">👁️ Chỉ xem (Admin duyệt)</span>
          `}
        </div>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('button[data-review-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      openReviewRequestModal(btn.dataset.reviewId, btn.dataset.decision);
    });
  });
}

function openReviewRequestModal(reqId, decision) {
  if (!isAdmin()) {
    return showToast('Tài khoản Tổ trưởng / Tổ phó chỉ được xem đơn, không có quyền duyệt/từ chối!', 'error');
  }
  const req = state.adminRequestsCache.find(r => r.id === reqId);
  if (!req) return;

  document.getElementById('review-req-id').value = reqId;
  document.getElementById('review-req-decision').value = decision;
  document.getElementById('review-admin-note').value = decision === 'approved' ? 'OK, đã duyệt.' : '';

  const titleEl = document.getElementById('review-modal-title');
  const confirmBtn = document.getElementById('btn-confirm-review');
  if (decision === 'approved') {
    titleEl.textContent = '✅ Xác Nhận Duyệt OK';
    confirmBtn.textContent = '✅ Duyệt OK ngay';
    confirmBtn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
  } else {
    titleEl.textContent = '❌ Từ Chối Đơn';
    confirmBtn.textContent = '❌ Xác nhận Từ chối';
    confirmBtn.style.background = 'linear-gradient(135deg, #be123c, #f43f5e)';
  }

  document.getElementById('review-req-summary').innerHTML =
    `<b>${escapeHtml(req.user_name)}</b> (${escapeHtml(req.user_phone)}) — ${req.category === 'leave' ? 'Nghỉ phép' : 'Giải trình'}<br>` +
    `<span style="color: #7dd3fc;">${escapeHtml(formatRequestTimeSpan(req))}</span><br>` +
    `Lý do: ${escapeHtml(req.reason)}`;

  document.getElementById('modal-review-request').classList.add('show');
}

document.getElementById('form-review-request').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!isAdmin()) {
    return showToast('Chỉ Admin mới có quyền duyệt hoặc từ chối đơn!', 'error');
  }
  const reqId = document.getElementById('review-req-id').value;
  const decision = document.getElementById('review-req-decision').value;
  const adminNote = document.getElementById('review-admin-note').value.trim();

  try {
    const now = Date.now();
    await DB.updateRequest(reqId, {
      status: decision,
      admin_note: adminNote,
      reviewed_by: state.user ? state.user.name : 'Admin',
      reviewed_at: now,
      reviewed_time_str: getVnTimeStr(now)
    });

    playSuccessSound();
    showToast(decision === 'approved' ? '✅ Đã duyệt OK đơn thành công!' : 'Đã cập nhật từ chối đơn.', 'success');
    closeModal('modal-review-request');
    await loadAdminData();
  } catch (err) {
    showToast('Lỗi cập nhật duyệt đơn: ' + err.message, 'error');
  }
});

document.getElementById('filter-req-status').addEventListener('change', renderAdminRequestsList);
document.getElementById('filter-req-category').addEventListener('change', renderAdminRequestsList);
document.getElementById('filter-req-user').addEventListener('change', renderAdminRequestsList);
document.getElementById('btn-admin-req-refresh').addEventListener('click', loadAdminData);

// Xuất CSV đơn Nghỉ phép & Giải trình
document.getElementById('btn-export-requests-csv').addEventListener('click', () => {
  const rows = state.adminRequestsCache;
  if (!rows || rows.length === 0) {
    return showToast('Chưa có đơn nghỉ phép/giải trình nào để xuất Excel.', 'info');
  }

  let csv = '\uFEFF';
  csv += 'STT,Họ và Tên,Số Điện Thoại,Loại Đơn,Thời Gian Áp Dụng,Lý Do,Trạng Thái,Ghi Chú Admin,Ngày Gửi\n';
  rows.forEach((r, idx) => {
    const catStr = r.category === 'leave' ? 'Nghỉ phép' : 'Giải trình';
    const stStr = r.status === 'approved' ? 'Đã duyệt OK' : (r.status === 'rejected' ? 'Từ chối' : 'Chờ duyệt');
    const esc = v => `"${String(v || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    csv += `${idx + 1},${esc(r.user_name)},${r.user_phone},${catStr},${esc(formatRequestTimeSpan(r))},${esc(r.reason)},${stStr},${esc(r.admin_note)},${esc(r.created_time_str)}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `don-nghi-phep-giai-trinh-${getVnDateKey()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Đã tải file Excel đơn Nghỉ phép & Giải trình!', 'success');
});

// --- BẢNG NHÂN SỰ (TỐI ĐA 30 NGƯỜI) ---
function renderAdminStaffTable(lastPunchMap = null) {
  if (!isAdmin()) return;
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
      ? `<span class="badge" style="background: rgba(244, 63, 94, 0.2); color: #fda4af; border: 1px solid #f43f5e;">🔒 ${escapeHtml(lockReason)}</span>`
      : `<span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid #10b981;">✓ Hoạt động</span>`;

    const lastPunch = lastPunchMap.get(u.phone);
    const shiftBadge = (lastPunch && lastPunch.type === 'IN')
      ? `<span class="badge badge-in">🟢 Đang trong ca</span>`
      : `<span style="color: var(--text-dim); font-size: 0.8rem;">Chưa vào ca</span>`;

    const isCurrentAdmin = state.user && state.user.phone === u.phone;
    const curRole = normalizeRole(u.role);
    const roleCellHtml = isCurrentAdmin
      ? `<span class="badge badge-admin">👑 Quản lý (Admin)</span>`
      : `
        <select class="staff-role-select" data-role-phone="${escapeHtml(u.phone)}" data-role-name="${escapeHtml(u.name)}" data-prev-role="${escapeHtml(curRole)}" title="Đổi chức danh / vai trò tài khoản này">
          <option value="employee" ${curRole === 'employee' ? 'selected' : ''}>👤 Nhân viên (không ghi LCT/PCT)</option>
          <option value="service_worker" ${curRole === 'service_worker' ? 'selected' : ''}>🔧 Công nhân dịch vụ (không ghi LCT/PCT)</option>
          <option value="worker" ${curRole === 'worker' ? 'selected' : ''}>👷 Công nhân (có LCT/PCT)</option>
          <option value="deputy" ${curRole === 'deputy' ? 'selected' : ''}>⭐ Tổ phó (Chỉ xem + LCT/PCT)</option>
          <option value="leader" ${curRole === 'leader' ? 'selected' : ''}>👁️ Tổ trưởng (Chỉ xem + LCT/PCT)</option>
          <option value="admin" ${curRole === 'admin' ? 'selected' : ''}>👑 Quản lý (Admin)</option>
        </select>
      `;

    return `
      <tr>
        <td>
          <b>${escapeHtml(u.name)}</b>
          ${isCurrentAdmin ? '<small style="color: #60a5fa;"> (Bạn)</small>' : ''}
        </td>
        <td><code>${escapeHtml(u.phone)}</code></td>
        <td>${roleCellHtml}</td>
        <td>${shiftBadge}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="action-btns">
            <button class="btn-sm btn-unlock" data-action="manual-punch" data-phone="${escapeHtml(u.phone)}" title="Chấm bù Vào ca / Ra ca cho nhân viên này">
              ✍️ Chấm bù
            </button>
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

  tbody.querySelectorAll('select[data-role-phone]').forEach(sel => {
    sel.addEventListener('change', async () => {
      if (!isAdmin()) return;
      const phone = sel.dataset.rolePhone;
      const name = sel.dataset.roleName;
      const prevRole = normalizeRole(sel.dataset.prevRole);
      const newRole = normalizeRole(sel.value);
      if (newRole === prevRole) return;

      const labelMap = {
        admin: 'Quản lý (Admin toàn quyền)',
        leader: 'Tổ trưởng (Chỉ xem + ghi LCT/PCT khi tan ca)',
        deputy: 'Tổ phó (Chỉ xem + ghi LCT/PCT khi tan ca)',
        worker: 'Công nhân (ghi LCT/PCT & km khi tan ca)',
        service_worker: 'Công nhân dịch vụ (KHÔNG cần ghi LCT/PCT khi tan ca)',
        employee: 'Nhân viên (KHÔNG cần ghi LCT/PCT khi tan ca)'
      };
      if (!confirm(`Đổi chức danh của "${name}" (${phone})\nsang: ${labelMap[newRole]}?`)) {
        sel.value = prevRole;
        return;
      }
      sel.disabled = true;
      try {
        await DB.updateUser(phone, { role: newRole });
        sel.dataset.prevRole = newRole;
        playSuccessSound();
        showToast(`✅ Đã đổi "${name}" sang chức danh ${labelMap[newRole]}!`, 'success');
        await loadAdminData();
      } catch (err) {
        sel.value = prevRole;
        showToast('Lỗi đổi chức danh: ' + err.message, 'error');
      } finally {
        sel.disabled = false;
      }
    });
  });

  tbody.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const phone = btn.dataset.phone;
      const name = btn.dataset.name;
      if (action === 'manual-punch') openAdminPunchModal(phone);
      else if (action === 'pin') openChangePinModal(phone, name);
      else if (action === 'lock') toggleLockUser(phone);
      else if (action === 'delete') deleteUser(phone, name);
    });
  });
}

document.getElementById('filter-date').addEventListener('change', renderAdminHistoryTable);
document.getElementById('filter-user').addEventListener('change', renderAdminHistoryTable);
const filterRoleEl = document.getElementById('filter-role');
if (filterRoleEl) filterRoleEl.addEventListener('change', renderAdminHistoryTable);
document.getElementById('filter-type').addEventListener('change', renderAdminHistoryTable);
document.getElementById('filter-shift-mode').addEventListener('change', renderAdminHistoryTable);
document.getElementById('btn-admin-refresh').addEventListener('click', loadAdminData);

// --- ADMIN CHẤM BÙ VÀO CA / RA CA (KHI NHÂN VIÊN QUÊN CHẤM) ---
function getCurrentVnTimeHHMM() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date());
  return parts; // HH:mm
}

function openAdminPunchModal(preselectPhone = null, preset = null) {
  if (!isAdmin()) {
    return showToast('Tài khoản Tổ trưởng / Tổ phó chỉ có quyền xem, không được chấm bù!', 'error');
  }
  const userSel = document.getElementById('manual-user-select');
  if (!state.allUsersList || state.allUsersList.length === 0) {
    return showToast('Chưa tải được danh sách nhân viên.', 'error');
  }

  userSel.innerHTML = state.allUsersList
    .map(u => `<option value="${escapeHtml(u.phone)}">${escapeHtml(u.name)} (${escapeHtml(u.phone)})</option>`)
    .join('');

  if (preselectPhone && [...userSel.options].some(o => o.value === preselectPhone)) {
    userSel.value = preselectPhone;
  }

  // Tự gợi ý Vào ca hay Ra ca dựa theo preset (nếu có) hoặc lần chấm gần nhất
  const selectedPhone = userSel.value;
  const lastRec = state.adminRecordsCache.find(r => r.user_id === selectedPhone);
  document.getElementById('manual-type-select').value = (preset && preset.type)
    ? preset.type
    : ((lastRec && lastRec.type === 'IN') ? 'OUT' : 'IN');
  document.getElementById('manual-shift-mode').value = (preset && preset.shiftMode)
    ? preset.shiftMode
    : ((lastRec && lastRec.type === 'IN' && lastRec.shift_mode) ? lastRec.shift_mode : 'normal');
  document.getElementById('manual-date').value = (preset && preset.date) ? preset.date : getVnDateKey();
  document.getElementById('manual-time').value = (preset && preset.time) ? preset.time : getCurrentVnTimeHHMM();
  document.getElementById('manual-note').value = (preset && preset.note) ? preset.note : 'Admin chấm bù (nhân viên quên chấm)';

  document.getElementById('modal-admin-punch').classList.add('show');
}

document.getElementById('manual-user-select').addEventListener('change', (e) => {
  const phone = e.target.value;
  const lastRec = state.adminRecordsCache.find(r => r.user_id === phone);
  document.getElementById('manual-type-select').value = (lastRec && lastRec.type === 'IN') ? 'OUT' : 'IN';
  document.getElementById('manual-shift-mode').value = (lastRec && lastRec.type === 'IN' && lastRec.shift_mode) ? lastRec.shift_mode : 'normal';
});

document.getElementById('form-admin-punch').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.user || state.user.role !== 'admin') return;

  const targetPhone = document.getElementById('manual-user-select').value;
  const actionType = document.getElementById('manual-type-select').value === 'OUT' ? 'OUT' : 'IN';
  const shiftMode = document.getElementById('manual-shift-mode').value || 'normal';
  const manualDate = document.getElementById('manual-date').value;
  const manualTime = document.getElementById('manual-time').value;
  const note = document.getElementById('manual-note').value.trim() || 'Admin chấm bù';

  if (!targetPhone || !manualDate || !manualTime) {
    return showToast('Vui lòng chọn đầy đủ nhân viên, ngày và giờ chấm bù!', 'error');
  }

  const targetUser = state.allUsersList.find(u => u.phone === targetPhone);
  if (!targetUser) return showToast('Không tìm thấy nhân viên đã chọn.', 'error');

  const btn = document.getElementById('btn-confirm-manual-punch');
  btn.disabled = true;
  btn.textContent = '⏳ Đang lưu...';

  try {
    const [y, m, d] = manualDate.split('-').map(Number);
    const [hh, mm] = manualTime.split(':').map(Number);
    // Chuyển ngày giờ VN (UTC+7) sang epoch ms chuẩn
    const ts = Date.UTC(y, m - 1, d, hh, mm, 0) - (7 * 3600 * 1000);
    const shiftModeLabel = getShiftModeLabel(shiftMode);
    const attId = `att_${ts}_${Math.random().toString(36).slice(2, 7)}`;

    const record = {
      id: attId,
      user_id: targetUser.phone,
      user_name: targetUser.name,
      user_phone: targetUser.phone,
      user_role: targetUser.role,
      type: actionType,
      typeText: actionType === 'IN' ? 'Vào ca' : 'Ra ca',
      shift_mode: shiftMode,
      shift_mode_text: shiftModeLabel,
      is_manual: true,
      created_by_admin: state.user.name,
      note,
      timestamp: ts,
      datetime_str: getVnTimeStr(ts),
      date_key: getVnDateKey(ts),
      latitude: OFFICE_LOCATION.lat,
      longitude: OFFICE_LOCATION.lng,
      accuracy: 0,
      distance_m: 0,
      in_office: true,
      mapUrl: OFFICE_LOCATION.mapUrl,
      photo_thumb: '',
      has_photo: false
    };

    await DB.addAttendance(record, null);

    playSuccessSound();
    showToast(`✅ Đã chấm bù ${record.typeText} (${shiftModeLabel}) cho ${targetUser.name}!`, 'success', 4500);
    closeModal('modal-admin-punch');
    await Promise.all([loadAdminData(), syncUserStatus(), loadMyHistory()]);
  } catch (err) {
    playErrorSound();
    showToast('Lỗi chấm bù: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Lưu chấm bù';
  }
});

// Xuất CSV lịch sử chấm công (đầy đủ Loại công, Nguồn chấm, Khoảng cách)
document.getElementById('btn-export-csv').addEventListener('click', () => {
  const rows = state.adminRecordsCache;
  if (!rows || rows.length === 0) {
    showToast('Chưa có dữ liệu chấm công để xuất Excel.', 'info');
    return;
  }

  let csv = '\uFEFF';
  csv += 'STT,Họ và Tên,Số Điện Thoại,Chức Danh,Hành Động,Chế Độ Ca,Trạng Thái Giờ (07:30-18:30),Nguồn Chấm,Thời Gian,Khoảng Cách Công Ty (m),Trạng Thái Vị Trí,Ghi Chú,Số LCT/PCT,Địa Điểm Thực Hiện LCT/PCT,Quãng Đường (km),Vĩ Độ,Kinh Độ,Sai Số (m),Link Google Maps,Link Ảnh Google Drive\n';
  const roleMapCsv = buildUserRoleMap();
  rows.forEach((r, idx) => {
    const typeStr = r.type === 'IN' ? 'Vào ca' : 'Ra ca';
    const modeStr = getShiftModeLabel(r.shift_mode);
    const punct = getPunctualityInfo(r);
    const punctStr = punct ? punct.label : ((r.shift_mode && r.shift_mode !== 'normal') ? 'Ca đặc thù' : 'Đúng giờ');
    const sourceStr = r.is_manual ? `Admin chấm bù (${r.created_by_admin || 'Admin'})` : 'Nhân viên tự chấm';
    const distM = getRecordDistance(r);
    const zoneStr = distM <= state.officeRadius ? 'Tại công ty' : 'Ngoài phạm vi';
    const mapUrl = `https://www.google.com/maps?q=${r.latitude},${r.longitude}`;
    const esc = v => `"${String(v || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const photoCol = r.photo_drive_view_url ? r.photo_drive_view_url : (r.has_photo ? 'Lưu trên Firebase' : 'Không');
    const lctCodeCol = formatLctCodeDisplay(r);
    const lctLocCol = r.lct_location || '';
    const kmCol = Number(r.travel_km) > 0 ? (Math.round(Number(r.travel_km) * 10) / 10) : '';
    const roleStr = getRoleLabel(roleMapCsv.get(r.user_id) || normalizeRole(r.user_role));
    csv += `${idx + 1},${esc(r.user_name)},${r.user_phone},${esc(roleStr)},${typeStr},${modeStr},${esc(punctStr)},${esc(sourceStr)},${esc(r.datetime_str)},${distM},${esc(zoneStr)},${esc(r.note)},${esc(lctCodeCol)},${esc(lctLocCol)},${kmCol},${r.latitude},${r.longitude},${r.accuracy},"${mapUrl}",${esc(photoCol)}\n`;
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

// --- Thêm nhân viên (tối đa 30 người) ---
function openAddUserModal() {
  if (!isAdmin()) {
    return showToast('Chỉ Admin mới có quyền thêm nhân sự!', 'error');
  }
  if (state.allUsersList.length >= MAX_USERS) {
    return showToast(`Đã đạt giới hạn tối đa ${MAX_USERS} nhân sự!`, 'error');
  }
  document.getElementById('form-add-user').reset();
  document.getElementById('modal-add-user').classList.add('show');
}

document.getElementById('form-add-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!isAdmin()) {
    return showToast('Chỉ Admin mới có quyền thêm nhân sự!', 'error');
  }
  const name = document.getElementById('add-user-name').value.trim();
  const phone = document.getElementById('add-user-phone').value.trim();
  const pin = document.getElementById('add-user-pin').value.trim();
  const rawRole = document.getElementById('add-user-role').value;
  const role = normalizeRole(rawRole);

  if (!name) return showToast('Họ tên nhân viên không được để trống!', 'error');
  if (!/^\d{9,11}$/.test(phone)) return showToast('Số điện thoại phải từ 9 đến 11 chữ số!', 'error');
  if (!/^\d{4,6}$/.test(pin)) return showToast('Mã PIN phải từ 4 đến 6 chữ số!', 'error');

  try {
    const allUsers = await DB.getAllUsers();
    if (allUsers.length >= MAX_USERS) {
      return showToast(`Đã đạt giới hạn tối đa ${MAX_USERS} người dùng!`, 'error');
    }

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
  if (!isAdmin()) {
    return showToast('Chỉ Admin mới có quyền đổi PIN nhân sự!', 'error');
  }
  document.getElementById('change-pin-user-id').value = phone;
  document.getElementById('change-pin-user-name').value = `${userName} (${phone})`;
  document.getElementById('change-pin-val').value = '';
  document.getElementById('modal-change-pin').classList.add('show');
}

document.getElementById('form-change-pin').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!isAdmin()) {
    return showToast('Chỉ Admin mới có quyền đổi PIN nhân sự!', 'error');
  }
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
  if (!isAdmin()) {
    return showToast('Chỉ Admin mới có quyền khóa/mở khóa tài khoản!', 'error');
  }
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
  if (!isAdmin()) {
    return showToast('Chỉ Admin mới có quyền xóa nhân viên!', 'error');
  }
  if (!confirm(`Bạn có chắc chắn muốn xóa nhân viên "${userName}"?\nToàn bộ lịch sử chấm công và đơn từ của người này sẽ bị xóa vĩnh viễn.`)) {
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

// ==========================================
// 11B. CÀI APP RA MÀN HÌNH ĐIỆN THOẠI (PWA INSTALL - ANDROID 1 CHẠM & IPHONE)
// ==========================================
let deferredInstallPrompt = null;

function isStandaloneMode() {
  return Boolean(
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true ||
    document.referrer.startsWith('android-app://')
  );
}

function detectInstallPlatform() {
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isInAppBrowser = /Zalo|FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|TikTok/i.test(ua);
  const platform = isIos ? 'ios' : (isAndroid ? 'android' : 'desktop');
  return { platform, isIos, isAndroid, isInAppBrowser };
}

function getCleanAppUrl() {
  return window.location.origin + window.location.pathname;
}

function updateInstallUI() {
  const headerBtn = document.getElementById('btn-header-install');
  const loginCard = document.getElementById('login-install-card');
  const punchLink = document.getElementById('link-install-app');
  const loginSub = document.getElementById('login-install-sub');
  const loginBtn = document.getElementById('btn-login-install');
  const nativeBox = document.getElementById('install-native-box');

  if (isStandaloneMode()) {
    if (headerBtn) headerBtn.classList.add('hidden');
    if (loginCard) loginCard.classList.add('hidden');
    if (punchLink) punchLink.classList.add('hidden');
    if (nativeBox) nativeBox.classList.add('hidden');
    return;
  }

  if (headerBtn) headerBtn.classList.remove('hidden');
  if (loginCard) loginCard.classList.remove('hidden');
  if (punchLink) punchLink.classList.remove('hidden');

  const { isIos, isInAppBrowser } = detectInstallPlatform();
  if (deferredInstallPrompt && !isInAppBrowser) {
    if (loginSub) loginSub.textContent = 'Bấm 1 chạm để cài trực tiếp ra màn hình chính!';
    if (loginBtn) loginBtn.textContent = '📲 Cài 1 chạm';
    if (nativeBox) nativeBox.classList.remove('hidden');
  } else if (isInAppBrowser) {
    if (loginSub) loginSub.textContent = 'Mở bằng Safari / Chrome để lưu ra màn hình điện thoại';
    if (loginBtn) loginBtn.textContent = 'Xem cách cài';
    if (nativeBox) nativeBox.classList.add('hidden');
  } else if (isIos) {
    if (loginSub) loginSub.textContent = 'Xem hướng dẫn 3 bước lưu ra màn hình iPhone';
    if (loginBtn) loginBtn.textContent = 'Xem cách cài';
    if (nativeBox) nativeBox.classList.add('hidden');
  } else {
    if (loginSub) loginSub.textContent = 'Mở 1 chạm như app thật • Hỗ trợ Android & iPhone';
    if (loginBtn) loginBtn.textContent = 'Cài ngay';
    if (nativeBox) nativeBox.classList.add('hidden');
  }
}

function switchInstallGuideTab(tabName) {
  const tabs = ['ios', 'android', 'desktop'];
  tabs.forEach(t => {
    const btn = document.getElementById(`install-tab-${t}`);
    const panel = document.getElementById(`install-guide-${t}`);
    if (btn) btn.classList.toggle('active', t === tabName);
    if (panel) panel.classList.toggle('hidden', t !== tabName);
  });
}

function openInstallModal() {
  const { platform, isInAppBrowser } = detectInstallPlatform();
  const inAppWarn = document.getElementById('install-inapp-warning');
  const nativeBox = document.getElementById('install-native-box');
  const urlText = document.getElementById('install-app-url-text');

  if (urlText) urlText.textContent = getCleanAppUrl();
  if (inAppWarn) inAppWarn.classList.toggle('hidden', !isInAppBrowser);
  if (nativeBox) nativeBox.classList.toggle('hidden', !(deferredInstallPrompt && !isInAppBrowser));

  switchInstallGuideTab(platform);
  document.getElementById('modal-install-app').classList.add('show');
}

async function triggerNativeInstall() {
  if (!deferredInstallPrompt) {
    openInstallModal();
    return;
  }
  try {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice && choice.outcome === 'accepted') {
      closeModal('modal-install-app');
      showToast('🎉 Đang cài Chấm Công ra màn hình chính!', 'success');
    }
  } catch (err) {
    console.warn('PWA install prompt error:', err);
    openInstallModal();
  } finally {
    updateInstallUI();
  }
}

async function handleInstallAppClick() {
  if (isStandaloneMode()) {
    showToast('Ứng dụng đã được cài sẵn trên màn hình chính rồi!', 'info');
    return;
  }
  const { isInAppBrowser } = detectInstallPlatform();
  if (deferredInstallPrompt && !isInAppBrowser) {
    await triggerNativeInstall();
    return;
  }
  openInstallModal();
}

async function copyAppInstallLink() {
  const url = getCleanAppUrl();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast('✅ Đã sao chép link app! Dán vào Safari hoặc Chrome để cài.', 'success');
  } catch {
    showToast('Không thể tự sao chép, bạn hãy copy đường link trên thanh địa chỉ.', 'error');
  }
}

// Bắt sự kiện cài app PWA sớm nhất có thể (tránh bỏ lỡ trước DOMContentLoaded)
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallUI();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  closeModal('modal-install-app');
  updateInstallUI();
  showToast('🎉 Đã cài Chấm Công ra màn hình chính thành công!', 'success');
});

function initPwaInstall() {
  try {
    const mq = window.matchMedia('(display-mode: standalone)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', updateInstallUI);
    }
  } catch {}

  updateInstallUI();
}

// Gắn các hàm gọi từ HTML onclick vào window (vì script là ES module)
window.openGpsModal = openGpsModal;
window.closeModal = closeModal;
window.switchEmployeeTab = switchEmployeeTab;
window.selectRequestCategory = selectRequestCategory;
window.switchAdminTab = switchAdminTab;
window.showAttendanceView = showAttendanceView;
window.openAddUserModal = openAddUserModal;
window.openChangePinModal = openChangePinModal;
window.toggleLockUser = toggleLockUser;
window.deleteUser = deleteUser;
window.closeCameraModal = closeCameraModal;
window.openPhotoViewer = openPhotoViewer;
window.openCleanupModal = openCleanupModal;
window.selectShiftMode = selectShiftMode;
window.openAdminPunchModal = openAdminPunchModal;
window.setQuickWorkNote = setQuickWorkNote;
window.selectLctType = selectLctType;
window.openCheckoutReportModal = openCheckoutReportModal;
window.handleInstallAppClick = handleInstallAppClick;
window.openInstallModal = openInstallModal;
window.switchInstallGuideTab = switchInstallGuideTab;
window.triggerNativeInstall = triggerNativeInstall;
window.copyAppInstallLink = copyAppInstallLink;

// ==========================================
// 12. KHỞI TẠO ỨNG DỤNG (AUTO-LOGIN 30 NGÀY)
// ==========================================
async function initApp() {
  initClock();
  initPwaInstall();

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

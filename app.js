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

  try {
    // Dùng text/plain để tránh CORS preflight OPTIONS trên Google Apps Script
    const res = await fetch(cfg.scriptUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
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

function getShiftModeLabel(mode) {
  if (mode === 'overtime') return 'Tăng ca';
  if (mode === 'holiday') return 'Trực lễ';
  return 'Ca thường';
}

function renderShiftModeBadge(mode) {
  if (mode === 'overtime') return '<span class="badge badge-overtime">⚡ Tăng ca</span>';
  if (mode === 'holiday') return '<span class="badge badge-holiday">🎌 Trực lễ</span>';
  return '';
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

  // Đặt sẵn ngày hôm nay cho form Nghỉ phép / Giải trình
  const today = getVnDateKey();
  document.getElementById('req-from-date').value = today;
  document.getElementById('req-to-date').value = today;
  document.getElementById('req-explain-date').value = today;

  showAttendanceView();
  switchEmployeeTab('punch');
  prewarmGPS();

  await Promise.all([
    syncUserStatus(),
    loadMyHistory(),
    loadMyRequests()
  ]);
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
  state.selectedShiftMode = ['normal', 'overtime', 'holiday'].includes(mode) ? mode : 'normal';
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

  // Cập nhật 3 nút chọn chế độ ca (khóa khi đang ở trong ca để tránh bấm nhầm)
  document.querySelectorAll('#shift-mode-selector .shift-pill').forEach(pill => {
    const pMode = pill.dataset.mode;
    pill.classList.toggle('active', pMode === activeMode);
    pill.disabled = isOut && pMode !== activeMode;
  });

  btn.classList.remove('loading');
  if (wrapper) {
    wrapper.classList.remove('mode-out', 'mode-overtime-ring', 'mode-holiday-ring');
  }

  if (!isOut) {
    let btnClass = 'punch-btn btn-in';
    let btnIcon = '☀️';
    let btnLabel = 'VÀO CA';

    if (activeMode === 'overtime') {
      btnClass += ' mode-overtime';
      if (wrapper) wrapper.classList.add('mode-overtime-ring');
      btnIcon = '⚡';
      btnLabel = 'VÀO TĂNG CA';
    } else if (activeMode === 'holiday') {
      btnClass += ' mode-holiday';
      if (wrapper) wrapper.classList.add('mode-holiday-ring');
      btnIcon = '🎌';
      btnLabel = 'VÀO TRỰC LỄ';
    }

    btn.className = btnClass;
    icon.textContent = btnIcon;
    text.textContent = btnLabel;
    subtext.textContent = `${modeLabel} • Chụp mặt & GPS`;

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
    text.textContent = activeMode === 'overtime' ? 'RA TĂNG CA' : (activeMode === 'holiday' ? 'RA TRỰC LỄ' : 'RA CA');
    subtext.textContent = `${modeLabel} • Chụp mặt & GPS`;

    statusChip.className = 'status-chip in-shift';
    const inTime = state.lastAttendance ? state.lastAttendance.datetime_str : '';
    const modePrefix = activeMode === 'overtime' ? '⚡ Đang TĂNG CA' : (activeMode === 'holiday' ? '🎌 Đang TRỰC LỄ' : '🟢 Đang trong ca làm việc');
    statusChip.textContent = `${modePrefix} (Vào lúc ${inTime})`;
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
// 7. GPS TỐI ƯU DI ĐỘNG + KHOẢNG CÁCH CÔNG TY + CAMERA CHỤP MẶT
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
    const distanceM = calcDistanceMeters(lat, lng);
    const inOffice = distanceM <= state.officeRadius;

    text.textContent = 'ĐANG LƯU...';
    subtext.textContent = `Cách công ty ${formatDistance(distanceM)}`;

    const recent = await DB.getUserAttendance(state.user.phone, 1);
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

    // Nếu đã cấu hình Google Drive -> tải ảnh lên Drive (0KB ảnh trên Firebase!)
    let driveResult = null;
    if (fullPhoto && isDriveConfigured()) {
      text.textContent = 'LƯU ẢNH DRIVE...';
      subtext.textContent = 'Đang tải ảnh lên Google Drive';
      driveResult = await uploadPhotoToDrive(fullPhoto, {
        userName: state.user.name,
        dateKey,
        timeTag,
        actionType
      });
    }

    text.textContent = 'ĐANG LƯU CA...';
    subtext.textContent = `Cách công ty ${formatDistance(distanceM)}`;

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
      note: '',
      timestamp: now,
      datetime_str: timeStr,
      date_key: dateKey,
      latitude: lat,
      longitude: lng,
      accuracy: accValue,
      distance_m: distanceM,
      in_office: inOffice,
      mapUrl: `https://www.google.com/maps?q=${lat},${lng}`,
      photo_thumb: driveResult ? driveResult.thumbUrl : (thumbPhoto || ''),
      photo_full_url: driveResult ? driveResult.fullUrl : '',
      photo_drive_id: driveResult ? driveResult.fileId : '',
      photo_drive_view_url: driveResult ? driveResult.viewUrl : '',
      photo_download_url: driveResult ? driveResult.downloadUrl : '',
      photo_storage: driveResult ? 'drive' : (fullPhoto ? 'firestore' : ''),
      has_photo: Boolean(driveResult || fullPhoto)
    };

    // Nếu đã lưu lên Drive -> truyền null để KHÔNG lưu byte ảnh nào vào Firebase!
    await DB.addAttendance(record, driveResult ? null : fullPhoto);

    playSuccessSound();
    const actionLabel = actionType === 'IN' ? `VÀO ${shiftModeLabel.toUpperCase()}` : `RA ${shiftModeLabel.toUpperCase()}`;
    showToast(`✅ Chấm công ${actionLabel} thành công!`, 'success', 4000);

    showPunchResult(record, fullPhoto);

    state.lastAttendance = record;
    state.nextAction = actionType === 'IN' ? 'OUT' : 'IN';
    if (actionType === 'OUT') state.selectedShiftMode = 'normal';
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
  const distEl = document.getElementById('res-distance');
  const gpsEl = document.getElementById('res-gps');
  const accEl = document.getElementById('res-acc');
  const mapLink = document.getElementById('res-map-link');
  const photoRow = document.getElementById('res-photo-row');
  const photoImg = document.getElementById('res-photo-img');

  const modeLabel = getShiftModeLabel(record.shift_mode);
  typeEl.textContent = record.type === 'IN' ? `✅ Vào ca (${modeLabel})` : `👋 Ra ca (${modeLabel})`;
  typeEl.className = record.type === 'IN' ? 'result-value text-success' : 'result-value text-danger';

  timeEl.textContent = record.datetime_str;
  distEl.innerHTML = renderZoneBadge(getRecordDistance(record));
  gpsEl.textContent = `${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}`;
  accEl.textContent = `± ${record.accuracy}m`;
  mapLink.href = record.mapUrl;

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
  const initialSrc = (meta && meta.photo_full_url) ? meta.photo_full_url : (fallbackSrc || '');
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

  // Nếu ảnh lưu trên Google Drive -> không cần đọc từ Firebase attendance_photos!
  if (meta && meta.photo_full_url) {
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
                ${renderManualBadge(item)}
                <span class="history-time">${escapeHtml(item.datetime_str)}</span>
              </div>
              <span class="history-gps">
                ${renderZoneBadge(distM)}
                ${item.is_manual ? '' : `<span>±${item.accuracy}m</span>`}
              </span>
              ${item.note ? `<div class="manual-note-text">💬 ${escapeHtml(item.note)}</div>` : ''}
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
  const reqTab = document.getElementById('admin-tab-requests');
  const staffTab = document.getElementById('admin-tab-staff');

  const btnHistory = document.getElementById('tab-btn-history');
  const btnReq = document.getElementById('tab-btn-requests');
  const btnStaff = document.getElementById('tab-btn-staff');

  historyTab.classList.add('hidden');
  reqTab.classList.add('hidden');
  staffTab.classList.add('hidden');

  btnHistory.classList.remove('active');
  btnReq.classList.remove('active');
  btnStaff.classList.remove('active');

  if (tab === 'history') {
    historyTab.classList.remove('hidden');
    btnHistory.classList.add('active');
    renderAdminHistoryTable();
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
// 11. BẢNG QUẢN LÝ: THỐNG KÊ, LỊCH SỬ 30 NGƯỜI, DUYỆT ĐƠN & NHÂN SỰ
// ==========================================
async function loadAdminData() {
  if (!state.user || state.user.role !== 'admin') return;
  try {
    const [users, records, requests] = await Promise.all([
      DB.getAllUsers(),
      DB.getAllAttendance(500),
      DB.getAllRequests(300).catch(err => {
        console.warn('Không tải được requests:', err.message);
        return [];
      })
    ]);

    users.sort((a, b) => {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return (a.created_at || 0) - (b.created_at || 0);
    });

    state.allUsersList = users;
    state.adminRecordsCache = records;
    state.adminRequestsCache = requests;

    const now = Date.now();
    const todayKey = getVnDateKey(now);
    const lockedCount = users.filter(u => u.is_locked === 1 || (u.lock_until && u.lock_until > now)).length;
    const todayPunches = records.filter(r => (r.date_key || getVnDateKey(r.timestamp)) === todayKey).length;
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
    document.getElementById('stat-today-punches').textContent = todayPunches;
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

    renderAdminHistoryTable();
    renderAdminRequestsList();
    renderAdminStaffTable(lastPunchByUser);
  } catch (err) {
    showToast('Lỗi tải dữ liệu quản trị: ' + err.message, 'error');
  }
}

document.getElementById('admin-radius-select').addEventListener('change', (e) => {
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
  const typeVal = document.getElementById('filter-type').value;
  const shiftModeVal = document.getElementById('filter-shift-mode').value;
  const todayKey = getVnDateKey();

  const filtered = state.adminRecordsCache.filter(r => {
    if (dateVal === 'today' && (r.date_key || getVnDateKey(r.timestamp)) !== todayKey) return false;
    if (userVal !== 'all' && r.user_id !== userVal) return false;
    if (typeVal !== 'all' && r.type !== typeVal) return false;
    if (shiftModeVal !== 'all' && (r.shift_mode || 'normal') !== shiftModeVal) return false;
    return true;
  });

  // Cập nhật chế độ Thư viện ảnh dạng lưới song song
  renderAdminPhotoGallery(filtered, galleryEl);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 24px; color: var(--text-dim);">Không có lượt chấm công nào phù hợp với bộ lọc.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const distM = getRecordDistance(r);
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
            ${r.user_role === 'admin' ? '<span class="badge badge-admin" style="font-size: 0.65rem; margin-left: 4px;">Admin</span>' : ''}
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
            </div>
            ${renderManualBadge(r)}
            ${r.note ? `<div class="manual-note-text">💬 ${escapeHtml(r.note)}</div>` : ''}
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
            <button type="button" class="btn-sm btn-lock" data-del-att-id="${escapeHtml(r.id)}" data-del-att-label="${escapeHtml(r.user_name + ' - ' + r.typeText + ' lúc ' + r.datetime_str)}" title="Xóa hẳn dòng chấm công này">
              🗑️
            </button>
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

function renderAdminPhotoGallery(filtered, galleryEl) {
  if (!galleryEl) return;
  const withPhotos = (filtered || []).filter(r => Boolean(r.photo_thumb));
  if (withPhotos.length === 0) {
    galleryEl.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="empty-icon">✨</div>
        <p>Hiện không còn ảnh chấm công nào trong bộ lọc này.<br><small style="color: var(--text-dim);">Các ảnh đã xóa được ẩn khỏi Lưới ảnh. Bấm <b>"📋 Dạng bảng"</b> để xem hoặc xóa các dòng giờ Vào/Ra.</small></p>
      </div>
    `;
    return;
  }

  galleryEl.innerHTML = withPhotos.map(r => {
    const distM = getRecordDistance(r);
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
          <div class="gallery-name">${escapeHtml(r.user_name)}</div>
          <div class="gallery-time">🕒 ${escapeHtml(r.datetime_str)}</div>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">${renderZoneBadge(distM)} ${renderShiftModeBadge(r.shift_mode)}</div>
          <div class="gallery-footer">
            <a href="${escapeHtml(r.mapUrl)}" target="_blank" class="btn-map" style="padding: 4px 8px; font-size: 0.72rem;">📍 Bản đồ</a>
            <div style="display: flex; gap: 4px;">
              <button type="button" class="btn-sm btn-unlock" data-quick-dl="${escapeHtml(r.id)}" data-dl-name="${escapeHtml(r.user_name + '_' + r.date_key + '_' + r.type)}">
                ⬇️ Tải
              </button>
              <button type="button" class="btn-sm btn-lock" data-quick-del-photo="${escapeHtml(r.id)}" title="Chỉ xóa ảnh này (giữ giờ công)">
                🗑️
              </button>
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
    btn.textContent = '🖼️ Lưới ảnh';
  }
});

// --- Dọn ảnh / Dọn hẳn dòng dữ liệu chấm công ---
function openCleanupModal() {
  document.getElementById('modal-cleanup-photos').classList.add('show');
}

document.getElementById('form-cleanup-photos').addEventListener('submit', async (e) => {
  e.preventDefault();
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

function openAdminPunchModal(preselectPhone = null) {
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

  // Tự gợi ý Vào ca hay Ra ca dựa theo lần chấm gần nhất của nhân viên đó
  const selectedPhone = userSel.value;
  const lastRec = state.adminRecordsCache.find(r => r.user_id === selectedPhone);
  document.getElementById('manual-type-select').value = (lastRec && lastRec.type === 'IN') ? 'OUT' : 'IN';
  document.getElementById('manual-shift-mode').value = (lastRec && lastRec.type === 'IN' && lastRec.shift_mode) ? lastRec.shift_mode : 'normal';
  document.getElementById('manual-date').value = getVnDateKey();
  document.getElementById('manual-time').value = getCurrentVnTimeHHMM();
  document.getElementById('manual-note').value = 'Admin chấm bù (nhân viên quên chấm)';

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
  csv += 'STT,Họ và Tên,Số Điện Thoại,Hành Động,Chế Độ Ca,Nguồn Chấm,Thời Gian,Khoảng Cách Công Ty (m),Trạng Thái Vị Trí,Ghi Chú,Vĩ Độ,Kinh Độ,Sai Số (m),Link Google Maps,Link Ảnh Google Drive\n';
  rows.forEach((r, idx) => {
    const typeStr = r.type === 'IN' ? 'Vào ca' : 'Ra ca';
    const modeStr = getShiftModeLabel(r.shift_mode);
    const sourceStr = r.is_manual ? `Admin chấm bù (${r.created_by_admin || 'Admin'})` : 'Nhân viên tự chấm';
    const distM = getRecordDistance(r);
    const zoneStr = distM <= state.officeRadius ? 'Tại công ty' : 'Ngoài phạm vi';
    const mapUrl = `https://www.google.com/maps?q=${r.latitude},${r.longitude}`;
    const esc = v => `"${String(v || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const photoCol = r.photo_drive_view_url ? r.photo_drive_view_url : (r.has_photo ? 'Lưu trên Firebase' : 'Không');
    csv += `${idx + 1},${esc(r.user_name)},${r.user_phone},${typeStr},${modeStr},${esc(sourceStr)},${esc(r.datetime_str)},${distM},${esc(zoneStr)},${esc(r.note)},${r.latitude},${r.longitude},${r.accuracy},"${mapUrl}",${esc(photoCol)}\n`;
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
  if (state.allUsersList.length >= MAX_USERS) {
    return showToast(`Đã đạt giới hạn tối đa ${MAX_USERS} nhân sự!`, 'error');
  }
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

// ==========================================
// 12. KHỞI TẠO ỨNG DỤNG (AUTO-LOGIN 30 NGÀY)
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

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'attendance.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ==========================================
// 1. KHỞI TẠO CƠ SỞ DỮ LIỆU SQLITE
// ==========================================
const db = new DatabaseSync(DB_FILE);

// Tạo bảng
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    pin_hash TEXT NOT NULL,
    pin_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'employee',
    is_locked INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    lock_until INTEGER DEFAULT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('IN', 'OUT')),
    timestamp INTEGER NOT NULL,
    datetime_str TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy REAL NOT NULL,
    note TEXT DEFAULT '',
    photo_url TEXT DEFAULT '',
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id, timestamp);
`);

// Tự động nâng cấp bảng nếu thiếu cột photo_url
try {
  db.exec("ALTER TABLE attendance ADD COLUMN photo_url TEXT DEFAULT '';");
} catch (e) {
  // Cột đã tồn tại
}

// ==========================================
// 2. MÃ HÓA PIN & TIỆN ÍCH BẢO MẬT
// ==========================================
function createSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPin(pin, salt) {
  // Dùng Scrypt chuẩn mật mã với salt ngẫu nhiên
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}

function verifyPin(pin, salt, expectedHash) {
  const computedHash = hashPin(pin, salt);
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getVnTimeStr(timestamp = Date.now()) {
  const d = new Date(timestamp);
  // Định dạng Giờ:Phút:Giây Ngày/Tháng/Năm theo múi giờ Việt Nam
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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
  return parts; // YYYY-MM-DD
}

// ==========================================
// 3. KHỞI TẠO DỮ LIỆU MẪU (NẾU CHƯA CÓ)
// ==========================================
function seedDefaultUsers() {
  const countStmt = db.prepare('SELECT COUNT(*) AS count FROM users');
  const { count } = countStmt.get();
  if (count === 0) {
    console.log('📌 Chưa có dữ liệu, đang khởi tạo tài khoản Quản lý và nhân viên mẫu...');
    const insertStmt = db.prepare(`
      INSERT INTO users (name, phone, pin_hash, pin_salt, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // 1. Quản lý
    const adminSalt = createSalt();
    insertStmt.run(
      'Quản trị viên (Admin)',
      '0901234567',
      hashPin('123456', adminSalt),
      adminSalt,
      'admin',
      Date.now()
    );

    // 2. Nhân viên mẫu (đủ danh sách để trải nghiệm ngay)
    const samples = [
      { name: 'Nguyễn Văn An', phone: '0911000001', pin: '1111' },
      { name: 'Trần Thị Bình', phone: '0911000002', pin: '2222' },
      { name: 'Lê Hoàng Cường', phone: '0911000003', pin: '3333' },
      { name: 'Phạm Thu Dung', phone: '0911000004', pin: '4444' },
      { name: 'Võ Minh Em', phone: '0911000005', pin: '5555' }
    ];

    for (const s of samples) {
      const salt = createSalt();
      insertStmt.run(
        s.name,
        s.phone,
        hashPin(s.pin, salt),
        salt,
        'employee',
        Date.now()
      );
    }

    console.log('✅ Đã tạo tài khoản Admin (SĐT: 0901234567 | PIN: 123456) và 5 nhân viên mẫu.');
  }
}
seedDefaultUsers();

// ==========================================
// 4. TIỆN ÍCH HTTP SERVER & AUTH
// ==========================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8'
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) { // 2MB limit
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { success: false, error: message });
}

function getAuthUser(req) {
  const auth = req.headers['authorization'];
  let token = null;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.slice(7).trim();
  } else if (req.headers.cookie) {
    const match = req.headers.cookie.match(/chamcong_token=([^;]+)/);
    if (match) token = match[1];
  }

  if (!token) return null;

  const now = Date.now();
  const session = db.prepare(`
    SELECT s.user_id, s.expires_at, u.id, u.name, u.phone, u.role, u.is_locked
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, now);

  if (!session) return null;
  if (session.is_locked === 1) return null; // Tài khoản bị khóa

  return {
    id: session.id,
    name: session.name,
    phone: session.phone,
    role: session.role,
    token
  };
}

function serveStatic(req, res, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname;
  // Chuẩn hóa chống path traversal
  const resolved = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback về index.html cho SPA
      const indexFile = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexFile, (err2, content) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': contentType };

    // Không lưu cache HTML, CSS, JS để trình duyệt luôn nhận giao diện mới nhất
    if (ext === '.html' || ext === '.js' || ext === '.css' || ext === '.json') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma'] = 'no-cache';
      headers['Expires'] = '0';
    } else {
      headers['Cache-Control'] = 'public, max-age=86400';
    }

    res.writeHead(200, headers);
    fs.createReadStream(resolved).pipe(res);
  });
}

// ==========================================
// 5. BỘ XỬ LÝ CÁC API ENDPOINTS
// ==========================================
const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  try {
    // ------------------------------------------
    // API: ĐĂNG NHẬP (PHONE + PIN 4-6 SỐ, KHÓA 5 PHÚT NẾU SAI 5 LẦN)
    // ------------------------------------------
    if (pathname === '/api/login' && method === 'POST') {
      const { phone, pin } = await parseBody(req);
      const cleanPhone = (phone || '').trim();
      const cleanPin = (pin || '').trim();

      if (!cleanPhone || !cleanPin) {
        return sendError(res, 400, 'Vui lòng nhập đầy đủ Số điện thoại và Mã PIN.');
      }

      if (!/^\d{4,6}$/.test(cleanPin)) {
        return sendError(res, 400, 'Mã PIN phải từ 4 đến 6 chữ số.');
      }

      const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);
      if (!user) {
        return sendError(res, 401, 'Số điện thoại hoặc mã PIN không đúng.');
      }

      const now = Date.now();

      // Kiểm tra tài khoản bị Admin khóa vĩnh viễn/tạm thời
      if (user.is_locked === 1) {
        return sendError(res, 403, 'Tài khoản của bạn đã bị Quản lý khóa. Vui lòng liên hệ Quản lý.');
      }

      // Kiểm tra khóa 5 phút do nhập sai 5 lần
      if (user.lock_until && user.lock_until > now) {
        const remainingSec = Math.ceil((user.lock_until - now) / 1000);
        const mins = Math.floor(remainingSec / 60);
        const secs = remainingSec % 60;
        const timeStr = mins > 0 ? `${mins} phút ${secs} giây` : `${secs} giây`;
        return sendError(
          res,
          423,
          `Tài khoản tạm bị khóa do nhập sai PIN 5 lần. Thử lại sau ${timeStr} hoặc nhờ Quản lý mở khóa.`
        );
      }

      // Nếu đã hết hạn khóa 5 phút, tự động reset trạng thái thử
      if (user.lock_until && user.lock_until <= now) {
        db.prepare('UPDATE users SET failed_attempts = 0, lock_until = NULL WHERE id = ?').run(user.id);
        user.failed_attempts = 0;
        user.lock_until = null;
      }

      // Xác thực PIN bằng mã hóa Scrypt
      const isMatch = verifyPin(cleanPin, user.pin_salt, user.pin_hash);

      if (!isMatch) {
        const newAttempts = (user.failed_attempts || 0) + 1;
        if (newAttempts >= 5) {
          const lockUntil = now + 5 * 60 * 1000; // Khóa 5 phút
          db.prepare('UPDATE users SET failed_attempts = ?, lock_until = ? WHERE id = ?').run(
            newAttempts,
            lockUntil,
            user.id
          );
          return sendError(
            res,
            423,
            'Mã PIN không đúng! Bạn đã nhập sai 5 lần. Tài khoản bị tạm khóa 5 phút.'
          );
        } else {
          db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(newAttempts, user.id);
          const remaining = 5 - newAttempts;
          return sendError(
            res,
            401,
            `Mã PIN không đúng! (Còn ${remaining} lần thử trước khi bị khóa 5 phút).`
          );
        }
      }

      // PIN ĐÚNG -> Reset số lần nhập sai
      db.prepare('UPDATE users SET failed_attempts = 0, lock_until = NULL WHERE id = ?').run(user.id);

      // Tạo Session nhớ 30 ngày (30 * 24 * 60 * 60 * 1000 ms)
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = now + 30 * 24 * 60 * 60 * 1000;

      db.prepare(`
        INSERT INTO sessions (token, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(token, user.id, expiresAt, now);

      return sendJson(res, 200, {
        success: true,
        message: 'Đăng nhập thành công',
        token,
        expiresAt,
        user: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          role: user.role
        }
      });
    }

    // ------------------------------------------
    // API: ĐĂNG XUẤT
    // ------------------------------------------
    if (pathname === '/api/logout' && method === 'POST') {
      const user = getAuthUser(req);
      if (user && user.token) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
      }
      return sendJson(res, 200, { success: true, message: 'Đã đăng xuất' });
    }

    // ------------------------------------------
    // API: LẤY THÔNG TIN NGƯỜI DÙNG HIỆN TẠI & TRẠNG THÁI CA
    // ------------------------------------------
    if (pathname === '/api/me' && method === 'GET') {
      const user = getAuthUser(req);
      if (!user) {
        return sendError(res, 401, 'Phiên đăng nhập không tồn tại hoặc đã hết hạn.');
      }

      // Lấy lần chấm công gần nhất của nhân viên
      const lastAttendance = db.prepare(`
        SELECT id, type, timestamp, datetime_str, latitude, longitude, accuracy
        FROM attendance
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `).get(user.id);

      // Xác định nút bấm tiếp theo: nếu lần trước là IN thì giờ là OUT, ngược lại là IN
      const nextAction = (!lastAttendance || lastAttendance.type === 'OUT') ? 'IN' : 'OUT';

      return sendJson(res, 200, {
        success: true,
        user,
        lastAttendance: lastAttendance || null,
        nextAction
      });
    }

    // ------------------------------------------
    // API: CHẤM CÔNG (1 NÚT DUY NHẤT: VÀO CA <-> RA CA + GPS + SAI SỐ)
    // ------------------------------------------
    if (pathname === '/api/attendance' && method === 'POST') {
      const user = getAuthUser(req);
      if (!user) {
        return sendError(res, 401, 'Vui lòng đăng nhập để chấm công.');
      }

      const body = await parseBody(req);
      const { latitude, longitude, accuracy, note } = body;

      // Kiểm tra tọa độ GPS
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      const acc = parseFloat(accuracy);

      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return sendError(res, 400, 'Tọa độ GPS không hợp lệ. Vui lòng bật vị trí trên điện thoại/máy tính.');
      }

      const accValue = isNaN(acc) ? 0 : Math.round(acc * 10) / 10;

      // Lấy trạng thái gần nhất để tự động đảo Vào ca / Ra ca
      const last = db.prepare(`
        SELECT type FROM attendance
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `).get(user.id);

      let actionType = (!last || last.type === 'OUT') ? 'IN' : 'OUT';

      // Nếu client gửi rõ loại mong muốn (để tránh race condition), tôn trọng nếu hợp lệ
      if (body.type === 'IN' || body.type === 'OUT') {
        actionType = body.type;
      }

      const now = Date.now();
      const timeStr = getVnTimeStr(now);

      // Xử lý ảnh khuôn mặt selfie (nếu có)
      let photoUrl = '';
      if (body.photo && typeof body.photo === 'string' && body.photo.startsWith('data:image/')) {
        try {
          const matches = body.photo.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
          if (matches) {
            const ext = matches[1] === 'png' ? 'png' : 'jpg';
            const buffer = Buffer.from(matches[2], 'base64');
            const filename = `face_${now}_${user.id}.${ext}`;
            fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
            photoUrl = `/uploads/${filename}`;
          }
        } catch (photoErr) {
          console.error('Lỗi lưu ảnh khuôn mặt:', photoErr);
        }
      }

      const stmt = db.prepare(`
        INSERT INTO attendance (user_id, type, timestamp, datetime_str, latitude, longitude, accuracy, note, photo_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        user.id,
        actionType,
        now,
        timeStr,
        lat,
        lng,
        accValue,
        note || '',
        photoUrl
      );

      const mapUrl = `https://www.google.com/maps?q=${lat},${lng}`;

      return sendJson(res, 200, {
        success: true,
        message: actionType === 'IN' ? '✅ Chấm công VÀO CA thành công!' : '👋 Chấm công RA CA thành công!',
        record: {
          id: Number(result.lastInsertRowid),
          type: actionType,
          typeText: actionType === 'IN' ? 'Vào ca' : 'Ra ca',
          timestamp: now,
          datetime_str: timeStr,
          latitude: lat,
          longitude: lng,
          accuracy: accValue,
          mapUrl,
          photo_url: photoUrl
        },
        nextAction: actionType === 'IN' ? 'OUT' : 'IN'
      });
    }

    // ------------------------------------------
    // API: LỊCH SỬ CHẤM CÔNG CÁ NHÂN (30 LẦN GẦN NHẤT)
    // ------------------------------------------
    if (pathname === '/api/attendance/my-history' && method === 'GET') {
      const user = getAuthUser(req);
      if (!user) {
        return sendError(res, 401, 'Vui lòng đăng nhập.');
      }

      const rows = db.prepare(`
        SELECT id, type, timestamp, datetime_str, latitude, longitude, accuracy, note, photo_url
        FROM attendance
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT 30
      `).all(user.id);

      const data = rows.map(r => ({
        ...r,
        typeText: r.type === 'IN' ? 'Vào ca' : 'Ra ca',
        mapUrl: `https://www.google.com/maps?q=${r.latitude},${r.longitude}`
      }));

      return sendJson(res, 200, { success: true, history: data });
    }

    // ------------------------------------------
    // CÁC API DÀNH RIÊNG CHO QUẢN LÝ (ROLE = 'ADMIN')
    // ------------------------------------------

    // Middleware kiểm tra quyền Quản trị
    const checkAdmin = () => {
      const user = getAuthUser(req);
      if (!user) {
        sendError(res, 401, 'Vui lòng đăng nhập tài khoản Quản lý.');
        return null;
      }
      if (user.role !== 'admin') {
        sendError(res, 403, 'Bạn không có quyền Quản lý để thực hiện thao tác này.');
        return null;
      }
      return user;
    };

    // 1. Thống kê nhanh trang Quản lý
    if (pathname === '/api/admin/stats' && method === 'GET') {
      if (!checkAdmin()) return;

      const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'employee'").get().count;
      const allUsersCount = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
      const lockedUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE is_locked = 1 OR (lock_until > ?)").get(Date.now()).count;

      // Lượt chấm công hôm nay
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayPunches = db.prepare('SELECT COUNT(*) as count FROM attendance WHERE timestamp >= ?').get(todayStart.getTime()).count;

      // Đang trong ca (lần chấm cuối là IN)
      const usersInShift = db.prepare(`
        SELECT COUNT(*) as count FROM (
          SELECT a1.user_id, a1.type
          FROM attendance a1
          INNER JOIN (
            SELECT user_id, MAX(timestamp) as max_time
            FROM attendance
            GROUP BY user_id
          ) a2 ON a1.user_id = a2.user_id AND a1.timestamp = a2.max_time
          WHERE a1.type = 'IN'
        )
      `).get().count;

      return sendJson(res, 200, {
        success: true,
        stats: {
          totalUsers,
          allUsersCount,
          lockedUsers,
          todayPunches,
          usersInShift
        }
      });
    }

    // 2. Lịch sử chấm công của cả 15 người (kèm bộ lọc & link bản đồ)
    if (pathname === '/api/admin/attendance' && method === 'GET') {
      if (!checkAdmin()) return;

      const filterDate = parsedUrl.searchParams.get('date'); // YYYY-MM-DD hoặc 'today' hoặc 'all'
      const filterUserId = parsedUrl.searchParams.get('userId');
      const filterType = parsedUrl.searchParams.get('type'); // 'IN', 'OUT', 'all'

      let sql = `
        SELECT a.id, a.user_id, a.type, a.timestamp, a.datetime_str, a.latitude, a.longitude, a.accuracy, a.note, a.photo_url,
               u.name as user_name, u.phone as user_phone, u.role as user_role
        FROM attendance a
        JOIN users u ON u.id = a.user_id
        WHERE 1=1
      `;
      const params = [];

      if (filterUserId && filterUserId !== 'all') {
        sql += ' AND a.user_id = ?';
        params.push(filterUserId);
      }

      if (filterType && (filterType === 'IN' || filterType === 'OUT')) {
        sql += ' AND a.type = ?';
        params.push(filterType);
      }

      if (filterDate && filterDate !== 'all') {
        let dateKey = filterDate;
        if (filterDate === 'today') {
          dateKey = getVnDateKey();
        }
        // datetime_str định dạng VN: hh:mm:ss dd/mm/yyyy -> tìm kiếm hoặc so sánh timestamp
        // Tính khoảng timestamp của ngày dateKey (theo giờ VN)
        const [y, m, d] = dateKey.split('-').map(Number);
        if (y && m && d) {
          // Bắt đầu ngày ở UTC+7
          const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) - (7 * 3600 * 1000);
          const endMs = startMs + 24 * 3600 * 1000;
          sql += ' AND a.timestamp >= ? AND a.timestamp < ?';
          params.push(startMs, endMs);
        }
      }

      sql += ' ORDER BY a.timestamp DESC LIMIT 300';

      const rows = db.prepare(sql).all(...params);

      const results = rows.map(r => ({
        ...r,
        typeText: r.type === 'IN' ? 'Vào ca' : 'Ra ca',
        mapUrl: `https://www.google.com/maps?q=${r.latitude},${r.longitude}`
      }));

      return sendJson(res, 200, { success: true, records: results });
    }

    // 3. Xuất file CSV báo cáo cho Excel (có UTF-8 BOM)
    if (pathname === '/api/admin/export-csv' && method === 'GET') {
      if (!checkAdmin()) return;

      const rows = db.prepare(`
        SELECT a.id, a.type, a.timestamp, a.datetime_str, a.latitude, a.longitude, a.accuracy, a.photo_url,
               u.name as user_name, u.phone as user_phone
        FROM attendance a
        JOIN users u ON u.id = a.user_id
        ORDER BY a.timestamp DESC
      `).all();

      let csv = '\uFEFF'; // UTF-8 BOM để Excel hiển thị đúng tiếng Việt
      csv += 'STT,Họ và Tên,Số Điện Thoại,Hành Động,Thời Gian,Vĩ Độ,Kinh Độ,Sai Số (m),Link Google Maps,Link Ảnh Mặt\n';

      rows.forEach((r, idx) => {
        const typeStr = r.type === 'IN' ? 'Vào ca' : 'Ra ca';
        const mapUrl = `https://www.google.com/maps?q=${r.latitude},${r.longitude}`;
        const nameEscaped = `"${(r.user_name || '').replace(/"/g, '""')}"`;
        const timeEscaped = `"${r.datetime_str}"`;
        const photoLink = r.photo_url ? `"${r.photo_url}"` : '""';
        csv += `${idx + 1},${nameEscaped},${r.user_phone},${typeStr},${timeEscaped},${r.latitude},${r.longitude},${r.accuracy},"${mapUrl}",${photoLink}\n`;
      });

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="lich-su-cham-cong-${getVnDateKey()}.csv"`
      });
      res.end(csv);
      return;
    }

    // 4. Danh sách tất cả nhân viên (kèm trạng thái hoạt động / khóa / ca làm việc)
    if (pathname === '/api/admin/users' && method === 'GET') {
      if (!checkAdmin()) return;

      const users = db.prepare(`
        SELECT u.id, u.name, u.phone, u.role, u.is_locked, u.failed_attempts, u.lock_until, u.created_at,
          (
            SELECT a.type FROM attendance a
            WHERE a.user_id = u.id
            ORDER BY a.timestamp DESC
            LIMIT 1
          ) as last_punch_type,
          (
            SELECT a.datetime_str FROM attendance a
            WHERE a.user_id = u.id
            ORDER BY a.timestamp DESC
            LIMIT 1
          ) as last_punch_time
        FROM users u
        ORDER BY u.role DESC, u.id ASC
      `).all();

      const now = Date.now();
      const mapped = users.map(u => {
        const isTempLocked = u.lock_until && u.lock_until > now;
        let lockReason = 'Bình thường';
        if (u.is_locked === 1) lockReason = 'Bị Quản lý khóa';
        else if (isTempLocked) {
          const sec = Math.ceil((u.lock_until - now) / 1000);
          lockReason = `Tạm khóa sai PIN (${sec}s)`;
        }

        return {
          id: u.id,
          name: u.name,
          phone: u.phone,
          role: u.role,
          is_locked: u.is_locked,
          is_temp_locked: isTempLocked ? 1 : 0,
          lock_reason: lockReason,
          failed_attempts: u.failed_attempts,
          last_punch_type: u.last_punch_type,
          last_punch_time: u.last_punch_time,
          is_in_shift: u.last_punch_type === 'IN'
        };
      });

      return sendJson(res, 200, { success: true, users: mapped });
    }

    // 5. Thêm nhân viên mới
    if (pathname === '/api/admin/users' && method === 'POST') {
      if (!checkAdmin()) return;

      const body = await parseBody(req);
      const name = (body.name || '').trim();
      const phone = (body.phone || '').trim();
      const pin = (body.pin || '').trim();
      const role = body.role === 'admin' ? 'admin' : 'employee';

      if (!name) return sendError(res, 400, 'Họ tên nhân viên không được để trống.');
      if (!phone || !/^\d{9,11}$/.test(phone)) return sendError(res, 400, 'Số điện thoại phải từ 9 đến 11 chữ số.');
      if (!pin || !/^\d{4,6}$/.test(pin)) return sendError(res, 400, 'Mã PIN phải từ 4 đến 6 chữ số.');

      // Kiểm tra trùng SĐT
      const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (existing) {
        return sendError(res, 400, `Số điện thoại ${phone} đã được đăng ký bởi nhân viên khác.`);
      }

      const salt = createSalt();
      const hash = hashPin(pin, salt);

      const result = db.prepare(`
        INSERT INTO users (name, phone, pin_hash, pin_salt, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, phone, hash, salt, role, Date.now());

      return sendJson(res, 201, {
        success: true,
        message: 'Thêm nhân viên thành công!',
        userId: Number(result.lastInsertRowid)
      });
    }

    // 6. Đổi PIN nhân viên (Quản lý cấp lại PIN)
    const matchChangePin = pathname.match(/^\/api\/admin\/users\/(\d+)\/change-pin$/);
    if (matchChangePin && method === 'POST') {
      if (!checkAdmin()) return;

      const targetUserId = parseInt(matchChangePin[1], 10);
      const body = await parseBody(req);
      const newPin = (body.pin || '').trim();

      if (!newPin || !/^\d{4,6}$/.test(newPin)) {
        return sendError(res, 400, 'Mã PIN mới phải từ 4 đến 6 chữ số.');
      }

      const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(targetUserId);
      if (!user) return sendError(res, 404, 'Không tìm thấy nhân viên.');

      const newSalt = createSalt();
      const newHash = hashPin(newPin, newSalt);

      // Cập nhật PIN, đồng thời mở khóa và reset số lần thử sai
      db.prepare(`
        UPDATE users
        SET pin_hash = ?, pin_salt = ?, failed_attempts = 0, lock_until = NULL
        WHERE id = ?
      `).run(newHash, newSalt, targetUserId);

      return sendJson(res, 200, {
        success: true,
        message: `Đã đổi PIN thành công cho nhân viên "${user.name}". Số lần sai và khóa tạm thời đã được gỡ bỏ.`
      });
    }

    // 7. Khóa / Mở khóa tài khoản nhân viên
    const matchToggleLock = pathname.match(/^\/api\/admin\/users\/(\d+)\/toggle-lock$/);
    if (matchToggleLock && method === 'POST') {
      const admin = checkAdmin();
      if (!admin) return;

      const targetUserId = parseInt(matchToggleLock[1], 10);
      if (admin.id === targetUserId) {
        return sendError(res, 400, 'Bạn không thể tự khóa tài khoản của chính mình.');
      }

      const user = db.prepare('SELECT id, name, is_locked, lock_until FROM users WHERE id = ?').get(targetUserId);
      if (!user) return sendError(res, 404, 'Không tìm thấy nhân viên.');

      const now = Date.now();
      const isCurrentlyLocked = user.is_locked === 1 || (user.lock_until && user.lock_until > now);
      const shouldLock = !isCurrentlyLocked;

      if (shouldLock) {
        // Khóa tài khoản và hủy các phiên đăng nhập đang hoạt động
        db.prepare('UPDATE users SET is_locked = 1 WHERE id = ?').run(targetUserId);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
      } else {
        // Mở khóa: gỡ bỏ cả khóa admin lẫn khóa tạm 5 phút
        db.prepare(`
          UPDATE users
          SET is_locked = 0, failed_attempts = 0, lock_until = NULL
          WHERE id = ?
        `).run(targetUserId);
      }

      return sendJson(res, 200, {
        success: true,
        message: shouldLock
          ? `Đã KHÓA tài khoản của nhân viên "${user.name}".`
          : `Đã MỞ KHÓA tài khoản cho nhân viên "${user.name}".`,
        is_locked: shouldLock ? 1 : 0
      });
    }

    // 8. Xóa nhân viên
    const matchDeleteUser = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
    if (matchDeleteUser && method === 'DELETE') {
      const admin = checkAdmin();
      if (!admin) return;

      const targetUserId = parseInt(matchDeleteUser[1], 10);
      if (admin.id === targetUserId) {
        return sendError(res, 400, 'Không thể xóa tài khoản Quản lý đang đăng nhập.');
      }

      const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(targetUserId);
      if (!user) return sendError(res, 404, 'Không tìm thấy nhân viên.');

      db.prepare('DELETE FROM attendance WHERE user_id = ?').run(targetUserId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetUserId);
      db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);

      return sendJson(res, 200, {
        success: true,
        message: `Đã xóa nhân viên "${user.name}" và toàn bộ dữ liệu liên quan.`
      });
    }

    // ------------------------------------------
    // CÁC YÊU CẦU FILE TĨNH (HTML, CSS, JS, ICONS)
    // ------------------------------------------
    serveStatic(req, res, pathname);

  } catch (err) {
    console.error('Server error:', err);
    sendError(res, 500, 'Lỗi hệ thống: ' + (err.message || 'Unknown error'));
  }
});

// ==========================================
// 6. KHỞI CHẠY SERVER & IN THÔNG BÁO TIỆN LỢI
// ==========================================
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }

  console.log('===============================================================');
  console.log('  🏢 HỆ THỐNG CHẤM CÔNG 15 NGƯỜI GỌN NHẸ (GPS + PIN MÃ HÓA)');
  console.log('===============================================================');
  console.log(`  🖥️  Truy cập trên máy tính này:`);
  console.log(`      👉 http://localhost:${PORT}`);
  if (ips.length > 0) {
    console.log(`  📱 Truy cập từ điện thoại qua cùng mạng Wi-Fi:`);
    ips.forEach(ip => {
      console.log(`      👉 http://${ip}:${PORT}`);
    });
  }
  console.log('---------------------------------------------------------------');
  console.log('  🔑 TÀI KHOẢN QUẢN LÝ MẶC ĐỊNH:');
  console.log('      👤 SĐT: 0901234567   |   Mã PIN: 123456');
  console.log('  👥 TÀI KHOẢN NHÂN VIÊN MẪU:');
  console.log('      👤 0911000001 (PIN 1111) | 0911000002 (PIN 2222)...');
  console.log('===============================================================');
});

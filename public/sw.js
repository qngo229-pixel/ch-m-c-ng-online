const CACHE_NAME = 'chamcong-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Xóa toàn bộ cache cũ ngay lập tức
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Bỏ qua các API request và ảnh uploads để luôn lấy trực tiếp từ server
  if (e.request.url.includes('/api/') || e.request.url.includes('/uploads/')) {
    return;
  }

  // Chiến thuật: Ưu tiên mạng (Network first) để luôn nhận giao diện mới nhất
  e.respondWith(
    fetch(e.request)
      .then((networkRes) => {
        return networkRes;
      })
      .catch(() => {
        // Chỉ dùng cache khi mất mạng hoàn toàn
        return caches.match(e.request);
      })
  );
});

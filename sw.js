// アプリの画面ファイルだけをキャッシュする（GitHub API の応答やトークンはキャッシュしない。前回の記事データは app/cache.js が IndexedDB に保存する）。
// app/ を note-growth-app に反映するたびに、CACHE の番号と domain.js の APP_VERSION を上げる。
const CACHE = "ngt-app-v42";
const SHELL = ["./", "index.html", "app.js", "ui.js", "state.js", "load.js", "articles.js", "approval-diff.js", "posting.js", "share.js", "performance.js", "data.js", "top10.js", "settings.js", "domain.js", "cache.js", "github.js", "auth.js", "cover.js", "style.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API（GitHub・Netlify Functions）は素通りさせ、キャッシュしない
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // 新しい版を優先し、オフラインのときだけキャッシュを使う
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});

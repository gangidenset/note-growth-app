// 「GitHub でログイン」（GitHub アプリのユーザー認証）。
// ログインは本物の github.com の画面で行い、このアプリの画面ではトークンやパスワードを入力しない。
// 受け取ったアクセストークン（8時間で期限切れ）と更新用トークンは、この端末のブラウザ内にだけ保存する。

const AUTH_KEY = "ngt-auth";
const STATE_KEY = "ngt-oauth-state";

function read(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // 保存できない環境（プライベートモードなど）では、ログインがその場限りになる
  }
}

function loadAuth() {
  try {
    return JSON.parse(read(localStorage, AUTH_KEY) ?? "null");
  } catch {
    return null;
  }
}

function saveAuth(token, now = Date.now()) {
  const auth = {
    access_token: token.access_token,
    expires_at: token.expires_in ? now + token.expires_in * 1000 : null,
    refresh_token: token.refresh_token ?? null,
    refresh_expires_at: token.refresh_token_expires_in ? now + token.refresh_token_expires_in * 1000 : null,
  };
  write(localStorage, AUTH_KEY, JSON.stringify(auth));
  return auth;
}

function redirectUri() {
  return `${location.origin}/`;
}

async function exchange(body) {
  const res = await fetch("/api/github-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`ログインに失敗しました（${data.error ?? res.status}）。もう一度「GitHub でログイン」を押してください`);
  }
  return data;
}

export function isLoggedIn() {
  return loadAuth() !== null;
}

/** github.com のログイン画面へ移動する */
export async function startLogin() {
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (!cfg.client_id) throw new Error("ログインの設定がまだです（Netlify に GITHUB_CLIENT_ID が未設定）");
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  write(sessionStorage, STATE_KEY, state);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", cfg.client_id);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  location.assign(url.toString());
}

/**
 * github.com から戻ってきたとき（?code=…&state=…）にログインを完了する。
 * 戻ってきたのでなければ false。state が一致しなければ（なりすましの可能性）エラー。
 */
export async function completeLogin() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return false;
  const expected = read(sessionStorage, STATE_KEY);
  write(sessionStorage, STATE_KEY, null);
  history.replaceState(null, "", location.pathname); // code を URL に残さない
  if (!expected || params.get("state") !== expected) {
    throw new Error("ログインの確認に失敗しました（画面を開き直して、もう一度ログインしてください）");
  }
  saveAuth(await exchange({ code }));
  return true;
}

/** API を呼ぶ直前に使う。期限が近ければ自動で更新し、更新できなければ null（再ログインが必要） */
export async function getAccessToken() {
  const auth = loadAuth();
  if (!auth) return null;
  const now = Date.now();
  if (!auth.expires_at || now < auth.expires_at - 60_000) return auth.access_token;
  if (auth.refresh_token && (!auth.refresh_expires_at || now < auth.refresh_expires_at)) {
    try {
      return saveAuth(await exchange({ refresh_token: auth.refresh_token })).access_token;
    } catch {
      // 更新に失敗したら、再ログインしてもらう
    }
  }
  logout();
  return null;
}

export function logout() {
  write(localStorage, AUTH_KEY, null);
}

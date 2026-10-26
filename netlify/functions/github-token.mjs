// Netlify Function: GitHub アプリのログインで受け取った code（または refresh_token）を、アクセストークンに交換する。
// クライアントシークレットはブラウザに置けないため、ここ（サーバー側）で使う。値は Netlify の環境変数にだけ置く。

const TOKEN_URL = "https://github.com/login/oauth/access_token";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 別のサイトからの呼び出しは断る（同じサイトの画面からだけ受け付ける）
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return json({ error: "forbidden_origin" }, 403);

  const body = await req.json().catch(() => null);
  let grant;
  if (typeof body?.code === "string" && body.code !== "") grant = { code: body.code };
  else if (typeof body?.refresh_token === "string" && body.refresh_token !== "") {
    grant = { grant_type: "refresh_token", refresh_token: body.refresh_token };
  } else return json({ error: "bad_request" }, 400);

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return json({ error: "server_not_configured" }, 500);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...grant }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    return json({ error: data.error ?? "token_exchange_failed", description: data.error_description ?? "" }, 400);
  }
  // 必要な項目だけを返す
  return json({
    access_token: data.access_token,
    expires_in: data.expires_in ?? null,
    refresh_token: data.refresh_token ?? null,
    refresh_token_expires_in: data.refresh_token_expires_in ?? null,
  });
}

export const config = { path: "/api/github-token" };

// Netlify Function: 画面がログインを始めるのに必要な公開情報（クライアントID）だけを返す。シークレットは返さない。

export default async function handler() {
  const clientId = process.env.GITHUB_CLIENT_ID ?? "";
  return new Response(JSON.stringify({ client_id: clientId }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const config = { path: "/api/config" };

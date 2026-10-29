// アプリ（PWA）用のドメイン処理。ブラウザでそのまま動く ES モジュール（ビルド不要）。
// src/domain/hash.ts・scripts/note-export.ts・src/app/articles.ts と同じ結果になるように作り、
// tests/app-domain.test.ts で一致を確認している。

export const PAYWALL_PLACEHOLDER = "＝＝＝＝＝ ここに note の有料ラインを入れる（この行は消す） ＝＝＝＝＝";
const PAYWALL_PATTERN = /<!--\s*paywall\s*-->/g;
const ARTICLE_URL = /^https:\/\/note\.com\/([A-Za-z0-9_]+)\/n\/(n[0-9a-f]{12})\/?(?:\?.*)?$/;
const AGENT_NAMES = ["market-researcher", "marketing-strategist", "editor-writer", "quality-analyst", "orchestrator"];

/** 利用者に見せるエラー（messages は日本語） */
export class AppError extends Error {
  constructor(messages) {
    super(messages.join("\n"));
    this.messages = messages;
  }
}

export function normalizeText(text) {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** src/domain/hash.ts の contentHash と同じ SHA-256（16進64文字）。images は [{ name, git_sha }] */
export async function contentHash({ title, price_jpy, free, paid, images = /** @type {{ name: string, git_sha: string }[]} */ ([]) }) {
  const base = { title: normalizeText(title), price_jpy, free: normalizeText(free), paid: normalizeText(paid) };
  const sorted = [...images]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((i) => ({ name: i.name, git_sha: i.git_sha }));
  const canonical = JSON.stringify(sorted.length === 0 ? { v: 1, ...base } : { v: 2, ...base, images: sorted });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** src/domain/hash.ts の IMAGE_LINE と同じ（本文中の画像の行） */
export const IMAGE_LINE = /^!\[([^\]]*)\]\(assets\/([A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp|gif))\)\s*$/;

/**
 * 本文が参照している画像（コードブロックの中は除く）。出てきた順
 * @param {string} markdown
 * @returns {{ alt: string, name: string }[]}
 */
export function imageRefs(markdown) {
  const refs = [];
  let inCode = false;
  for (const line of normalizeText(markdown).split("\n")) {
    if (line.startsWith("```")) inCode = !inCode;
    const m = inCode ? null : IMAGE_LINE.exec(line.trim());
    if (m) refs.push({ alt: m[1], name: m[2] });
  }
  return refs;
}

/**
 * 本文が参照している画像を、assets/ の一覧（GitHub API の name と sha）と突き合わせる。
 * Git の blob SHA は PC 側の gitBlobSha と同じ値なので、画像をダウンロードせずにハッシュに使える
 * @param {string | null} free
 * @param {string | null} paid
 * @param {{ name: string, sha: string }[]} assetEntries
 * @returns {{ images: { name: string, git_sha: string }[], missing: string[] }}
 */
export function matchImages(free, paid, assetEntries) {
  const byName = new Map(assetEntries.map((e) => [e.name, e.sha]));
  const names = [...new Set([...imageRefs(free ?? ""), ...imageRefs(paid ?? "")].map((r) => r.name))];
  /** @type {{ name: string, git_sha: string }[]} */
  const images = [];
  /** @type {string[]} */
  const missing = [];
  for (const name of names) {
    const sha = byName.get(name);
    if (sha !== undefined) images.push({ name, git_sha: sha });
    else missing.push(name);
  }
  return { images, missing };
}

/** scripts/note-export.ts の imagePlaceholder と同じ */
export function imagePlaceholder(alt, name) {
  return `＝＝ ここに画像「${name}」を入れる（${alt}）（この行は消す） ＝＝`;
}

/** src/domain/length.ts の LENGTH_GUIDE・articleLength と同じ（記事の分量の目安と数え方） */
export const LENGTH_GUIDE = { free: { min: 2000, max: 3500 }, paid: { min: 4000, max: 8000 }, code: { max: 2500 } };
const SOURCES_HEADING = /^#{2,4}\s*(根拠|出典|参考)/;

/**
 * @param {string} markdown
 * @returns {{ text: number, code: number }}
 */
export function articleLength(markdown) {
  const lines = normalizeText(markdown).split("\n");
  if (lines[0]?.startsWith("# ")) lines.shift();
  let text = 0;
  let code = 0;
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (!inCode && SOURCES_HEADING.test(line)) break;
    if (!inCode && IMAGE_LINE.test(line.trim())) continue;
    const n = line.replace(/\s/g, "").length;
    if (inCode) code += n;
    else text += n;
  }
  return { text, code };
}

/**
 * 見出し画像（サムネイル）用の、画像生成 AI に貼るプロンプトを組み立てる。
 * 見た目の型（style）と、文字・人物・相棒・小物・色を入れると、いつも同じ注意書き
 * （ロゴを入れない・実在の人や作品に似せない）を付けた文章になる
 */
export const THUMB_STYLES = {
  pop: {
    label: "にぎやかサムネ（文字入り・ポップ）",
    look: "にぎやかで明るいアニメ調サムネイル。情報量は多いが、文字が読みやすいようにすっきり配置",
    character: "ちびキャラ風の人物。元気な笑顔で、記事の内容に合ったポーズ",
    setting: "明るい部屋。机の上にノートパソコン（ロゴなし）",
    colors: "オレンジ・ティール（青緑）・クリーム色",
  },
  night: {
    label: "しっとりイラスト（夜の窓辺）",
    look: "アニメ調、柔らかい光、細かい描き込み、温かみのある色",
    character: "後ろ姿か横顔の人物（顔ははっきり見せない）",
    setting: "夜、窓辺の木の机。暖かいデスクランプの光、窓の外は夕暮れから夜の空と街の灯り",
    colors: "深い青と、ランプのオレンジ",
  },
  flat: {
    label: "フラット・ポップ（人物なし）",
    look: "フラットでポップなイラスト、パステルカラー、やわらかい影",
    character: "",
    setting: "明るい机の上",
    colors: "パステルのミント・ピンク・クリーム",
  },
};

/**
 * @param {{ style?: keyof typeof THUMB_STYLES, mainText?: string, subText?: string, noteText?: string,
 *   character?: string, buddy?: string, items?: string, setting?: string, colors?: string, textSide?: "left" | "right" | "center" }} opts
 * @returns {string}
 */
export function buildThumbnailPrompt(opts = {}) {
  const s = THUMB_STYLES[opts.style ?? "pop"] ?? THUMB_STYLES.pop;
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const main = clean(opts.mainText);
  const sub = clean(opts.subText);
  const small = clean(opts.noteText);
  const character = clean(opts.character) || s.character;
  const buddy = clean(opts.buddy);
  const items = clean(opts.items);
  const setting = clean(opts.setting) || s.setting;
  const colors = clean(opts.colors) || s.colors;
  const side = { left: "左", right: "右", center: "中央" }[opts.textSide ?? "left"] ?? "左";
  const lines = [`横長16:9（1280×670 に近い比率）の画像を作ってください。${s.look}。`];
  if (character) lines.push(`【人物】${character}。`);
  if (buddy) lines.push(`【相棒】${buddy}。`);
  lines.push(`【背景と小物】${setting}。${items ? `${items}。` : ""}`);
  if (main || sub || small) {
    const parts = [];
    if (main) parts.push(`${side}側に一番大きく太い丸ゴシックで「${main}」（白い太いふち取り）`);
    if (sub) parts.push(`その近くに少し小さく「${sub}」`);
    if (small) parts.push(`隅に小さめの手書き風で「${small}」`);
    lines.push(`【文字】${parts.join("。")}。文字は正確にこの通りに。それ以外の文字・ロゴ・実在のブランド名は入れない。`);
  } else {
    lines.push(`【文字】画像の中に文字は入れない。あとでタイトルを重ねるので、${side}側の約45%は何も置かない余白にする。ロゴ・実在のブランド名も入れない。`);
  }
  lines.push(`【色】${colors}が中心。`);
  lines.push("実在の人物、特定の作家・作品・既存の記事の絵柄や構図に似せないでください。");
  return lines.join("\n");
}

export function countPaywalls(paid) {
  return paid.match(PAYWALL_PATTERN)?.length ?? 0;
}

/** 端末のタイムゾーンでオフセット付き ISO 8601（例: 2026-10-26T21:00:00+09:00） */
export function toZonedIso(date) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + offsetMin * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function isNoteArticleUrl(url) {
  return ARTICLE_URL.test(url.trim());
}

function canonicalArticleUrl(url) {
  const m = ARTICLE_URL.exec(url.trim());
  return `https://note.com/${m[1]}/n/${m[2]}`;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** scripts/note-export.ts の toNoteText と同じ変換（note 貼り付け用） */
export function toNoteText(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  if (lines[0]?.startsWith("# ")) {
    title = lines.shift().slice(2).trim();
    while (lines[0]?.trim() === "") lines.shift();
  }
  const out = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) inCode = !inCode;
    if (!inCode && /^\s*<!--\s*paywall\s*-->\s*$/.test(line)) {
      out.push(PAYWALL_PLACEHOLDER);
      continue;
    }
    const image = inCode ? null : IMAGE_LINE.exec(line.trim());
    if (image) {
      out.push(imagePlaceholder(image[1], image[2]));
      continue;
    }
    const sep = lines[i + 1];
    if (!inCode && line.trim().startsWith("|") && sep !== undefined && /^\s*\|?\s*:?-{3,}/.test(sep)) {
      const header = splitRow(line);
      i++;
      while (lines[i + 1]?.trim().startsWith("|")) {
        const cells = splitRow(lines[++i]);
        const [first, ...rest] = cells;
        const detail = rest.map((c, k) => `${header[k + 1] ?? ""}: ${c}`).join(" ／ ");
        out.push(`・${first}${detail ? `（${detail}）` : ""}`);
      }
      continue;
    }
    out.push(line);
  }
  return { title, body: out.join("\n") };
}

function json(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function appendAudit(auditText, entry) {
  const base = auditText && !auditText.endsWith("\n") ? `${auditText}\n` : (auditText ?? "");
  return `${base}${JSON.stringify(entry)}\n`;
}

function withTransition(meta, to, at, reason, changes = {}) {
  return {
    ...meta,
    ...changes,
    status: to,
    updated_at: at,
    history: [...meta.history, { from: meta.status, to, at, by: "owner", reason }],
  };
}

/**
 * 承認（オーナー専用）で書き込むファイルを作る。src/app/articles.ts の approveArticle と同じ内容。
 * 実際の書き込みは GitHub への1回のコミットで行う（3ファイルまとめて）。
 */
export async function buildApprovalChange({ meta, free, paid, images = /** @type {{ name: string, git_sha: string }[]} */ ([]), missingImages = /** @type {string[]} */ ([]), auditText, approver, now }) {
  const errors = [];
  if (meta.status !== "awaiting_approval") errors.push(`承認できるのは awaiting_approval の記事だけです（現在: ${meta.status}）`);
  if (free === null || paid === null) errors.push("free.md と paid.md がそろっていません");
  for (const n of missingImages) errors.push(`本文が参照している画像 assets/${n} がありません`);
  const name = (approver ?? "").trim() || "owner";
  if (AGENT_NAMES.includes(name)) errors.push("AI社員の名前は承認者にできません");
  if (errors.length > 0) throw new AppError(errors);

  const at = toZonedIso(now);
  const hash = await contentHash({ title: meta.title, price_jpy: meta.price_jpy, free, paid, images });
  const approval = { article_id: meta.id, approver: name, approved_at: at, content_sha256: hash, note: "" };
  const newMeta = withTransition(meta, "approved", at, "");
  const audit = appendAudit(auditText, {
    at,
    actor: "owner",
    action: "approved",
    article_id: meta.id,
    from: meta.status,
    to: "approved",
    content_sha256: hash,
    via: "app",
  });
  return {
    hash,
    files: [
      { path: `data/approvals/${meta.id}.json`, content: json(approval) },
      { path: `data/articles/${meta.id}/meta.json`, content: json(newMeta) },
      { path: "data/audit.log.jsonl", content: audit },
    ],
  };
}

/** 公開記録（オーナー専用）で書き込むファイルを作る。src/app/articles.ts の recordPublication と同じ条件 */
export async function buildPublicationChange({ meta, free, paid, images = /** @type {{ name: string, git_sha: string }[]} */ ([]), missingImages = /** @type {string[]} */ ([]), approval, auditText, url, now }) {
  const errors = [];
  if (meta.status !== "approved") errors.push(`公開記録できるのは approved の記事だけです（現在: ${meta.status}）`);
  const hash =
    free === null || paid === null || missingImages.length > 0
      ? null
      : await contentHash({ title: meta.title, price_jpy: meta.price_jpy, free, paid, images });
  if (!approval || hash === null || approval.content_sha256 !== hash) {
    errors.push("承認記録がない、または承認後に本文が変更されています（再承認が必要）");
  }
  let ok = false;
  try {
    const u = new URL(url.trim());
    ok = u.protocol === "https:" && (u.hostname === "note.com" || u.hostname.endsWith(".note.com"));
  } catch {
    ok = false;
  }
  if (!ok) errors.push("公開URLは https://note.com/ の記事URLである必要があります");
  if (errors.length > 0) throw new AppError(errors);

  const at = toZonedIso(now);
  const clean = url.trim();
  const newMeta = withTransition(meta, "published", at, "", { published_url: clean });
  const audit = appendAudit(auditText, {
    at,
    actor: "owner",
    action: "published",
    article_id: meta.id,
    from: meta.status,
    to: "published",
    url: clean,
    content_sha256: hash,
    via: "app",
  });
  return {
    files: [
      { path: `data/articles/${meta.id}/meta.json`, content: json(newMeta) },
      { path: "data/audit.log.jsonl", content: audit },
    ],
  };
}

/** note の「共有」で受け取った内容（title / text / url）から、記事URLを1つ取り出す（なければ null） */
export function extractNoteUrl({ title = "", text = "", url = "" } = {}) {
  for (const source of [url, text, title]) {
    for (const m of String(source).matchAll(/https:\/\/note\.com\/[A-Za-z0-9_]+\/n\/n[0-9a-f]{12}[^\s]*/g)) {
      if (isNoteArticleUrl(m[0])) return canonicalArticleUrl(m[0]);
    }
  }
  return null;
}

/**
 * 共有されたのが有料記事か無料記事かを、共有の文面に含まれるタイトルで判定する。
 * 判定できなければ null（アプリで利用者に選んでもらう）
 */
export function classifyShared(shared, { paidTitle, freeTitle }) {
  const hay = `${shared.title ?? ""} ${shared.text ?? ""}`;
  const paid = !!paidTitle && hay.includes(paidTitle);
  const free = !!freeTitle && hay.includes(freeTitle);
  if (paid && !free) return "paid";
  if (free && !paid) return "free";
  return null;
}

/** 無料記事の公開URLを記録する（承認済み・公開済みの記事のみ。承認ハッシュの対象外の項目） */
export function buildFreeUrlChange({ meta, url, auditText, now }) {
  const errors = [];
  if (meta.status !== "approved" && meta.status !== "published") {
    errors.push(`無料記事のURLを記録できるのは、承認済み・公開済みの記事だけです（現在: ${meta.status}）`);
  }
  if (!isNoteArticleUrl(url)) errors.push("note の記事URL（https://note.com/<ユーザー名>/n/<記事ID>）を入れてください");
  if (errors.length > 0) throw new AppError(errors);
  const clean = canonicalArticleUrl(url);
  const at = toZonedIso(now);
  const newMeta = { ...meta, free_url: clean, updated_at: at };
  const audit = appendAudit(auditText, { at, actor: "owner", action: "free_url_recorded", article_id: meta.id, url: clean, via: "app" });
  return {
    files: [
      { path: `data/articles/${meta.id}/meta.json`, content: json(newMeta) },
      { path: "data/audit.log.jsonl", content: audit },
    ],
  };
}

/**
 * 人気上位10件の調査依頼ファイルを作る（data/requests/）。
 * 記事ページの取得は、進行役か PC で `npm run research:top10 -- --file <このファイル>` を実行して行う。
 */
/** PC とスマホで共有する「上位10件」の入力途中の下書き（調査依頼ではない。research:top10 は読まない） */
export const TOP10_DRAFT_PATH = "data/requests/top10-draft.json";

/**
 * 下書きのファイルを作る。空の下書き（keyword・urls とも空）は「下書きなし」を表す
 * @param {{ keyword: string, urlsText: string, now: Date }} input
 */
export function buildTop10Draft({ keyword, urlsText, now }) {
  const kw = String(keyword ?? "").slice(0, 200);
  const urls = String(urlsText ?? "").slice(0, 5000);
  return { path: TOP10_DRAFT_PATH, content: json({ keyword: kw, urls, saved_at: toZonedIso(now) }) };
}

export function buildTop10Request({ keyword, urlsText, now }) {
  const kw = (keyword ?? "").trim();
  const urls = urlsText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const errors = [];
  if (kw === "") errors.push("キーワードを入力してください");
  if (/[\r\n]/.test(kw)) errors.push("キーワードは1行で入力してください");
  const bad = urls.filter((u) => !isNoteArticleUrl(u));
  if (bad.length > 0) errors.push(`note の記事URLではない行があります: ${bad.join(", ")}`);
  const unique = [...new Set(urls.filter(isNoteArticleUrl).map(canonicalArticleUrl))];
  if (bad.length === 0 && unique.length === 0) errors.push("URLを1件以上入力してください");
  if (unique.length > 10) errors.push(`URLは最大10件です（${unique.length}件あります）`);
  if (errors.length > 0) throw new AppError(errors);

  const at = toZonedIso(now);
  const stamp = at.slice(0, 16).replace(/[-:T]/g, "");
  return {
    path: `data/requests/top10-${stamp}.txt`,
    content: `# keyword: ${kw}\n# requested_at: ${at}\n# requested_by: owner (app)\n${unique.join("\n")}\n`,
  };
}

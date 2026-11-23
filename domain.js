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
export const LENGTH_GUIDE = { free: { min: 1500, max: 2500 }, paid: { min: 3000, max: 6000 }, code: { max: 2500 } };
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
/** 預かった共有内容を覚えておく時間（これより古いものは、何の共有か分からなくなるので捨てる） */
export const PENDING_SHARE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * note の「共有」で受け取った内容を、ログインや読み込みが終わるまで端末に預けるための文字列にする
 * @param {{ title?: string, text?: string, url?: string }} shared
 * @param {Date} now
 */
export function packPendingShare(shared, now) {
  return JSON.stringify({ title: shared.title ?? "", text: shared.text ?? "", url: shared.url ?? "", saved_at: now.getTime() });
}

/**
 * 預けた共有内容を取り出す。壊れている・古すぎる・中身が空なら null
 * @param {string | null} stored
 * @param {Date} now
 * @returns {{ title: string, text: string, url: string } | null}
 */
export function unpackPendingShare(stored, now) {
  if (!stored) return null;
  let data;
  try {
    data = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || typeof data.saved_at !== "number") return null;
  const age = now.getTime() - data.saved_at;
  if (age < 0 || age > PENDING_SHARE_MAX_AGE_MS) return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const shared = { title: str(data.title), text: str(data.text), url: str(data.url) };
  return shared.title || shared.text || shared.url ? shared : null;
}

/** 記事一覧の分け方（A-25）。進行中＝公開・中止のどちらでもない記事 */
export const ARTICLE_GROUPS = { active: "進行中", published: "公開済み", archived: "中止", all: "すべて" };

/** 記事の状態から、一覧の分け方を決める */
export function articleGroup(status) {
  if (status === "published") return "published";
  if (status === "archived") return "archived";
  return "active";
}

/**
 * 一覧を分け方で絞り込み、分けごとの件数も返す
 * @template {{ meta: { status: string } }} T
 * @param {T[]} articles
 * @param {string} group
 * @returns {{ list: T[], counts: Record<string, number> }}
 */
export function filterArticles(articles, group) {
  const counts = { active: 0, published: 0, archived: 0, all: articles.length };
  for (const a of articles) counts[articleGroup(a.meta.status)]++;
  const list = group === "all" ? articles : articles.filter((a) => articleGroup(a.meta.status) === group);
  return { list, counts };
}

/** 最初に開く分け方: 進行中があればそれ、なければ公開済み */
export function defaultArticleGroup(articles) {
  return articles.some((a) => articleGroup(a.meta.status) === "active") ? "active" : "published";
}

/** 記事の形の表示（A-25） */
export function formatLabel(meta) {
  if (meta.format === "membership") return "メンバーシップ限定";
  if (meta.format === "free_only") return "無料だけ";
  return "無料＋有料";
}

/**
 * 一覧や確認画面に出す「価格」の表示。無料だけ・メンバーシップ限定の記事には価格がない（price_jpy が null）
 * @param {{ format?: string, price_jpy?: number | null }} meta
 */
export function priceLabel(meta) {
  if (meta.format === "membership") return "メンバーシップ限定";
  if (meta.format === "free_only") return "無料";
  return typeof meta.price_jpy === "number" ? `${meta.price_jpy}円` : "価格未定";
}

/**
 * 同時に動かす数を limit までに抑える（GitHub への通信を一度に出しすぎない）。
 * 返り値の関数に「Promise を返す関数」を渡すと、順番が来たら実行する
 * @param {number} limit
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(limit) {
  let active = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  const next = () => {
    active--;
    waiting.shift()?.();
  };
  return async (task) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
    active++;
    try {
      return await task();
    } finally {
      next();
    }
  };
}

/**
 * ファイルの一覧（パス → { sha, type }）から、フォルダ直下の中身を取り出す（名前順）
 * @param {Map<string, { sha: string, type: string }>} tree
 * @param {string} dir
 * @returns {{ name: string, type: "file" | "dir", sha: string }[]}
 */
export function listTreeDir(tree, dir) {
  const prefix = `${dir.replace(/\/+$/, "")}/`;
  /** @type {{ name: string, type: "file" | "dir", sha: string }[]} */
  const out = [];
  for (const [path, entry] of tree) {
    if (!path.startsWith(prefix)) continue;
    const name = path.slice(prefix.length);
    if (name === "" || name.includes("/")) continue;
    out.push({ name, type: entry.type === "tree" ? "dir" : "file", sha: entry.sha });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

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
  // URL が空なら「キーワードだけの依頼」。Claude Code（進行役）が検索エンジンで note の記事を探す（note の人気順ではない）
  if (unique.length > 10) errors.push(`URLは最大10件です（${unique.length}件あります）`);
  if (errors.length > 0) throw new AppError(errors);

  const at = toZonedIso(now);
  const stamp = at.slice(0, 16).replace(/[-:T]/g, "");
  return {
    path: `data/requests/top10-${stamp}.txt`,
    content: `# keyword: ${kw}\n# requested_at: ${at}\n# requested_by: owner (app)\n${unique.length === 0 ? "# mode: web_search（URL なし。進行役が検索エンジンで記事を探す）\n" : unique.join("\n") + "\n"}`,
  };
}

// ---------- 上位10件の入力を楽に（A-24。note の「共有」から1件ずつ足す） ----------

export const TOP10_MAX = 10;

/** 入力欄の1行ずつ（空行と # で始まる行は除く。buildTop10Request と同じ数え方） */
function top10Rows(urlsText) {
  return String(urlsText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/**
 * 上位10件の入力欄を点検する。count は重なりを除いた note の記事URLの数、
 * bad は note の記事URLではない行、duplicates は前の行と同じ記事の行（2回目以降）
 * @param {string} urlsText
 */
export function checkTop10Urls(urlsText) {
  const seen = new Set();
  const bad = [];
  const duplicates = [];
  for (const line of top10Rows(urlsText)) {
    if (!isNoteArticleUrl(line)) {
      bad.push(line);
      continue;
    }
    const url = canonicalArticleUrl(line);
    if (seen.has(url)) duplicates.push(line);
    else seen.add(url);
  }
  return { count: seen.size, urls: [...seen], bad, duplicates };
}

/**
 * 共有された URL を上位10件の入力欄の末尾に足す。足せないとき（note の記事URLではない・もう入っている・10件ある）は text をそのまま返す
 * @param {string} urlsText
 * @param {string | null} url
 * @returns {{ result: "added" | "not_note" | "duplicate" | "full", text: string, count: number, url: string | null, position: number | null }}
 */
export function addTop10Url(urlsText, url) {
  const text = String(urlsText ?? "");
  const before = checkTop10Urls(text);
  if (!url || !isNoteArticleUrl(url)) return { result: "not_note", text, count: before.count, url: null, position: null };
  const clean = canonicalArticleUrl(url);
  const at = before.urls.indexOf(clean);
  if (at >= 0) return { result: "duplicate", text, count: before.count, url: clean, position: at + 1 };
  if (before.count >= TOP10_MAX) return { result: "full", text, count: before.count, url: clean, position: null };
  const trimmed = text.replace(/\s+$/, "");
  return { result: "added", text: `${trimmed === "" ? "" : `${trimmed}\n`}${clean}\n`, count: before.count + 1, url: clean, position: before.count + 1 };
}

/** note の記事URLの書き手（https://note.com/<書き手>/n/…）。記事URLでなければ null */
export function noteAuthor(url) {
  const m = ARTICLE_URL.exec(String(url ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * 共有された note の記事を、何に使うかを決める（A-24）。
 * - 自分の記事（記録済みの公開URLと同じ書き手）→ "publication"（公開の記録。今までどおり）
 * - 自分の書き手名が分かっていて、ほかの人の記事 → "top10"（上位10件に足す）
 * - 自分の書き手名がまだ分からない（公開URLの記録がない）→ 記録できる記事があれば "ask"（どちらか選んでもらう）、なければ "top10"
 * @param {{ url: string, metas: { published_url?: string | null, free_url?: string | null }[], hasCandidates: boolean }} input
 * @returns {"publication" | "top10" | "ask"}
 */
export function sharedPurpose({ url, metas, hasCandidates }) {
  const own = new Set(metas.flatMap((m) => [m.published_url, m.free_url]).map(noteAuthor).filter(Boolean));
  const author = noteAuthor(url);
  if (own.size > 0) return author !== null && own.has(author) ? "publication" : "top10";
  return hasCandidates ? "ask" : "top10";
}

// ---------- データタブのつながり（A-08。調査依頼 → 市場データ → ギャップ分析 → テーマ → 記事） ----------

/** 上位10件の調査依頼のファイル名（下書き・執筆依頼・修正依頼は含まない） */
export const TOP10_REQUEST_NAME = /^top10-(\d{12})\.txt$/;

/** 依頼ファイル（data/requests/top10-*.txt）の中身から、キーワード・日時・URL の数を読む */
export function parseTop10Request(name, text) {
  const line = (key) => new RegExp(`^# ${key}: (.*)$`, "m").exec(text ?? "")?.[1]?.trim() ?? null;
  const urls = String(text ?? "").split(/\r?\n/).filter((l) => /^https:\/\//.test(l.trim())).length;
  return { name, path: `data/requests/${name}`, keyword: line("keyword") ?? "", requested_at: line("requested_at"), urls, webSearch: /^# mode: web_search/m.test(text ?? "") };
}

/** キーワードの比べ方（大文字・小文字、全角・半角の空白の違いは同じとみなす） */
const sameKeyword = (k) => String(k ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const timeOf = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * 調査依頼ごとに、市場データ・ギャップ分析・テーマ・記事をつなぐ（新しい依頼が先）。
 * ギャップ分析は、要約に依頼ファイル名が書いてあればその依頼に、なければ「同じキーワードで、分析より前の、いちばん新しい依頼」に結びつける（推定）。
 * state: done（分析済み）／ replaced（同じキーワードの後の依頼で分析済み）／ pending（まだ分析していない）
 * @param {{ requests: { name: string, text: string | null }[], gaps: any[], themes: any[], metas: any[], marketIds: string[] }} input
 */
export function researchFlow({ requests, gaps, themes, metas, marketIds }) {
  const reqs = requests.filter((r) => TOP10_REQUEST_NAME.test(r.name)).map((r) => parseTop10Request(r.name, r.text));
  const market = new Set(marketIds);
  /** @type {Map<string, any[]>} 依頼ファイル名 → ギャップ分析 */
  const byRequest = new Map();
  const assign = (name, g) => byRequest.set(name, [...(byRequest.get(name) ?? []), g]);
  const valid = gaps.filter((g) => g && !g._broken && g.id);
  const rest = [];
  for (const g of valid) {
    const named = reqs.find((r) => String(g.summary ?? "").includes(r.name.replace(/\.txt$/, "")));
    if (named) assign(named.name, g);
    else rest.push(g);
  }
  for (const g of [...rest].sort((a, b) => timeOf(a.updated_at) - timeOf(b.updated_at))) {
    const t = timeOf(g.updated_at);
    const candidates = reqs
      .filter((r) => sameKeyword(r.keyword) === sameKeyword(g.keyword) && !(timeOf(r.requested_at) > t))
      .sort((a, b) => timeOf(b.requested_at) - timeOf(a.requested_at));
    const free = candidates.find((r) => !byRequest.has(r.name)) ?? candidates[0];
    if (free) assign(free.name, g);
  }
  const rows = reqs.map((r) => {
    const linked = byRequest.get(r.name) ?? [];
    const gapRows = linked.map((g) => {
      const gapThemes = themes.filter((t) => t && !t._broken && t.gap_analysis_id === g.id);
      return {
        id: g.id,
        keyword: g.keyword,
        recommended: g.recommended_gap_ids ?? [],
        marketCount: (g.top_record_ids ?? []).filter((id) => market.has(id)).length,
        themes: gapThemes.map((t) => ({
          id: t.id,
          title: t.title ?? t.id,
          status: t.status,
          articles: metas.filter((m) => m.theme_id === t.id).map((m) => ({ id: m.id, title: m.title, status: m.status })),
        })),
      };
    });
    return { ...r, gaps: gapRows, state: gapRows.length > 0 ? "done" : "pending", replacedBy: null };
  });
  // まだの依頼でも、同じキーワードの後の依頼が分析済みなら「後の依頼で分析済み」
  for (const r of rows) {
    if (r.state !== "pending") continue;
    const later = rows.find((x) => x !== r && x.state === "done" && sameKeyword(x.keyword) === sameKeyword(r.keyword) && timeOf(x.requested_at) > timeOf(r.requested_at));
    if (later) {
      r.state = "replaced";
      r.replacedBy = later.name;
    }
  }
  return rows.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

// ---------- 実績の記録（自分のアカウントの数字。src/domain/schemas.ts の PerformanceRecord と同じ形） ----------

export const PERFORMANCE_DIR = "data/performance";
const PART_LABEL = { paid: "有料記事", free: "無料記事", membership: "メンバーシップ限定" };

/**
 * 数字を記録できる note の投稿の一覧（公開URLが記録されているものだけ）。
 * 無料＋有料の記事は2つ（有料・無料）、無料だけ・メンバーシップ限定の記事は1つ
 * @param {{ id: string, title?: string, format?: string, price_jpy?: number | null, published_url?: string | null, free_url?: string | null }[]} metas
 */
export const AUTO_PERFORMANCE_DIR = "data/performance-auto";

/**
 * 自動の記録（data/performance-auto/、公開ページのスキ・フォロワー）の最新と前回の差。記録がなければ null。
 * 取れなかった値（null）は差を出さない
 * @param {{ id: string, recorded_at: string, account?: { followers?: number | null }, articles?: { article_id: string, part: string, likes: number | null, error?: string | null }[] }[]} records
 */
export function summarizeAutoPerformance(records) {
  const sorted = [...records].filter((r) => r && typeof r.id === "string").sort((a, b) => a.id.localeCompare(b.id));
  const latest = sorted.at(-1);
  if (!latest) return null;
  const previous = sorted.at(-2) ?? null;
  const num = (v) => (typeof v === "number" ? v : null);
  const diff = (a, b) => (a !== null && b !== null ? a - b : null);
  const likesOf = (rec, key) => num(rec?.articles?.find((e) => `${e.article_id}/${e.part}` === key)?.likes);
  /** @type {Record<string, { likes: number | null, d_likes: number | null, error: string | null }>} */
  const byKey = {};
  let total = 0;
  let totalBefore = 0;
  let comparable = previous !== null;
  for (const e of latest.articles ?? []) {
    const key = `${e.article_id}/${e.part}`;
    const likes = num(e.likes);
    const before = likesOf(previous, key);
    byKey[key] = { likes, d_likes: diff(likes, before), error: e.error ?? null };
    if (likes !== null) total += likes;
    if (likes === null || before === null) comparable = false;
    else totalBefore += before;
  }
  const followers = num(latest.account?.followers);
  return {
    latest_id: latest.id,
    recorded_at: latest.recorded_at,
    previous_id: previous?.id ?? null,
    followers,
    d_followers: diff(followers, num(previous?.account?.followers)),
    likes_total: total,
    d_likes_total: comparable ? total - totalBefore : null,
    errors: Object.values(byKey).filter((v) => v.error).length,
    byKey,
  };
}

export function performanceTargets(metas) {
  const out = [];
  const add = (m, part, url) => {
    if (!url) return;
    out.push({ key: `${m.id}/${part}`, article_id: m.id, part, part_label: PART_LABEL[part], url, title: m.title || m.id, price_jpy: part === "paid" ? m.price_jpy ?? null : null });
  };
  for (const m of metas) {
    if (m.format === "membership") add(m, "membership", m.published_url);
    else if (m.format === "free_only") add(m, "free", m.published_url);
    else {
      add(m, "paid", m.published_url);
      add(m, "free", m.free_url);
    }
  }
  return out;
}

/** 入力欄の文字を数に直す。空欄は null（記録しない）。全角数字と桁区切りのカンマは受け付ける */
function parseCount(text, label, errors) {
  const s = String(text ?? "").normalize("NFKC").replace(/[,\s]/g, "");
  if (s === "") return null;
  if (!/^\d{1,9}$/.test(s)) {
    errors.push(`${label}: 0 以上の整数で入力してください（入力: ${String(text).trim()}）`);
    return null;
  }
  return Number(s);
}

/**
 * 実績の記録で書き込むファイルを作る（1日1ファイル。同じ日に記録し直すと上書き）。
 * 数字は「今の時点での全期間の合計」をそのまま入れる。空欄は null として残し、0 や推定値で埋めない
 * @param {{ metas: object[], values: Record<string, { views?: string, likes?: string, sales_count?: string }>, account: { followers?: string, membership_members?: string }, notes?: string, now: Date }} input
 */
export function buildPerformanceChange({ metas, values, account, notes = "", now }) {
  const errors = [];
  const articles = [];
  for (const t of performanceTargets(metas)) {
    const v = values[t.key] ?? {};
    const name = `${t.title}（${t.part_label}）`;
    const entry = {
      article_id: t.article_id,
      part: t.part,
      url: t.url,
      views: parseCount(v.views, `${name}のビュー`, errors),
      likes: parseCount(v.likes, `${name}のスキ`, errors),
      sales_count: t.part === "paid" ? parseCount(v.sales_count, `${name}の販売件数`, errors) : null,
    };
    if (entry.views !== null || entry.likes !== null || entry.sales_count !== null) articles.push(entry);
  }
  const acc = {
    followers: parseCount(account?.followers, "フォロワー", errors),
    membership_members: parseCount(account?.membership_members, "メンバーシップの会員", errors),
  };
  if (errors.length === 0 && articles.length === 0 && acc.followers === null && acc.membership_members === null) {
    errors.push("数字が1つも入力されていません");
  }
  if (errors.length > 0) throw new AppError(errors);

  const at = toZonedIso(now);
  const record = {
    id: at.slice(0, 10),
    recorded_at: at,
    measurement: "self_reported",
    method: "owner_dashboard",
    collected_by: "owner",
    via: "app",
    basis: "cumulative",
    account: acc,
    articles,
    notes: String(notes ?? "").trim(),
  };
  return { record, files: [{ path: `${PERFORMANCE_DIR}/${record.id}.json`, content: json(record) }] };
}

const diff = (now, before) => (typeof now === "number" && typeof before === "number" ? now - before : null);

/**
 * 記録のまとめ（最新の数字と、その前の記録との差）。売上は「販売件数 × 今の価格」の計算値で、手数料を引く前の金額。
 * 入力しなかった数字（null）は合計に入れず、差も出さない（0 として扱わない）
 * @param {object[]} records data/performance/*.json（順番は問わない）
 * @param {object[]} metas 記事の meta.json
 */
export function summarizePerformance(records, metas) {
  const sorted = records.filter((r) => r && typeof r.id === "string" && Array.isArray(r.articles)).sort((a, b) => a.id.localeCompare(b.id));
  const latest = sorted.at(-1) ?? null;
  if (!latest) return null;
  const previous = sorted.at(-2) ?? null;
  const targets = new Map(performanceTargets(metas).map((t) => [t.key, t]));
  const metaById = new Map(metas.map((m) => [m.id, m]));
  const prevByKey = new Map((previous?.articles ?? []).map((e) => [`${e.article_id}/${e.part}`, e]));

  const rows = latest.articles.map((e) => {
    const key = `${e.article_id}/${e.part}`;
    const p = prevByKey.get(key);
    const price = e.part === "paid" ? metaById.get(e.article_id)?.price_jpy ?? null : null;
    return {
      key,
      article_id: e.article_id,
      part: e.part,
      part_label: PART_LABEL[e.part] ?? e.part,
      title: targets.get(key)?.title ?? metaById.get(e.article_id)?.title ?? e.article_id,
      url: e.url,
      views: e.views ?? null,
      likes: e.likes ?? null,
      sales_count: e.sales_count ?? null,
      d_views: diff(e.views, p?.views),
      d_likes: diff(e.likes, p?.likes),
      d_sales_count: diff(e.sales_count, p?.sales_count),
      price_jpy: price,
      revenue_calc_jpy: typeof e.sales_count === "number" && typeof price === "number" ? e.sales_count * price : null,
      d_revenue_calc_jpy: typeof price === "number" && diff(e.sales_count, p?.sales_count) !== null ? diff(e.sales_count, p?.sales_count) * price : null,
    };
  });
  /** 数字が入っている行だけを足す。1つもなければ null */
  const sum = (field) => {
    const nums = rows.map((r) => r[field]).filter((n) => typeof n === "number");
    return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
  };
  return {
    latest_id: latest.id,
    latest_at: latest.recorded_at,
    previous_id: previous?.id ?? null,
    count: sorted.length,
    account: {
      followers: latest.account?.followers ?? null,
      membership_members: latest.account?.membership_members ?? null,
      d_followers: diff(latest.account?.followers, previous?.account?.followers),
      d_membership_members: diff(latest.account?.membership_members, previous?.account?.membership_members),
    },
    totals: {
      views: sum("views"),
      likes: sum("likes"),
      sales_count: sum("sales_count"),
      revenue_calc_jpy: sum("revenue_calc_jpy"),
      d_views: sum("d_views"),
      d_likes: sum("d_likes"),
      d_sales_count: sum("d_sales_count"),
      d_revenue_calc_jpy: sum("d_revenue_calc_jpy"),
    },
    rows,
    notes: latest.notes ?? "",
  };
}

/**
 * 入力の打ち間違いに気づくための注意。ビューと販売件数は全期間の合計なので、前回より減ることは普通ない
 * @returns {string[]}
 */
export function performanceWarnings(record, previous) {
  if (!previous) return [];
  const prevByKey = new Map((previous.articles ?? []).map((e) => [`${e.article_id}/${e.part}`, e]));
  const out = [];
  for (const e of record.articles) {
    const p = prevByKey.get(`${e.article_id}/${e.part}`);
    if (!p) continue;
    const label = `${e.article_id}（${PART_LABEL[e.part] ?? e.part}）`;
    if (diff(e.views, p.views) < 0) out.push(`${label}のページビューが前回（${p.views}）より少ない: ${e.views}`);
    if (diff(e.sales_count, p.sales_count) < 0) out.push(`${label}の販売件数が前回（${p.sales_count}）より少ない: ${e.sales_count}`);
  }
  return out;
}

// ---------- note の下書きと投稿の予定（A-37。承認済み・まだ投稿していない記事のストック） ----------

/** 記事ごとの「下書きと投稿の予定」の置き場所。本文・承認とは別のファイルなので、変えても承認はやり直しにならない */
export const POSTING_PLAN_DIR = "data/posting-plans";

export function postingPlanPath(articleId) {
  return `${POSTING_PLAN_DIR}/${articleId}.json`;
}

/** 投稿の予定と下書きを出す記事: 承認済み（承認が有効）で、まだ公開の記録がないもの */
export function isStockArticle(a) {
  return a.meta.status === "approved" && a.approvalValid && !a.meta.published_url;
}

/**
 * datetime-local の値（"2026-11-25T07:00"）を、端末のタイムゾーン付きの日時にする。空なら null
 * @param {string} value
 */
export function localInputToZoned(value) {
  const v = (value ?? "").trim();
  if (v === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) throw new Error("投稿する日時の形が読めません");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(d.getTime())) throw new Error("投稿する日時の形が読めません");
  return toZonedIso(d);
}

/** タイムゾーン付きの日時を、datetime-local の入力欄に入れる値（端末の時刻）にする。null なら空 */
export function zonedToLocalInput(iso) {
  if (!iso) return "";
  return toZonedIso(new Date(iso)).slice(0, 16);
}

/**
 * 「下書きと投稿の予定」のファイルを作る。承認・状態は変えない（オーナーのメモ）
 * @param {{ meta: { id: string }, plan: any | null, scheduledAt?: string | null, drafted?: boolean, now: Date }} input
 *   scheduledAt: タイムゾーン付きの日時か null（予定を消す）。undefined なら今のまま。drafted も undefined なら今のまま
 */
export function buildPostingPlan({ meta, plan, scheduledAt, drafted, now }) {
  const prev = plan ?? { scheduled_at: null, note_draft_saved: false, note_draft_saved_at: null };
  const nowIso = toZonedIso(now);
  const nextDrafted = drafted === undefined ? !!prev.note_draft_saved : drafted;
  const record = {
    article_id: meta.id,
    scheduled_at: scheduledAt === undefined ? prev.scheduled_at ?? null : scheduledAt,
    note_draft_saved: nextDrafted,
    note_draft_saved_at: nextDrafted ? (prev.note_draft_saved && prev.note_draft_saved_at ? prev.note_draft_saved_at : nowIso) : null,
    updated_at: nowIso,
    updated_by: "owner",
  };
  return { path: postingPlanPath(meta.id), content: `${JSON.stringify(record, null, 2)}\n` };
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 予定の日時の表示（端末の時刻で「11/25(火) 07:00」） */
export function scheduleLabel(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 記事の「下書きと投稿の予定」の状態を短い文にする
 * @returns {{ drafted: boolean, draftText: string, scheduleText: string, overdue: boolean }}
 */
export function postingPlanStatus(plan, now) {
  const drafted = !!plan?.note_draft_saved;
  const at = plan?.scheduled_at ?? null;
  const overdue = !!at && Date.parse(at) < now.getTime();
  return {
    drafted,
    draftText: drafted ? "note の下書きに保存済み" : "note の下書きはまだ",
    scheduleText: at ? `投稿予定 ${scheduleLabel(at)}${overdue ? "（予定の時刻を過ぎました）" : ""}` : "投稿の予定はまだ",
    overdue,
  };
}

/**
 * ストック（承認済み・まだ投稿していない記事）を、投稿予定の早い順に並べる。予定のないものは後ろ（更新の新しい順のまま）
 * @template {{ meta: any, approvalValid: boolean, plan?: any }} T
 * @param {T[]} articles
 * @returns {T[]}
 */
export function stockArticles(articles) {
  const list = articles.filter(isStockArticle);
  const key = (a) => (a.plan?.scheduled_at ? Date.parse(a.plan.scheduled_at) : Infinity);
  return list.map((a, i) => ({ a, i })).sort((x, y) => key(x.a) - key(y.a) || x.i - y.i).map((x) => x.a);
}

// ---------- 次にやること（記事タブの一番上） ----------

/** 実績の記録の間隔の目安（日）。これより空いたら「記録しましょう」と出す */
export const PERFORMANCE_INTERVAL_DAYS = 7;

/**
 * オーナーが次にやることを、急ぐ順に並べる。
 * kind: approve（承認）/ post（note に投稿して記録）/ record_free（無料記事のURLを記録）/ stale（承認が無効。Claude Code に依頼）/
 * link（無料記事に有料記事のリンクを足す）/ membership（メンバーシップ限定記事を頼む）/ performance（実績を記録）
 * @param {{ articles: { meta: any, approvalValid: boolean, freeOnly: boolean, free?: string | null }[], performanceIds: string[], now: Date, membership?: ReturnType<typeof membershipStatus> | null }} input
 * @returns {{ kind: string, article_id: string | null, text: string, detail: string }[]}
 */
export function nextActions({ articles, performanceIds, now, membership = null }) {
  const out = [];
  const add = (kind, a, text, detail) => out.push({ kind, article_id: a?.meta.id ?? null, text, detail });
  const name = (a) => `「${a.meta.title || a.meta.id}」`;
  for (const a of articles) {
    if (a.meta.status === "awaiting_approval") add("approve", a, `${name(a)}を読んで承認する`, "承認待ち");
  }
  // 投稿の予定が早い順（A-37）。予定・下書きの状態も添える
  for (const a of stockArticles(articles)) {
    const p = postingPlanStatus(a.plan ?? null, now);
    add("post", a, `${name(a)}を note に投稿して、公開を記録する`, `承認済み・まだ公開の記録がない ・ ${p.scheduleText} ・ ${p.draftText}`);
  }
  for (const a of articles) {
    // 公開済みの記事を直して承認し直した（A-31）: note の記事を手で直して記録し直す
    if (a.meta.status === "approved" && a.approvalValid && a.meta.published_url) {
      add("republish", a, `${name(a)}の note の記事を直して、記録する`, "公開済みの記事の修正を承認した・note の記事はまだ前の内容");
    }
  }
  for (const a of articles) {
    if (a.meta.status === "published" && !a.freeOnly && !a.meta.free_url) {
      add("record_free", a, `${name(a)}の無料記事を投稿して、URLを記録する`, "有料記事は公開済み・無料記事の記録がない");
    }
  }
  for (const a of articles) {
    if ((a.meta.status === "approved" || a.meta.status === "published") && !a.approvalValid) {
      add("stale", a, `${name(a)}の承認が無効になっている`, "承認後に本文が変わった。Claude Code に「承認待ちに戻して」と依頼して、承認し直す");
    }
  }
  for (const l of paidLinkStatus(articles)) {
    if (l.state === "missing") {
      add("link", { meta: { id: l.id } }, `「${l.title}」の無料記事に、有料記事のリンクを note で足す`, "無料記事の読者が、有料記事へ1回で移れるようにする");
    }
  }
  // メンバーシップ: 今月の約束の本数に届いておらず、作っている途中の記事もないとき
  if (membership && membership.published < membership.goal && membership.in_progress.length === 0) {
    const next = membership.next ? `次の企画: 第${membership.next.no}回 ${membership.next.title}` : "企画の残りがありません。Claude Code に「メンバーシップの記事を企画して」と依頼";
    add("membership", null, `メンバーシップ限定記事を Claude Code に頼む（今月 ${membership.published}/${membership.goal}本）`, next);
  }
  if (performanceTargets(articles.map((a) => a.meta)).length > 0) {
    const last = [...performanceIds].sort().at(-1) ?? null;
    if (last === null) add("performance", null, "実績（note の数字）を記録する", "まだ1回も記録していない");
    else {
      // 日付どうしの差（時刻は見ない）。端末のタイムゾーンの「今日」と比べる
      const today = toZonedIso(now).slice(0, 10);
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
      if (days >= PERFORMANCE_INTERVAL_DAYS) add("performance", null, "実績（note の数字）を記録する", `前回の記録（${last}）から${days}日`);
    }
  }
  return out;
}

// ---------- 今月の売上と目標 ----------

/** 売上の目標（月あたり・円）。docs/business-plan.md の目標と同じ */
export const MONTHLY_GOAL_JPY = 50_000;

/**
 * 今月の売上の計算値（販売件数の増えた分 × 今の価格。手数料を引く前。メンバーシップの会費は含まない）。
 * 記録は「これまでの合計」なので、今月の分は「今月の最新の記録 − 今月より前の最後の記録」で出す。
 * 今月より前の記録がない記事は、今月公開したものなら 0 から数え、そうでなければ今月の最初の記録から数える（その場合 partial）。
 * @param {object[]} records data/performance/*.json
 * @param {object[]} metas 記事の meta.json
 * @param {Date} now
 * @returns {{ month: string, revenue_calc_jpy: number, sales_count: number, goal_jpy: number, remaining_jpy: number, latest_id: string, partial_since: string | null } | null} 今月の記録がなければ null
 */
export function monthlyProgress(records, metas, now, goal = MONTHLY_GOAL_JPY) {
  const month = toZonedIso(now).slice(0, 7);
  const sorted = records.filter((r) => r && typeof r.id === "string" && Array.isArray(r.articles)).sort((a, b) => a.id.localeCompare(b.id));
  const inMonth = sorted.filter((r) => r.id.startsWith(month));
  const latest = inMonth.at(-1);
  if (!latest) return null;
  const before = sorted.filter((r) => r.id < `${month}-01`);
  const metaById = new Map(metas.map((m) => [m.id, m]));
  /** その記事の販売件数が入っている最後（または最初）の記録 */
  const salesIn = (list, id, pick) => {
    const hits = list.map((r) => ({ id: r.id, e: r.articles.find((x) => x.article_id === id && x.part === "paid") })).filter((h) => typeof h.e?.sales_count === "number");
    return pick === "last" ? hits.at(-1) : hits[0];
  };

  let revenue = 0;
  let sales = 0;
  let partialSince = null;
  for (const e of latest.articles) {
    if (e.part !== "paid" || typeof e.sales_count !== "number") continue;
    const meta = metaById.get(e.article_id);
    if (typeof meta?.price_jpy !== "number") continue;
    let base;
    const prev = salesIn(before, e.article_id, "last");
    const publishedAt = (meta.history ?? []).find((h) => h.to === "published")?.at ?? "";
    if (prev) base = prev.e.sales_count;
    else if (publishedAt.startsWith(month)) base = 0;
    else {
      const first = salesIn(inMonth, e.article_id, "first");
      base = first.e.sales_count;
      if (partialSince === null || first.id < partialSince) partialSince = first.id;
    }
    const n = Math.max(0, e.sales_count - base);
    sales += n;
    revenue += n * meta.price_jpy;
  }
  return { month, revenue_calc_jpy: revenue, sales_count: sales, goal_jpy: goal, remaining_jpy: Math.max(0, goal - revenue), latest_id: latest.id, partial_since: partialSince };
}

// ---------- GitHub のエラーを日本語に（A-17） ----------

/** 通信そのものができなかったとき（電波がない・つながらない）のエラーか。ブラウザごとに文言が違う */
export function isNetworkError(e) {
  return e instanceof TypeError && /fetch|network|load failed|internet/i.test(String(e.message ?? ""));
}

export const NETWORK_MESSAGE = "GitHub につながりませんでした。電波の状態を確認して、右上の ↻ で読み込み直してください";

/**
 * GitHub API の失敗を、オーナーが次にすることの分かる日本語にする。
 * @param {{ status: number, path?: string, method?: string, rateRemaining?: string | null, rateReset?: string | null, now?: Date }} info
 * @returns {{ code: "unauthorized" | "rate_limited" | "forbidden" | "conflict" | "rejected" | "server" | "other", message: string }}
 */
export function describeGitHubError({ status, path = "", method = "GET", rateRemaining = null, rateReset = null, now = new Date() }) {
  if (status === 401) {
    return { code: "unauthorized", message: "ログインの期限が切れたか、ログインが取り消されました。「設定」の「GitHub でログイン」を押してください" };
  }
  if (status === 429 || (status === 403 && rateRemaining === "0")) {
    const resetMs = Number(rateReset) * 1000;
    const minutes = Number.isFinite(resetMs) && resetMs > 0 ? Math.max(1, Math.ceil((resetMs - now.getTime()) / 60_000)) : null;
    const wait = minutes === null ? "しばらく" : `${minutes}分ほど`;
    return { code: "rate_limited", message: `GitHub の利用回数の上限に達しました。${wait}待ってから、右上の ↻ で読み込み直してください` };
  }
  // ブランチの先頭を進める操作が断られた ＝ 読み込んだ後に、ほかから更新された（Claude Code のプッシュなど）
  if ((status === 422 || status === 409) && method === "PATCH" && path.startsWith("/git/refs/heads/")) {
    return { code: "conflict", message: "読み込んだ後に GitHub 側が更新されたため、保存できませんでした。右上の ↻ で読み込み直してから、もう一度やり直してください" };
  }
  if (status === 403) {
    return { code: "forbidden", message: "この操作の権限がありません。GitHub アプリが note-growth-team に入っていて、中身の読み書き（Contents）が許可されているか確認してください" };
  }
  if (status === 422) return { code: "rejected", message: "GitHub が内容を受け付けませんでした。Claude Code に「アプリで保存できない」と知らせてください" };
  if (status >= 500) return { code: "server", message: "GitHub 側で一時的な不具合が起きています。少し待ってから、右上の ↻ で読み込み直してください" };
  return { code: "other", message: `GitHub でエラーが起きました（番号 ${status}）。続くときは Claude Code に知らせてください` };
}

// ---------- 保存がほかの更新と重なったとき（A-07） ----------

/**
 * 2つの時点のファイル一覧（パス → { sha }）を比べ、watch に挙げた場所（ファイルか、末尾が / のフォルダ）の中で
 * 増えた・消えた・中身が変わったファイルを返す（パスの名前順）
 * @param {Map<string, { sha: string, type?: string }>} before
 * @param {Map<string, { sha: string, type?: string }>} after
 * @param {string[]} watch
 */
export function changedPaths(before, after, watch) {
  const hit = (p) => watch.some((w) => (w.endsWith("/") ? p.startsWith(w) : p === w));
  const out = new Set();
  for (const [p, e] of before) if (e.type !== "tree" && hit(p) && after.get(p)?.sha !== e.sha) out.add(p);
  for (const [p, e] of after) if (e.type !== "tree" && hit(p) && before.get(p)?.sha !== e.sha) out.add(p);
  return [...out].sort();
}

/** 承認・公開記録で見張る場所（この記事の本文・画像・状態と、承認記録）。ここが変わっていたら、自動でやり直さない */
export function articleWatchPaths(id) {
  return [`data/articles/${id}/`, `data/approvals/${id}.json`];
}

// ---------- 記事どうしのリンク（A-14。src/domain/links.ts と同じ） ----------

export const PAID_LINK_LINE = /^＝＝\s*有料記事のリンク\s*＝＝$/;
export const ARTICLE_LINK_LINE = /^＝＝\s*記事のリンク[:：]\s*([a-z0-9][a-z0-9-]{0,63})\s*＝＝$/;

/** 本文の中の印（コードブロックの中は除く）。出てきた順 */
export function linkRefs(markdown) {
  const refs = [];
  let inCode = false;
  for (const line of String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("```")) inCode = !inCode;
    if (inCode) continue;
    const t = line.trim();
    if (PAID_LINK_LINE.test(t)) refs.push({ kind: "paid" });
    const m = ARTICLE_LINK_LINE.exec(t);
    if (m) refs.push({ kind: "article", id: m[1] });
  }
  return refs;
}

export const linkPlaceholder = (what) => `＝＝ ここに${what}のURLを貼る（まだ公開の記録がありません）（この行は消す） ＝＝`;

/** 投稿用テキストの印を、記録済みの公開URLに置き換える。URL がまだなければ置き場所の行にして missing に入れる */
/** note の公開URLから、共有のときに付く ?app_launch=false などのクエリと # 以降を除く（src/domain/links.ts と同じ） */
export function cleanArticleUrl(url) {
  return url.replace(/[?#].*$/, "");
}

export function resolveLinks(body, meta, metas) {
  const byId = new Map(metas.map((m) => [m.id, m]));
  const missing = [];
  let inCode = false;
  const out = body.split("\n").map((line) => {
    if (line.startsWith("```")) inCode = !inCode;
    if (inCode) return line;
    const t = line.trim();
    if (PAID_LINK_LINE.test(t)) {
      if ((meta.format === "free_and_paid" || meta.format === undefined) && meta.published_url) return cleanArticleUrl(meta.published_url);
      missing.push("有料記事");
      return linkPlaceholder("有料記事");
    }
    const m = ARTICLE_LINK_LINE.exec(t);
    if (m) {
      const url = byId.get(m[1])?.published_url;
      if (url) return cleanArticleUrl(url);
      missing.push(m[1]);
      return linkPlaceholder(`記事 ${m[1]}`);
    }
    return line;
  });
  return { body: out.join("\n"), missing };
}

/**
 * 公開済みの「無料＋有料」の記事ごとに、無料記事から有料記事へのリンクがあるか。
 * marker: 本文に印がある（投稿のときに URL が入る）/ confirmed: オーナーが note 上で足したと記録した / missing: どちらもない
 * @param {{ meta: any, free: string | null }[]} articles
 */
export function paidLinkStatus(articles) {
  return articles
    .filter((a) => a.meta.status === "published" && (a.meta.format ?? "free_and_paid") === "free_and_paid")
    .map((a) => {
      const marker = linkRefs(a.free ?? "").some((r) => r.kind === "paid");
      const state = marker ? "marker" : a.meta.paid_link_confirmed_at ? "confirmed" : "missing";
      const outgoing = linkRefs(a.free ?? "").filter((r) => r.kind === "article").map((r) => r.id);
      return { id: a.meta.id, title: a.meta.title || a.meta.id, state, confirmed_at: a.meta.paid_link_confirmed_at ?? null, free_url: a.meta.free_url ?? null, paid_url: a.meta.published_url ?? null, outgoing };
    });
}

/** オーナーが note 上で、公開済みの無料記事に有料記事のリンクを足したことを記録する（本文は変えないので承認ハッシュの対象外） */
export function buildPaidLinkConfirmChange({ meta, auditText, now }) {
  const errors = [];
  if (meta.status !== "published") errors.push(`記録できるのは公開済みの記事だけです（現在: ${meta.status}）`);
  if ((meta.format ?? "free_and_paid") !== "free_and_paid") errors.push("無料記事と有料記事がある記事だけが対象です");
  if (!meta.published_url) errors.push("有料記事の公開URLが記録されていません");
  if (errors.length > 0) throw new AppError(errors);
  const at = toZonedIso(now);
  const newMeta = { ...meta, paid_link_confirmed_at: at, updated_at: at };
  const audit = appendAudit(auditText, { at, actor: "owner", action: "paid_link_confirmed", article_id: meta.id, url: meta.published_url, via: "app" });
  return {
    files: [
      { path: `data/articles/${meta.id}/meta.json`, content: json(newMeta) },
      { path: "data/audit.log.jsonl", content: audit },
    ],
  };
}

// ---------- メンバーシップの予定（A-13） ----------

/** メンバーシップ限定記事の、月あたりの本数の約束（data/profile/note-profile.md「月2回ほど」） */
export const MEMBERSHIP_PER_MONTH = 2;
export const MEMBERSHIP_PLAN_PATH = "data/profile/membership-plan.md";

/** 企画ファイルの「## 第N回（時期）題名」を読む */
export function parseMembershipPlan(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^##\s*第\s*(\d+)\s*回\s*(?:[（(]([^）)]*)[）)])?\s*(.*)$/.exec(line.trim());
    if (m) out.push({ no: Number(m[1]), when: m[2] ?? "", title: m[3].trim() });
  }
  return out.sort((a, b) => a.no - b.no);
}

/**
 * 今月のメンバーシップ限定記事の本数と、次に作る企画。
 * 企画と記事の対応は「作った順（中止を除く）の k 本目 ＝ 第 k 回」と仮定する（記事に企画の番号を持たせていないため）
 * @param {{ metas: any[], planText: string | null, now: Date }} input
 */
export function membershipStatus({ metas, planText, now }) {
  const month = toZonedIso(now).slice(0, 7);
  const members = metas.filter((m) => m.format === "membership" && m.status !== "archived").sort((a, b) => a.created_at.localeCompare(b.created_at));
  const publishedAt = (m) => (m.history ?? []).find((h) => h.to === "published")?.at ?? "";
  const thisMonth = members.filter((m) => m.status === "published" && publishedAt(m).startsWith(month));
  const inProgress = members.filter((m) => m.status !== "published");
  const plan = parseMembershipPlan(planText);
  const next = plan[members.length] ?? null;
  return { month, goal: MEMBERSHIP_PER_MONTH, published: thisMonth.length, published_titles: thisMonth.map((m) => m.title || m.id), in_progress: inProgress.map((m) => ({ id: m.id, title: m.title || m.id, status: m.status })), next, plan_count: plan.length };
}

// ---------- 品質チェックの結果（A-19。.claude/skills/fact-integrity-check/SKILL.md の項目） ----------

export const QA_LABELS = {
  F1: "数値・事実に出典がある",
  F2: "出典と記事の記述が一致",
  F3: "他者の売上を断定していない",
  F4: "架空の体験談・実績がない",
  F5: "【要オーナー記入】が残っていない",
  F6: "誇大表現・収益保証がない",
  F7: "引用が最小限・複製がない",
  F8: "有料ラインがちょうど1つ",
  F9: "タイトル・価格が一致",
  F10: "個人情報・秘密情報がない",
  F11: "誤字脱字・読みやすさ・分量",
};
const SEVERITY_LABEL = { critical: "重大", major: "中", minor: "軽微" };
const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2 };

/**
 * qa.json を、承認の判断に使える形にまとめる。指摘（fail）は重い順、未確認（not_checked）はその後
 * @returns {{ ok: boolean, verdict_label: string, checked_at: string, checked_by: string, pass_count: number, total: number, issues: { id: string, label: string, kind: "fail" | "not_checked", severity_label: string, note: string }[] } | null}
 */
export function summarizeQa(qa) {
  if (!qa || !Array.isArray(qa.results)) return null;
  const issues = qa.results
    .filter((r) => r.status !== "pass")
    .map((r) => ({
      id: r.id,
      label: QA_LABELS[r.id] ?? r.id,
      kind: r.status === "fail" ? "fail" : "not_checked",
      severity_label: r.status === "fail" ? SEVERITY_LABEL[r.severity] ?? "?" : "未確認",
      order: r.status === "fail" ? SEVERITY_ORDER[r.severity] ?? 3 : 4,
      note: String(r.note ?? ""),
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...rest }) => rest);
  const ok = qa.verdict === "ready_for_approval";
  return {
    ok,
    verdict_label: ok ? "承認に進めてよい" : "直しが必要",
    checked_at: String(qa.checked_at ?? ""),
    checked_by: String(qa.checked_by ?? ""),
    pass_count: qa.results.filter((r) => r.status === "pass").length,
    total: qa.results.length,
    issues,
  };
}

// ---------- テーマを選んで執筆依頼（A-15） ----------

export const WRITE_FORMATS = {
  free_only: "無料記事だけ",
  free_and_paid: "無料記事＋有料記事",
  membership: "メンバーシップ限定",
};

/**
 * テーマと記事の形を選んだ執筆依頼のファイルを作る（data/requests/write-<日時>.txt）。
 * Claude Code は「<このファイル> の依頼を実行して」と頼まれたら、npm run article:new から始める（CLAUDE.md）
 * @param {{ theme: { id: string, title?: string }, format: string, priceText?: string, memo?: string, now: Date }} input
 */
export function buildWriteRequest({ theme, format, priceText = "", memo = "", now }) {
  const errors = [];
  if (!theme?.id) errors.push("テーマを選んでください");
  if (!(format in WRITE_FORMATS)) errors.push("記事の形を選んでください");
  let price = null;
  const p = String(priceText ?? "").normalize("NFKC").replace(/[,円\s]/g, "");
  if (format === "free_and_paid" && p !== "") {
    if (!/^\d+$/.test(p) || Number(p) < 100 || Number(p) > 50000) errors.push("価格は 100〜50,000 の整数（円）で入れてください。空欄なら担当（marketing-strategist）が決めます");
    else price = Number(p);
  }
  if (errors.length > 0) throw new AppError(errors);
  const at = toZonedIso(now);
  const stamp = at.slice(0, 19).replace(/[-:T]/g, "");
  const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();
  const lines = [
    "# kind: write",
    `# theme_id: ${theme.id}`,
    `# theme_title: ${oneLine(theme.title)}`,
    `# format: ${format}`,
    `# price_jpy: ${format === "free_and_paid" ? price ?? "おまかせ" : "なし"}`,
    `# requested_at: ${at}`,
    "# requested_by: owner (app)",
  ];
  const note = String(memo ?? "").replace(/\r\n?/g, "\n").trim();
  return { path: `data/requests/write-${stamp}.txt`, content: `${lines.join("\n")}\n${note ? `${note}\n` : ""}` };
}

/** 執筆依頼のファイルを読む（ヘッダーとメモ）。形が違えば null */
export function parseWriteRequest(text) {
  const head = {};
  const body = [];
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^#\s*([a-z_]+):\s*(.*)$/.exec(line);
    if (m && body.length === 0) head[m[1]] = m[2].trim();
    else body.push(line);
  }
  if (head.kind !== "write" || !head.theme_id || !(head.format in WRITE_FORMATS)) return null;
  return { theme_id: head.theme_id, theme_title: head.theme_title ?? "", format: head.format, price_jpy: /^\d+$/.test(head.price_jpy ?? "") ? Number(head.price_jpy) : null, requested_at: head.requested_at ?? "", memo: body.join("\n").trim() };
}

// ---------- 修正依頼（A-20） ----------

/** 修正依頼のファイル名の頭（data/requests/fix-<記事ID>-<日時>.txt） */
export const FIX_REQUEST_PREFIX = "fix-";

/**
 * 記事の修正依頼のファイルを作る（data/requests/fix-<記事ID>-<日時>.txt）。承認はしない操作。
 * Claude Code は「<このファイル> の修正依頼を反映して」と頼まれたら、メモのとおりに直して品質チェックをやり直し、承認待ちに戻す（CLAUDE.md）
 * @param {{ meta: { id: string, title?: string, status?: string }, memo: string, now: Date }} input
 */
export function buildFixRequest({ meta, memo, now }) {
  const note = String(memo ?? "").replace(/\r\n?/g, "\n").trim();
  if (note === "") throw new AppError(["直してほしいところを書いてください"]);
  if (note.length > 5000) throw new AppError([`メモが長すぎます（${note.length}文字。5000文字まで）`]);
  const at = toZonedIso(now);
  const stamp = at.slice(0, 19).replace(/[-:T]/g, "");
  const oneLine = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();
  const lines = [
    "# kind: fix",
    `# article_id: ${meta.id}`,
    `# article_title: ${oneLine(meta.title)}`,
    `# status_at_request: ${meta.status ?? ""}`,
    `# requested_at: ${at}`,
    "# requested_by: owner (app)",
  ];
  return { path: `data/requests/${FIX_REQUEST_PREFIX}${meta.id}-${stamp}.txt`, content: `${lines.join("\n")}\n${note}\n` };
}

/** 修正依頼のファイルを読む（ヘッダーとメモ）。形が違えば null */
export function parseFixRequest(text) {
  const head = {};
  const body = [];
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^#\s*([a-z_]+):\s*(.*)$/.exec(line);
    if (m && body.length === 0) head[m[1]] = m[2].trim();
    else body.push(line);
  }
  if (head.kind !== "fix" || !head.article_id) return null;
  return { article_id: head.article_id, article_title: head.article_title ?? "", status_at_request: head.status_at_request ?? "", requested_at: head.requested_at ?? "", memo: body.join("\n").trim() };
}

/** ファイル一覧の名前から、その記事の修正依頼（新しい順）を選ぶ */
export function fixRequestNames(names, articleId) {
  const re = new RegExp(`^${FIX_REQUEST_PREFIX}${articleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{14}\\.txt$`);
  return names.filter((n) => re.test(n)).sort().reverse();
}

// ---------- X での公開のお知らせ（src/domain/xpost.ts と同じ計算） ----------

export const X_MAX_WEIGHTED = 280;
const X_URL_LENGTH = 23;
const X_URL_RE = /https?:\/\/\S+/g;
const isLightChar = (cp) => cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);

/** X の数え方での文字数（日本語は1文字2、URL は23） */
export function xWeightedLength(text) {
  let n = 0;
  const rest = text.replace(X_URL_RE, () => {
    n += X_URL_LENGTH;
    return "";
  });
  for (const ch of rest) n += isLightChar(ch.codePointAt(0)) ? 1 : 2;
  return n;
}

/** 投稿する文（本文・URL・ハッシュタグ） */
export function buildXPostText(text, url, hashtags) {
  const tags = hashtags.map((t) => `#${t}`).join(" ");
  return [text.trim(), "", url, ...(tags ? [tags] : [])].join("\n");
}

/**
 * 記事の公開のお知らせを、X の投稿画面に入れる文にする。
 * x-post.json がなければタイトルから簡単な文を作る。公開URLがまだなければ null
 * @param {{ meta: any, freeOnly: boolean, xPost: any, freeTitle: string | null }} a
 */
export function xAnnouncement({ meta, freeOnly, xPost, freeTitle }) {
  const link = xPost?.link ?? "free";
  const url = freeOnly
    ? meta.published_url
    : link === "paid"
      ? meta.published_url ?? meta.free_url
      : meta.free_url ?? meta.published_url;
  if (!url) return null;
  const text = xPost?.text ?? `note に記事を公開しました。\n「${freeTitle || meta.title}」`;
  return buildXPostText(text, url, xPost?.hashtags ?? []);
}

/** X の投稿画面（下書き入り）の URL。開いたあと、投稿するかどうかはオーナーが決める */
export function xIntentUrl(fullText) {
  return `https://x.com/intent/post?text=${encodeURIComponent(fullText)}`;
}

// ---------- X 以外の SNS での公開のお知らせ（投稿画面を下書き入りで開くだけ。投稿するのはオーナー自身） ----------

export const THREADS_MAX = 500;
export const BLUESKY_MAX = 300;

/** 見た目の文字数（絵文字や結合文字も1文字。Threads・Bluesky の数え方に近い） */
export function graphemeLength(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) return [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)].length;
  return [...text].length;
}

/** Threads の投稿画面（下書き入り）の URL */
export function threadsIntentUrl(fullText) {
  return `https://www.threads.net/intent/post?text=${encodeURIComponent(fullText)}`;
}

/** Bluesky の投稿画面（下書き入り）の URL */
export function blueskyIntentUrl(fullText) {
  return `https://bsky.app/intent/compose?text=${encodeURIComponent(fullText)}`;
}

/**
 * 文の長さが各 SNS の上限に収まるか。長すぎる SNS の名前を返す（空なら全部収まる）
 * @param {string} text
 */
export function snsTooLong(text) {
  const out = [];
  if (xWeightedLength(text) > X_MAX_WEIGHTED) out.push("X");
  if (graphemeLength(text) > THREADS_MAX) out.push("Threads");
  if (graphemeLength(text) > BLUESKY_MAX) out.push("Bluesky");
  return out;
}

// ---------- 前回の内容の保存（A-05） ----------

/** 保存の形が変わったら上げる（古い形の保存は使わずに読み直す） */
export const SNAPSHOT_FORMAT = 1;

/**
 * 読み込んだ内容を、端末に保存できる形にする（ファイル一覧の Map は配列に直す）
 * @param {{ sha: string, tree: Map<string, { sha: string, type: string }>, articles: any[], performance: any, membershipPlan: string | null }} snapshot
 * @param {Date} now
 */
export function packSnapshot(snapshot, now) {
  return {
    format: SNAPSHOT_FORMAT,
    saved_at: now.getTime(),
    sha: snapshot.sha,
    tree: [...snapshot.tree.entries()],
    articles: snapshot.articles,
    performance: snapshot.performance,
    membershipPlan: snapshot.membershipPlan,
  };
}

/** 保存した内容を元に戻す。形が違う・壊れているときは null（GitHub から読み直す） */
export function unpackSnapshot(stored) {
  if (!stored || typeof stored !== "object" || stored.format !== SNAPSHOT_FORMAT) return null;
  if (typeof stored.sha !== "string" || !Array.isArray(stored.tree) || !Array.isArray(stored.articles) || !stored.performance) return null;
  return {
    snapshot: { sha: stored.sha, tree: new Map(stored.tree), articles: stored.articles, performance: stored.performance, membershipPlan: stored.membershipPlan ?? null },
    saved_at: typeof stored.saved_at === "number" ? stored.saved_at : null,
  };
}

/** 保存した時刻の表示（「11/20 21:43」） */
export function savedAtLabel(ms) {
  if (typeof ms !== "number") return "前回";
  return toZonedIso(new Date(ms)).slice(5, 16).replace("-", "/").replace("T", " ");
}

// ---------- 画像の全部保存の順番 ----------

/**
 * 「全部保存」で1枚ずつ保存する間隔（ミリ秒）。前の画像の保存が終わってから次を保存し、
 * 保存した時刻が本文の順（1枚目がいちばん古い）になるように、間を長めにあける
 */
export const SAVE_ALL_INTERVAL_MS = 1500;

/**
 * 「全部保存」で保存する順番。オーナーの端末では保存した時刻の順に並ぶので、本文の順（1枚目から）に保存する
 * （2026-11-20 オーナー指示「1が終わったら2みたいな感じで」）
 * @template T
 * @param {T[]} files 本文に出てくる順の画像
 * @returns {T[]}
 */
export function saveAllOrder(files) {
  return [...files];
}

// ---------- アプリの版（A-26） ----------

/**
 * アプリの版。note-growth-app に反映するたびに日付（同じ日に2回目なら末尾に -2 など）を上げ、
 * APP_CHANGES にその版で変わったことを短く書く（sw.js の CACHE の番号も上げる）
 */
export const APP_VERSION = "2026-11-23-5";
export const APP_CHANGES = [
  "承認済みの記事に「下書きと投稿の予定」: 「note の下書きに保存した」の印と、投稿する日時を記録できる（自動で投稿はしない。承認はやり直しにならない）",
  "記事タブに「ストック」: 承認済み・まだ投稿していない記事を、投稿予定の早い順に並べる。「次にやること」も同じ順",
];

/**
 * 新しい版が入ったときのお知らせ。初めて開いたとき（前回の版の記録なし）と同じ版のときは null
 * @param {string | null} lastSeen 端末に記録した、前回開いた版
 */
export function updateNotice(lastSeen, version = APP_VERSION, changes = APP_CHANGES) {
  if (!lastSeen || lastSeen === version) return null;
  return `アプリを新しい版（${version}）に更新しました。${changes.length > 0 ? `\n${changes.map((c) => `・${c}`).join("\n")}` : ""}`;
}

// ---------- 前回の承認からの変更点（A-22。承認が無効になった記事で、どこが変わったかを出す） ----------

/** 1回の比較で扱う行の組み合わせの上限（これを超えたら、変わった範囲をまとめて出す） */
const DIFF_MAX_CELLS = 4_000_000;

/**
 * 2つの文を行ごとに比べ、変わったところ（前後 context 行つき）をまとめて返す。
 * 改行コード・先頭の BOM の違いは変更として数えない（内容ハッシュと同じ扱い）
 * @param {string | null} before
 * @param {string | null} after
 * @returns {{ hunks: { oldStart: number, newStart: number, lines: { type: " " | "-" | "+", text: string }[] }[], added: number, removed: number }}
 */
export function diffLines(before, after, context = 2) {
  const a = before === null || before === undefined ? [] : normalizeText(before).replace(/\n$/, "").split("\n");
  const b = after === null || after === undefined ? [] : normalizeText(after).replace(/\n$/, "").split("\n");
  if (a.length === 1 && a[0] === "" && before !== null) a.length = before === "" ? 0 : 1;
  if (b.length === 1 && b[0] === "" && after !== null) b.length = after === "" ? 0 : 1;
  // 先頭と末尾の同じ行は先に除く（記事の手直しは一部だけのことが多いので、比べる量が減る）
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  /** @type {{ type: " " | "-" | "+", text: string }[]} */
  const ops = a.slice(0, head).map((text) => ({ type: /** @type {" "} */ (" "), text }));
  if (midA.length * midB.length > DIFF_MAX_CELLS) {
    ops.push(...midA.map((text) => ({ type: /** @type {"-"} */ ("-"), text })), ...midB.map((text) => ({ type: /** @type {"+"} */ ("+"), text })));
  } else {
    // 最長共通部分列（LCS）で、消えた行・増えた行を決める
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ type: " ", text: midA[i] });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) ops.push({ type: "+", text: midB[j++] });
      else ops.push({ type: "-", text: midA[i++] });
    }
  }
  ops.push(...a.slice(a.length - tail).map((text) => ({ type: /** @type {" "} */ (" "), text })));

  // 変わった行の前後 context 行だけを残し、近いものは1つのまとまりにする
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op.type === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true;
  });
  const hunks = [];
  let oldNo = 1;
  let newNo = 1;
  let current = null;
  ops.forEach((op, k) => {
    if (keep[k]) {
      if (!current) {
        current = { oldStart: oldNo, newStart: newNo, lines: [] };
        hunks.push(current);
      }
      current.lines.push(op);
    } else current = null;
    if (op.type !== "+") oldNo++;
    if (op.type !== "-") newNo++;
  });
  return { hunks, added: ops.filter((o) => o.type === "+").length, removed: ops.filter((o) => o.type === "-").length };
}

/**
 * 承認したときの記事と今の記事を比べる（A-22）。タイトル・価格・画像・本文（無料記事・有料記事）の変わったところ
 * @param {{ meta: any, free: string | null, paid: string | null, images: { name: string, git_sha: string }[] }} before 承認したとき（paid は無料記事だけの記事なら null）
 * @param {{ meta: any, free: string | null, paid: string | null, images: { name: string, git_sha: string }[] }} after 今
 */
export function approvalChanges(before, after) {
  const bySha = (list) => new Map(list.map((x) => [x.name, x.git_sha]));
  const oldImages = bySha(before.images);
  const newImages = bySha(after.images);
  const images = {
    added: [...newImages.keys()].filter((n) => !oldImages.has(n)).sort(),
    removed: [...oldImages.keys()].filter((n) => !newImages.has(n)).sort(),
    changed: [...newImages.keys()].filter((n) => oldImages.has(n) && oldImages.get(n) !== newImages.get(n)).sort(),
  };
  const parts = [];
  for (const [key, label] of [["free", "無料記事"], ["paid", "有料記事"]]) {
    if (before[key] === null && after[key] === null) continue;
    const d = diffLines(before[key], after[key]);
    if (d.hunks.length > 0) parts.push({ key, label, ...d });
  }
  const title = before.meta.title !== after.meta.title ? { before: before.meta.title, after: after.meta.title } : null;
  const price = (before.meta.price_jpy ?? null) !== (after.meta.price_jpy ?? null) ? { before: priceLabel(before.meta), after: priceLabel(after.meta) } : null;
  const format = (before.meta.format ?? null) !== (after.meta.format ?? null) ? { before: formatLabel(before.meta), after: formatLabel(after.meta) } : null;
  const none = !title && !price && !format && parts.length === 0 && images.added.length + images.removed.length + images.changed.length === 0;
  return { title, price, format, images, parts, none };
}

// ---------- 本文を読みやすく表示する（A-21。表示だけで、コピーする文は変えない） ----------

/**
 * note 貼り付け用の本文（toNoteText の body）を、表示用のまとまりに分ける。
 * 見出し（## / ###）・箇条書き（- / * / ・）・番号つき（1.）・引用（>）・コード（```）・目印の行（＝＝ … ＝＝）・区切り（---）・段落
 * @param {string} body
 * @returns {{ type: string, level?: number, text?: string, items?: string[], lines?: string[] }[]}
 */
export function markdownBlocks(body) {
  const blocks = [];
  let para = null;
  let list = null;
  const flush = () => {
    if (para) blocks.push({ type: "p", lines: para });
    if (list) blocks.push(list);
    para = null;
    list = null;
  };
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith("```")) {
      flush();
      const code = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith("```")) code.push(lines[++i]);
      i++; // 閉じの ``` を飛ばす（なければ最後まで）
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    if (t === "") {
      flush();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      blocks.push({ type: "heading", level: Math.min(h[1].length, 3), text: h[2] });
      continue;
    }
    if (/^＝＝.*＝＝$/.test(t)) {
      flush();
      blocks.push({ type: "marker", text: t });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      blocks.push({ type: "hr" });
      continue;
    }
    if (t.startsWith(">")) {
      flush();
      blocks.push({ type: "quote", text: t.replace(/^>\s?/, "") });
      continue;
    }
    const ul = /^([-*・])\s*(.*)$/.exec(t);
    const ol = /^(\d+)[.)．]\s+(.*)$/.exec(t);
    if ((ul && (ul[1] === "・" || /^[-*]\s/.test(t))) || ol) {
      const ordered = !!ol;
      if (para) {
        blocks.push({ type: "p", lines: para });
        para = null;
      }
      if (!list || list.type !== (ordered ? "ol" : "ul")) {
        if (list) blocks.push(list);
        list = { type: ordered ? "ol" : "ul", items: [] };
      }
      list.items.push(ordered ? ol[2] : ul[2]);
      continue;
    }
    if (list) {
      blocks.push(list);
      list = null;
    }
    (para ??= []).push(t);
  }
  flush();
  return blocks;
}

/**
 * 1行の中の太字（**…**）とコード（`…`）を分ける
 * @param {string} text
 * @returns {{ text: string, bold?: boolean, code?: boolean }[]}
 */
export function inlineParts(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const m of String(text ?? "").matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], code: true });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? "").length) out.push({ text: text.slice(last) });
  return out;
}

// ---------- note に貼ると見出し・太字になる形（A-32。コピーの形だけを変え、承認した本文の中身は変えない） ----------

const escapeHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 1行の太字・コードを HTML にする（文字はすべてエスケープする） */
function inlineHtml(text) {
  return inlineParts(text).map((p) => (p.bold ? `<strong>${escapeHtml(p.text)}</strong>` : p.code ? `<code>${escapeHtml(p.text)}</code>` : escapeHtml(p.text))).join("");
}

/**
 * note 貼り付け用の本文（toNoteText の body）を、書式つきの HTML にする。
 * 見出し（## → 大見出し、### 以下 → 小見出し）・太字・箇条書き・番号つき・引用・コード・区切り線。
 * 目印の行（＝＝ … ＝＝。画像を入れる場所・有料ラインなど）は、そのままの文字の段落にする（貼ったあとに消す行なので）
 * @param {string} body
 */
export function noteHtml(body) {
  const blocks = markdownBlocks(body);
  return blocks.map((b, i) => {
    if (b.type === "heading") return b.level <= 2 ? `<h2>${inlineHtml(b.text)}</h2>` : `<h3>${inlineHtml(b.text)}</h3>`;
    if (b.type === "ul" || b.type === "ol") return `<${b.type}>${b.items.map((t) => `<li>${inlineHtml(t)}</li>`).join("")}</${b.type}>`;
    if (b.type === "quote") return `<blockquote><p>${inlineHtml(b.text)}</p></blockquote>`;
    if (b.type === "code") return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
    if (b.type === "marker") return `<p>${escapeHtml(b.text)}</p>`;
    if (b.type === "hr") return "<hr>";
    // URL だけの行は、note の記事でカードが保存されている形（figure）にする。貼っただけでカードになる（A-36。2026-11-23 オーナーが確認）
    const card = linkUrlOf(b);
    if (card) {
      const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `card-${i}`;
      return `<figure name="${id}" id="${id}" data-src="${escapeHtml(card)}" data-identifier="null" embedded-service="${/^https:\/\/note\.com\//.test(card) ? "note" : "external-article"}"></figure>`;
    }
    // すぐ下が URL だけの行（印から置き換わった記事のURL）なら、この段落の最後の行（「有料記事はこちら。」など）をそのURLへのリンクにする。URL の行はカードのために残す
    const url = linkUrlOf(blocks[i + 1]);
    const lines = b.lines.map(inlineHtml);
    if (url) lines[lines.length - 1] = `<a href="${escapeHtml(url)}">${lines[lines.length - 1]}</a>`;
    return `<p>${lines.join("<br>")}</p>`;
  }).join("\n");
}

/** URL だけの1行の段落なら、その URL（http/https のみ） */
function linkUrlOf(block) {
  if (block?.type !== "p" || block.lines.length !== 1) return null;
  const t = block.lines[0].trim();
  return /^https?:\/\/\S+$/.test(t) ? t : null;
}

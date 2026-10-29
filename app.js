// Note Growth アプリ（PWA）の画面処理。
// データは非公開リポジトリから GitHub API で読み書きする。承認・公開記録はこの端末の持ち主（オーナー）の操作として記録する。
import { AppError, buildApprovalChange, buildFreeUrlChange, buildPublicationChange, articleLength, buildThumbnailPrompt, THUMB_STYLES, buildTop10Draft, buildTop10Request, classifyShared, TOP10_DRAFT_PATH, contentHash, countPaywalls, LENGTH_GUIDE, extractNoteUrl, imageRefs, matchImages, toNoteText } from "./domain.js";
import { GitHubRepo } from "./github.js";
import { completeLogin, getAccessToken, isLoggedIn, logout, startLogin } from "./auth.js";
import { drawCover, splitTitle } from "./cover.js";

const STORE_KEY = "ngt-settings";
const $ = (id) => document.getElementById(id);

// ---------- 小さな道具 ----------

/** 要素を作る。文字列は必ず textContent として入れる（記事の内容を HTML として解釈しない） */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function notice(message, ok = false) {
  const n = $("notice");
  n.hidden = !message;
  n.textContent = message ?? "";
  n.classList.toggle("ok", ok);
  if (message) window.scrollTo({ top: 0, behavior: "smooth" });
}

function errorText(e) {
  return e instanceof AppError ? e.messages.join("\n") : e?.message ?? String(e);
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** 画面下に短く出すお知らせ（画面の位置を動かさない。コピーの完了など） */
let toastTimer;
function toast(message) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = el("div", { class: "toast", role: "status" });
    document.body.append(t);
  }
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2000);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}をコピーしました`);
  } catch {
    notice(`${label}をコピーできませんでした。長押しで選択してコピーしてください`);
  }
}

const STATUS_LABEL = {
  idea: "アイデア", researching: "調査中", planning: "企画中", drafting: "執筆中", qa: "品質チェック中",
  needs_revision: "差し戻し", awaiting_approval: "承認待ち", approved: "承認済み", published: "公開済み", archived: "中止",
};

// ---------- 状態 ----------

let settings = loadSettings();
let gh = null;
let snapshot = null; // { sha, articles: [...] } 読み込んだ時点のコミット

function connect() {
  const [owner, repo] = (settings.repo || "gangidenset/note-growth-team").split("/");
  if (!isLoggedIn() || !owner || !repo) {
    gh = null;
    return false;
  }
  gh = new GitHubRepo({ getToken: getAccessToken, owner, repo, branch: settings.branch || "" });
  return true;
}

async function ensureBranch() {
  if (!gh.branch) {
    const info = await gh.info();
    gh.branch = info.default_branch;
  }
}

// ---------- 読み込み ----------

async function loadArticles(sha) {
  const dirs = (await gh.listDir("data/articles", sha)).filter((e) => e.type === "dir");
  const articles = [];
  for (const d of dirs) {
    const meta = await gh.readJson(`data/articles/${d.name}/meta.json`, sha);
    if (!meta) continue;
    const [free, paid, approval, hashtags] = await Promise.all([
      gh.readText(`data/articles/${d.name}/free.md`, sha),
      gh.readText(`data/articles/${d.name}/paid.md`, sha),
      gh.readJson(`data/approvals/${d.name}.json`, sha),
      gh.readJson(`data/articles/${d.name}/hashtags.json`, sha).catch(() => null),
    ]);
    const coverPrompt = await gh.readJson(`data/articles/${d.name}/cover-prompt.json`, sha).catch(() => null);
    const assets = (await gh.listDir(`data/articles/${d.name}/assets`, sha)).filter((e) => e.type === "file");
    // 無料記事だけの記事（free_only）は、有料記事を空文字としてハッシュする（PC 側の readDrafts と同じ）
    const freeOnly = meta.format === "free_only";
    const hashPaid = freeOnly ? "" : paid;
    const { images, missing } = matchImages(free, hashPaid, assets);
    const hash =
      free !== null && hashPaid !== null && missing.length === 0
        ? await contentHash({ title: meta.title, price_jpy: meta.price_jpy, free, paid: hashPaid, images })
        : null;
    articles.push({ meta, free, paid: freeOnly ? null : paid, hashPaid, freeOnly, approval, hashtags, coverPrompt, images, missingImages: missing, sha, hash, approvalValid: !!approval && approval.content_sha256 === hash });
  }
  articles.sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at));
  return articles;
}

async function reload() {
  if (!connect()) {
    showTab("settings");
    notice("最初に「設定」の「GitHub でログイン」を押してください");
    return;
  }
  notice("読み込み中…", true);
  try {
    await ensureBranch();
    const sha = await gh.headSha();
    snapshot = { sha, articles: await loadArticles(sha) };
    renderArticles();
    syncTop10DraftFromRemote(sha).catch(() => {});
    renderData(sha).catch((e) => notice(`データの読み込みに失敗: ${errorText(e)}`));
    notice("");
  } catch (e) {
    notice(`読み込みに失敗しました: ${errorText(e)}`);
  }
}

// ---------- 記事タブ ----------

function renderArticles() {
  const root = $("tab-articles");
  root.replaceChildren();
  const waiting = snapshot.articles.filter((a) => a.meta.status === "awaiting_approval").length;
  root.append(el("h2", {}, `記事（${snapshot.articles.length}件）`, waiting ? ` ・承認待ち ${waiting}件` : ""));
  if (snapshot.articles.length === 0) root.append(el("p", { class: "muted" }, "記事はまだありません"));
  for (const a of snapshot.articles) {
    const m = a.meta;
    const stale = (m.status === "approved" || m.status === "published") && !a.approvalValid;
    root.append(
      el("div", { class: "card" },
        el("div", {}, el("span", { class: `badge ${m.status}` }, STATUS_LABEL[m.status] ?? m.status),
          el("span", { class: "meta" }, m.price_jpy ? `${m.price_jpy}円` : "価格未定")),
        el("div", { class: "title" }, m.title || "(タイトル未定)"),
        el("div", { class: "meta" }, `${m.id} ・ 更新 ${m.updated_at}`),
        stale && el("div", { class: "warn" }, "承認後に本文が変わっています。承認は無効です（再承認が必要）"),
        el("div", { class: "row" }, el("button", { class: "secondary", onclick: () => renderArticle(a) }, "開く")),
      ),
    );
  }
}

function copyBlock(label, markdown) {
  if (markdown === null) return el("p", { class: "muted" }, `${label}: ファイルがありません`);
  const { title, body } = toNoteText(markdown);
  return el("div", { class: "card" },
    el("h3", {}, label),
    el("div", { class: "title" }, title || "(タイトルなし)"),
    el("div", { class: "row" },
      el("button", { class: "secondary", onclick: () => copy(title, `${label}のタイトル`) }, "タイトルをコピー"),
      el("button", { class: "secondary", onclick: () => copy(body, `${label}の本文`) }, "本文をコピー"),
    ),
    el("pre", { class: "body" }, body),
  );
}

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** 本文に入れる画像の一覧（確認用の表示と、note に入れるための保存ボタン） */
function imagesBlock(a) {
  const refs = [...imageRefs(a.free ?? "").map((r) => ({ ...r, where: "無料" })), ...imageRefs(a.paid ?? "").map((r) => ({ ...r, where: "有料" }))];
  if (refs.length === 0) return null;
  const list = el("div", {});
  const card = el("div", { class: "card" },
    el("h3", {}, `記事の画像（${refs.length}枚）`),
    el("p", { class: "muted" }, "本文の「＝＝ ここに画像「…」を入れる ＝＝」の行の位置に、同じ名前の画像を note で挿入して、その行を消してください。画像も承認の対象です（差し替えると承認が無効になります）。"),
    a.missingImages.length > 0 && el("div", { class: "warn" }, `見つからない画像: ${a.missingImages.join(", ")}`),
    el("button", { class: "secondary", onclick: () => loadImages(a, refs, list) }, "画像を表示する"),
    list,
  );
  return card;
}

async function loadImages(a, refs, list) {
  list.replaceChildren(el("p", { class: "muted" }, "読み込み中…"));
  const items = [];
  for (const [i, r] of refs.entries()) {
    const type = IMAGE_TYPES[r.name.split(".").pop().toLowerCase()] ?? "application/octet-stream";
    let b64 = null;
    try {
      b64 = await gh.readBase64(`data/articles/${a.meta.id}/assets/${r.name}`, a.sha);
    } catch (e) {
      notice(`画像の読み込みに失敗: ${errorText(e)}`);
    }
    const save = () => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const link = el("a", { href: url, download: r.name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    items.push(el("div", { class: "card" },
      el("div", { class: "meta" }, `${i + 1}. ${r.where}記事 ・ ${r.name}`),
      el("div", {}, r.alt),
      b64 ? el("img", { src: `data:${type};base64,${b64}`, alt: r.alt, class: "figure" }) : el("div", { class: "warn" }, "画像がありません"),
      b64 && el("button", { class: "secondary", onclick: save }, "この画像を保存"),
    ));
  }
  list.replaceChildren(...items);
}

/** ハッシュタグの案（hashtags.json）。タグを押すと1つずつコピーできる（note では1つずつ入力するため） */
function hashtagsBlock(plan, kind) {
  const list = plan?.[kind];
  if (!Array.isArray(list) || list.length === 0) return null;
  return el("details", { class: "hashtags" },
    el("summary", {}, `ハッシュタグの案（${list.length}個）`),
    el("p", { class: "muted" }, "タグを押すとコピーされます。note の「ハッシュタグ」欄に貼って決定、を1つずつ繰り返してください。使うかどうかは自由です。"),
    el("div", { class: "row" }, ...list.map((t) => el("button", { class: "secondary", onclick: () => copy(t.tag, `#${t.tag}`) }, `#${t.tag}`))),
    el("ul", { class: "muted" }, ...list.map((t) => el("li", {}, `#${t.tag}: ${t.reason}`))),
    kind === "paid" && Array.isArray(plan.avoided) && plan.avoided.length > 0 &&
      el("ul", { class: "muted" }, ...plan.avoided.map((t) => el("li", {}, `付けない: #${t.tag}（${t.reason}）`))),
    plan.basis && el("p", { class: "muted" }, `根拠: ${plan.basis}`),
  );
}

/** 文字数と目安（長すぎる記事は精査が大変なので、目安を超えたら知らせる） */
function lengthLine(a) {
  const part = (md, kind, label) => {
    if (md === null) return null;
    const { text } = articleLength(md);
    const g = LENGTH_GUIDE[kind];
    const mark = text > g.max ? "（目安より長い）" : text < g.min ? "（目安より短い）" : "";
    return `${label} ${text}字${mark}`;
  };
  const parts = [part(a.free, "free", "無料"), part(a.paid, "paid", "有料")].filter(Boolean);
  if (parts.length === 0) return null;
  return el("div", { class: "meta" }, `文字数: ${parts.join(" ・ ")}（目安: 無料 ${LENGTH_GUIDE.free.min}〜${LENGTH_GUIDE.free.max}字、有料 ${LENGTH_GUIDE.paid.min}〜${LENGTH_GUIDE.paid.max}字）`);
}

function renderArticle(a) {
  const m = a.meta;
  const root = $("tab-articles");
  root.replaceChildren(...[
    el("button", { class: "secondary", onclick: renderArticles }, "← 一覧へ"),
    el("h2", {}, m.title || m.id),
    el("div", { class: "meta" }, `${STATUS_LABEL[m.status] ?? m.status} ・ ${m.price_jpy ?? "価格未定"}円 ・ ${m.id}`),
    m.published_url && el("div", { class: "meta" }, "有料記事: ", el("a", { href: m.published_url, target: "_blank", rel: "noopener" }, m.published_url)),
    m.free_url && el("div", { class: "meta" }, "無料記事: ", el("a", { href: m.free_url, target: "_blank", rel: "noopener" }, m.free_url)),
    el("div", { class: "meta" }, `内容ハッシュ: ${a.hash ?? "(本文または画像がそろっていません)"}`),
    lengthLine(a),
    a.paid !== null && countPaywalls(a.paid) !== 1 && el("div", { class: "warn" }, "有料記事の境目（paywall）がちょうど1つではありません"),
  ].filter(Boolean)); // 条件に合わない要素（null / false）は表示しない

  const actions = el("div", { class: "row" });
  if (m.status === "awaiting_approval") actions.append(el("button", { onclick: () => approveDialog(a) }, "内容を確認して承認する"));
  root.append(actions);
  if (m.status === "approved" && !a.approvalValid) {
    root.append(el("div", { class: "warn" }, "承認後に本文が変わっています。Claude Code に「承認待ちに戻して」と依頼し、再承認してください"));
  }
  const images = imagesBlock(a);
  if (images) root.append(images);
  if ((m.status === "approved" && a.approvalValid) || m.status === "published") root.append(postingGuide(a));
  if (m.status !== "approved" && m.status !== "published") {
    root.append(...(a.freeOnly ? [copyBlock("無料記事", a.free)] : [copyBlock("有料記事", a.paid), copyBlock("無料記事", a.free)]));
  }
}

const NOTE_NEW_POST = "https://note.com/notes/new";
/**
 * Android では、インストールしたアプリからリンクを開くと、アプリの中（同じ画面の重ね表示）で開いてしまい、
 * Note Growth に戻ってコピーできない。Chrome を名指しして開き、別のアプリとして行き来できるようにする
 */
const NOTE_NEW_POST_LINK = /Android/i.test(navigator.userAgent)
  ? "intent://note.com/notes/new#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fnote.com%2Fnotes%2Fnew;end"
  : NOTE_NEW_POST;

/**
 * 投稿用のコピーボタンと、note の投稿画面へのリンク。
 * Android では note のリンクが note アプリで開き、アプリに戻りにくいことがあるため、コピーと画面を開く操作を分けている
 */
function postButtons(text, label) {
  return [
    el("div", { class: "row" },
      el("button", { onclick: () => copy(text.title, `${label}のタイトル`) }, "① タイトルをコピー"),
      el("button", { onclick: () => copy(text.body, `${label}の本文`) }, "② 本文をコピー"),
      el("a", { class: "button secondary", href: NOTE_NEW_POST_LINK, target: "_blank", rel: "noopener" }, "note の投稿画面を Chrome で開く"),
    ),
    el("p", { class: "muted" },
      "おすすめ: ①と②を続けて押してから note を開き、キーボード（Gboard）のクリップボード履歴から、タイトルと本文をそれぞれ貼り付ける。" +
      "履歴がないときは、①を押す → note に貼る → 画面下の「□」（最近使ったアプリ）で Note Growth に戻る → ②を押す → note に貼る。" +
      "note がこのアプリの中で開いてしまったら、右上の「⋮」→「Chrome で開く」で別の画面に移せる。"),
  ];
}

/** 承認済みの記事を note に投稿する手順（投稿モード） */
function postingGuide(a) {
  const m = a.meta;
  const paid = a.paid === null ? null : toNoteText(a.paid);
  const free = a.free === null ? null : toNoteText(a.free);
  const step = (n, title, ...body) => el("div", { class: "card" }, el("h3", {}, `${n}. ${title}`), ...body);
  const done = (url) => el("div", { class: "meta" }, "✓ 記録済み: ", el("a", { href: url, target: "_blank", rel: "noopener" }, url));

  const paidStep = m.published_url
    ? step(1, "有料記事", done(m.published_url))
    : step(1, "有料記事を投稿する",
        el("div", { class: "big" }, `価格: ${m.price_jpy ?? "?"}円（有料）`),
        paid && el("button", { class: "secondary", onclick: () => coverDialog(paid.title, "paid", `${m.id}-paid-cover.png`, a.coverPrompt?.paid) }, "見出し画像を作る"),
        el("div", { class: "warn" }, "本文中の「＝＝＝＝＝ ここに note の有料ラインを入れる ＝＝＝＝＝」の行を消し、その位置に有料ラインを入れる（筆者紹介のすぐ下）"),
        paid && postButtons(paid, "有料記事"),
        el("p", { class: "muted" }, "本文を貼ったら → 画像を入れる（下の「記事の画像」）→ 有料ラインと価格を設定 → ハッシュタグを入れる → 公開"),
        hashtagsBlock(a.hashtags, "paid"),
        paid && el("details", {}, el("summary", {}, "本文を確認する"), el("pre", { class: "body" }, paid.body)),
      );

  const freeStep = m.free_url
    ? step(2, "無料記事", done(m.free_url))
    : step(2, "無料記事を投稿する",
        el("div", { class: "big" }, "無料のまま公開"),
        free && el("button", { class: "secondary", onclick: () => coverDialog(free.title, "free", `${m.id}-free-cover.png`, a.coverPrompt?.free) }, "見出し画像を作る"),
        free && postButtons(free, "無料記事"),
        hashtagsBlock(a.hashtags, "free"),
        free && el("details", {}, el("summary", {}, "本文を確認する"), el("pre", { class: "body" }, free.body)),
      );

  const recordStep = step(3, "公開を記録する",
    el("p", {}, "公開した記事を note で開き、「共有」→「Note Growth」を選ぶと、このアプリが自動で記録します（有料・無料それぞれ1回）。"),
    el("p", { class: "muted" }, "共有先に Note Growth が出ないときは、アプリを一度ホーム画面から削除して、もう一度「ホーム画面に追加」してください。または下のボタンで URL を貼って記録できます。"),
    el("div", { class: "row" },
      !m.published_url && m.status === "approved" && el("button", { class: "secondary", onclick: () => publishDialog(a) }, "有料記事のURLを貼って記録"),
      !m.free_url && el("button", { class: "secondary", onclick: () => freeUrlDialog(a) }, "無料記事のURLを貼って記録"),
    ),
  );

  const coverRow = (m.published_url || m.free_url) && el("div", { class: "row" },
    paid && el("button", { class: "secondary", onclick: () => coverDialog(paid.title, "paid", `${m.id}-paid-cover.png`, a.coverPrompt?.paid) }, "有料記事の見出し画像"),
    free && el("button", { class: "secondary", onclick: () => coverDialog(free.title, "free", `${m.id}-free-cover.png`, a.coverPrompt?.free) }, "無料記事の見出し画像"),
  );

  if (a.freeOnly) {
    // 無料記事だけの記事: 投稿は1本。公開URLは「公開記録」（published_url）として記録する
    const onlyStep = m.published_url
      ? step(1, "無料記事", done(m.published_url))
      : step(1, "無料記事を投稿する",
          el("div", { class: "big" }, "無料のまま公開（この記事は無料記事だけ）"),
          free && el("button", { class: "secondary", onclick: () => coverDialog(free.title, "free", `${m.id}-free-cover.png`, a.coverPrompt?.free) }, "見出し画像を作る"),
          free && postButtons(free, "無料記事"),
          el("p", { class: "muted" }, "本文を貼ったら → 画像を入れる（下の「記事の画像」）→ ハッシュタグを入れる → 公開"),
          hashtagsBlock(a.hashtags, "free"),
          free && el("details", {}, el("summary", {}, "本文を確認する"), el("pre", { class: "body" }, free.body)),
        );
    const onlyRecord = step(2, "公開を記録する",
      el("p", {}, "公開した記事を note で開き、「共有」→「Note Growth」を選ぶと記録できます。"),
      el("div", { class: "row" },
        !m.published_url && m.status === "approved" && el("button", { class: "secondary", onclick: () => publishDialog(a) }, "記事のURLを貼って記録"),
      ),
    );
    return el("div", {}, el("h3", {}, "投稿モード"), onlyStep, onlyRecord,
      el("p", { class: "muted" }, "「.md」などは note で自動リンクになることがあります。リンクは外してください（見た目の調整なので再承認は不要）。"));
  }

  return el("div", {},
    el("h3", {}, "投稿モード"),
    coverRow,
    paidStep, freeStep, recordStep,
    el("p", { class: "muted" }, "CLAUDE.md などの「.md」は note で自動リンクになることがあります。リンクは外してください（見た目の調整なので再承認は不要）。"),
  );
}

function openDialog(...children) {
  const d = $("dialog");
  d.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));
  if (!d.open) d.showModal();
  return d;
}

function approveDialog(a) {
  const m = a.meta;
  const input = el("input", { type: "text", autocomplete: "off", placeholder: m.id });
  const ok = el("button", { disabled: "" }, "承認する");
  input.addEventListener("input", () => (ok.disabled = input.value.trim() !== m.id));
  const d = openDialog(
    el("h2", {}, "承認の確認"),
    el("p", {}, "無料記事・有料記事の本文を最後まで読みましたか？ 承認後に本文が1文字でも変わると、承認は無効になります。"),
    el("div", { class: "meta" }, `タイトル: ${m.title}`),
    el("div", { class: "meta" }, `価格: ${m.price_jpy}円`),
    el("div", { class: "meta" }, `内容ハッシュ: ${a.hash}`),
    el("label", {}, `承認するには記事ID（${m.id}）を入力`, input),
    el("div", { class: "row" }, ok, el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
  );
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    try {
      const audit = await gh.readText("data/audit.log.jsonl", snapshot.sha);
      const change = await buildApprovalChange({ meta: m, free: a.free, paid: a.hashPaid, images: a.images, missingImages: a.missingImages, auditText: audit, approver: settings.approver, now: new Date() });
      await gh.commitFiles(change.files, `${m.id} を承認（アプリ）`, snapshot.sha);
      d.close();
      await reload();
      notice(`承認しました（${m.id}）。note に投稿したら「公開を記録する」を押してください`, true);
    } catch (e) {
      d.close();
      notice(`承認できませんでした:\n${errorText(e)}`);
    }
  });
}

function publishDialog(a) {
  const m = a.meta;
  const url = el("input", { type: "url", placeholder: "https://note.com/xxxx/n/n0123456789ab" });
  const confirm = el("input", { type: "text", autocomplete: "off", placeholder: "yes" });
  const ok = el("button", { disabled: "" }, "公開を記録する");
  const update = () => (ok.disabled = confirm.value.trim() !== "yes" || url.value.trim() === "");
  url.addEventListener("input", update);
  confirm.addEventListener("input", update);
  const d = openDialog(
    el("h2", {}, "公開の記録"),
    el("p", {}, a.freeOnly ? "note に投稿した記事のURLを入れてください。" : "note に投稿した有料記事のURLを入れてください。"),
    el("label", {}, a.freeOnly ? "記事のURL" : "有料記事のURL", url),
    el("label", {}, "よろしければ yes と入力", confirm),
    el("div", { class: "row" }, ok, el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
  );
  ok.addEventListener("click", () => {
    ok.disabled = true;
    savePublication(a, url.value, d);
  });
}

/** 見出し画像（1280×670）を作って保存する。文字は編集できる */
const CHATGPT_URL = "https://chatgpt.com/";

/** 見出し画像のプロンプト（cover-prompt.json の paid / free）。ChatGPT などの画像生成 AI に貼って背景を作る */
function coverPromptBlock(item) {
  if (!item || typeof item.prompt !== "string") return null;
  return el("details", { class: "hashtags" },
    el("summary", {}, "背景イラストのプロンプト（ChatGPT などに貼る）"),
    el("pre", { class: "body" }, item.prompt),
    el("div", { class: "row" },
      el("button", { class: "secondary", onclick: () => copy(item.prompt, "プロンプト") }, "プロンプトをコピー"),
      el("a", { class: "button secondary", href: CHATGPT_URL, target: "_blank", rel: "noopener" }, "ChatGPT を開く"),
    ),
    el("p", { class: "muted" }, `できた画像を保存して、下の「背景画像を選ぶ」で読み込みます。文字は${item.text_side === "right" ? "右" : item.text_side === "center" ? "中央" : "左"}側に重ねる想定です。使う AI の利用規約で、商用利用（有料記事の見出し）ができるか確認してください。`),
  );
}

/** サムネイル用のプロンプトを、項目を埋めて作る（ChatGPT などに貼る） */
function thumbnailPromptDialog(title) {
  const { main, sub } = splitTitle(title);
  const field = (label, value = "", rows = 1) => {
    const input = rows > 1 ? el("textarea", { rows: String(rows) }) : el("input", { type: "text" });
    input.value = value;
    return { input, node: el("label", {}, label, input) };
  };
  const style = el("select", {}, ...Object.entries(THUMB_STYLES).map(([k, v]) => el("option", { value: k }, v.label)));
  const side = el("select", {}, el("option", { value: "left" }, "左"), el("option", { value: "right" }, "右"), el("option", { value: "center" }, "中央"));
  const mainF = field("一番大きい文字（空欄なら文字なしの背景だけ）", main.slice(0, 20));
  const subF = field("2番目の文字（空欄可）", sub.slice(0, 30));
  const smallF = field("隅の小さな文字（空欄可。例: やってみた（汗））");
  const charF = field("人物（空欄なら型のおすすめ）", "", 2);
  const buddyF = field("相棒・マスコット（空欄可。例: 小さなロボット）");
  const itemsF = field("小物・アイコン（記事の中身に合うもの。例: 10個のアプリアイコンが円を描いて飛ぶ）", "", 2);
  const settingF = field("場所（空欄なら型のおすすめ）");
  const colorsF = field("色（空欄なら型のおすすめ）");
  const out = el("pre", { class: "body" });
  const make = () => {
    out.textContent = buildThumbnailPrompt({
      style: style.value, textSide: side.value, mainText: mainF.input.value, subText: subF.input.value, noteText: smallF.input.value,
      character: charF.input.value, buddy: buddyF.input.value, items: itemsF.input.value, setting: settingF.input.value, colors: colorsF.input.value,
    });
  };
  for (const i of [style, side, mainF.input, subF.input, smallF.input, charF.input, buddyF.input, itemsF.input, settingF.input, colorsF.input]) {
    i.addEventListener("input", make);
    i.addEventListener("change", make);
  }
  const d = openDialog(
    el("h2", {}, "サムネイルのプロンプトを作る"),
    el("p", { class: "muted" }, "項目を埋めると、下にプロンプトができます。人物・相棒・色は、ほかの人の画像と似ないように自分で決めると、オリジナルになります。"),
    el("div", { class: "row" }, el("label", {}, "見た目の型", style), el("label", {}, "文字の位置", side)),
    mainF.node, subF.node, smallF.node, charF.node, buddyF.node, itemsF.node, settingF.node, colorsF.node,
    el("h3", {}, "できたプロンプト"),
    out,
    el("div", { class: "row" },
      el("button", { onclick: () => copy(out.textContent, "プロンプト") }, "プロンプトをコピー"),
      el("a", { class: "button secondary", href: CHATGPT_URL, target: "_blank", rel: "noopener" }, "ChatGPT を開く"),
      el("button", { class: "secondary", onclick: () => d.close() }, "閉じる"),
    ),
    el("p", { class: "muted" }, "日本語の文字は崩れることがあります。崩れたら作り直すか、文字を空欄にして背景だけ作り、「見出し画像を作る」でタイトルを重ねてください。使う AI の利用規約で商用利用（有料記事の見出し）ができるかも確認してください。"),
  );
  make();
}

function coverDialog(title, variant, filename, coverPrompt = null) {
  const { main, sub } = splitTitle(title);
  const mainIn = el("textarea", { rows: "2" });
  mainIn.value = main;
  const subIn = el("textarea", { rows: "2" });
  subIn.value = sub;
  const labelIn = el("input", { type: "text" });
  labelIn.value = "";
  const fileIn = el("input", { type: "file", accept: "image/*" });
  const positionIn = el("select", {},
    el("option", { value: "left" }, "左に文字"), el("option", { value: "right" }, "右に文字"), el("option", { value: "center" }, "中央に文字"));
  positionIn.value = coverPrompt?.text_side ?? "left";
  const fontIn = el("select", {}, el("option", { value: "mincho" }, "明朝体（雑誌風）"), el("option", { value: "gothic" }, "ゴシック体"));
  let background = null;
  const canvas = el("canvas", { class: "cover" });
  const redraw = () =>
    drawCover(canvas, {
      main: mainIn.value.trim(), sub: subIn.value.trim(), label: labelIn.value.trim(), variant,
      background, position: positionIn.value, font: fontIn.value,
    });
  for (const i of [mainIn, subIn, labelIn]) i.addEventListener("input", redraw);
  for (const i of [positionIn, fontIn]) i.addEventListener("change", redraw);
  fileIn.addEventListener("change", async () => {
    const file = fileIn.files?.[0];
    if (!file) return;
    try {
      background = await createImageBitmap(file);
      redraw();
    } catch {
      notice("この画像は読み込めませんでした（PNG・JPG などを選んでください）");
    }
  });

  const save = el("button", {}, "画像を保存");
  save.addEventListener("click", () => {
    canvas.toBlob(async (blob) => {
      if (!blob) return notice("画像を作れませんでした");
      const file = new File([blob], filename, { type: "image/png" });
      // 共有シートが使える端末では、写真アプリなどに直接送れるようにする
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: filename });
          return;
        } catch {
          // 共有をやめた場合は下のダウンロードに切り替える
        }
      }
      const a = el("a", { href: URL.createObjectURL(blob), download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }, "image/png");
  });

  const d = openDialog(
    el("h2", {}, variant === "paid" ? "見出し画像（有料記事）" : "見出し画像（無料記事）"),
    canvas,
    coverPromptBlock(coverPrompt),
    el("button", { class: "secondary", onclick: () => thumbnailPromptDialog(title) }, "サムネイルのプロンプトを自分で作る"),
    el("label", {}, "背景画像を選ぶ（なしなら単色のデザイン）", fileIn),
    el("div", { class: "row" }, el("label", {}, "文字の位置", positionIn), el("label", {}, "文字の書体", fontIn)),
    el("label", {}, "大きい文字", mainIn),
    el("label", {}, "小さい文字（空欄可）", subIn),
    el("label", {}, "上のラベル（空欄可）", labelIn),
    el("div", { class: "row" }, save, el("button", { class: "secondary", onclick: () => d.close() }, "閉じる")),
    el("p", { class: "muted" }, "サイズは note 推奨の 1280×670px。保存した画像を、note の投稿画面で見出し画像に設定してください。顔写真やアカウント名など、身元がわかるものは入れないでください。"),
  );
  redraw();
}

function freeUrlDialog(a, presetUrl = "") {
  const m = a.meta;
  const url = el("input", { type: "url", placeholder: "https://note.com/xxxx/n/n0123456789ab" });
  url.value = presetUrl;
  const ok = el("button", {}, "無料記事のURLを記録する");
  const d = openDialog(
    el("h2", {}, "無料記事のURL"),
    el("div", { class: "meta" }, m.title),
    el("label", {}, "note に投稿した無料記事のURL", url),
    el("div", { class: "row" }, ok, el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
  );
  ok.addEventListener("click", () => saveFreeUrl(a, url.value, d));
}

async function saveFreeUrl(a, url, dialog) {
  try {
    const audit = await gh.readText("data/audit.log.jsonl", snapshot.sha);
    const change = buildFreeUrlChange({ meta: a.meta, url, auditText: audit, now: new Date() });
    await gh.commitFiles(change.files, `${a.meta.id} の無料記事URLを記録（アプリ）`, snapshot.sha);
    dialog?.close();
    await reload();
    notice(`無料記事のURLを記録しました（${a.meta.id}）`, true);
  } catch (e) {
    dialog?.close();
    notice(`記録できませんでした:\n${errorText(e)}`);
  }
}

async function savePublication(a, url, dialog) {
  try {
    const audit = await gh.readText("data/audit.log.jsonl", snapshot.sha);
    const change = await buildPublicationChange({ meta: a.meta, free: a.free, paid: a.hashPaid, images: a.images, missingImages: a.missingImages, approval: a.approval, auditText: audit, url, now: new Date() });
    await gh.commitFiles(change.files, `${a.meta.id} を公開（アプリ）`, snapshot.sha);
    dialog?.close();
    await reload();
    notice(`有料記事の公開を記録しました（${a.meta.id}）`, true);
  } catch (e) {
    dialog?.close();
    notice(`記録できませんでした:\n${errorText(e)}`);
  }
}

// ---------- note の「共有」から受け取る（Android の共有ターゲット） ----------

function readShared() {
  const p = new URLSearchParams(location.search);
  const shared = { title: p.get("share_title") ?? "", text: p.get("share_text") ?? "", url: p.get("share_url") ?? "" };
  if (!shared.title && !shared.text && !shared.url) return null;
  history.replaceState(null, "", location.pathname); // 再読み込みで同じ共有を二重に処理しない
  return shared;
}

/** 共有された note の URL を、どの記事の有料／無料として記録するかを確認して記録する */
function handleShared(shared) {
  const url = extractNoteUrl(shared);
  if (!url) return notice("共有された内容に note の記事URLが見つかりませんでした");
  const candidates = snapshot.articles.filter(
    (a) => (a.meta.status === "approved" && a.approvalValid) || (a.meta.status === "published" && !a.meta.free_url && !a.freeOnly),
  );
  if (candidates.length === 0) return notice(`記録できる記事がありません（承認済みの記事がない）。共有されたURL: ${url}`);

  const choose = (a) => {
    if (a.freeOnly) {
      const d = openDialog(
        el("h2", {}, "共有された記事を記録"),
        el("div", { class: "meta" }, url),
        el("div", { class: "title" }, a.meta.title),
        el("p", { class: "muted" }, "この記事は無料記事だけです。公開記録として保存します。"),
        el("div", { class: "row" },
          el("button", { onclick: () => savePublication(a, url, d) }, "公開を記録する"),
          el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
      );
      return;
    }
    const kind = classifyShared(shared, {
      paidTitle: a.paid === null ? "" : toNoteText(a.paid).title,
      freeTitle: a.free === null ? "" : toNoteText(a.free).title,
    });
    const canPaid = a.meta.status === "approved" && !a.meta.published_url;
    const canFree = !a.meta.free_url;
    const paidBtn = canPaid && el("button", { onclick: () => savePublication(a, url, d) }, kind === "paid" ? "有料記事として記録する（推定: 有料）" : "有料記事として記録する");
    const freeBtn = canFree && el("button", { class: kind === "free" ? "" : "secondary", onclick: () => saveFreeUrl(a, url, d) }, kind === "free" ? "無料記事として記録する（推定: 無料）" : "無料記事として記録する");
    const d = openDialog(
      el("h2", {}, "共有された記事を記録"),
      el("div", { class: "meta" }, url),
      el("div", { class: "title" }, a.meta.title),
      el("p", { class: "muted" }, kind ? "共有された文面のタイトルから判定しました。違っていれば、もう一方を押してください。" : "有料記事・無料記事のどちらか選んでください。"),
      el("div", { class: "row" }, ...[kind === "free" ? freeBtn : paidBtn, kind === "free" ? paidBtn : freeBtn].filter(Boolean),
        el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
    );
  };

  if (candidates.length === 1) return choose(candidates[0]);
  openDialog(
    el("h2", {}, "どの記事として記録しますか？"),
    el("div", { class: "meta" }, url),
    ...candidates.map((a) => el("div", { class: "row" }, el("button", { class: "secondary", onclick: () => choose(a) }, a.meta.title || a.meta.id))),
  );
}

// ---------- データタブ ----------

async function readAll(dir, sha) {
  const files = (await gh.listDir(dir, sha)).filter((e) => e.type === "file" && e.name.endsWith(".json"));
  const out = [];
  for (const f of files) {
    try {
      out.push(await gh.readJson(`${dir}/${f.name}`, sha));
    } catch {
      out.push({ id: f.name, _broken: true });
    }
  }
  return out;
}

async function renderData(sha) {
  const root = $("tab-data");
  root.replaceChildren(el("p", { class: "muted" }, "読み込み中…"));
  const [themes, gaps, market, requests] = await Promise.all([
    readAll("data/themes", sha),
    readAll("data/gaps", sha),
    gh.listDir("data/market", sha),
    gh.listDir("data/requests", sha),
  ]);
  const marketFiles = market.filter((e) => e.name.endsWith(".json")).map((e) => e.name.replace(".json", "")).sort().reverse();
  const reqFiles = requests.filter((e) => e.name.endsWith(".txt")).map((e) => e.name).sort().reverse();

  root.replaceChildren(...[
    el("h2", {}, `ギャップ分析（${gaps.length}件）`),
    gaps.length === 0 ? el("p", { class: "muted" }, "まだありません") : null,
    ...gaps.map((g) => el("div", { class: "card" },
      el("div", { class: "title" }, `${g.keyword ?? g.id}（${g.genre ?? "-"}）`),
      el("div", { class: "meta" }, g.summary ?? ""),
      el("ul", { class: "plain" }, ...(g.gaps ?? []).map((x) =>
        el("li", {}, (g.recommended_gap_ids ?? []).includes(x.id) ? "★ " : "", `${x.id} [${x.type}] ${x.description}（経験との合い方: ${x.owner_fit}）`))),
    )),
    el("h2", {}, `テーマ（${themes.length}件）`),
    ...themes
      .sort((a, b) => (b.status === "selected") - (a.status === "selected"))
      .map((t) => el("div", { class: "card" },
        el("div", {}, el("span", { class: "badge" }, t.status ?? "?"), el("span", { class: "meta" }, `${t.genre ?? ""} ・ ${t.price_plan_jpy ?? "-"}円`)),
        el("div", { class: "title" }, t.title ?? t.id),
        t.scores && el("div", { class: "meta" }, `需要 ${t.scores.demand} ／ 競合の少なさ ${t.scores.competition} ／ 強み ${t.scores.owner_strength} ／ 作りやすさ ${t.scores.production_cost}`),
      )),
    el("h2", {}, `調査依頼（${reqFiles.length}件）`),
    el("ul", { class: "plain" }, ...reqFiles.map((n) => el("li", {}, n))),
    el("h2", {}, `市場データ（${marketFiles.length}件、新しい順に20件）`),
    el("ul", { class: "plain" }, ...marketFiles.slice(0, 20).map((n) => el("li", {}, n))),
  ].filter(Boolean));
}

// ---------- 上位10件タブ ----------

// 入力途中の依頼（キーワードと URL）は、入力のたびにこの端末に自動保存する。
// 「途中で保存」を押すと GitHub（data/requests/top10-draft.json）にも保存し、PC とスマホで続きから入力できる
const TOP10_DRAFT_KEY = "ngt-top10-draft";

function countUrls(text) {
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

function showTop10DraftStatus(savedAt) {
  const n = countUrls($("t10-urls").value);
  const time = savedAt ? `途中保存: ${new Date(savedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
  $("t10-draft-status").textContent = [`入力済み ${n}/10件`, time].filter(Boolean).join(" ・ ");
}

/** 端末に保存する。保存できない環境（プライベートモードなど）では false */
function saveTop10Draft() {
  const draft = { keyword: $("t10-keyword").value, urls: $("t10-urls").value, savedAt: new Date().toISOString() };
  try {
    if (draft.keyword.trim() === "" && draft.urls.trim() === "") localStorage.removeItem(TOP10_DRAFT_KEY);
    else localStorage.setItem(TOP10_DRAFT_KEY, JSON.stringify(draft));
    showTop10DraftStatus(draft.keyword.trim() || draft.urls.trim() ? draft.savedAt : null);
    return true;
  } catch {
    showTop10DraftStatus(null);
    return false;
  }
}

function restoreTop10Draft() {
  let draft = null;
  try {
    draft = JSON.parse(localStorage.getItem(TOP10_DRAFT_KEY) ?? "null");
  } catch {
    draft = null;
  }
  if (draft && typeof draft === "object") {
    $("t10-keyword").value = typeof draft.keyword === "string" ? draft.keyword : "";
    $("t10-urls").value = typeof draft.urls === "string" ? draft.urls : "";
  }
  showTop10DraftStatus(draft?.savedAt ?? null);
}

function clearTop10Draft() {
  $("t10-keyword").value = "";
  $("t10-urls").value = "";
  try {
    localStorage.removeItem(TOP10_DRAFT_KEY);
  } catch {
    // 保存できない環境では消すものもない
  }
  showTop10DraftStatus(null);
}

function localTop10SavedAt() {
  try {
    return Date.parse(JSON.parse(localStorage.getItem(TOP10_DRAFT_KEY) ?? "null")?.savedAt ?? "") || 0;
  } catch {
    return 0;
  }
}

/** GitHub の下書きがこの端末の下書きより新しければ、そちらを読み込む（別の端末で保存した続き） */
async function syncTop10DraftFromRemote(sha) {
  const remote = await gh.readJson(TOP10_DRAFT_PATH, sha).catch(() => null);
  if (!remote || typeof remote !== "object") return;
  const remoteAt = Date.parse(remote.saved_at ?? "") || 0;
  if (remoteAt <= localTop10SavedAt()) return;
  $("t10-keyword").value = typeof remote.keyword === "string" ? remote.keyword : "";
  $("t10-urls").value = typeof remote.urls === "string" ? remote.urls : "";
  try {
    localStorage.setItem(TOP10_DRAFT_KEY, JSON.stringify({ keyword: $("t10-keyword").value, urls: $("t10-urls").value, savedAt: remote.saved_at }));
  } catch {
    // 端末に保存できなくても、画面には表示できている
  }
  showTop10DraftStatus(remote.saved_at);
}

/** 下書きを GitHub に保存する（PC とスマホで共有）。空にすると「下書きなし」 */
async function pushTop10Draft(message) {
  const sha = await gh.headSha();
  const file = buildTop10Draft({ keyword: $("t10-keyword").value, urlsText: $("t10-urls").value, now: new Date() });
  await gh.commitFiles([file], message, sha);
}

async function onTop10DraftSave() {
  const local = saveTop10Draft();
  if (!gh || !snapshot) {
    toast(local ? "この端末に保存しました（ログインすると PC とスマホで共有できます）" : "保存できませんでした");
    return;
  }
  try {
    await pushTop10Draft("上位10件の下書きを保存（アプリ）");
    saveTop10Draft(); // 共有した時刻を端末側にもそろえる
    toast("途中まで保存しました（PC とスマホで共有）");
  } catch (e) {
    notice(`GitHub に保存できませんでした（この端末には保存済み）:\n${errorText(e)}`);
  }
}

async function onTop10DraftClear() {
  if (!confirm("キーワードと URL の入力を消しますか？（PC とスマホの両方から消えます）")) return;
  clearTop10Draft();
  if (gh && snapshot) {
    try {
      await pushTop10Draft("上位10件の下書きを消去（アプリ）");
    } catch (e) {
      notice(`GitHub の下書きを消せませんでした:\n${errorText(e)}`);
    }
  }
}

let top10DraftTimer;
function onTop10Input() {
  showTop10DraftStatus(null);
  clearTimeout(top10DraftTimer);
  top10DraftTimer = setTimeout(saveTop10Draft, 500);
}

async function saveTop10() {
  if (!gh || !snapshot) return notice("先に「設定」で接続してください");
  try {
    const req = buildTop10Request({ keyword: $("t10-keyword").value, urlsText: $("t10-urls").value, now: new Date() });
    const sha = await gh.headSha();
    // 依頼と一緒に、共有の下書きを空にする（PC とスマホのどちらで開いても、送った内容が残らないように）
    const emptyDraft = buildTop10Draft({ keyword: "", urlsText: "", now: new Date() });
    await gh.commitFiles([req, emptyDraft], `上位10件の調査依頼: ${$("t10-keyword").value.trim()}（アプリ）`, sha);
    clearTop10Draft();
    await reload();
    notice(`保存しました: ${req.path}\nClaude Code に「${req.path} の調査を実行して」と依頼してください`, true);
  } catch (e) {
    notice(`保存できませんでした:\n${errorText(e)}`);
  }
}

// ---------- 設定タブ ----------

function fillSettings() {
  $("s-login-status").textContent = isLoggedIn() ? "ログイン中（8時間ごとに自動で更新）" : "ログインしていません";
  $("s-login").hidden = isLoggedIn();
  $("s-logout").hidden = !isLoggedIn();
  $("s-repo").value = settings.repo ?? "gangidenset/note-growth-team";
  $("s-branch").value = settings.branch ?? "";
  $("s-approver").value = settings.approver ?? "";
}

async function onSaveSettings() {
  settings = {
    repo: $("s-repo").value.trim(),
    branch: $("s-branch").value.trim(),
    approver: $("s-approver").value.trim(),
  };
  if (!saveSettings(settings)) notice("この端末に設定を保存できませんでした（プライベートモードなど）。今回だけ使えます");
  await reload();
  if (gh && snapshot) showTab("articles");
}

async function onLogin() {
  try {
    await startLogin();
  } catch (e) {
    notice(errorText(e));
  }
}

function onLogout() {
  logout();
  fillSettings();
  gh = null;
  snapshot = null;
  notice("ログアウトしました（この端末からログイン情報を消しました）", true);
}

// ---------- タブ ----------

function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== `tab-${name}`;
}

for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
$("reload").addEventListener("click", reload);
$("s-save").addEventListener("click", onSaveSettings);
$("s-login").addEventListener("click", onLogin);
$("s-logout").addEventListener("click", onLogout);
$("t10-save").addEventListener("click", saveTop10);
$("t10-draft-save").addEventListener("click", onTop10DraftSave);
$("t10-draft-clear").addEventListener("click", onTop10DraftClear);
$("t10-keyword").addEventListener("input", onTop10Input);
$("t10-urls").addEventListener("input", onTop10Input);
restoreTop10Draft();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
// 古い版で保存したトークンが残っていれば消す（トークンを入力する方式はやめたため）
if (settings.token) {
  delete settings.token;
  saveSettings(settings);
}
fillSettings();
const shared = readShared();
let loginError = null;
completeLogin()
  .then((loggedIn) => {
    if (loggedIn) fillSettings();
  })
  .catch((e) => {
    loginError = e;
  })
  .then(() => reload())
  .then(() => {
    if (loginError) notice(errorText(loginError)); // 読み込み時のメッセージで上書きされないよう、最後に出す
  if (shared && snapshot) handleShared(shared);
});

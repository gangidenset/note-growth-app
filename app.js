// Note Growth アプリ（PWA）の画面処理。
// データは非公開リポジトリから GitHub API で読み書きする。承認・公開記録はこの端末の持ち主（オーナー）の操作として記録する。
import { AppError, buildApprovalChange, buildFreeUrlChange, buildPerformanceChange, buildPublicationChange, PERFORMANCE_DIR, performanceTargets, articleWatchPaths, changedPaths, buildPaidLinkConfirmChange, membershipStatus, MEMBERSHIP_PLAN_PATH, summarizeQa, buildWriteRequest, WRITE_FORMATS, paidLinkStatus, resolveLinks, isNetworkError, NETWORK_MESSAGE, nextActions, monthlyProgress, MONTHLY_GOAL_JPY, performanceWarnings, summarizePerformance, articleLength, buildThumbnailPrompt, THUMB_STYLES, buildTop10Draft, buildTop10Request, classifyShared, TOP10_DRAFT_PATH, contentHash, countPaywalls, LENGTH_GUIDE, extractNoteUrl, imageRefs, listTreeDir, matchImages, packPendingShare, priceLabel, toNoteText, toZonedIso, unpackPendingShare } from "./domain.js";
import { GitHubError, GitHubRepo } from "./github.js";
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
  if (e instanceof AppError) return e.messages.join("\n");
  if (isNetworkError(e)) return NETWORK_MESSAGE; // 「Failed to fetch」などの英語は出さない
  return e?.message ?? String(e);
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
let snapshot = null; // { sha, tree, articles: [...], performance } 読み込んだ時点のコミットとファイル一覧

function connect() {
  const [owner, repo] = (settings.repo || "gangidenset/note-growth-team").split("/");
  if (!isLoggedIn() || !owner || !repo) {
    gh = null;
    return false;
  }
  gh = new GitHubRepo({
    getToken: getAccessToken,
    owner,
    repo,
    branch: settings.branch || "",
    // ログインが取り消された・期限が切れたときは、ログインのボタンを出す
    onUnauthorized: () => {
      logout();
      fillSettings();
    },
  });
  return true;
}

async function ensureBranch() {
  if (!gh.branch) {
    const info = await gh.info();
    gh.branch = info.default_branch;
  }
}

// ---------- 保存 ----------

function readAudit(base) {
  return gh.readText("data/audit.log.jsonl", base);
}

/** 自動でやり直す回数の上限（Claude Code が続けてプッシュしているときに、いつまでも繰り返さないため） */
const MAX_SAVE_ATTEMPTS = 3;

/**
 * 読み込んだ時点（snapshot）を元に1回のコミットで保存する。
 * 保存の直前にほかから更新されていて断られたら（Claude Code のプッシュなど）、最新の状態を読み、
 * watch に挙げた場所（ファイル、または末尾が / のフォルダ）が変わっていなければ、最新の状態を元に作り直して保存し直す。
 * watch の場所が変わっていたら、上書きせずに止める（承認するのは、読んで確かめた内容だけ）。
 * 監査ログは build の中で、その時点のものを読み直して追記する
 * @param {{ message: string, watch: string[], build: (base: string) => Promise<{ files: { path: string, content: string }[] }> }} opts
 */
async function commitChange({ message, watch, build }) {
  let base = snapshot.sha;
  let tree = snapshot.tree;
  for (let attempt = 1; ; attempt++) {
    const change = await build(base);
    try {
      await gh.commitFiles(change.files, message, base);
      return change;
    } catch (e) {
      if (!(e instanceof GitHubError && e.code === "conflict") || attempt >= MAX_SAVE_ATTEMPTS) throw e;
      const head = await gh.headSha();
      const next = await gh.readTree(head);
      if (!next) throw e;
      const changed = changedPaths(tree, next, watch);
      if (changed.length > 0) {
        throw new Error(`保存しませんでした。読み込んだ後に、この内容が GitHub 側で更新されています（${changed.join("、")}）。右上の ↻ で読み込み直し、内容を確かめてからやり直してください`);
      }
      base = head;
      tree = next;
    }
  }
}

// ---------- 読み込み ----------

/**
 * 全記事を読む。ファイルの一覧（tree）は取得済みなので、ここでの通信は中身の読み込みだけ。
 * 記事どうし・ファイルどうしを並行して読む（同時に行う数は github.js で抑えている）
 */
async function loadArticles(sha, tree) {
  const dirs = listTreeDir(tree, "data/articles").filter((e) => e.type === "dir");
  const loaded = await Promise.all(dirs.map((d) => loadArticle(sha, tree, d.name)));
  const articles = loaded.filter(Boolean);
  articles.sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at));
  return articles;
}

async function loadArticle(sha, tree, id) {
  const dir = `data/articles/${id}`;
  const [meta, free, paid, approval, hashtags, coverPrompt, qa] = await Promise.all([
    gh.treeJson(tree, `${dir}/meta.json`),
    gh.treeText(tree, `${dir}/free.md`),
    gh.treeText(tree, `${dir}/paid.md`),
    gh.treeJson(tree, `data/approvals/${id}.json`),
    gh.treeJson(tree, `${dir}/hashtags.json`).catch(() => null),
    gh.treeJson(tree, `${dir}/cover-prompt.json`).catch(() => null),
    gh.treeJson(tree, `${dir}/qa.json`).catch(() => null),
  ]);
  if (!meta) return null;
  const assets = listTreeDir(tree, `${dir}/assets`).filter((e) => e.type === "file");
  // 無料記事だけの記事（free_only）は、有料記事を空文字としてハッシュする（PC 側の readDrafts と同じ）
  const freeOnly = meta.format === "free_only" || meta.format === "membership";
  const hashPaid = freeOnly ? "" : paid;
  const { images, missing } = matchImages(free, hashPaid, assets);
  const hash =
    free !== null && hashPaid !== null && missing.length === 0
      ? await contentHash({ title: meta.title, price_jpy: meta.price_jpy, free, paid: hashPaid, images })
      : null;
  return { meta, free, paid: freeOnly ? null : paid, hashPaid, freeOnly, approval, hashtags, coverPrompt, qa, images, missingImages: missing, sha, hash, approvalValid: !!approval && approval.content_sha256 === hash };
}

async function reload() {
  if (!connect()) {
    showTab("settings");
    notice(peekPendingShare()
      ? "共有された記事のURLを預かりました。「GitHub でログイン」を押すと、ログインのあと続きから記録できます"
      : "最初に「設定」の「GitHub でログイン」を押してください");
    return;
  }
  notice("読み込み中…", true);
  try {
    await ensureBranch();
    const sha = await gh.headSha();
    const tree = await gh.readTree(sha);
    if (!tree) throw new Error("ファイルの一覧を取得できませんでした（リポジトリが大きすぎます）。Claude Code に知らせてください");
    const [articles, performance, membershipPlan] = await Promise.all([
      loadArticles(sha, tree),
      loadPerformance(tree),
      gh.treeText(tree, MEMBERSHIP_PLAN_PATH).catch(() => null),
    ]);
    snapshot = { sha, tree, articles, performance, membershipPlan };
    renderArticles();
    renderPerformance();
    syncTop10DraftFromRemote(tree).catch(() => {});
    renderData(tree).catch((e) => notice(`データの読み込みに失敗: ${errorText(e)}`));
    notice("");
    // note の「共有」で受け取った内容があれば、読み込めた今、記録の確認に進む
    const pending = takePendingShare();
    if (pending) handleShared(pending);
  } catch (e) {
    notice(`読み込みに失敗しました: ${errorText(e)}${peekPendingShare() ? "\n共有された記事のURLは預かっています。右上の ↻ で読み込み直すと、続きから記録できます" : ""}`);
  }
}

// ---------- 記事タブ ----------

/** 記事タブの一番上に出す「次にやること」。押すとその記事（または実績の入力）を開く */
function nextActionsBlock() {
  const actions = nextActions({ articles: snapshot.articles, performanceIds: snapshot.performance.ids, now: new Date(), membership: currentMembership() });
  if (actions.length === 0) {
    return el("div", { class: "card todo done" }, el("div", { class: "title" }, "次にやること: いまはありません"),
      el("p", { class: "muted" }, "承認・投稿・記録はすべて済んでいます。"));
  }
  const open = (x) => {
    if (x.kind === "performance") {
      showTab("performance");
      renderPerformanceForm();
      return;
    }
    if (x.kind === "membership") {
      document.getElementById("membership-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const a = snapshot.articles.find((y) => y.meta.id === x.article_id);
    if (a) renderArticle(a);
  };
  return el("div", { class: "card todo" },
    el("h2", {}, `次にやること（${actions.length}件）`),
    el("ol", { class: "todo-list" }, ...actions.map((x) => el("li", {},
      el("button", { class: "link", onclick: () => open(x) }, x.text),
      el("div", { class: "meta" }, x.detail),
    ))),
  );
}

function currentMembership() {
  return membershipStatus({ metas: snapshot.articles.map((a) => a.meta), planText: snapshot.membershipPlan, now: new Date() });
}

/** メンバーシップ限定記事の今月の本数と、次の企画（A-13） */
function membershipBlock() {
  const s = currentMembership();
  const request = s.next ? `${MEMBERSHIP_PLAN_PATH} の第${s.next.no}回（${s.next.title}）のメンバーシップ記事を作って` : "メンバーシップの記事を企画して";
  return el("div", { class: "card", id: "membership-card" },
    el("div", { class: "row-between" },
      el("h3", { class: "flush" }, "メンバーシップ限定記事"),
      el("span", { class: s.published >= s.goal ? "badge published" : "badge awaiting_approval" }, `今月 ${s.published}/${s.goal}本`)),
    s.published_titles.length > 0 && el("div", { class: "meta" }, `今月公開: ${s.published_titles.join("、")}`),
    ...s.in_progress.map((m) => el("div", { class: "meta" }, `作成中: ${m.title}（${STATUS_LABEL[m.status] ?? m.status}）`)),
    s.next
      ? el("div", {}, el("div", { class: "meta" }, `次の企画: 第${s.next.no}回${s.next.when ? `（${s.next.when}）` : ""}`), el("div", { class: "title" }, s.next.title))
      : el("p", { class: "muted" }, s.plan_count > 0 ? "企画はすべて記事になりました。" : "企画がまだありません。"),
    s.in_progress.length === 0 && el("div", { class: "row" }, el("button", { class: "secondary", onclick: () => copy(request, "Claude Code への依頼文") }, "Claude Code への依頼文をコピー")),
    s.in_progress.length === 0 && el("p", { class: "muted" }, `コピーされる文: 「${request}」`),
    el("p", { class: "muted" }, "企画と記事は「作った順の◯本目 ＝ 第◯回」として対応させています（仮定）。順番を入れ替えたときは表示がずれます。"),
  );
}

/** 公開済みの記事の、無料記事 → 有料記事のリンクの一覧（A-14）。対象がなければ出さない */
function linksBlock() {
  const rows = paidLinkStatus(snapshot.articles);
  if (rows.length === 0) return null;
  const missing = rows.filter((r) => r.state === "missing").length;
  const label = { marker: "本文に入っている", confirmed: "note で足した", missing: "まだない" };
  return el("details", { class: "card" },
    el("summary", {}, `無料記事 → 有料記事のリンク（${rows.length}件中 ${missing}件 まだ）`),
    el("ul", { class: "plain" }, ...rows.map((r) => el("li", {},
      el("span", { class: r.state === "missing" ? "badge awaiting_approval" : "badge published" }, label[r.state]),
      el("button", { class: "link", onclick: () => renderArticle(snapshot.articles.find((a) => a.meta.id === r.id)) }, r.title),
      r.confirmed_at && el("div", { class: "meta" }, `記録: ${r.confirmed_at}`),
    ))),
    el("p", { class: "muted" }, "これから書く記事は、無料記事の本文に「＝＝ 有料記事のリンク ＝＝」の印を入れておくと、投稿モードのコピーで有料記事の URL に置き換わります。"),
  );
}

function renderArticles() {
  const root = $("tab-articles");
  root.replaceChildren();
  const waiting = snapshot.articles.filter((a) => a.meta.status === "awaiting_approval").length;
  root.append(nextActionsBlock());
  root.append(membershipBlock());
  const links = linksBlock();
  if (links) root.append(links);
  root.append(el("h2", {}, `記事（${snapshot.articles.length}件）`, waiting ? ` ・承認待ち ${waiting}件` : ""));
  if (snapshot.articles.length === 0) root.append(el("p", { class: "muted" }, "記事はまだありません"));
  for (const a of snapshot.articles) {
    const m = a.meta;
    const stale = (m.status === "approved" || m.status === "published") && !a.approvalValid;
    root.append(
      el("div", { class: "card" },
        el("div", {}, el("span", { class: `badge ${m.status}` }, STATUS_LABEL[m.status] ?? m.status),
          el("span", { class: "meta" }, priceLabel(m))),
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
    el("div", { class: "meta" }, `${STATUS_LABEL[m.status] ?? m.status} ・ ${priceLabel(m)} ・ ${m.id}`),
    m.published_url && el("div", { class: "meta" }, a.freeOnly ? "公開した記事: " : "有料記事: ", el("a", { href: m.published_url, target: "_blank", rel: "noopener" }, m.published_url)),
    m.free_url && el("div", { class: "meta" }, "無料記事: ", el("a", { href: m.free_url, target: "_blank", rel: "noopener" }, m.free_url)),
    el("div", { class: "meta" }, `内容ハッシュ: ${a.hash ?? "(本文または画像がそろっていません)"}`),
    lengthLine(a),
    a.paid !== null && countPaywalls(a.paid) !== 1 && el("div", { class: "warn" }, "有料記事の境目（paywall）がちょうど1つではありません"),
  ].filter(Boolean)); // 条件に合わない要素（null / false）は表示しない

  if (["qa", "needs_revision", "awaiting_approval"].includes(m.status)) {
    const qa = qaBlock(a.qa, m.status !== "awaiting_approval");
    if (qa) root.append(qa);
  }
  const actions = el("div", { class: "row" });
  if (m.status === "awaiting_approval") actions.append(el("button", { onclick: () => approveDialog(a) }, "内容を確認して承認する"));
  root.append(actions);
  if (m.status === "approved" && !a.approvalValid) {
    root.append(el("div", { class: "warn" }, "承認後に本文が変わっています。Claude Code に「承認待ちに戻して」と依頼し、再承認してください"));
  }
  const link = paidLinkStatus([a])[0];
  if (link && link.state !== "marker") root.append(paidLinkCard(a, link));
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
  const metas = snapshot.articles.map((x) => x.meta);
  // 記事どうしのリンクの印を、記録済みの公開URLに置き換える（承認した本文の印が URL になるだけ）
  const noteText = (md) => {
    if (md === null) return null;
    const t = toNoteText(md);
    const r = resolveLinks(t.body, m, metas);
    return { title: t.title, body: r.body, missing: r.missing };
  };
  const paid = noteText(a.paid);
  const free = noteText(a.free);
  const linkWarn = (t) => t && t.missing.length > 0 &&
    el("div", { class: "warn" }, `リンク先の公開URLがまだ記録されていません（${t.missing.join("、")}）。本文の「＝＝ ここに…のURLを貼る ＝＝」の行を、あとで URL に置き換えてください。${t.missing.includes("有料記事") ? "先に有料記事を投稿して記録すると、自動で入ります。" : ""}`);
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
        linkWarn(free),
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
          el("div", { class: "big" }, m.format === "membership" ? "メンバーシップ限定で公開（note の公開設定で「メンバーシップ」を選ぶ）" : "無料のまま公開（この記事は無料記事だけ）"),
          free && el("button", { class: "secondary", onclick: () => coverDialog(free.title, "free", `${m.id}-free-cover.png`, a.coverPrompt?.free) }, "見出し画像を作る"),
          linkWarn(free),
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

/** 公開済みの無料記事に、note の編集画面で有料記事のリンクを足す手順（A-14。本文は変えないので再承認は不要） */
function paidLinkCard(a, link) {
  const m = a.meta;
  if (link.state === "confirmed") {
    return el("div", { class: "card" }, el("h3", {}, "無料記事 → 有料記事のリンク"), el("div", { class: "meta" }, `✓ note で足した（記録: ${link.confirmed_at}）`));
  }
  return el("div", { class: "card todo" },
    el("h3", {}, "無料記事に、有料記事のリンクを足す"),
    el("p", { class: "muted" }, "無料記事の読者が、有料記事へ1回で移れるようにします。note の上で自分の記事の URL を足すだけなので、承認のやり直しは要りません（オーナー決定 2026-11-17）。"),
    el("ol", { class: "help" },
      el("li", {}, "下の「有料記事の URL をコピー」を押す"),
      el("li", {}, m.free_url ? "「無料記事を開く」から note で無料記事を開き、「編集」を押す" : "note で無料記事を開き、「編集」を押す"),
      el("li", {}, "「有料記事の案内」の段落（「記事一覧から読める」の文）のすぐ下に、URL だけの行を貼る（note ではカードで表示されます）"),
      el("li", {}, "「更新する」を押して、カードが表示されるか確かめる"),
      el("li", {}, "このアプリに戻って「足した」を押す"),
    ),
    el("div", { class: "row" },
      el("button", { onclick: () => copy(m.published_url, "有料記事の URL") }, "有料記事の URL をコピー"),
      m.free_url && el("a", { class: "button secondary", href: m.free_url, target: "_blank", rel: "noopener" }, "無料記事を開く"),
      el("button", { class: "secondary", onclick: () => paidLinkDialog(a) }, "足した"),
    ),
  );
}

function paidLinkDialog(a) {
  const m = a.meta;
  const ok = el("button", {}, "記録する");
  const d = openDialog(
    el("h2", {}, "リンクを足したことの記録"),
    el("div", { class: "meta" }, m.title),
    el("p", {}, "note の無料記事に、有料記事のリンクを足して「更新する」まで済ませましたか？"),
    el("div", { class: "row" }, ok, el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
  );
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    try {
      await commitChange({
        message: `${m.id} の無料記事に有料記事のリンクを足したことを記録（アプリ）`,
        watch: articleWatchPaths(m.id),
        build: async (base) => buildPaidLinkConfirmChange({ meta: m, auditText: await readAudit(base), now: new Date() }),
      });
      d.close();
      await reload();
      notice(`記録しました（${m.id}）`, true);
    } catch (e) {
      d.close();
      notice(`記録できませんでした:\n${errorText(e)}`);
    }
  });
}

/** 品質チェック（qa.json）の結論と指摘（A-19）。collapsed なら詳細を閉じた状態で出す */
function qaBlock(qa, collapsed) {
  const s = summarizeQa(qa);
  if (!s) return el("div", { class: "warn" }, "品質チェックの記録（qa.json）がありません");
  const fails = s.issues.filter((i) => i.kind === "fail").length;
  const list = s.issues.length === 0
    ? el("p", { class: "muted" }, "指摘はありません。")
    : el("ul", { class: "plain" }, ...s.issues.map((i) => el("li", {},
        el("span", { class: i.kind === "fail" ? "badge awaiting_approval" : "badge" }, `${i.id} ${i.severity_label}`),
        el("span", { class: "title" }, i.label),
        i.note && el("div", { class: "meta" }, i.note),
      )));
  const body = [
    el("div", { class: "meta" }, `${s.checked_by} ・ ${s.checked_at} ・ 合格 ${s.pass_count}/${s.total}項目${fails ? ` ・ 指摘 ${fails}件` : ""}`),
    list,
  ];
  const summary = `品質チェック: ${s.verdict_label}${s.issues.length ? `（確認したい点 ${s.issues.length}件）` : ""}`;
  return collapsed
    ? el("details", { class: "card" }, el("summary", {}, summary), ...body)
    : el("div", { class: s.ok ? "card" : "card todo" }, el("div", { class: "title" }, summary), ...body);
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
    el("p", {}, `${a.freeOnly ? "本文" : "無料記事・有料記事の本文"}を最後まで読みましたか？ 承認後に本文が1文字でも変わると、承認は無効になります。`),
    el("div", { class: "meta" }, `タイトル: ${m.title}`),
    el("div", { class: "meta" }, `価格: ${priceLabel(m)}`),
    el("div", { class: "meta" }, `内容ハッシュ: ${a.hash}`),
    qaBlock(a.qa, false),
    el("label", {}, `承認するには記事ID（${m.id}）を入力`, input),
    el("div", { class: "row" }, ok, el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
  );
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    try {
      await commitChange({
        message: `${m.id} を承認（アプリ）`,
        watch: articleWatchPaths(m.id),
        build: async (base) => buildApprovalChange({ meta: m, free: a.free, paid: a.hashPaid, images: a.images, missingImages: a.missingImages, auditText: await readAudit(base), approver: settings.approver, now: new Date() }),
      });
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
    await commitChange({
      message: `${a.meta.id} の無料記事URLを記録（アプリ）`,
      watch: articleWatchPaths(a.meta.id),
      build: async (base) => buildFreeUrlChange({ meta: a.meta, url, auditText: await readAudit(base), now: new Date() }),
    });
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
    await commitChange({
      message: `${a.meta.id} を公開（アプリ）`,
      watch: articleWatchPaths(a.meta.id),
      build: async (base) => buildPublicationChange({ meta: a.meta, free: a.free, paid: a.hashPaid, images: a.images, missingImages: a.missingImages, approval: a.approval, auditText: await readAudit(base), url, now: new Date() }),
    });
    dialog?.close();
    await reload();
    notice(`${a.freeOnly ? "記事" : "有料記事"}の公開を記録しました（${a.meta.id}）`, true);
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

// 共有された内容は、ログインや読み込みが済むまで端末に預ける。
// （ログインが切れていると github.com へ移動して戻ってくるので、画面の中に持っているだけでは消えてしまう）
const PENDING_SHARE_KEY = "ngt-pending-share";
let pendingShareMemory = null; // 端末に保存できない環境（プライベートモードなど）のための控え

function savePendingShare(shared) {
  pendingShareMemory = packPendingShare(shared, new Date());
  try {
    localStorage.setItem(PENDING_SHARE_KEY, pendingShareMemory);
  } catch {
    // 保存できなくても、この画面を開いている間は pendingShareMemory で続けられる
  }
}

function peekPendingShare() {
  let stored = pendingShareMemory;
  try {
    stored = localStorage.getItem(PENDING_SHARE_KEY) ?? stored;
  } catch {
    // 読めない環境では控えを使う
  }
  return unpackPendingShare(stored, new Date());
}

/** 預けた共有内容を取り出して消す（同じ共有を2回処理しない） */
function takePendingShare() {
  const shared = peekPendingShare();
  pendingShareMemory = null;
  try {
    localStorage.removeItem(PENDING_SHARE_KEY);
  } catch {
    // 消せなくても、1時間たてば無効になる
  }
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

// ---------- 実績タブ ----------
// オーナーが note のダッシュボードで見た数字を記録する（自分のアカウントの数字だけ。data/performance/<日付>.json）。
// 数字は「これまでの合計」をそのまま入れ、前回との差はここで計算して見せる。

/** 読み込む記録の数（新しい順）。表示に使うのは最新とその前だけなので、古いものまでは読まない */
const PERFORMANCE_KEEP = 12;

async function loadPerformance(tree) {
  const files = listTreeDir(tree, PERFORMANCE_DIR).filter((e) => e.type === "file" && /^\d{4}-\d{2}-\d{2}\.json$/.test(e.name));
  const recent = files.slice(-PERFORMANCE_KEEP);
  const records = await Promise.all(recent.map((f) => gh.treeJson(tree, `${PERFORMANCE_DIR}/${f.name}`).catch(() => null)));
  // ids は全部の記録の日付（「前回の記録から何日」に使う。中身は読まない）
  return { records: records.filter(Boolean), broken: records.filter((r) => !r).length, total: files.length, ids: files.map((f) => f.name.slice(0, 10)) };
}

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("ja-JP") : "—");

/** 前回との差（増えたら緑）。差が出せないときは何も出さない */
function deltaEl(d, unit = "") {
  if (typeof d !== "number") return null;
  return el("span", { class: `delta${d > 0 ? " up" : ""}` }, `${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmt(Math.abs(d))}${unit}`);
}

function statTile(label, value, d, unit = "") {
  return el("div", { class: "stat" },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, `${fmt(value)}${typeof value === "number" ? unit : ""}`),
    el("div", { class: "delta" }, typeof d === "number" ? ["前回から ", deltaEl(d, unit)] : "\u00a0"),
  );
}

/** 進み具合のバー。CSP（style-src 'self'）で style 属性は使えないため、幅は JS から直接設定する */
function barOf(pct) {
  const bar = el("div", { class: "bar" });
  bar.style.width = `${pct}%`;
  return bar;
}

/** 今月の売上の計算値と、月5万円の目標までの進み具合 */
function monthlyBlock(records, metas) {
  const p = monthlyProgress(records, metas, new Date());
  const month = toZonedIso(new Date()).slice(0, 7);
  if (!p) {
    return el("div", { class: "card" }, el("h3", {}, `今月（${month}）の売上`),
      el("p", { class: "muted" }, `今月の記録がまだありません。記録すると、目標（月${fmt(MONTHLY_GOAL_JPY)}円）までの進み具合が出ます。`));
  }
  const pct = Math.min(100, Math.round((p.revenue_calc_jpy / p.goal_jpy) * 100));
  return el("div", { class: "card" },
    el("h3", {}, `今月（${p.month}）の売上（計算値）`),
    el("div", { class: "big" }, `${fmt(p.revenue_calc_jpy)}円 `, el("span", { class: "meta" }, `／ 目標 ${fmt(p.goal_jpy)}円`)),
    el("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": "目標までの進み具合" },
      barOf(pct)),
    el("div", { class: "meta" }, p.remaining_jpy > 0 ? `目標まで あと ${fmt(p.remaining_jpy)}円（${pct}%）` : "目標に届きました", ` ・ 今月の販売 ${fmt(p.sales_count)}件 ・ ${p.latest_id} の記録まで`),
    p.partial_since && el("div", { class: "warn" }, `先月までの記録がない記事は、${p.partial_since} の記録から数えています。それより前の今月の売上は入っていません（実際より少なく出ます）。`),
    el("p", { class: "muted" }, "「今月増えた販売件数 × 今の価格」の計算値で、手数料を引く前の金額です。メンバーシップの会費は含みません。正確な金額は note の「売上管理」で確認してください。"),
  );
}

function renderPerformance() {
  const root = $("tab-performance");
  const metas = snapshot.articles.map((a) => a.meta);
  const targets = performanceTargets(metas);
  const { records, broken } = snapshot.performance;
  const s = summarizePerformance(records, metas);
  const children = [el("h2", {}, "実績（自分の note の数字）")];

  if (targets.length === 0) {
    children.push(el("p", { class: "muted" }, "公開を記録した記事がまだありません。記事を公開して記録すると、ここで数字を記録できます。"));
    root.replaceChildren(...children);
    return;
  }
  children.push(el("div", { class: "row" }, el("button", { onclick: renderPerformanceForm }, s ? "今の数字を記録する" : "最初の数字を記録する")));
  if (broken > 0) children.push(el("div", { class: "warn" }, `読めない記録が ${broken}件あります。Claude Code に「npm run data:check を実行して」と依頼してください`));

  if (!s) {
    children.push(el("p", { class: "muted" }, "まだ記録がありません。週に1回、note のダッシュボードの数字を記録すると、前回からの伸びが分かります。"));
    root.replaceChildren(...children);
    return;
  }
  const t = s.totals;
  children.push(monthlyBlock(records, metas));
  children.push(
    el("p", { class: "meta" }, `最新の記録: ${s.latest_id}`, s.previous_id ? `（前回: ${s.previous_id}）` : "（前回の記録はまだありません）"),
    el("div", { class: "stats" },
      statTile("売上（計算値）", t.revenue_calc_jpy, t.d_revenue_calc_jpy, "円"),
      statTile("販売件数", t.sales_count, t.d_sales_count, "件"),
      statTile("ページビュー", t.views, t.d_views),
      statTile("スキ", t.likes, t.d_likes),
      statTile("フォロワー", s.account.followers, s.account.d_followers, "人"),
      statTile("メンバーシップ会員", s.account.membership_members, s.account.d_membership_members, "人"),
    ),
    el("p", { class: "muted" }, "数字はどれも「これまでの合計」です。売上は「販売件数 × 今の価格」の計算値で、手数料を引く前の金額です（メンバーシップの会費は含みません）。記録していない数字は「—」で、合計にも入れていません。"),
    el("h3", {}, "記事ごと"),
    ...s.rows.map((r) => el("div", { class: "card" },
      el("div", {}, el("span", { class: "badge" }, r.part_label), r.price_jpy ? el("span", { class: "meta" }, `${fmt(r.price_jpy)}円`) : null),
      el("div", { class: "title" }, r.title),
      el("div", { class: "meta" },
        `ページビュー ${fmt(r.views)} `, deltaEl(r.d_views), ` ・ スキ ${fmt(r.likes)} `, deltaEl(r.d_likes),
        r.part === "paid" ? [` ・ 販売 ${fmt(r.sales_count)}${typeof r.sales_count === "number" ? "件" : ""} `, deltaEl(r.d_sales_count)] : null),
      r.revenue_calc_jpy !== null && el("div", { class: "meta" }, `売上（計算値） ${fmt(r.revenue_calc_jpy)}円`),
    )),
    s.notes && el("p", { class: "muted" }, `メモ: ${s.notes}`),
  );
  root.replaceChildren(...children.flat().filter(Boolean));
}

// 入力の途中で note のアプリに切り替えても消えないよう、入力のたびに端末に保存する（その日のうちだけ有効）
const PERF_DRAFT_KEY = "ngt-performance-draft";

function loadPerfDraft(today) {
  try {
    const d = JSON.parse(localStorage.getItem(PERF_DRAFT_KEY) ?? "null");
    return d && d.date === today && d.fields && typeof d.fields === "object" ? d.fields : null;
  } catch {
    return null;
  }
}

function savePerfDraft(today, fields) {
  try {
    if (fields === null) localStorage.removeItem(PERF_DRAFT_KEY);
    else localStorage.setItem(PERF_DRAFT_KEY, JSON.stringify({ date: today, fields }));
  } catch {
    // 保存できなくても入力は続けられる
  }
}

function renderPerformanceForm() {
  const root = $("tab-performance");
  const metas = snapshot.articles.map((a) => a.meta);
  const targets = performanceTargets(metas);
  const sorted = [...snapshot.performance.records].sort((a, b) => a.id.localeCompare(b.id));
  const today = toZonedIso(new Date()).slice(0, 10);
  const sameDay = sorted.find((r) => r.id === today) ?? null; // 今日すでに記録していれば、その続き（上書き）
  const previous = sorted.filter((r) => r.id !== today).at(-1) ?? null;
  const draft = loadPerfDraft(today);
  const entryOf = (rec, key) => rec?.articles?.find((e) => `${e.article_id}/${e.part}` === key) ?? null;

  /** @type {Record<string, HTMLInputElement>} */
  const inputs = {};
  const numberInput = (name, label, saved, before) => {
    const input = el("input", { type: "text", inputmode: "numeric", autocomplete: "off", placeholder: typeof before === "number" ? `前回 ${fmt(before)}` : "" });
    input.value = draft?.[name] ?? (typeof saved === "number" ? String(saved) : "");
    input.addEventListener("input", () => savePerfDraft(today, Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]))));
    inputs[name] = input;
    return el("label", {}, label, input);
  };

  const cards = targets.map((t) => {
    const saved = entryOf(sameDay, t.key);
    const before = entryOf(previous, t.key);
    return el("div", { class: "card" },
      el("div", {}, el("span", { class: "badge" }, t.part_label), t.price_jpy ? el("span", { class: "meta" }, `${fmt(t.price_jpy)}円`) : null),
      el("div", { class: "title" }, t.title),
      el("div", { class: "meta" }, el("a", { href: t.url, target: "_blank", rel: "noopener" }, "note で記事を開く")),
      el("div", { class: "nums" },
        numberInput(`${t.key}/views`, "ページビュー", saved?.views, before?.views),
        numberInput(`${t.key}/likes`, "スキ", saved?.likes, before?.likes),
        t.part === "paid" ? numberInput(`${t.key}/sales_count`, "販売件数", saved?.sales_count, before?.sales_count) : null),
    );
  });
  const notes = el("input", { type: "text", autocomplete: "off", placeholder: "例: X で告知した週" });
  notes.value = draft?.notes ?? sameDay?.notes ?? "";
  inputs.notes = notes;
  notes.addEventListener("input", () => savePerfDraft(today, Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]))));

  const save = el("button", {}, "記録を保存");
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const values = Object.fromEntries(targets.map((t) => [t.key, {
        views: inputs[`${t.key}/views`].value,
        likes: inputs[`${t.key}/likes`].value,
        sales_count: inputs[`${t.key}/sales_count`]?.value ?? "",
      }]));
      const change = buildPerformanceChange({
        metas,
        values,
        account: { followers: inputs["account/followers"].value, membership_members: inputs["account/membership_members"].value },
        notes: notes.value,
        now: new Date(),
      });
      const warnings = performanceWarnings(change.record, previous);
      if (warnings.length > 0 && !confirm(`打ち間違いではありませんか？\n\n${warnings.join("\n")}\n\nこのまま保存するなら OK を押してください`)) {
        save.disabled = false;
        return;
      }
      // 同じ日の記録を、ほかの端末が読み込んだ後に保存していたら、上書きせずに止める
      await commitChange({ message: `実績を記録: ${change.record.id}（アプリ）`, watch: change.files.map((f) => f.path), build: async () => change });
      savePerfDraft(today, null);
      await reload();
      notice(`実績を記録しました（${change.record.id}）`, true);
    } catch (e) {
      save.disabled = false;
      notice(`記録できませんでした:\n${errorText(e)}`);
    }
  });

  root.replaceChildren(...[
    el("button", { class: "secondary", onclick: renderPerformance }, "← 実績へ"),
    el("h2", {}, `数字を記録する（${today}）`),
    el("ul", { class: "help" },
      el("li", {}, "note のダッシュボードで見た数字を、「これまでの合計」で入れてください（前回からの伸びはアプリが計算します）"),
      el("li", {}, "分からない数字は空欄のままにしてください。空欄は「記録なし」として扱い、0 にはしません"),
      el("li", {}, "入力はこの端末に自動で保存されます。note を見に行って戻ってきても消えません"),
    ),
    sameDay && el("div", { class: "warn" }, "今日はすでに記録があります。保存すると今日の記録を上書きします。"),
    el("h3", {}, "アカウント全体"),
    el("div", { class: "card" }, el("div", { class: "nums" },
      numberInput("account/followers", "フォロワー", sameDay?.account?.followers, previous?.account?.followers),
      numberInput("account/membership_members", "メンバーシップ会員", sameDay?.account?.membership_members, previous?.account?.membership_members),
    )),
    el("h3", {}, `記事ごと（${targets.length}件）`),
    ...cards,
    el("label", {}, "メモ（任意）", notes),
    el("div", { class: "row" }, save, el("button", { class: "secondary", onclick: renderPerformance }, "やめる")),
  ].filter(Boolean));
  window.scrollTo({ top: 0 });
}

// ---------- データタブ ----------

function readAll(dir, tree) {
  const files = listTreeDir(tree, dir).filter((e) => e.type === "file" && e.name.endsWith(".json"));
  return Promise.all(files.map((f) => gh.treeJson(tree, `${dir}/${f.name}`).catch(() => ({ id: f.name, _broken: true }))));
}

async function renderData(tree) {
  const root = $("tab-data");
  root.replaceChildren(el("p", { class: "muted" }, "読み込み中…"));
  const [themes, gaps] = await Promise.all([readAll("data/themes", tree), readAll("data/gaps", tree)]);
  const market = listTreeDir(tree, "data/market");
  const requests = listTreeDir(tree, "data/requests");
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
        !t._broken && t.id && el("div", { class: "row" },
          ...Object.entries(WRITE_FORMATS).map(([format, label]) =>
            el("button", { class: "secondary small", onclick: () => writeRequestDialog(t, format) }, `${label}で書いて`))),
      )),
    el("h2", {}, `調査依頼（${reqFiles.length}件）`),
    el("ul", { class: "plain" }, ...reqFiles.map((n) => el("li", {}, n))),
    el("h2", {}, `市場データ（${marketFiles.length}件、新しい順に20件）`),
    el("ul", { class: "plain" }, ...marketFiles.slice(0, 20).map((n) => el("li", {}, n))),
  ].filter(Boolean));
}

/** テーマと記事の形を選んで、Claude Code への執筆依頼を保存する（A-15） */
function writeRequestDialog(theme, format) {
  const price = el("input", { type: "text", inputmode: "numeric", autocomplete: "off", placeholder: "空欄なら担当が決める" });
  if (typeof theme.price_plan_jpy === "number") price.value = String(theme.price_plan_jpy);
  const memo = el("textarea", { rows: "4", placeholder: "例: 前半は失敗談から。図は2枚くらい" });
  const ok = el("button", {}, "依頼を保存");
  const d = openDialog(
    el("h2", {}, "執筆を依頼"),
    el("div", { class: "title" }, theme.title ?? theme.id),
    el("div", { class: "big" }, WRITE_FORMATS[format]),
    format === "free_and_paid" && el("label", {}, "有料記事の価格（円）", price),
    format === "membership" && el("p", { class: "muted" }, "メンバーシップ限定の記事は価格なし。note でメンバー限定として公開します。"),
    el("label", {}, "メモ（任意。書いてほしいこと・入れてほしい経験など）", memo),
    el("div", { class: "row" }, ok, el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
  );
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    try {
      const req = buildWriteRequest({ theme, format, priceText: price.value, memo: memo.value, now: new Date() });
      await commitChange({ message: `執筆依頼: ${theme.id}（${WRITE_FORMATS[format]}、アプリ）`, watch: [], build: async () => ({ files: [req] }) });
      const ask = `${req.path} の依頼を実行して`;
      openDialog(
        el("h2", {}, "依頼を保存しました"),
        el("p", {}, "Claude Code に、次の文を送ってください。"),
        el("pre", { class: "body" }, ask),
        el("div", { class: "row" },
          el("button", { onclick: () => copy(ask, "依頼文") }, "依頼文をコピー"),
          el("button", { class: "secondary", onclick: () => $("dialog").close() }, "閉じる")),
      );
      reload();
    } catch (e) {
      ok.disabled = false;
      notice(`保存できませんでした:\n${errorText(e)}`);
      d.close();
    }
  });
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
async function syncTop10DraftFromRemote(tree) {
  const remote = await gh.treeJson(tree, TOP10_DRAFT_PATH).catch(() => null);
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
  const file = buildTop10Draft({ keyword: $("t10-keyword").value, urlsText: $("t10-urls").value, now: new Date() });
  // 下書きは最後に保存したものが残る（今までどおり）。ほかの更新と重なっても、そのままやり直す
  await commitChange({ message, watch: [], build: async () => ({ files: [file] }) });
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
    // 依頼と一緒に、共有の下書きを空にする（PC とスマホのどちらで開いても、送った内容が残らないように）
    const emptyDraft = buildTop10Draft({ keyword: "", urlsText: "", now: new Date() });
    await commitChange({ message: `上位10件の調査依頼: ${$("t10-keyword").value.trim()}（アプリ）`, watch: [], build: async () => ({ files: [req, emptyDraft] }) });
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
  takePendingShare(); // 預かっていた共有内容も消す
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
if (shared) savePendingShare(shared);
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
  });

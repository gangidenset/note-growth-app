// Note Growth アプリ（PWA）の画面処理。
// データは非公開リポジトリから GitHub API で読み書きする。承認・公開記録はこの端末の持ち主（オーナー）の操作として記録する。
import { AppError, buildApprovalChange, buildFreeUrlChange, buildPublicationChange, buildTop10Request, classifyShared, contentHash, countPaywalls, extractNoteUrl, toNoteText } from "./domain.js";
import { GitHubRepo } from "./github.js";
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

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    notice(`${label}をコピーしました`, true);
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
  const [owner, repo] = (settings.repo ?? "").split("/");
  if (!settings.token || !owner || !repo) {
    gh = null;
    return false;
  }
  gh = new GitHubRepo({ token: settings.token, owner, repo, branch: settings.branch || "" });
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
    const [free, paid, approval] = await Promise.all([
      gh.readText(`data/articles/${d.name}/free.md`, sha),
      gh.readText(`data/articles/${d.name}/paid.md`, sha),
      gh.readJson(`data/approvals/${d.name}.json`, sha),
    ]);
    const hash = free !== null && paid !== null ? await contentHash({ title: meta.title, price_jpy: meta.price_jpy, free, paid }) : null;
    articles.push({ meta, free, paid, approval, hash, approvalValid: !!approval && approval.content_sha256 === hash });
  }
  articles.sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at));
  return articles;
}

async function reload() {
  if (!connect()) {
    showTab("settings");
    notice("最初に「設定」で GitHub トークンとリポジトリを入力してください");
    return;
  }
  notice("読み込み中…", true);
  try {
    await ensureBranch();
    const sha = await gh.headSha();
    snapshot = { sha, articles: await loadArticles(sha) };
    renderArticles();
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

function renderArticle(a) {
  const m = a.meta;
  const root = $("tab-articles");
  root.replaceChildren(...[
    el("button", { class: "secondary", onclick: renderArticles }, "← 一覧へ"),
    el("h2", {}, m.title || m.id),
    el("div", { class: "meta" }, `${STATUS_LABEL[m.status] ?? m.status} ・ ${m.price_jpy ?? "価格未定"}円 ・ ${m.id}`),
    m.published_url && el("div", { class: "meta" }, "有料記事: ", el("a", { href: m.published_url, target: "_blank", rel: "noopener" }, m.published_url)),
    m.free_url && el("div", { class: "meta" }, "無料記事: ", el("a", { href: m.free_url, target: "_blank", rel: "noopener" }, m.free_url)),
    el("div", { class: "meta" }, `内容ハッシュ: ${a.hash ?? "(本文がそろっていません)"}`),
    a.paid !== null && countPaywalls(a.paid) !== 1 && el("div", { class: "warn" }, "有料記事の境目（paywall）がちょうど1つではありません"),
  ].filter(Boolean)); // 条件に合わない要素（null / false）は表示しない

  const actions = el("div", { class: "row" });
  if (m.status === "awaiting_approval") actions.append(el("button", { onclick: () => approveDialog(a) }, "内容を確認して承認する"));
  root.append(actions);
  if (m.status === "approved" && !a.approvalValid) {
    root.append(el("div", { class: "warn" }, "承認後に本文が変わっています。Claude Code に「承認待ちに戻して」と依頼し、再承認してください"));
  }
  if ((m.status === "approved" && a.approvalValid) || m.status === "published") root.append(postingGuide(a));
  if (m.status !== "approved" && m.status !== "published") root.append(copyBlock("有料記事", a.paid), copyBlock("無料記事", a.free));
}

const NOTE_NEW_POST = "https://note.com/notes/new";

/** タイトルをコピーしてから note の新規投稿画面を開く（クリップボードには1つしか入らないため、本文は次のボタンで） */
async function copyTitleAndOpenNote(title, label) {
  await copy(title, `${label}のタイトル`);
  window.open(NOTE_NEW_POST, "_blank", "noopener");
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
        paid && el("button", { class: "secondary", onclick: () => coverDialog(paid.title, "paid", `${m.id}-paid-cover.png`) }, "見出し画像を作る"),
        el("div", { class: "warn" }, "本文中の「＝＝＝＝＝ ここに note の有料ラインを入れる ＝＝＝＝＝」の行を消し、その位置に有料ラインを入れる（筆者紹介のすぐ下）"),
        paid && el("div", { class: "row" },
          el("button", { onclick: () => copyTitleAndOpenNote(paid.title, "有料記事") }, "① タイトルをコピーして note を開く"),
          el("button", { class: "secondary", onclick: () => copy(paid.body, "有料記事の本文") }, "② 本文をコピー"),
        ),
        el("p", { class: "muted" }, "note でタイトル欄に貼る → アプリに戻って②を押す → 本文に貼る → 有料ラインと価格を設定 → 公開"),
        paid && el("details", {}, el("summary", {}, "本文を確認する"), el("pre", { class: "body" }, paid.body)),
      );

  const freeStep = m.free_url
    ? step(2, "無料記事", done(m.free_url))
    : step(2, "無料記事を投稿する",
        el("div", { class: "big" }, "無料のまま公開"),
        free && el("button", { class: "secondary", onclick: () => coverDialog(free.title, "free", `${m.id}-free-cover.png`) }, "見出し画像を作る"),
        free && el("div", { class: "row" },
          el("button", { onclick: () => copyTitleAndOpenNote(free.title, "無料記事") }, "① タイトルをコピーして note を開く"),
          el("button", { class: "secondary", onclick: () => copy(free.body, "無料記事の本文") }, "② 本文をコピー"),
        ),
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
    paid && el("button", { class: "secondary", onclick: () => coverDialog(paid.title, "paid", `${m.id}-paid-cover.png`) }, "有料記事の見出し画像"),
    free && el("button", { class: "secondary", onclick: () => coverDialog(free.title, "free", `${m.id}-free-cover.png`) }, "無料記事の見出し画像"),
  );

  return el("div", {},
    el("h3", {}, "投稿モード"),
    coverRow,
    paidStep, freeStep, recordStep,
    el("p", { class: "muted" }, "CLAUDE.md などの「.md」は note で自動リンクになることがあります。リンクは外してください（見た目の調整なので再承認は不要）。"),
  );
}

function openDialog(...children) {
  const d = $("dialog");
  d.replaceChildren(...children);
  d.showModal();
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
      const change = await buildApprovalChange({ meta: m, free: a.free, paid: a.paid, auditText: audit, approver: settings.approver, now: new Date() });
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
    el("p", {}, "note に投稿した有料記事のURLを入れてください。"),
    el("label", {}, "有料記事のURL", url),
    el("label", {}, "よろしければ yes と入力", confirm),
    el("div", { class: "row" }, ok, el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
  );
  ok.addEventListener("click", () => {
    ok.disabled = true;
    savePublication(a, url.value, d);
  });
}

/** 見出し画像（1280×670）を作って保存する。文字は編集できる */
function coverDialog(title, variant, filename) {
  const { main, sub } = splitTitle(title);
  const mainIn = el("textarea", { rows: "2" });
  mainIn.value = main;
  const subIn = el("textarea", { rows: "2" });
  subIn.value = sub;
  const labelIn = el("input", { type: "text" });
  labelIn.value = "AI社員チーム 制作ログ";
  const canvas = el("canvas", { class: "cover" });
  const redraw = () => drawCover(canvas, { main: mainIn.value.trim(), sub: subIn.value.trim(), label: labelIn.value.trim(), variant });
  for (const i of [mainIn, subIn, labelIn]) i.addEventListener("input", redraw);

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
    const change = await buildPublicationChange({ meta: a.meta, free: a.free, paid: a.paid, approval: a.approval, auditText: audit, url, now: new Date() });
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
    (a) => (a.meta.status === "approved" && a.approvalValid) || (a.meta.status === "published" && !a.meta.free_url),
  );
  if (candidates.length === 0) return notice(`記録できる記事がありません（承認済みの記事がない）。共有されたURL: ${url}`);

  const choose = (a) => {
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

async function saveTop10() {
  if (!gh || !snapshot) return notice("先に「設定」で接続してください");
  try {
    const req = buildTop10Request({ keyword: $("t10-keyword").value, urlsText: $("t10-urls").value, now: new Date() });
    const sha = await gh.headSha();
    await gh.commitFiles([req], `上位10件の調査依頼: ${$("t10-keyword").value.trim()}（アプリ）`, sha);
    $("t10-urls").value = "";
    await reload();
    notice(`保存しました: ${req.path}\nClaude Code に「${req.path} の調査を実行して」と依頼してください`, true);
  } catch (e) {
    notice(`保存できませんでした:\n${errorText(e)}`);
  }
}

// ---------- 設定タブ ----------

function fillSettings() {
  $("s-token").value = settings.token ?? "";
  $("s-repo").value = settings.repo ?? "gangidenset/note-growth-team";
  $("s-branch").value = settings.branch ?? "";
  $("s-approver").value = settings.approver ?? "";
}

async function onSaveSettings() {
  settings = {
    token: $("s-token").value.trim(),
    repo: $("s-repo").value.trim(),
    branch: $("s-branch").value.trim(),
    approver: $("s-approver").value.trim(),
  };
  if (!saveSettings(settings)) notice("この端末に設定を保存できませんでした（プライベートモードなど）。今回だけ使えます");
  await reload();
  if (gh && snapshot) showTab("articles");
}

function onClearToken() {
  settings = { ...settings, token: "" };
  saveSettings(settings);
  fillSettings();
  gh = null;
  snapshot = null;
  notice("トークンを消しました", true);
}

// ---------- タブ ----------

function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== `tab-${name}`;
}

for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
$("reload").addEventListener("click", reload);
$("s-save").addEventListener("click", onSaveSettings);
$("s-clear").addEventListener("click", onClearToken);
$("t10-save").addEventListener("click", saveTop10);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
fillSettings();
const shared = readShared();
reload().then(() => {
  if (shared && snapshot) handleShared(shared);
});

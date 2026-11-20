// 記事タブ（一覧・記事画面・承認・公開の記録・修正依頼）。
// （A-27 で app.js から分けた）
import { buildApprovalChange, buildFreeUrlChange, buildPublicationChange, articleWatchPaths, membershipStatus, MEMBERSHIP_PLAN_PATH, summarizeQa, buildFixRequest, fixRequestNames, paidLinkStatus, nextActions, articleLength, countPaywalls, LENGTH_GUIDE, imageRefs, listTreeDir, priceLabel, toNoteText, ARTICLE_GROUPS, markdownBlocks, inlineParts, filterArticles, defaultArticleGroup, formatLabel, saveAllOrder, SAVE_ALL_INTERVAL_MS } from "./domain.js";
import { approvalDiffCard } from "./approval-diff.js";
import { reload } from "./load.js";
import { renderPerformanceForm } from "./performance.js";
import { paidLinkCard, postingGuide, republishGuide, restyleGuide, xPostCard } from "./posting.js";
import { commitChange, readAudit, state } from "./state.js";
import { $, STATUS_LABEL, copy, el, errorText, notice, openDialog, showTab } from "./ui.js";

// ---------- 記事タブ ----------

/** 記事タブの一番上に出す「次にやること」。押すとその記事（または実績の入力）を開く */
function nextActionsBlock() {
  const actions = nextActions({ articles: state.snapshot.articles, performanceIds: state.snapshot.performance.ids, now: new Date(), membership: currentMembership() });
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
    const a = state.snapshot.articles.find((y) => y.meta.id === x.article_id);
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
  return membershipStatus({ metas: state.snapshot.articles.map((a) => a.meta), planText: state.snapshot.membershipPlan, now: new Date() });
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
  const rows = paidLinkStatus(state.snapshot.articles);
  if (rows.length === 0) return null;
  const missing = rows.filter((r) => r.state === "missing").length;
  const label = { marker: "本文に入っている", confirmed: "note で足した", missing: "まだない" };
  return el("details", { class: "card" },
    el("summary", {}, `無料記事 → 有料記事のリンク（${rows.length}件中 ${missing}件 まだ）`),
    el("ul", { class: "plain" }, ...rows.map((r) => el("li", {},
      el("span", { class: r.state === "missing" ? "badge awaiting_approval" : "badge published" }, label[r.state]),
      el("button", { class: "link", onclick: () => renderArticle(state.snapshot.articles.find((a) => a.meta.id === r.id)) }, r.title),
      r.confirmed_at && el("div", { class: "meta" }, `記録: ${r.confirmed_at}`),
    ))),
    el("p", { class: "muted" }, "これから書く記事は、無料記事の本文に「＝＝ 有料記事のリンク ＝＝」の印を入れておくと、投稿モードのコピーで有料記事の URL に置き換わります。"),
  );
}

/** 一覧の絞り込み（A-25）。null なら記事に合わせて決める */
let articleFilter = null;

export function renderArticles() {
  state.openArticleId = null;
  // 記事を開いていた履歴が残っていれば、一覧の状態に書き換える（戻るで同じ記事が開き直さないように）
  if (history.state?.article) history.replaceState({}, "", location.pathname);
  const root = $("tab-articles");
  root.replaceChildren();
  const waiting = state.snapshot.articles.filter((a) => a.meta.status === "awaiting_approval").length;
  root.append(nextActionsBlock());
  root.append(membershipBlock());
  const links = linksBlock();
  if (links) root.append(links);
  const group = articleFilter ?? defaultArticleGroup(state.snapshot.articles);
  const { list, counts } = filterArticles(state.snapshot.articles, group);
  root.append(el("h2", {}, `記事（${state.snapshot.articles.length}件）`, waiting ? ` ・承認待ち ${waiting}件` : ""));
  root.append(el("div", { class: "row filter", role: "group", "aria-label": "記事の絞り込み" },
    ...Object.entries(ARTICLE_GROUPS).map(([key, label]) => el("button", {
      class: key === group ? "chip active" : "chip",
      "aria-pressed": key === group ? "true" : "false",
      onclick: () => {
        articleFilter = key;
        renderArticles();
      },
    }, `${label} ${counts[key]}`)),
  ));
  if (state.snapshot.articles.length === 0) root.append(el("p", { class: "muted" }, "記事はまだありません"));
  else if (list.length === 0) root.append(el("p", { class: "muted" }, `「${ARTICLE_GROUPS[group]}」の記事はありません`));
  for (const a of list) {
    const m = a.meta;
    const stale = (m.status === "approved" || m.status === "published") && !a.approvalValid;
    root.append(
      el("div", { class: "card" },
        el("div", {}, el("span", { class: `badge ${m.status}` }, STATUS_LABEL[m.status] ?? m.status),
          el("span", { class: "badge format" }, formatLabel(m)),
          m.format !== "free_only" && m.format !== "membership" ? el("span", { class: "meta" }, priceLabel(m)) : null),
        el("div", { class: "title" }, m.title || "(タイトル未定)"),
        el("div", { class: "meta" }, `${m.id} ・ 更新 ${m.updated_at}`),
        stale && el("div", { class: "warn" }, "承認後に本文が変わっています。承認は無効です（再承認が必要）"),
        el("div", { class: "row" }, el("button", { class: "secondary", onclick: () => renderArticle(a) }, "開く")),
      ),
    );
  }
}

/** 「← 一覧へ」: 記事を開いたときに足した履歴があれば戻る（Android の「戻る」と同じ動き）。なければそのまま一覧を出す */
function backToList() {
  if (history.state?.article) history.back();
  else renderArticles();
}

/** 1行の太字・コードを要素にする（A-21） */
function inlineEl(tag, text, attrs = {}) {
  return el(tag, attrs, ...inlineParts(text).map((p) => (p.bold ? el("strong", {}, p.text) : p.code ? el("code", {}, p.text) : p.text)));
}

/**
 * 本文を読みやすく表示する（A-21）。見出し・箇条書き・太字を整えるだけで、コピーされる文は今のまま。
 * 「そのままの文」を開くと、貼り付けられる文がそのまま見える
 */
export function renderBody(body) {
  const view = el("div", { class: "md" }, ...markdownBlocks(body).map((b) => {
    if (b.type === "heading") return inlineEl(b.level <= 2 ? "h3" : "h4", b.text);
    if (b.type === "ul" || b.type === "ol") return el(b.type, {}, ...b.items.map((t) => inlineEl("li", t)));
    if (b.type === "quote") return inlineEl("blockquote", b.text);
    if (b.type === "code") return el("pre", { class: "body" }, b.text);
    if (b.type === "marker") return el("div", { class: "marker" }, b.text);
    if (b.type === "hr") return el("hr", {});
    return el("p", {}, ...b.lines.flatMap((line, i) => [i > 0 ? el("br", {}) : null, ...inlineEl("span", line).childNodes]).filter(Boolean));
  }));
  return el("div", {}, view, el("details", {}, el("summary", {}, "そのままの文（貼り付けられる文）を見る"), el("pre", { class: "body" }, body)));
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
    renderBody(body),
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

/** 画像をファイルとして端末に保存する（ダウンロード） */
function downloadImage(file) {
  const url = URL.createObjectURL(file);
  const link = el("a", { href: url, download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function loadImages(a, refs, list) {
  list.replaceChildren(el("p", { class: "muted" }, "読み込み中…"));
  const items = [];
  /** @type {File[]} 読めた画像（まとめて保存・共有に使う） */
  const files = [];
  for (const [i, r] of refs.entries()) {
    const type = IMAGE_TYPES[r.name.split(".").pop().toLowerCase()] ?? "application/octet-stream";
    let b64 = null;
    try {
      b64 = await state.gh.readBase64(`data/articles/${a.meta.id}/assets/${r.name}`, a.sha);
    } catch (e) {
      notice(`画像の読み込みに失敗: ${errorText(e)}`);
    }
    const file = b64 ? new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], r.name, { type }) : null;
    if (file && !files.some((f) => f.name === file.name)) files.push(file);
    items.push(el("div", { class: "card" },
      el("div", { class: "meta" }, `${i + 1}. ${r.where}記事 ・ ${r.name}`),
      el("div", {}, r.alt),
      b64 ? el("img", { src: `data:${type};base64,${b64}`, alt: r.alt, class: "figure" }) : el("div", { class: "warn" }, "画像がありません"),
      file && el("button", { class: "secondary", onclick: () => downloadImage(file) }, "この画像を保存"),
    ));
  }
  list.replaceChildren(...(files.length > 1 ? [allImagesRow(files)] : []), ...items);
}

/** 画像をまとめて保存・共有する（A-23）。共有は、ファイルの共有に対応した端末（Android の Chrome など）だけ */
function allImagesRow(files) {
  const saveAll = async () => {
    // 続けて保存すると、ブラウザが「複数のファイルをダウンロードしますか？」と聞くことがある（許可すると全部保存される）。
    // 写真の一覧は保存した時刻の順に並ぶので、1枚目から順に、前の画像の保存が終わってから次を保存する
    // （間を長めにあけて、保存した時刻が入れ替わったり同じになったりしないようにする）
    const order = saveAllOrder(files);
    for (const [i, f] of order.entries()) {
      notice(`画像を保存しています（${i + 1}/${order.length}枚目）…`, true, { scroll: false });
      downloadImage(f);
      await new Promise((r) => setTimeout(r, SAVE_ALL_INTERVAL_MS));
    }
    notice(`画像を${files.length}枚、1枚目から順に保存しました（「複数のファイルのダウンロード」を聞かれたら許可してください）`, true);
  };
  const canShare = typeof navigator.canShare === "function" && navigator.canShare({ files });
  const share = async () => {
    try {
      await navigator.share({ files });
    } catch (e) {
      if (e?.name !== "AbortError") notice(`共有できませんでした: ${errorText(e)}`);
    }
  };
  return el("div", { class: "row" },
    el("button", { onclick: saveAll }, `全部保存（${files.length}枚）`),
    canShare ? el("button", { class: "secondary", onclick: share }, "まとめて共有") : null,
  );
}

/** ハッシュタグの案（hashtags.json）。タグを押すと1つずつコピーできる（note では1つずつ入力するため） */
export function hashtagsBlock(plan, kind) {
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

export function renderArticle(a) {
  const m = a.meta;
  // 記事を開いたら履歴を1つ足す。Android の「戻る」でアプリが閉じず、一覧に戻る（A-18）
  if (state.openArticleId !== m.id || history.state?.article !== m.id) {
    if (history.state?.article) history.replaceState({ article: m.id }, "", location.pathname);
    else history.pushState({ article: m.id }, "", location.pathname);
    window.scrollTo(0, 0);
  }
  state.openArticleId = m.id;
  showTab("articles");
  const root = $("tab-articles");
  root.replaceChildren(...[
    el("button", { class: "secondary", onclick: backToList }, "← 一覧へ"),
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
  // 公開済みの記事も依頼できる（A-31: 直す → 承認し直す → note の記事を手で直して記録）
  if (["drafting", "qa", "needs_revision", "awaiting_approval", "approved", "published"].includes(m.status)) {
    actions.append(el("button", { class: "secondary", onclick: () => fixRequestDialog(a) }, "修正を依頼する"));
  }
  root.append(actions);
  const fixes = fixRequestNames(listTreeDir(state.snapshot.tree, "data/requests").map((e) => e.name), m.id);
  if (fixes.length > 0) {
    root.append(el("div", { class: "meta" }, `この記事の修正依頼: ${fixes.length}件（最新: ${fixes[0]}）。反映されたかは、記事の更新日時と品質チェックの結果で確かめてください`));
  }
  if (m.status === "approved" && !a.approvalValid) {
    root.append(el("div", { class: "warn" }, "承認後に本文が変わっています。Claude Code に「承認待ちに戻して」と依頼し、再承認してください"));
  }
  // 承認のあとに変わった記事は、どこが変わったかを出せるようにする（A-22）
  if (a.approval && !a.approvalValid) root.append(approvalDiffCard(a));
  const link = paidLinkStatus([a])[0];
  if (link && link.state !== "marker") root.append(paidLinkCard(a, link));
  const images = imagesBlock(a);
  if (images) root.append(images);
  const xCard = xPostCard(a);
  if (xCard) root.append(xCard);
  // 公開済みの記事を直して承認し直したとき（A-31）は、新しく投稿せず note の記事を直す手順を出す
  if (m.status === "approved" && a.approvalValid && m.published_url) root.append(republishGuide(a));
  else if ((m.status === "approved" && a.approvalValid) || m.status === "published") root.append(postingGuide(a));
  if (m.status === "published" && m.published_url) root.append(restyleGuide(a));
  if (m.status !== "approved" && m.status !== "published") {
    root.append(...(a.freeOnly ? [copyBlock("無料記事", a.free)] : [copyBlock("有料記事", a.paid), copyBlock("無料記事", a.free)]));
  }
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
    a.approval && !a.approvalValid && el("p", { class: "muted" }, "前回の承認から変わったところは、記事画面の「前回の承認からの変更点」で確かめられます。"),
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
        build: async (base) => buildApprovalChange({ meta: m, free: a.free, paid: a.hashPaid, images: a.images, missingImages: a.missingImages, auditText: await readAudit(base), approver: state.settings.approver, now: new Date() }),
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

export function publishDialog(a) {
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

export function freeUrlDialog(a, presetUrl = "") {
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

export async function saveFreeUrl(a, url, dialog) {
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

export async function savePublication(a, url, dialog) {
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

/** 記事の修正依頼（A-20）。メモを data/requests/fix-<記事ID>-<日時>.txt に保存し、Claude Code への依頼文を出す。承認はしない */
function fixRequestDialog(a) {
  const m = a.meta;
  const memo = el("textarea", { rows: "6", placeholder: "例: 2つ目の見出しの「〜」は言い過ぎなので弱めて。図3の数字が本文と違う" });
  const ok = el("button", {}, "依頼を保存");
  const afterApproval = m.status === "approved" || m.status === "published";
  const d = openDialog(
    el("h2", {}, "修正を依頼"),
    el("div", { class: "title" }, m.title || m.id),
    el("label", {}, "直してほしいところ（どこを・どう直すか）", memo),
    afterApproval && el("div", { class: "warn" }, m.status === "published"
      ? "公開済みの記事です。直したあと承認し直し、note の記事を手で直して「直したので記録する」を押す流れになります（note の記事は、直すまで今のまま公開されています）"
      : "承認済みの記事です。直すと承認がやり直しになります"),
    el("p", { class: "muted" }, "保存すると、Claude Code が直して品質チェックをやり直し、承認待ちに戻します。承認はオーナーが改めて行います。"),
    el("div", { class: "row" }, ok, el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
  );
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    try {
      const req = buildFixRequest({ meta: m, memo: memo.value, now: new Date() });
      await commitChange({ message: `修正依頼: ${m.id}（アプリ）`, watch: [], build: async () => ({ files: [req] }) });
      const ask = `${req.path} の修正依頼を反映して`;
      openDialog(
        el("h2", {}, "修正依頼を保存しました"),
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

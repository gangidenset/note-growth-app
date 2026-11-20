// 投稿モード（SNS のお知らせ・note への投稿の手順・有料記事のリンク・見出し画像）。
// （A-27 で app.js から分けた）
import { articleWatchPaths, buildPaidLinkConfirmChange, resolveLinks, buildThumbnailPrompt, THUMB_STYLES, toNoteText, xAnnouncement, xIntentUrl, xWeightedLength, X_MAX_WEIGHTED, threadsIntentUrl, blueskyIntentUrl, graphemeLength, snsTooLong, noteHtml } from "./domain.js";
import { drawCover, splitTitle } from "./cover.js";
import { freeUrlDialog, hashtagsBlock, publishDialog, renderBody, savePublication } from "./articles.js";
import { reload } from "./load.js";
import { commitChange, readAudit, state } from "./state.js";
import { $, copy, copyRich, el, errorText, notice, openDialog } from "./ui.js";

/** 公開した記事を SNS でお知らせする（各 SNS の投稿画面を下書き入りで開く。投稿するのはオーナー自身） */
export function xPostCard(a) {
  const freeTitle = a.free === null ? null : toNoteText(a.free).title;
  const full = xAnnouncement({ meta: a.meta, freeOnly: a.freeOnly, xPost: a.xPost, freeTitle });
  if (!full) return null;
  const box = el("textarea", { rows: "6" });
  box.value = full;
  const count = el("div", { class: "meta" });
  const update = () => {
    const long = snsTooLong(box.value);
    count.textContent = `X ${xWeightedLength(box.value)} / ${X_MAX_WEIGHTED}（日本語は1文字2、URL は23）・ Threads・Bluesky ${graphemeLength(box.value)}文字（上限 500・300）${long.length > 0 ? ` ← ${long.join("・")} には長すぎます。少し削ってください` : ""}`;
  };
  box.addEventListener("input", update);
  update();
  const open = (url) => window.open(url, "_blank", "noopener");
  // Android の共有メニュー（LINE・Discord など、入っているアプリに渡せる）。使えないブラウザではボタンを出さない
  const canShare = typeof navigator.share === "function";
  const share = async () => {
    try {
      await navigator.share({ text: box.value });
    } catch (e) {
      if (e?.name !== "AbortError") notice(`共有できませんでした: ${errorText(e)}`);
    }
  };
  return el("div", { class: "card" },
    el("h3", {}, "SNS で公開をお知らせする"),
    el("p", { class: "muted" }, a.xPost ? "Claude Code が用意した文です。直してから開いても大丈夫です。" : "記事のタイトルから作った文です。直してから開いても大丈夫です。"),
    box, count,
    el("div", { class: "row" },
      el("button", { onclick: () => open(xIntentUrl(box.value)) }, "X で投稿"),
      el("button", { onclick: () => open(threadsIntentUrl(box.value)) }, "Threads で投稿"),
      el("button", { onclick: () => open(blueskyIntentUrl(box.value)) }, "Bluesky で投稿"),
    ),
    el("div", { class: "row" },
      canShare ? el("button", { class: "secondary", onclick: share }, "ほかのアプリで共有") : null,
      el("button", { class: "secondary", onclick: () => copy(box.value, "お知らせの文") }, "文をコピー"),
    ),
    el("p", { class: "muted" }, `どのボタンも、その SNS の画面に文が入った状態で開くだけです。内容を見て投稿ボタンを押すと投稿されます（押さなければ投稿されません）。ログインしていないときは、先にログインしてください。${canShare ? "「ほかのアプリで共有」は、スマホの共有メニューから LINE などに渡せます。" : ""}`),
  );
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
      el("button", { onclick: () => copyRich(text.body, noteHtml(text.body), `${label}の本文`) }, "② 本文をコピー"),
      el("a", { class: "button secondary", href: NOTE_NEW_POST_LINK, target: "_blank", rel: "noopener" }, "note の投稿画面を Chrome で開く"),
    ),
    el("p", { class: "muted" },
      "②の本文は、見出し・太字・箇条書きつきでコピーされる。note の本文の欄を長押しして「貼り付け」で貼ると、記号（## や **）ではなく見出しや太字になる。" +
      "キーボード（Gboard）のクリップボード履歴から貼ると、書式が落ちて記号つきの文字だけになることがある（推定）ので、本文は長押しの「貼り付け」で。" +
      "手順: ①を押す → note のタイトルに貼る → 画面下の「□」（最近使ったアプリ）で Note Growth に戻る → ②を押す → note の本文の欄を長押し →「貼り付け」。" +
      "note がこのアプリの中で開いてしまったら、右上の「⋮」→「Chrome で開く」で別の画面に移せる。"),
  ];
}

/**
 * 公開済みの記事の見た目を直す（A-33）。2026-11-20 より前は本文が記号（## や **）つきの文字でコピーされていたため、
 * note の記事に記号が残っている。承認した本文をそのまま、見出し・太字つきでコピーして貼り直す（見た目の調整なので再承認は不要。状態も変えない）。
 * 承認のあとに本文が変わっている記事では、承認していない文が note に載らないよう、コピーのボタンを出さない
 */
export function restyleGuide(a) {
  const m = a.meta;
  const summary = el("summary", {}, "note の記事の見た目を直す（## や ** が残っているとき）");
  if (!a.approvalValid) {
    return el("details", { class: "card" }, summary,
      el("div", { class: "warn" }, "承認のあとに本文が変わっているため、ここからはコピーできません（承認していない文が note に載らないように）。中身を直すときは「修正を依頼する」から、承認し直す流れで直してください。"));
  }
  const metas = state.snapshot.articles.map((x) => x.meta);
  const noteText = (md) => {
    if (md === null) return null;
    const t = toNoteText(md);
    return { title: t.title, body: resolveLinks(t.body, m, metas).body };
  };
  const parts = (a.freeOnly
    ? [["記事", m.published_url, noteText(a.free)]]
    : [["有料記事", m.published_url, noteText(a.paid)], ["無料記事", m.free_url, noteText(a.free)]]
  ).filter(([, url, text]) => url && text);
  return el("details", { class: "card" }, summary,
    el("p", { class: "muted" }, "承認した本文を、見出し・太字・箇条書きつきでコピーします。中身は変わらないので、承認し直しは要りません。アプリの状態も「公開済み」のままです。"),
    el("ol", { class: "help" },
      el("li", {}, "下の「本文をコピー」を押す"),
      el("li", {}, "note で記事を開き、右上の「…」→「編集」"),
      el("li", {}, "本文を全部選んで消し、本文の欄を長押しして「貼り付け」（キーボードの履歴からだと書式が落ちることがある）"),
      el("li", {}, "画像を入れ直す（下の「記事の画像」）。有料記事は、目印の行を消して有料ラインと価格を設定し直す"),
      el("li", {}, "「更新」")),
    ...parts.map(([label, url, text]) => el("div", { class: "card" },
      el("h3", { class: "flush" }, label),
      el("div", { class: "meta" }, "公開中: ", el("a", { href: url, target: "_blank", rel: "noopener" }, url)),
      el("div", { class: "row" },
        el("button", { class: "secondary", onclick: () => copy(text.title, `${label}のタイトル`) }, "タイトルをコピー"),
        el("button", { onclick: () => copyRich(text.body, noteHtml(text.body), `${label}の本文`) }, "本文をコピー")),
    )),
    el("p", { class: "muted" }, "目印の行（画像を入れる場所・有料ライン）は文字のまま貼られるので、貼ったあとに消してください。"),
  );
}

/**
 * 公開済みの記事を直して承認し直したあと（A-31）: note の記事を手で直して、記録し直す。
 * 新しく投稿はしない（公開URLはそのまま）。記録すると approved → published に戻る
 */
export function republishGuide(a) {
  const m = a.meta;
  const metas = state.snapshot.articles.map((x) => x.meta);
  const noteText = (md) => {
    if (md === null) return null;
    const t = toNoteText(md);
    return { title: t.title, body: resolveLinks(t.body, m, metas).body };
  };
  const parts = a.freeOnly
    ? [["記事", m.published_url, noteText(a.free)]]
    : [["有料記事", m.published_url, noteText(a.paid)], ["無料記事", m.free_url, noteText(a.free)]];
  const ok = el("button", {}, "note の記事を直したので記録する");
  ok.addEventListener("click", async () => {
    if (!confirm("note の記事を、承認した内容に直しましたか？（OK で記録します）")) return;
    ok.disabled = true;
    await savePublication(a, m.published_url, null);
    ok.disabled = false;
  });
  return el("div", {},
    el("h3", {}, "note の記事を直す（公開済みの記事の修正）"),
    el("p", { class: "muted" }, "承認し直した内容に合わせて、公開中の note の記事を手で直します。新しく投稿はしません（URL はそのまま）。"),
    ...parts.map(([label, url, text]) => el("div", { class: "card" },
      el("h3", {}, label),
      url ? el("div", { class: "meta" }, "公開中: ", el("a", { href: url, target: "_blank", rel: "noopener" }, url)) : el("div", { class: "warn" }, `${label}の公開URLが記録されていません`),
      text && el("div", { class: "row" },
        el("button", { onclick: () => copy(text.title, `${label}のタイトル`) }, "タイトルをコピー"),
        el("button", { onclick: () => copyRich(text.body, noteHtml(text.body), `${label}の本文`) }, "本文をコピー")),
      el("p", { class: "muted" }, "note で記事を開き、右上の「…」→「編集」で、タイトルと本文を貼り直して「更新」（本文は見出し・太字つきでコピーされるので、本文の欄を長押しして「貼り付け」）。画像を差し替えたときは画像も入れ直す。"),
    )),
    el("div", { class: "card" },
      el("h3", {}, "直し終わったら"),
      el("div", { class: "row" }, ok),
      el("p", { class: "muted" }, "押すと「公開済み」に戻ります。押すまでは、記事一覧で「承認済み」のままです。"),
    ),
  );
}

/** 承認済みの記事を note に投稿する手順（投稿モード） */
export function postingGuide(a) {
  const m = a.meta;
  const metas = state.snapshot.articles.map((x) => x.meta);
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
        paid && el("details", {}, el("summary", {}, "本文を確認する"), renderBody(paid.body)),
      );

  const freeStep = m.free_url
    ? step(2, "無料記事", done(m.free_url))
    : step(2, "無料記事を投稿する",
        el("div", { class: "big" }, "無料のまま公開"),
        free && el("button", { class: "secondary", onclick: () => coverDialog(free.title, "free", `${m.id}-free-cover.png`, a.coverPrompt?.free) }, "見出し画像を作る"),
        linkWarn(free),
        free && postButtons(free, "無料記事"),
        hashtagsBlock(a.hashtags, "free"),
        free && el("details", {}, el("summary", {}, "本文を確認する"), renderBody(free.body)),
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
          free && el("details", {}, el("summary", {}, "本文を確認する"), renderBody(free.body)),
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
export function paidLinkCard(a, link) {
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
  const canvas = el("canvas", { class: "cover", role: "img", "aria-label": "見出し画像のできあがりの見本" });
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
    el("p", {}, "タイトル入りの画像ができています。", el("strong", {}, "このまま「画像を保存」でOK"), "です（ChatGPT は使わなくてよい）。"),
    el("div", { class: "row" }, save, el("button", { class: "secondary", onclick: () => d.close() }, "閉じる")),
    el("details", {},
      el("summary", {}, "文字や見た目を変える（任意）"),
      el("div", { class: "row" }, el("label", {}, "文字の位置", positionIn), el("label", {}, "文字の書体", fontIn)),
      el("label", {}, "大きい文字", mainIn),
      el("label", {}, "小さい文字（空欄可）", subIn),
      el("label", {}, "上のラベル（空欄可）", labelIn),
    ),
    el("details", {},
      el("summary", {}, "イラストの背景を使う（任意。ChatGPT などで作る）"),
      coverPromptBlock(coverPrompt),
      el("button", { class: "secondary", onclick: () => thumbnailPromptDialog(title) }, "サムネイルのプロンプトを自分で作る"),
      el("label", {}, "背景画像を選ぶ（なしなら単色のデザイン）", fileIn),
    ),
    el("p", { class: "muted" }, "サイズは note 推奨の 1280×670px。保存した画像を、note の投稿画面で見出し画像に設定してください。顔写真やアカウント名など、身元がわかるものは入れないでください。"),
  );
  redraw();
}

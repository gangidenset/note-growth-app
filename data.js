// データタブ（調査の流れ・ギャップ分析・テーマ・執筆依頼）。
// （A-27 で app.js から分けた）
import { buildWriteRequest, WRITE_FORMATS, listTreeDir, researchFlow, TOP10_REQUEST_NAME } from "./domain.js";
import { renderArticle } from "./articles.js";
import { reload } from "./load.js";
import { commitChange, state } from "./state.js";
import { $, STATUS_LABEL, copy, el, errorText, notice, openDialog } from "./ui.js";

// ---------- データタブ ----------

function readAll(dir, tree) {
  const files = listTreeDir(tree, dir).filter((e) => e.type === "file" && e.name.endsWith(".json"));
  return Promise.all(files.map((f) => state.gh.treeJson(tree, `${dir}/${f.name}`).catch(() => ({ id: f.name, _broken: true }))));
}

const RESEARCH_STATE = {
  done: { label: "分析済み", badge: "published" },
  replaced: { label: "後の依頼で分析済み", badge: "archived" },
  pending: { label: "まだ", badge: "awaiting_approval" },
};

/** 調査依頼1件のつながり（A-08）: 依頼 → 市場データ → ギャップ分析 → テーマ → 記事 */
function researchCard(r) {
  const s = RESEARCH_STATE[r.state];
  const openArticle = (id) => {
    const a = state.snapshot.articles.find((x) => x.meta.id === id);
    if (a) renderArticle(a);
  };
  const request = `${r.path} の調査を実行して`;
  return el("div", { class: "card" },
    el("div", { class: "row-between" },
      el("div", { class: "title" }, r.keyword || "(キーワードなし)"),
      el("span", { class: `badge ${s.badge}` }, s.label)),
    el("div", { class: "meta" }, `依頼: ${r.name}（${r.webSearch ? "キーワードだけ" : `URL ${r.urls}件`}）${r.requested_at ? ` ・ ${r.requested_at.slice(0, 16).replace("T", " ")}` : ""}`),
    r.state === "replaced" && el("div", { class: "meta" }, `同じキーワードの後の依頼（${r.replacedBy}）で分析しています`),
    r.state === "pending" && el("div", {},
      el("p", { class: "muted" }, "まだギャップ分析がありません。Claude Code に調査を頼んでください。"),
      el("div", { class: "row" }, el("button", { class: "secondary small", onclick: () => copy(request, "Claude Code への依頼文") }, "依頼文をコピー")),
      el("p", { class: "muted" }, `コピーされる文: 「${request}」`)),
    ...r.gaps.map((g) => el("ol", { class: "flow" },
      el("li", {}, `市場データ: ${g.marketCount}件`),
      el("li", {}, "ギャップ分析: ", el("button", { class: "link", onclick: () => document.getElementById(`gap-${g.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, g.id), g.recommended.length > 0 ? `（おすすめ ${g.recommended.join("・")}）` : "（おすすめなし）"),
      el("li", {}, g.themes.length === 0 ? "テーマ: なし" : `テーマ: ${g.themes.length}件`,
        g.themes.length > 0 && el("ul", { class: "plain" }, ...g.themes.map((t) => el("li", {},
          el("span", { class: "badge" }, THEME_STATUS[t.status] ?? t.status ?? "?"), t.title,
          ...t.articles.map((a) => el("div", { class: "meta" }, "→ 記事: ",
            el("button", { class: "link", onclick: () => openArticle(a.id) }, a.title || a.id), `（${STATUS_LABEL[a.status] ?? a.status}）`)),
        )))),
    )),
  );
}

const THEME_STATUS = { candidate: "候補", selected: "選定", rejected: "見送り" };

export async function renderData(tree) {
  const root = $("tab-data");
  root.replaceChildren(el("p", { class: "muted" }, "読み込み中…"));
  const requests = listTreeDir(tree, "data/requests").filter((e) => e.type === "file");
  const top10Names = requests.map((e) => e.name).filter((n) => TOP10_REQUEST_NAME.test(n));
  const [themes, gaps, requestTexts] = await Promise.all([
    readAll("data/themes", tree),
    readAll("data/gaps", tree),
    Promise.all(top10Names.map((n) => state.gh.treeText(tree, `data/requests/${n}`).catch(() => null))),
  ]);
  const market = listTreeDir(tree, "data/market");
  const marketFiles = market.filter((e) => e.name.endsWith(".json")).map((e) => e.name.replace(".json", "")).sort().reverse();
  const otherReqs = requests.map((e) => e.name).filter((n) => n.endsWith(".txt") && !TOP10_REQUEST_NAME.test(n)).sort().reverse();
  const flow = researchFlow({
    requests: top10Names.map((name, i) => ({ name, text: requestTexts[i] })),
    gaps,
    themes,
    metas: state.snapshot.articles.map((a) => a.meta),
    marketIds: marketFiles,
  });
  const pending = flow.filter((r) => r.state === "pending").length;
  /** ギャップ分析を元にした依頼（ギャップ分析のカードに出す） */
  const requestOf = new Map(flow.flatMap((r) => r.gaps.map((g) => [g.id, r.name])));

  root.replaceChildren(...[
    el("h2", {}, `調査の流れ（依頼 ${flow.length}件${pending > 0 ? `・まだ ${pending}件` : ""}）`),
    el("p", { class: "muted" }, "上位10件の調査依頼 → 市場データ → ギャップ分析 → テーマ → 記事 のつながりです。依頼とギャップ分析は、キーワードと日時で結びつけています（推定）。"),
    flow.length === 0 ? el("p", { class: "muted" }, "まだありません") : null,
    ...flow.map(researchCard),
    el("h2", {}, `ギャップ分析（${gaps.length}件）`),
    gaps.length === 0 ? el("p", { class: "muted" }, "まだありません") : null,
    ...gaps.map((g) => el("div", { class: "card", id: g.id ? `gap-${g.id}` : undefined },
      requestOf.has(g.id) && el("div", { class: "meta" }, `元の依頼: ${requestOf.get(g.id)}`),
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
    otherReqs.length > 0 && el("details", { class: "card" },
      el("summary", {}, `執筆・修正の依頼（${otherReqs.length}件）`),
      el("ul", { class: "plain" }, ...otherReqs.map((n) => el("li", {}, n)))),
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

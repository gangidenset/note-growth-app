// 実績タブ。
// （A-27 で app.js から分けた）
import { buildPerformanceChange, PERFORMANCE_DIR, AUTO_PERFORMANCE_DIR, summarizeAutoPerformance, performanceTargets, monthlyProgress, MONTHLY_GOAL_JPY, performanceWarnings, summarizePerformance, listTreeDir, toZonedIso } from "./domain.js";
import { reload } from "./load.js";
import { commitChange, state } from "./state.js";
import { $, el, errorText, notice } from "./ui.js";

// ---------- 実績タブ ----------
// オーナーが note のダッシュボードで見た数字を記録する（自分のアカウントの数字だけ。data/performance/<日付>.json）。
// 数字は「これまでの合計」をそのまま入れ、前回との差はここで計算して見せる。

/** 読み込む記録の数（新しい順）。表示に使うのは最新とその前だけなので、古いものまでは読まない */
const PERFORMANCE_KEEP = 12;

export async function loadPerformance(tree) {
  const files = listTreeDir(tree, PERFORMANCE_DIR).filter((e) => e.type === "file" && /^\d{4}-\d{2}-\d{2}\.json$/.test(e.name));
  const recent = files.slice(-PERFORMANCE_KEEP);
  const records = await Promise.all(recent.map((f) => state.gh.treeJson(tree, `${PERFORMANCE_DIR}/${f.name}`).catch(() => null)));
  // 自動の記録（公開ページのスキ・フォロワー）は、最新と前回の2つだけ読む
  const autoFiles = listTreeDir(tree, AUTO_PERFORMANCE_DIR).filter((e) => e.type === "file" && /^\d{4}-\d{2}-\d{2}\.json$/.test(e.name)).slice(-2);
  const auto = await Promise.all(autoFiles.map((f) => state.gh.treeJson(tree, `${AUTO_PERFORMANCE_DIR}/${f.name}`).catch(() => null)));
  // ids は全部の記録の日付（「前回の記録から何日」に使う。中身は読まない）
  return { records: records.filter(Boolean), broken: records.filter((r) => !r).length, total: files.length, ids: files.map((f) => f.name.slice(0, 10)), auto: summarizeAutoPerformance(auto.filter(Boolean)) };
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

/** 記事ごとのカードに出す、自動の記録のスキ */
function autoLikesEl(auto, key) {
  const v = auto?.byKey[key];
  if (!v) return null;
  return el("div", { class: "meta" }, `スキ（自動・${auto.latest_id}） ${fmt(v.likes)} `, deltaEl(v.d_likes), v.error ? "（取得できませんでした）" : "");
}

/** 自動の記録（毎日、公開ページから）のまとめ。ページビュー・販売件数は入らない */
function autoBlock(auto, targets, showRows) {
  if (!auto) {
    return el("p", { class: "muted" }, "スキとフォロワーは、毎日夜に公開ページから自動で記録されます（最初の記録はまだありません）。");
  }
  const when = auto.recorded_at.slice(5, 16).replace("-", "/").replace("T", " ");
  return el("div", { class: "card" },
    el("div", { class: "title" }, "自動の記録（公開ページから）"),
    el("div", { class: "meta" }, `${when} の記録`, auto.previous_id ? `（前回 ${auto.previous_id} から）` : ""),
    el("div", { class: "stats" },
      statTile("スキ（合計）", auto.likes_total, auto.d_likes_total),
      statTile("フォロワー", auto.followers, auto.d_followers, "人"),
    ),
    ...(showRows ? targets : []).map((t) => {
      const v = auto.byKey[t.key];
      if (!v) return null;
      return el("div", { class: "meta" }, `${t.part_label}「${t.title}」 スキ ${fmt(v.likes)} `, deltaEl(v.d_likes), v.error ? "（取得できませんでした）" : "");
    }),
    auto.errors > 0 && el("div", { class: "warn" }, `${auto.errors}件は取得できませんでした。続くときは Claude Code に「performance-auto が失敗している」と知らせてください`),
    el("p", { class: "muted" }, "誰でも見られる記事ページの値を毎日自動で記録しています。ページビュー・販売件数・会員数はログインが必要なので、下の「今の数字を記録する」で入力してください。"),
  );
}

export function renderPerformance() {
  const root = $("tab-performance");
  const metas = state.snapshot.articles.map((a) => a.meta);
  const targets = performanceTargets(metas);
  const { records, broken } = state.snapshot.performance;
  const s = summarizePerformance(records, metas);
  const children = [el("h2", {}, "実績（自分の note の数字）")];

  if (targets.length === 0) {
    children.push(el("p", { class: "muted" }, "公開を記録した記事がまだありません。記事を公開して記録すると、ここで数字を記録できます。"));
    root.replaceChildren(...children);
    return;
  }
  children.push(autoBlock(state.snapshot.performance.auto, targets, !s));
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
      autoLikesEl(state.snapshot.performance.auto, r.key),
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

export function renderPerformanceForm() {
  const root = $("tab-performance");
  const metas = state.snapshot.articles.map((a) => a.meta);
  const targets = performanceTargets(metas);
  const sorted = [...state.snapshot.performance.records].sort((a, b) => a.id.localeCompare(b.id));
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
        numberInput(`${t.key}/likes`, typeof state.snapshot.performance.auto?.byKey[t.key]?.likes === "number" ? `スキ（自動 ${fmt(state.snapshot.performance.auto.byKey[t.key].likes)}）` : "スキ", saved?.likes, before?.likes),
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
      numberInput("account/followers", typeof state.snapshot.performance.auto?.followers === "number" ? `フォロワー（自動 ${fmt(state.snapshot.performance.auto.followers)}）` : "フォロワー", sameDay?.account?.followers, previous?.account?.followers),
      numberInput("account/membership_members", "メンバーシップ会員", sameDay?.account?.membership_members, previous?.account?.membership_members),
    )),
    el("h3", {}, `記事ごと（${targets.length}件）`),
    ...cards,
    el("label", {}, "メモ（任意）", notes),
    el("div", { class: "row" }, save, el("button", { class: "secondary", onclick: renderPerformance }, "やめる")),
  ].filter(Boolean));
  window.scrollTo({ top: 0 });
}

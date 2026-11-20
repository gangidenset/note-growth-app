// 前回の承認からの変更点（A-22）。
// （A-27 で app.js から分けた）
import { contentHash, listTreeDir, matchImages, approvalChanges } from "./domain.js";
import { state } from "./state.js";
import { $, el, errorText } from "./ui.js";

// ---------- 前回の承認からの変更点（A-22） ----------

/** 承認が無効になった記事のカード。押したら承認したときの本文を読み、今の本文と比べて変わったところだけを出す */
export function approvalDiffCard(a) {
  const box = el("div", { "aria-live": "polite" });
  const btn = el("button", { class: "secondary" }, "変更点を見る");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    box.replaceChildren(el("p", { class: "muted" }, "承認したときの本文を読み込み中…"));
    try {
      box.replaceChildren(...(await approvalDiffView(a)));
      btn.hidden = true;
    } catch (e) {
      btn.disabled = false;
      box.replaceChildren(el("div", { class: "warn" }, `変更点を読み込めませんでした: ${errorText(e)}`));
    }
  });
  return el("div", { class: "card" },
    el("h3", { class: "flush" }, "前回の承認からの変更点"),
    el("p", { class: "muted" }, `前回の承認（${a.approval.approved_at}）のあとに変わったところだけを出します。承認し直す前に、全文を読み直さずに確かめられます。`),
    el("div", { class: "row" }, btn),
    box,
  );
}

/** 承認したときの記事（承認記録を最後に書いたコミットの時点）を読む。内容ハッシュが承認記録と合うかも確かめる */
async function loadApprovedVersion(a) {
  const id = a.meta.id;
  const commit = await state.gh.lastCommitFor(`data/approvals/${id}.json`);
  if (!commit) throw new Error("承認したときの記録が GitHub の履歴に見つかりませんでした");
  const tree = await state.gh.readTree(commit);
  if (!tree) throw new Error("承認したときのファイルの一覧を取得できませんでした");
  const dir = `data/articles/${id}`;
  const [meta, free, paid] = await Promise.all([state.gh.treeJson(tree, `${dir}/meta.json`), state.gh.treeText(tree, `${dir}/free.md`), state.gh.treeText(tree, `${dir}/paid.md`)]);
  if (!meta) throw new Error("承認したときの記事の記録が見つかりませんでした");
  const freeOnly = meta.format === "free_only" || meta.format === "membership";
  const hashPaid = freeOnly ? "" : paid;
  const assets = listTreeDir(tree, `${dir}/assets`).filter((e) => e.type === "file");
  const { images, missing } = matchImages(free, hashPaid, assets);
  const hash = free !== null && hashPaid !== null && missing.length === 0
    ? await contentHash({ title: meta.title, price_jpy: meta.price_jpy, free, paid: hashPaid, images })
    : null;
  return { meta, free, paid: freeOnly ? null : paid, images, verified: hash !== null && hash === a.approval.content_sha256 };
}

async function approvalDiffView(a) {
  const before = await loadApprovedVersion(a);
  const c = approvalChanges(before, { meta: a.meta, free: a.free, paid: a.paid, images: a.images });
  const out = [];
  if (!before.verified) {
    out.push(el("div", { class: "warn" }, "承認したときの本文を確かめられませんでした（内容ハッシュが承認記録と合いません）。承認記録を最後に書いたときの本文と比べています（推定）。承認し直すときは全文を読んでください"));
  }
  if (c.none) out.push(el("p", {}, "本文・タイトル・価格・画像に、見て分かる違いはありません（改行や行末の空白だけが変わった可能性があります）。"));
  if (c.title) out.push(el("div", { class: "meta" }, `タイトル: ${c.title.before} → ${c.title.after}`));
  if (c.format) out.push(el("div", { class: "meta" }, `記事の形: ${c.format.before} → ${c.format.after}`));
  if (c.price) out.push(el("div", { class: "meta" }, `価格: ${c.price.before} → ${c.price.after}`));
  const img = [
    c.images.added.length > 0 && `追加 ${c.images.added.join("、")}`,
    c.images.removed.length > 0 && `削除 ${c.images.removed.join("、")}`,
    c.images.changed.length > 0 && `差し替え ${c.images.changed.join("、")}`,
  ].filter(Boolean);
  if (img.length > 0) out.push(el("div", { class: "meta" }, `画像: ${img.join(" ・ ")}（下の「記事の画像」で確かめてください）`));
  const sign = { " ": "　", "-": "－", "+": "＋" };
  const cls = { " ": "", "-": " diff-del", "+": " diff-add" };
  for (const part of c.parts) {
    out.push(el("h4", {}, `${part.label}（増えた行 ${part.added}・消えた行 ${part.removed}）`));
    for (const h of part.hunks) {
      out.push(el("div", { class: "diff" },
        el("div", { class: "diff-head" }, `今の本文の ${h.newStart}行目あたり`),
        ...h.lines.map((l) => el("div", { class: `diff-line${cls[l.type]}` }, `${sign[l.type]} ${l.text}`)),
      ));
    }
  }
  if (c.parts.length > 0) out.push(el("p", { class: "muted" }, "＋ は増えた行、－ は消えた行です。前後の行は変わっていません。"));
  return out;
}

// note の「共有」から受け取る（Android の共有ターゲット）。
// （A-27 で app.js から分けた）
import { addTop10Url, sharedPurpose, TOP10_MAX, classifyShared, extractNoteUrl, packPendingShare, toNoteText, unpackPendingShare } from "./domain.js";
import { saveFreeUrl, savePublication } from "./articles.js";
import { state } from "./state.js";
import { saveTop10Draft } from "./top10.js";
import { $, el, notice, openDialog, showTab } from "./ui.js";

// ---------- note の「共有」から受け取る（Android の共有ターゲット） ----------

export function readShared() {
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

export function savePendingShare(shared) {
  pendingShareMemory = packPendingShare(shared, new Date());
  try {
    localStorage.setItem(PENDING_SHARE_KEY, pendingShareMemory);
  } catch {
    // 保存できなくても、この画面を開いている間は pendingShareMemory で続けられる
  }
}

export function peekPendingShare() {
  let stored = pendingShareMemory;
  try {
    stored = localStorage.getItem(PENDING_SHARE_KEY) ?? stored;
  } catch {
    // 読めない環境では控えを使う
  }
  return unpackPendingShare(stored, new Date());
}

/** 預けた共有内容を取り出して消す（同じ共有を2回処理しない） */
export function takePendingShare() {
  const shared = peekPendingShare();
  pendingShareMemory = null;
  try {
    localStorage.removeItem(PENDING_SHARE_KEY);
  } catch {
    // 消せなくても、1時間たてば無効になる
  }
  return shared;
}

/**
 * note の「共有」で受け取った記事を、自分の記事なら公開の記録に、ほかの人の記事なら上位10件の入力に使う（A-24）。
 * 自分の記事かどうかは、記録済みの公開URLの書き手と比べて決める。まだ分からないときは選んでもらう
 */
export function handleShared(shared) {
  const url = extractNoteUrl(shared);
  if (!url) {
    return notice("共有された内容に note の記事URLが見つかりませんでした。note の記事を開いて「共有」→「Note Growth」を選んでください（公開の記録・上位10件とも、note の記事URLだけ使えます）");
  }
  const candidates = state.snapshot.articles.filter(
    (a) => (a.meta.status === "approved" && a.approvalValid) || (a.meta.status === "published" && !a.meta.free_url && !a.freeOnly),
  );
  const purpose = sharedPurpose({ url, metas: state.snapshot.articles.map((a) => a.meta), hasCandidates: candidates.length > 0 });
  if (purpose === "top10") return addSharedToTop10(url);
  if (purpose === "ask") {
    const d = openDialog(
      el("h2", {}, "共有された記事をどうしますか？"),
      el("div", { class: "meta" }, url),
      el("div", { class: "row" },
        el("button", { onclick: () => recordShared(shared, url, candidates) }, "自分の記事: 公開を記録する"),
        el("button", { class: "secondary", onclick: () => { d.close(); addSharedToTop10(url); } }, "ほかの人の記事: 上位10件に追加"),
        el("button", { class: "secondary", onclick: () => d.close() }, "やめる")),
    );
    return;
  }
  recordShared(shared, url, candidates);
}

/** 共有された記事（ほかの人の記事）を、上位10件の入力欄に足す。もう入っている・10件ある・note 以外は、その場で知らせる */
function addSharedToTop10(url) {
  showTab("top10");
  const r = addTop10Url($("t10-urls").value, url);
  if (r.result === "not_note") return notice("note の記事URLではないため、上位10件に追加しませんでした");
  if (r.result === "duplicate") return notice(`この記事はもう入っています（${r.position}件目）。追加しませんでした\n${r.url}`);
  if (r.result === "full") return notice(`上位10件はもう${TOP10_MAX}件そろっています。追加しませんでした\n${r.url}\n入れ替えるときは、下の欄で不要な行を消してから、もう一度共有してください`);
  $("t10-urls").value = r.text;
  saveTop10Draft();
  const next = r.count < TOP10_MAX ? "続けて note で次の記事を開き、「共有」→「Note Growth」で追加できます" : `${TOP10_MAX}件そろいました。「依頼を保存」を押してください`;
  const keyword = $("t10-keyword").value.trim() === "" ? "\nキーワードがまだ空です。調べたキーワードを入れてください" : "";
  notice(`上位10件に追加しました（${r.count}/${TOP10_MAX}件）\n${r.url}\n${next}${keyword}`, true);
}

/** 共有された自分の記事の URL を、どの記事の有料／無料として記録するかを確認して記録する */
function recordShared(shared, url, candidates) {
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

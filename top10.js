// 上位10件タブ。
// （A-27 で app.js から分けた）
import { buildTop10Draft, buildTop10Request, checkTop10Urls, TOP10_MAX, TOP10_DRAFT_PATH } from "./domain.js";
import { reload } from "./load.js";
import { commitChange, state } from "./state.js";
import { $, errorText, notice, toast } from "./ui.js";

// ---------- 上位10件タブ ----------

// 入力途中の依頼（キーワードと URL）は、入力のたびにこの端末に自動保存する。
// 「途中で保存」を押すと GitHub（data/requests/top10-draft.json）にも保存し、PC とスマホで続きから入力できる
const TOP10_DRAFT_KEY = "ngt-top10-draft";

/** 入力済みの件数と途中保存の時刻。note 以外の行・同じ記事の行・10件を超えたときは、その場で知らせる（A-24） */
function showTop10DraftStatus(savedAt) {
  const c = checkTop10Urls($("t10-urls").value);
  const time = savedAt ? `途中保存: ${new Date(savedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
  const issues = [
    c.bad.length > 0 && `note の記事URLではない行が${c.bad.length}件あります（${c.bad[0]}${c.bad.length > 1 ? " など" : ""}）`,
    c.duplicates.length > 0 && `同じ記事が2回入っています（${c.duplicates.length}件。保存するときは1件にまとめます）`,
    c.count > TOP10_MAX && `${TOP10_MAX}件を超えています（${c.count}件）`,
  ].filter(Boolean);
  const status = $("t10-draft-status");
  status.textContent = [`入力済み ${c.count}/${TOP10_MAX}件`, time, ...issues].filter(Boolean).join(" ・ ");
  status.className = c.bad.length > 0 || c.count > TOP10_MAX ? "warn" : "muted";
}

/** 端末に保存する。保存できない環境（プライベートモードなど）では false */
export function saveTop10Draft() {
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

export function restoreTop10Draft() {
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
export async function syncTop10DraftFromRemote(tree) {
  const remote = await state.gh.treeJson(tree, TOP10_DRAFT_PATH).catch(() => null);
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

export async function onTop10DraftSave() {
  const local = saveTop10Draft();
  if (!state.gh || !state.snapshot) {
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

export async function onTop10DraftClear() {
  if (!confirm("キーワードと URL の入力を消しますか？（PC とスマホの両方から消えます）")) return;
  clearTop10Draft();
  if (state.gh && state.snapshot) {
    try {
      await pushTop10Draft("上位10件の下書きを消去（アプリ）");
    } catch (e) {
      notice(`GitHub の下書きを消せませんでした:\n${errorText(e)}`);
    }
  }
}

let top10DraftTimer;
export function onTop10Input() {
  showTop10DraftStatus(null);
  clearTimeout(top10DraftTimer);
  top10DraftTimer = setTimeout(saveTop10Draft, 500);
}

export async function saveTop10() {
  if (!state.gh || !state.snapshot) return notice("先に「設定」で接続してください");
  try {
    const req = buildTop10Request({ keyword: $("t10-keyword").value, urlsText: $("t10-urls").value, now: new Date() });
    // 依頼と一緒に、共有の下書きを空にする（PC とスマホのどちらで開いても、送った内容が残らないように）
    const emptyDraft = buildTop10Draft({ keyword: "", urlsText: "", now: new Date() });
    await commitChange({ message: `上位10件の調査依頼: ${$("t10-keyword").value.trim()}（アプリ）`, watch: [], build: async () => ({ files: [req, emptyDraft] }) });
    clearTop10Draft();
    await reload();
    notice(`保存しました: ${req.path}\nClaude Code に「${req.path} の調査を実行して」と依頼してください${req.content.includes("# mode: web_search") ? "\n（URL なしの依頼なので、Claude Code が検索エンジンで記事を探します。note の人気順とは違う並びになります）" : ""}`, true);
  } catch (e) {
    notice(`保存できませんでした:\n${errorText(e)}`);
  }
}

// Note Growth アプリ（PWA）の入り口。ボタンと画面のつなぎこみ、起動時の処理。
// データは非公開リポジトリから GitHub API で読み書きする。承認・公開記録はこの端末の持ち主（オーナー）の操作として記録する。
// 画面ごとの処理は、それぞれのファイル（ui.js・state.js・load.js・articles.js など。A-27 で分けた）にある。
import { APP_VERSION, updateNotice } from "./domain.js";
import { completeLogin, logout } from "./auth.js";
import { renderArticle, renderArticles } from "./articles.js";
import { reload } from "./load.js";
import { fillSettings, onLogin, onLogout, onSaveSettings } from "./settings.js";
import { readShared, savePendingShare } from "./share.js";
import { saveSettings, state } from "./state.js";
import { onTop10DraftClear, onTop10DraftSave, onTop10Input, restoreTop10Draft, saveTop10 } from "./top10.js";
import { $, errorText, notice, showTab } from "./ui.js";

const tabButtons = [...document.querySelectorAll(".tabs button")];
for (const b of tabButtons) {
  b.addEventListener("click", () => showTab(b.dataset.tab));
  // キーボードの ← → / Home / End でタブを移る（A-28）
  b.addEventListener("keydown", (e) => {
    const i = tabButtons.indexOf(b);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabButtons.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = tabButtons[(to + tabButtons.length) % tabButtons.length];
    showTab(next.dataset.tab);
    next.focus();
  });
}
// Android の「戻る」（と「← 一覧へ」）: 記事を開く前の状態に戻ったら一覧を出す。進むで記事の状態に来たら、その記事を開く
window.addEventListener("popstate", (e) => {
  if (!state.snapshot) return;
  const id = e.state?.article;
  const a = id && state.snapshot.articles.find((x) => x.meta.id === id);
  showTab("articles");
  if (a) {
    state.openArticleId = id;
    renderArticle(a);
  } else renderArticles();
});
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
if (state.settings.token) {
  delete state.settings.token;
  saveSettings(state.settings);
}
fillSettings();
// 新しい版が入ったら、最初の読み込みのあとに一度だけ知らせる（A-26）
const VERSION_KEY = "ngt-app-version";
let versionNotice = null;
try {
  versionNotice = updateNotice(localStorage.getItem(VERSION_KEY));
  localStorage.setItem(VERSION_KEY, APP_VERSION);
} catch {
  // 記録できない環境では知らせない
}
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
    else if (versionNotice) notice(versionNotice, true);
  });

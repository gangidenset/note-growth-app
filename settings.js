// 設定タブ。
// （A-27 で app.js から分けた）
import { APP_VERSION } from "./domain.js";
import { clearCachedSnapshots } from "./cache.js";
import { isLoggedIn, logout, startLogin } from "./auth.js";
import { reload } from "./load.js";
import { takePendingShare } from "./share.js";
import { saveSettings, state } from "./state.js";
import { $, errorText, notice, showTab } from "./ui.js";

// ---------- 設定タブ ----------

export function fillSettings() {
  $("s-version").textContent = `アプリの版: ${APP_VERSION}`;
  $("s-login-status").textContent = isLoggedIn() ? "ログイン中（8時間ごとに自動で更新）" : "ログインしていません";
  $("s-login").hidden = isLoggedIn();
  $("s-logout").hidden = !isLoggedIn();
  $("s-repo").value = state.settings.repo ?? "gangidenset/note-growth-team";
  $("s-branch").value = state.settings.branch ?? "";
  $("s-approver").value = state.settings.approver ?? "";
}

export async function onSaveSettings() {
  state.settings = {
    repo: $("s-repo").value.trim(),
    branch: $("s-branch").value.trim(),
    approver: $("s-approver").value.trim(),
  };
  if (!saveSettings(state.settings)) notice("この端末に設定を保存できませんでした（プライベートモードなど）。今回だけ使えます");
  await reload();
  if (state.gh && state.snapshot) showTab("articles");
}

export async function onLogin() {
  try {
    await startLogin();
  } catch (e) {
    notice(errorText(e));
  }
}

export function onLogout() {
  logout();
  takePendingShare(); // 預かっていた共有内容も消す
  fillSettings();
  state.gh = null;
  state.snapshot = null;
  clearCachedSnapshots(); // 端末に保存した記事のデータも消す（A-05）
  notice("ログアウトしました（この端末からログイン情報と、保存した記事のデータを消しました）", true);
}

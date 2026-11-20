// アプリの状態（設定・GitHub への接続・読み込んだ内容）と保存（1回のコミットで書く・重なったらやり直す）。
// （A-27 で app.js から分けた）
import { changedPaths } from "./domain.js";
import { GitHubError, GitHubRepo } from "./github.js";
import { getAccessToken, isLoggedIn, logout } from "./auth.js";
import { fillSettings } from "./settings.js";
import { $ } from "./ui.js";

const STORE_KEY = "ngt-settings";

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

// ---------- 状態 ----------

/**
 * アプリ全体で共有する状態。ほかのファイルから書き換えられるよう、1つのオブジェクトにまとめる
 * - state.settings: この端末の設定 / state.gh: GitHub への接続 / state.snapshot: 読み込んだ時点のコミットとファイル一覧と記事
 * - state.openArticleId: いま開いている記事（A-18。一覧を出しているときは null）
 */
export const state = { settings: loadSettings(), gh: null, snapshot: null, openArticleId: null };

export function connect() {
  const [owner, repo] = (state.settings.repo || "gangidenset/note-growth-team").split("/");
  if (!isLoggedIn() || !owner || !repo) {
    state.gh = null;
    return false;
  }
  state.gh = new GitHubRepo({
    getToken: getAccessToken,
    owner,
    repo,
    branch: state.settings.branch || "",
    // ログインが取り消された・期限が切れたときは、ログインのボタンを出す
    onUnauthorized: () => {
      logout();
      fillSettings();
    },
  });
  return true;
}

export async function ensureBranch() {
  if (!state.gh.branch) {
    const info = await state.gh.info();
    state.gh.branch = info.default_branch;
  }
}

// ---------- 保存 ----------

export function readAudit(base) {
  return state.gh.readText("data/audit.log.jsonl", base);
}

/** 自動でやり直す回数の上限（Claude Code が続けてプッシュしているときに、いつまでも繰り返さないため） */
const MAX_SAVE_ATTEMPTS = 3;

/**
 * 読み込んだ時点（state.snapshot）を元に1回のコミットで保存する。
 * 保存の直前にほかから更新されていて断られたら（Claude Code のプッシュなど）、最新の状態を読み、
 * watch に挙げた場所（ファイル、または末尾が / のフォルダ）が変わっていなければ、最新の状態を元に作り直して保存し直す。
 * watch の場所が変わっていたら、上書きせずに止める（承認するのは、読んで確かめた内容だけ）。
 * 監査ログは build の中で、その時点のものを読み直して追記する
 * @param {{ message: string, watch: string[], build: (base: string) => Promise<{ files: { path: string, content: string }[] }> }} opts
 */
export async function commitChange({ message, watch, build }) {
  let base = state.snapshot.sha;
  let tree = state.snapshot.tree;
  for (let attempt = 1; ; attempt++) {
    const change = await build(base);
    try {
      await state.gh.commitFiles(change.files, message, base);
      return change;
    } catch (e) {
      if (!(e instanceof GitHubError && e.code === "conflict") || attempt >= MAX_SAVE_ATTEMPTS) throw e;
      const head = await state.gh.headSha();
      const next = await state.gh.readTree(head);
      if (!next) throw e;
      const changed = changedPaths(tree, next, watch);
      if (changed.length > 0) {
        throw new Error(`保存しませんでした。読み込んだ後に、この内容が GitHub 側で更新されています（${changed.join("、")}）。右上の ↻ で読み込み直し、内容を確かめてからやり直してください`);
      }
      base = head;
      tree = next;
    }
  }
}

/** 端末に保存する内容の鍵（リポジトリとブランチの設定ごと） */
export function cacheKey() {
  return `${state.gh.owner}/${state.gh.repo}@${state.settings.branch || ""}`;
}

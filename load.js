// GitHub から記事などを読み込み、画面を作り直す。
// （A-27 で app.js から分けた）
import { MEMBERSHIP_PLAN_PATH, contentHash, listTreeDir, matchImages, packSnapshot, unpackSnapshot, savedAtLabel } from "./domain.js";
import { loadCachedSnapshot, saveCachedSnapshot } from "./cache.js";
import { renderArticle, renderArticles } from "./articles.js";
import { renderData } from "./data.js";
import { loadPerformance, renderPerformance } from "./performance.js";
import { handleShared, peekPendingShare, takePendingShare } from "./share.js";
import { cacheKey, connect, ensureBranch, state } from "./state.js";
import { syncTop10DraftFromRemote } from "./top10.js";
import { $, errorText, notice, showTab } from "./ui.js";

// ---------- 読み込み ----------

/**
 * 全記事を読む。ファイルの一覧（tree）は取得済みなので、ここでの通信は中身の読み込みだけ。
 * 記事どうし・ファイルどうしを並行して読む（同時に行う数は github.js で抑えている）
 */
async function loadArticles(sha, tree) {
  const dirs = listTreeDir(tree, "data/articles").filter((e) => e.type === "dir");
  const loaded = await Promise.all(dirs.map((d) => loadArticle(sha, tree, d.name)));
  const articles = loaded.filter(Boolean);
  articles.sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at));
  return articles;
}

async function loadArticle(sha, tree, id) {
  const dir = `data/articles/${id}`;
  const [meta, free, paid, approval, hashtags, coverPrompt, qa, xPost] = await Promise.all([
    state.gh.treeJson(tree, `${dir}/meta.json`),
    state.gh.treeText(tree, `${dir}/free.md`),
    state.gh.treeText(tree, `${dir}/paid.md`),
    state.gh.treeJson(tree, `data/approvals/${id}.json`),
    state.gh.treeJson(tree, `${dir}/hashtags.json`).catch(() => null),
    state.gh.treeJson(tree, `${dir}/cover-prompt.json`).catch(() => null),
    state.gh.treeJson(tree, `${dir}/qa.json`).catch(() => null),
    state.gh.treeJson(tree, `${dir}/x-post.json`).catch(() => null),
  ]);
  if (!meta) return null;
  const assets = listTreeDir(tree, `${dir}/assets`).filter((e) => e.type === "file");
  // 無料記事だけの記事（free_only）は、有料記事を空文字としてハッシュする（PC 側の readDrafts と同じ）
  const freeOnly = meta.format === "free_only" || meta.format === "membership";
  const hashPaid = freeOnly ? "" : paid;
  const { images, missing } = matchImages(free, hashPaid, assets);
  const hash =
    free !== null && hashPaid !== null && missing.length === 0
      ? await contentHash({ title: meta.title, price_jpy: meta.price_jpy, free, paid: hashPaid, images })
      : null;
  return { meta, free, paid: freeOnly ? null : paid, hashPaid, freeOnly, approval, hashtags, coverPrompt, qa, xPost, images, missingImages: missing, sha, hash, approvalValid: !!approval && approval.content_sha256 === hash };
}

/** 読み込んだ内容（state.snapshot）で画面を作る。開いていた記事があれば開いたままにする（A-18） */
function renderSnapshot({ withData }) {
  const open = state.openArticleId && state.snapshot.articles.find((a) => a.meta.id === state.openArticleId);
  if (open) renderArticle(open);
  else renderArticles();
  renderPerformance();
  if (withData) {
    syncTop10DraftFromRemote(state.snapshot.tree).catch(() => {});
    renderData(state.snapshot.tree).catch((e) => notice(`データの読み込みに失敗: ${errorText(e)}`));
  }
  return !!open;
}

export async function reload() {
  if (!connect()) {
    showTab("settings");
    notice(peekPendingShare()
      ? "共有された記事のURLを預かりました。「GitHub でログイン」を押すと、ログインのあと続きから記録できます"
      : "最初に「設定」の「GitHub でログイン」を押してください");
    return;
  }
  const scrollY = window.scrollY; // 読み込み直したあとも、同じ位置に戻す（A-18）
  // まだ何も表示していなければ、前回保存した内容をすぐ出す（A-05）。新しい内容はこのあと確かめる
  let cachedAt = null;
  if (!state.snapshot) {
    const cached = unpackSnapshot(await loadCachedSnapshot(cacheKey()));
    if (cached) {
      state.snapshot = cached.snapshot;
      cachedAt = cached.saved_at;
      renderSnapshot({ withData: false });
    }
  }
  notice(cachedAt !== null ? `前回（${savedAtLabel(cachedAt)}）の内容を表示しています。新しい内容を確認中…` : "読み込み中…", true, { scroll: false });
  try {
    await ensureBranch();
    const sha = await state.gh.headSha();
    if (!state.snapshot || state.snapshot.sha !== sha) {
      const tree = await state.gh.readTree(sha);
      if (!tree) throw new Error("ファイルの一覧を取得できませんでした（リポジトリが大きすぎます）。Claude Code に知らせてください");
      const [articles, performance, membershipPlan] = await Promise.all([
        loadArticles(sha, tree),
        loadPerformance(tree),
        state.gh.treeText(tree, MEMBERSHIP_PLAN_PATH).catch(() => null),
      ]);
      state.snapshot = { sha, tree, articles, performance, membershipPlan };
      saveCachedSnapshot(cacheKey(), packSnapshot(state.snapshot, new Date()));
    }
    // GitHub 側に変更がなければ、読み直さずに保存した内容をそのまま使う
    const open = renderSnapshot({ withData: true });
    notice("");
    if (open) window.scrollTo(0, scrollY); // 「読み込み中…」が消えたあとに位置を戻す
    // note の「共有」で受け取った内容があれば、読み込めた今、記録の確認に進む
    const pending = takePendingShare();
    if (pending) handleShared(pending);
  } catch (e) {
    const offline = state.snapshot && cachedAt !== null
      ? `\n前回（${savedAtLabel(cachedAt)}）の内容を表示しています。承認や記録は、電波のあるところで ↻ を押して読み込み直してからにしてください`
      : "";
    notice(`読み込みに失敗しました: ${errorText(e)}${offline}${peekPendingShare() ? "\n共有された記事のURLは預かっています。右上の ↻ で読み込み直すと、続きから記録できます" : ""}`);
  }
}

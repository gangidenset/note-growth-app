// 画面づくりの小さな道具（要素を作る・お知らせ・コピー・ダイアログ・タブの切り替え）。
// （A-27 で app.js から分けた）
import { AppError, isNetworkError, NETWORK_MESSAGE } from "./domain.js";

export const $ = (id) => document.getElementById(id);

// ---------- 小さな道具 ----------

/** 要素を作る。文字列は必ず textContent として入れる（記事の内容を HTML として解釈しない） */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function notice(message, ok = false, { scroll = true } = {}) {
  const n = $("notice");
  n.hidden = !message;
  n.textContent = message ?? "";
  n.classList.toggle("ok", ok);
  if (message && scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

export function errorText(e) {
  if (e instanceof AppError) return e.messages.join("\n");
  if (isNetworkError(e)) return NETWORK_MESSAGE; // 「Failed to fetch」などの英語は出さない
  return e?.message ?? String(e);
}

/** 画面下に短く出すお知らせ（画面の位置を動かさない。コピーの完了など） */
let toastTimer;
export function toast(message) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = el("div", { class: "toast", role: "status" });
    document.body.append(t);
  }
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2000);
}

export async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}をコピーしました`);
  } catch {
    notice(`${label}をコピーできませんでした。長押しで選択してコピーしてください`);
  }
}

/**
 * 書式つき（HTML）と書式なし（今までの文）を一緒にコピーする（A-32）。
 * note の本文の欄に貼ると、見出し・太字・箇条書きになる。書式を受け付けない貼り先では書式なしの文が貼られる。
 * 書式つきでコピーできないブラウザでは、書式なしだけをコピーする
 */
export async function copyRich(text, html, label) {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("書式つきのコピーに対応していない");
    await navigator.clipboard.write([new ClipboardItem({
      "text/plain": new Blob([text], { type: "text/plain" }),
      "text/html": new Blob([html], { type: "text/html" }),
    })]);
    toast(`${label}をコピーしました（見出し・太字つき）`);
  } catch {
    await copy(text, label);
  }
}

export const STATUS_LABEL = {
  idea: "アイデア", researching: "調査中", planning: "企画中", drafting: "執筆中", qa: "品質チェック中",
  needs_revision: "差し戻し", awaiting_approval: "承認待ち", approved: "承認済み", published: "公開済み", archived: "中止",
};

export function openDialog(...children) {
  const d = $("dialog");
  d.replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));
  // 読み上げで、ダイアログの見出しを名前として読む（A-28）
  d.querySelector("#dialog-title")?.removeAttribute("id");
  const title = d.querySelector("h2");
  if (title) title.id = "dialog-title";
  if (!d.open) d.showModal();
  return d;
}

// ---------- タブ ----------

export function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    // 読み上げで「選択中のタブ」と分かるようにし、キーボードの Tab では選択中のタブだけに止まる（A-28）
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  }
  for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== `tab-${name}`;
}

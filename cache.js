// 前回読み込んだ内容を端末（IndexedDB）に保存し、次に開いたときすぐ表示する（A-05）。
// 保存するのは記事などのデータだけ。ログイン情報（トークン）は保存しない。ログアウトすると消す。
// 保存できない環境（プライベートモードなど）では何もしない（毎回 GitHub から読むだけ）。

const DB_NAME = "ngt-cache";
const STORE = "snapshots";

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB が使えません"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** 保存した内容を読む。なければ・読めなければ null */
export async function loadCachedSnapshot(key) {
  try {
    return (await run("readonly", (s) => s.get(key))) ?? null;
  } catch {
    return null;
  }
}

/** 内容を保存する（同じリポジトリ・ブランチの前回分は上書き）。失敗しても画面の動きには影響させない */
export async function saveCachedSnapshot(key, value) {
  try {
    await run("readwrite", (s) => {
      s.clear(); // 設定でリポジトリを変えたときに、古いリポジトリの分を残さない
      return s.put(value, key);
    });
  } catch {
    // 保存できなくても、次回は GitHub から読むだけ
  }
}

/** 保存した内容をすべて消す（ログアウトのとき） */
export async function clearCachedSnapshots() {
  try {
    await run("readwrite", (s) => s.clear());
  } catch {
    // 消せる場所がない環境では、もともと保存されていない
  }
}

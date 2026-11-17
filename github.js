// GitHub REST API の薄いラッパー（ブラウザ用）。アクセストークンは auth.js から受け取り、GitHub 以外へは送らない。
import { createLimiter } from "./domain.js";

/** 中身の読み込みを同時に行う数（一度に出しすぎると GitHub に断られることがある） */
const MAX_PARALLEL = 8;

/**
 * 読んだ中身の控え（blob の SHA → 文字列）。同じ SHA なら中身も同じなので、再読み込みでは変わったファイルだけ通信する。
 * 画面を開いている間だけ覚えている（端末には保存しない）
 */
const blobCache = new Map();

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class GitHubRepo {
  constructor({ getToken, owner, repo, branch }) {
    this.getToken = getToken;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.limit = createLimiter(MAX_PARALLEL);
  }

  async api(path, options = {}) {
    const token = await this.getToken();
    if (!token) throw new Error("ログインの期限が切れました。「設定」から「GitHub でログイン」を押してください");
    const res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /** 接続確認と既定ブランチの取得 */
  async info() {
    const repo = await this.api("");
    if (!repo) throw new Error("リポジトリが見つかりません（名前・トークンの対象リポジトリを確認）");
    return repo;
  }

  /** ブランチの先頭コミットの SHA */
  async headSha() {
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    if (!ref) throw new Error(`ブランチ ${this.branch} が見つかりません`);
    return ref.object.sha;
  }

  /**
   * コミット時点の全ファイルの一覧（パス → { sha, type }）を通信2回で取る。
   * フォルダごとに一覧を取ったり、ないファイルを読みに行ったりしなくて済む。
   * 一覧が大きすぎて途中で切れた場合は null（呼び出し側は使えないものとして扱う）
   */
  async readTree(commitSha) {
    const commit = await this.api(`/git/commits/${commitSha}`);
    if (!commit) throw new Error("コミットが見つかりません。再読み込みしてください");
    const data = await this.api(`/git/trees/${commit.tree.sha}?recursive=1`);
    if (!data || data.truncated) return null;
    return new Map(data.tree.map((e) => [e.path, { sha: e.sha, type: e.type }]));
  }

  /** 一覧（readTree）にあるファイルを文字列で読む（なければ null）。同じ中身は2度読まない */
  treeText(tree, path) {
    const entry = tree.get(path);
    if (!entry || entry.type !== "blob") return Promise.resolve(null);
    let cached = blobCache.get(entry.sha);
    if (!cached) {
      cached = this.limit(async () => {
        const blob = await this.api(`/git/blobs/${entry.sha}`);
        if (!blob) throw new Error(`${path} を読めませんでした`);
        return decodeBase64Utf8(blob.content);
      });
      blobCache.set(entry.sha, cached);
      cached.catch(() => blobCache.delete(entry.sha)); // 失敗は控えない（次の読み込みでやり直す）
    }
    return cached;
  }

  async treeJson(tree, path) {
    const text = await this.treeText(tree, path);
    return text === null ? null : JSON.parse(text);
  }

  /** ファイルを文字列で読む（なければ null）。ref を固定すると、読み込み中に更新されても一貫した内容になる */
  async readText(path, ref) {
    const data = await this.api(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (!data || Array.isArray(data)) return null;
    if (data.content === "" && data.size > 0) {
      // 1MB を超えるファイルは contents API で中身が返らないため blob から読む
      const blob = await this.api(`/git/blobs/${data.sha}`);
      return decodeBase64Utf8(blob.content);
    }
    return decodeBase64Utf8(data.content);
  }

  /** ファイルを base64 のまま読む（画像用。なければ null） */
  async readBase64(path, ref) {
    const data = await this.api(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (!data || Array.isArray(data)) return null;
    if (data.content === "" && data.size > 0) return (await this.api(`/git/blobs/${data.sha}`)).content.replace(/\s/g, "");
    return data.content.replace(/\s/g, "");
  }

  async readJson(path, ref) {
    const text = await this.readText(path, ref);
    return text === null ? null : JSON.parse(text);
  }

  /** フォルダの中身の一覧（なければ空配列） */
  async listDir(path, ref) {
    const data = await this.api(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * 複数ファイルを1つのコミットで書き込む。parentSha が今のブランチの先頭でなければ失敗する
   * （読み込んだ後に誰かが更新していたら、上書きせずに止める）。
   */
  async commitFiles(files, message, parentSha) {
    const parent = await this.api(`/git/commits/${parentSha}`);
    const tree = await this.api("/git/trees", {
      method: "POST",
      body: JSON.stringify({
        base_tree: parent.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      }),
    });
    const commit = await this.api("/git/commits", {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
    });
    try {
      await this.api(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
    } catch (e) {
      throw new Error(`保存できませんでした。読み込んだ後に GitHub 側が更新された可能性があります。再読み込みしてからやり直してください（${e.message}）`);
    }
    return commit.sha;
  }
}

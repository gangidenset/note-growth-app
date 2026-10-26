# Note Growth アプリ（スマホ用 PWA）

スマホから、記事の状況確認・承認・公開記録・note 投稿用テキストのコピー・人気上位10件の調査依頼ができるアプリ。
ビルド不要の HTML / CSS / JavaScript だけでできている。

## しくみ
- **アプリのプログラム**: 公開リポジトリ（例: `note-growth-app`）に置き、GitHub Pages で配信する。秘密情報は含まない
- **データ**: 非公開リポジトリ `note-growth-team` にある。アプリは、スマホに保存したあなたの GitHub トークンで GitHub API を呼び、読み書きする
- 承認・公開記録は、記録・状態・監査ログの3つを **1回のコミット** でまとめて書く。読み込んだ後に GitHub 側が更新されていたら、上書きせずに失敗する
- 内容ハッシュと note 貼り付け用の変換は、PC のコマンドと同じ結果になることをテストで確認している（tests/app-domain.test.ts）

## 承認を「人間だけ」に保つしくみ（PC との違い）
| | PC のコマンド | アプリ |
|---|---|---|
| 誰が操作できるか | 対話できる端末（TTY）で、Claude Code の外 | トークンを入れたあなたのスマホ |
| 確認 | 記事IDの再入力 / yes の入力 | 記事IDの再入力 / yes の入力（同じ） |
| 記録 | 監査ログ（via なし or cli） | 監査ログに `via: "app"` |
| 後からの点検 | `npm run data:check` | 同じ（アプリで書いたデータも検査される） |

Claude Code はこのアプリを操作しない。トークンは Claude Code に渡さないこと（チャットに貼らない）。

## 初期設定（最初に1回）
### 1. GitHub トークンを作る
1. GitHub → 右上アイコン → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
2. Token name: `note-growth-app`、Expiration: 90日など（期限が来たら作り直す）
3. Repository access: **Only select repositories** → `note-growth-team` だけ
4. Permissions → Repository permissions → **Contents: Read and write**（ほかは触らない）
5. Generate token → 表示された `github_pat_...` をコピー（この画面でしか見られない）

### 2. アプリを開いて設定する
1. スマホで公開先の URL を開く（GitHub Pages の URL）
2. 「設定」タブ → トークンを貼る、リポジトリは `gangidenset/note-growth-team`、ブランチは空欄でよい → 「保存して接続」
3. ブラウザのメニューから「ホーム画面に追加」すると、アプリのように使える

## 注意
- トークンはスマホのブラウザ内（localStorage）にだけ保存される。スマホを人に貸すときや、なくしたときは、GitHub でトークンを削除（Revoke）する
- 「設定」の「トークンを消す」で、この端末からトークンを消せる
- 見た目の確認は PC のブラウザでも、ローカルで `npx serve app` などで開ける

公開URL: https://gangidenset.github.io/note-growth-app/

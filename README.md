# Note Growth アプリ（スマホ用 PWA）

スマホから、記事の状況確認・承認・公開記録・note 投稿用テキストのコピー・見出し画像の作成・人気上位10件の調査依頼ができるアプリ。
画面はビルド不要の HTML / CSS / JavaScript、ログインの中継だけ Netlify Functions を使う。

## しくみ
- **置き場所**: Netlify（このアプリ専用のアドレス）。ほかのアプリとアドレスを分けるため、github.io には置かない
- **ログイン**: 「GitHub でログイン」→ github.com の公式画面でログイン → 戻ってくる。アプリの画面でパスワードやトークンを入力しない
- **権限**: 自分で作った GitHub アプリを note-growth-team にだけ入れ、権限は「Contents の読み書き」だけ。ログインは8時間で期限切れになり、自動で更新される
- **秘密の値**: GitHub アプリのクライアントシークレットは Netlify の環境変数にだけ置く（リポジトリ・チャットには書かない）
- **データ**: 非公開リポジトリ note-growth-team。承認・公開記録は、記録・状態・監査ログを1回のコミットで書く（途中で更新されていたら失敗する）

### 2026-10-26 の経緯
以前は github.io 上で「トークンを入力する」方式だったため、Chrome に GitHub のフィッシングサイトと誤認され、`gangidenset.github.io` 全体が「危険なサイト」と表示された（推定）。その反省で、置き場所の分離と、トークン入力をなくすログイン方式に変えた。

## 初期設定（最初に1回）
### 1. Netlify にサイトを作る
1. https://app.netlify.com にログイン →「Add new project（または Add new site）」→「Import an existing project」
2. GitHub を選び、リポジトリ `note-growth-app` を選ぶ（Netlify に権限を求められたら、note-growth-app だけを許可）
3. 設定はそのまま（Build command は空、Publish directory は `.`）→「Deploy」
4. 「Site configuration」→「Change site name」で、分かりやすい名前にする（例: `note-growth-xxxx`）。URL は `https://<名前>.netlify.app/`
5. サイトを**公開（Public）**にする。Private（Netlify ログインが必要）のままだと、Chrome がアイコンを取得できず、スマホにインストールできない。公開されるのはアプリの画面だけで、データは GitHub でログインしないと読めない

### 2. GitHub アプリを作る
1. GitHub → Settings → Developer settings → **GitHub Apps** → New GitHub App
2. GitHub App name: 他と重ならない名前（例: `note-growth-<自分の名前>`）
3. Homepage URL / Callback URL: `https://<名前>.netlify.app/`（最後の `/` まで）
4. 「Expire user authorization tokens」に**チェック**（8時間で期限切れ＋自動更新）
5. Webhook の「Active」の**チェックを外す**
6. Repository permissions → **Contents: Read and write**（ほかは No access のまま）
7. Where can this GitHub App be installed? → **Only on this account**
8. Create → 表示された **Client ID** を控える → 「Generate a new client secret」でシークレットを作り、**すぐ次の手順で Netlify に貼る**（チャットには貼らない）
9. 左メニュー「Install App」→ 自分のアカウント → **Only select repositories** → `note-growth-team` だけ → Install

### 3. Netlify に値を入れる
1. Netlify のサイト →「Site configuration」→「Environment variables」→ Add a variable
2. `GITHUB_CLIENT_ID` = 控えた Client ID
3. `GITHUB_CLIENT_SECRET` = 作ったクライアントシークレット（「Contains secret values」にチェック）。この場合は環境ごとの入力欄になるので、**Production** の欄にだけ入れる。値は40文字ほどの英数字で、これ以外の文字が入っていると Netlify の秘密情報チェックでビルドが失敗する
4. 「Deploys」→「Trigger deploy」→「Deploy project」で反映

### 4. スマホで開く
1. `https://<名前>.netlify.app/` を開く →「設定」→「GitHub でログイン」→ github.com で許可
2. 「記事」タブに記事が出れば完了。メニューから「ホーム画面に追加」

## 投稿のしかた（投稿モード）
承認済みの記事を開くと「投稿モード」になる。
1. 有料記事: 「① タイトルをコピー」「② 本文をコピー」を続けて押す →「note の投稿画面を開く」→ キーボード（Gboard）のクリップボード履歴からタイトルと本文を貼る → 画像を入れる → 目印の行を消して有料ライン、価格を設定 → 公開
2. 無料記事: 同じように貼って、無料のまま公開
3. 「見出し画像を作る」で 1280×670px の画像を作り、note の見出し画像に設定
4. 公開した記事を note で開き、「共有」→「Note Growth」→ ボタンを1回押すと記録される（Android）

## 注意
- スマホをなくしたときは、GitHub → Settings → Applications → Authorized GitHub Apps で、このアプリの許可を取り消す
- 「設定」の「ログアウト」で、この端末からログイン情報を消せる
- 正本は note-growth-team の app/。直したら note-growth-app にコピーしてプッシュする（Netlify が自動で公開する）

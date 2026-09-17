# my-news-alert-bot

RSS フィードを定期チェックして、新着記事を Discord に通知する自己ホスト型ボットです。  
Docker Compose で簡単に自宅サーバへデプロイできます。

## 機能

- 複数の RSS フィードを 1 分ごとにポーリング
- 新着エントリが見つかったときだけ **Discord Webhook で通知**を送信
  - タイトル・抜粋・記事URL を embed 形式で表示
- 通知時にタイトル/本文の HTML タグ・HTML エンティティを整形し、読みやすい形式で表示
- Google Alerts のリダイレクト URL は可能な限り元記事 URL を優先
- 通知済み ID を `/data/state.json` に保存し、再起動後に重複通知しない
- フィード単位でエラーハンドリング（1 件失敗しても他フィードは継続）
- **Web GUI 管理画面**（ポート 3334）で以下が可能：
  - **RSS フィード管理** — 監視対象 URL の一覧・追加・削除
  - Discord テスト送信（任意のタイトル・本文・URL を指定可能）
  - 通知履歴の確認

## セットアップ

### 1. `.env` を作成する

```bash
cp .env.example .env
```

`.env` を開き、実際の値を記入してください。

```env
RSS_URLS=https://www.google.co.jp/alerts/feeds/xxxxx/yyyyy
```

複数フィードはカンマ区切りで指定できます。

```env
RSS_URLS=https://feed1.example.com/rss,https://feed2.example.com/rss
```

> **ヒント**: RSS フィード URL は管理画面から追加・削除することもできます。環境変数 `RSS_URLS` はファイルが存在しない場合の初期値として使用されます。

GUI のポートを変更したい場合は `GUI_PORT` を追加してください（デフォルト: `3334`）。

```env
GUI_PORT=3334
```

### 2. コンテナを起動する

```bash
docker compose up -d --build
```

### 3. 管理画面にアクセスする

ブラウザで以下の URL を開いてください。

```
http://localhost:3334
```

管理画面では以下の操作が可能です。

- **RSS フィード管理** — 監視対象 URL の一覧表示・追加・削除（`/data/rss-urls.json` に永続化）
- **通知履歴の確認** — 過去に送信した通知のタイトル・リンク・送信時刻・フィード URL を一覧で確認できます（最大 200 件）
- **Discord テスト送信** — タイトル・本文・URL を自由に指定して Discord 通知を送信し、動作確認できます

### 4. ログを確認する

```bash
docker compose logs -f
```

コンテナ内の cron ログも確認できます。

```bash
docker compose exec news-bot tail -f /var/log/cron.log
```

### 5. 停止する

```bash
docker compose down
```

## Discord セットアップ

通知には Discord の Incoming Webhook を使用します。

1. Discord で通知を送りたいチャンネルの「チャンネル設定」→「連携サービス」→「ウェブフック」→「新しいウェブフック」
2. ウェブフックの URL をコピー
3. `.env` に追加:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxx/yyyyy
```

> ⚠️ Webhook URL はトークンを含むため、絶対にコミットしないでください。

4. 管理画面の「🧪 Discord テスト送信」フォームで動作確認できます

## API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/` | Web GUI 管理画面 |
| `GET` | `/api/history` | 通知履歴を JSON で返す |
| `GET` | `/api/rss` | 監視中の RSS URL 一覧を JSON で返す |
| `POST` | `/api/rss` | RSS URL を追加（JSON ボディ: `{ url }`）|
| `DELETE` | `/api/rss` | RSS URL を削除（JSON ボディ: `{ url }`）|
| `POST` | `/api/discord/send` | Discord にテスト通知を送信（JSON ボディ: `{ title, body?, url? }`）|

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `RSS_URLS` | | — | 監視する RSS フィード URL（カンマ区切り）。`RSS_URLS_FILE` が存在しない場合の初期値として使用される |
| `DISCORD_WEBHOOK_URL` | ✅ | — | 通知先 Discord チャンネルの Webhook URL |
| `STATE_FILE` | | `/data/state.json` | 通知済み ID の保存先パス |
| `HISTORY_FILE` | | `/data/history.json` | 通知履歴の保存先パス |
| `RSS_URLS_FILE` | | `/data/rss-urls.json` | 監視 RSS URL リストの保存先パス |
| `GUI_PORT` | | `3334` | Web GUI のリッスンポート |

## セキュリティ

> ⚠️ **重要**: `DISCORD_WEBHOOK_URL` を誤ってコミットした場合は、**即座にウェブフックを削除・再作成**してください。

- `.env` は絶対にコミットしないでください（`.gitignore` で除外済み）
- 自宅サーバ上で `.env` のパーミッションを制限することを推奨します: `chmod 600 .env`
- `data/` ディレクトリ（状態ファイル・履歴ファイル・RSS URL ファイル）も `.gitignore` で除外されています
- 管理画面は認証なしで公開されます。自宅 LAN 内や VPN 越しに限定した利用を推奨します
- `/api/discord/send` は認証不要のため、公開環境では Cloudflare Access 等で保護してください

## トラブルシューティング

### Discord に通知が届かない

- コンテナのログに `[DISCORD] Failed to send notification` が出ていないか確認してください
- `DISCORD_WEBHOOK_URL` が正しく設定されているか確認してください（Webhook URL を再コピー）
- Discord 側でウェブフックが削除されていないか確認してください
- 管理画面の「🧪 Discord テスト送信」で疎通確認できます

## ディレクトリ構成

```
.
├── index.js            # RSS チェック & Discord 通知スクリプト（cron から実行）
├── lib.js              # 共通ユーティリティ（履歴 I/O・RSS URL 管理など）
├── discord.js          # Discord Webhook 送信ユーティリティ
├── server.js           # Web GUI サーバ（Express、ポート 3334）
├── public/
│   ├── discord-client.js  # ブラウザ側 Discord テスト送信スクリプト
│   ├── rss-client.js      # ブラウザ側 RSS フィード管理スクリプト
│   └── icons/             # アイコン画像
├── entrypoint.sh       # Docker 起動スクリプト（crond + server.js）
├── package.json
├── package-lock.json
├── Dockerfile
├── run.sh              # cron から呼ばれるラッパースクリプト
├── docker-compose.yml
├── .env.example        # 環境変数のサンプル（コミット可）
├── .env                # 実際の秘密情報（コミット禁止）
└── data/               # 永続化ディレクトリ（コミット禁止）
    ├── state.json      # 通知済み ID
    ├── history.json    # 通知履歴（最大 200 件）
    └── rss-urls.json   # 監視 RSS URL リスト
```

# my-news-alert-bot

RSS フィードを定期チェックして、新着記事を Discord に通知する自己ホスト型ボットです。  
Docker Compose で簡単に自宅サーバへデプロイできます。

## 機能

- 複数の RSS フィードを 1 分ごとにポーリング
- 新着エントリが見つかったときだけ Discord へ通知
- 通知済み ID を `/data/state.json` に保存し、再起動後に重複通知しない
- フィード単位でエラーハンドリング（1 件失敗しても他フィードは継続）
- **Web GUI 管理画面**（ポート 3334）で通知履歴の確認・テスト送信が可能

## セットアップ

### 1. `.env` を作成する

```bash
cp .env.example .env
```

`.env` を開き、実際の値を記入してください。

```env
RSS_URLS=https://www.google.co.jp/alerts/feeds/xxxxx/yyyyy
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxx/yyyyy
```

複数フィードはカンマ区切りで指定できます。

```env
RSS_URLS=https://feed1.example.com/rss,https://feed2.example.com/rss
```

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

- **通知履歴の確認** — 過去に送信した通知のタイトル・リンク・送信時刻・フィード URL を一覧で確認できます（最大 200 件）
- **テスト通知の送信** — タイトルと URL を入力して、Discord へテスト通知を即座に送信できます

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

## API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/` | Web GUI 管理画面 |
| `GET` | `/api/history` | 通知履歴を JSON で返す |
| `POST` | `/api/test-discord` | テスト通知を Discord へ送信（フォームボディ: `title`, `link`）|

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `RSS_URLS` | ✅ | — | 監視する RSS フィード URL（カンマ区切り） |
| `DISCORD_WEBHOOK_URL` | ✅ | — | Discord Webhook URL |
| `STATE_FILE` | | `/data/state.json` | 通知済み ID の保存先パス |
| `HISTORY_FILE` | | `/data/history.json` | 通知履歴の保存先パス |
| `GUI_PORT` | | `3334` | Web GUI のリッスンポート |

## セキュリティ

> ⚠️ **重要**: `DISCORD_WEBHOOK_URL` を誤ってコミットした場合は、**Discord 側でそのウェブフックを即座に削除・再発行**してください。URL が漏洩した場合、第三者がチャンネルにメッセージを送信できます。

- `.env` は絶対にコミットしないでください（`.gitignore` で除外済み）
- 自宅サーバ上で `.env` のパーミッションを制限することを推奨します: `chmod 600 .env`
- `data/` ディレクトリ（状態ファイル・履歴ファイル）も `.gitignore` で除外されています
- 管理画面は認証なしで公開されます。自宅 LAN 内や VPN 越しに限定した利用を推奨します

## ディレクトリ構成

```
.
├── index.js            # RSS チェック & Discord 通知スクリプト（cron から実行）
├── lib.js              # 共通ユーティリティ（Discord 送信・履歴 I/O など）
├── server.js           # Web GUI サーバ（Express、ポート 3334）
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
    └── history.json    # 通知履歴（最大 200 件）
```


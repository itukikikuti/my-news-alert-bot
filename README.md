# my-news-alert-bot

RSS フィードを定期チェックして、新着記事を Discord に通知する自己ホスト型ボットです。  
Docker Compose で簡単に自宅サーバへデプロイできます。

## 機能

- 複数の RSS フィードを 5 分ごとにポーリング
- 新着エントリが見つかったときだけ Discord へ通知
- 通知済み ID を `/data/state.json` に保存し、再起動後に重複通知しない
- フィード単位でエラーハンドリング（1 件失敗しても他フィードは継続）

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

### 2. コンテナを起動する

```bash
docker compose up -d --build
```

### 3. ログを確認する

```bash
docker compose logs -f
```

コンテナ内の cron ログも確認できます。

```bash
docker compose exec news-bot tail -f /var/log/cron.log
```

### 4. 停止する

```bash
docker compose down
```

## セキュリティ

> ⚠️ **重要**: `DISCORD_WEBHOOK_URL` を誤ってコミットした場合は、**Discord 側でそのウェブフックを即座に削除・再発行**してください。URL が漏洩した場合、第三者がチャンネルにメッセージを送信できます。

- `.env` は絶対にコミットしないでください（`.gitignore` で除外済み）
- 自宅サーバ上で `.env` のパーミッションを制限することを推奨します: `chmod 600 .env`
- `data/` ディレクトリ（状態ファイル）も `.gitignore` で除外されています

## ディレクトリ構成

```
.
├── index.js            # RSS チェック & Discord 通知スクリプト
├── package.json
├── package-lock.json
├── Dockerfile
├── run.sh              # cron から呼ばれるラッパースクリプト
├── docker-compose.yml
├── .env.example        # 環境変数のサンプル（コミット可）
├── .env                # 実際の秘密情報（コミット禁止）
└── data/               # 通知済み ID の永続化（コミット禁止）
    └── state.json
```

# my-news-alert-bot

RSS フィードを定期チェックして、新着記事を Discord に通知する自己ホスト型ボットです。  
Docker Compose で簡単に自宅サーバへデプロイできます。  
**Web Push（Android Chrome 対応）** にも対応しており、ブラウザから直接プッシュ通知を受け取れます。

## 機能

- 複数の RSS フィードを 1 分ごとにポーリング
- 新着エントリが見つかったときだけ Discord へ通知
- **Web Push 通知**（Android Chrome）— ブラウザから購読して通知を受信
- 通知時にタイトル/本文の HTML タグ・HTML エンティティを整形し、読みやすい形式で表示
- Google Alerts のリダイレクト URL は可能な限り元記事 URL を優先
- 通知済み ID を `/data/state.json` に保存し、再起動後に重複通知しない
- フィード単位でエラーハンドリング（1 件失敗しても他フィードは継続）
- **Web GUI 管理画面**（ポート 3334）で通知履歴の確認・テスト送信・Push 購読が可能

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
- **Web Push 購読** — 「Push通知を購読する」ボタンで Android Chrome からプッシュ通知を受け取れます

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

## Web Push セットアップ

### VAPID キーの生成

Web Push には VAPID（Voluntary Application Server Identification）キーが必要です。  
以下のいずれかの方法で生成してください。

**方法 A: npx を使う（推奨）**

```bash
npx web-push generate-vapid-keys
```

**方法 B: Node.js スクリプトで生成**

```bash
node -e "
import('web-push').then(wp => {
  const k = wp.default.generateVAPIDKeys();
  console.log('VAPID_PUBLIC_KEY=' + k.publicKey);
  console.log('VAPID_PRIVATE_KEY=' + k.privateKey);
});
"
```

生成された値を `.env` に追加してください。

```env
VAPID_PUBLIC_KEY=BExamplePublicKey...
VAPID_PRIVATE_KEY=ExamplePrivateKey...
VAPID_SUBJECT=mailto:you@example.com
```

> ⚠️ `VAPID_PRIVATE_KEY` は絶対にコミットしないでください。

### Cloudflare Tunnel での利用

Web Push は HTTPS が必要です。Cloudflare Tunnel を使用している場合、  
サイトは既に `https://` 配信されているため、追加設定は不要です。

1. Cloudflare Tunnel で `https://your-domain.example.com` → `localhost:3334` を設定済みであること
2. Android Chrome で `https://your-domain.example.com` にアクセス
3. 管理画面の「Push通知を購読する」をタップ → 通知を許可
4. 購読が完了したら `/api/push/send` または RSS アラート経由で通知が届きます

### Android でのテスト手順

1. Cloudflare Tunnel 経由で HTTPS にアクセスできる状態にする
2. Android Chrome で `https://your-domain.example.com` を開く
3. 「Push通知を購読する」ボタンをタップ
4. 「通知を許可」をタップ
5. 「✅ Push通知の購読が完了しました！」と表示されれば成功
6. テスト送信: `curl -X POST https://your-domain.example.com/api/push/send -H "Content-Type: application/json" -d '{"title":"テスト","body":"Web Push 動作確認","url":"/"}'`
7. Android の通知バーにプッシュ通知が届いていることを確認

## API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/` | Web GUI 管理画面 |
| `GET` | `/api/history` | 通知履歴を JSON で返す |
| `POST` | `/api/test-discord` | テスト通知を Discord へ送信（フォームボディ: `title`, `link`）|
| `POST` | `/api/push/subscribe` | Push 購読を保存（JSON ボディ: PushSubscription オブジェクト）|
| `POST` | `/api/push/unsubscribe` | Push 購読を削除（JSON ボディ: `{ endpoint }`）|
| `POST` | `/api/push/send` | Push 通知を全購読者へ送信（JSON ボディ: `{ title, body?, url?, icon?, badge?, tag? }`）|

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `RSS_URLS` | ✅ | — | 監視する RSS フィード URL（カンマ区切り） |
| `DISCORD_WEBHOOK_URL` | ✅ | — | Discord Webhook URL |
| `VAPID_PUBLIC_KEY` | | — | Web Push 用 VAPID 公開鍵（Push 通知を使う場合は必須） |
| `VAPID_PRIVATE_KEY` | | — | Web Push 用 VAPID 秘密鍵（Push 通知を使う場合は必須） |
| `VAPID_SUBJECT` | | — | VAPID 送信元識別子（例: `mailto:you@example.com`）|
| `STATE_FILE` | | `/data/state.json` | 通知済み ID の保存先パス |
| `HISTORY_FILE` | | `/data/history.json` | 通知履歴の保存先パス |
| `SUBSCRIPTIONS_FILE` | | `/data/subscriptions.json` | Push 購読情報の保存先パス |
| `GUI_PORT` | | `3334` | Web GUI のリッスンポート |

## セキュリティ

> ⚠️ **重要**: `DISCORD_WEBHOOK_URL` や `VAPID_PRIVATE_KEY` を誤ってコミットした場合は、**それぞれの秘密情報を即座に無効化・再発行**してください。

- `.env` は絶対にコミットしないでください（`.gitignore` で除外済み）
- 自宅サーバ上で `.env` のパーミッションを制限することを推奨します: `chmod 600 .env`
- `data/` ディレクトリ（状態ファイル・履歴ファイル・購読ファイル）も `.gitignore` で除外されています
- 管理画面は認証なしで公開されます。自宅 LAN 内や VPN 越しに限定した利用を推奨します
- `/api/push/send` は認証不要のため、公開環境では Cloudflare Access 等で保護してください

## トラブルシューティング（Web Push）

### 通知の許可を拒否してしまった

ブラウザのアドレスバー左の鍵アイコン → 「通知」→ 「許可」に変更してください。  
Android Chrome では設定 → サイト設定 → 通知 から該当サイトを許可できます。

### 購読が失効した / 通知が届かない

購読は端末やブラウザのデータ削除、OS の通知設定変更などで失効します。  
サーバーは送信失敗時（HTTP 404/410）に購読を自動で削除します。  
再度「Push通知を購読する」ボタンをタップして再登録してください。

### VAPID キーが設定されていない

サーバーログに `[PUSH] VAPID keys are not fully configured` と表示されます。  
`.env` に `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT` を設定してください。

### Service Worker が登録されない

- サイトが `https://` または `localhost` で配信されていることを確認してください
- `sw.js` がサーバーのルートから `/sw.js` でアクセスできることを確認してください

## ディレクトリ構成

```
.
├── index.js            # RSS チェック & Discord 通知スクリプト（cron から実行）
├── lib.js              # 共通ユーティリティ（Discord 送信・履歴 I/O など）
├── push.js             # Web Push ユーティリティ（VAPID・購読管理・送信）
├── server.js           # Web GUI サーバ（Express、ポート 3334）
├── public/
│   ├── sw.js           # Service Worker（push イベント処理）
│   └── push-client.js  # ブラウザ側 Push 購読スクリプト
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
    └── subscriptions.json  # Web Push 購読情報
```


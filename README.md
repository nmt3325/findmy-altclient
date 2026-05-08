# FindMy Location Tracker

AirTag・iPhone などの Apple FindMy 対応デバイス、OpenHaystack 互換デバイス、および **Google Find My Device** 対応トラッカーの位置履歴をローカルに保存してマップ表示するツール。

各サーバー側の保存期限を超えた位置情報も、ローカルの SQLite データベースから閲覧できます。

## 特徴

- **Apple FindMy**（FindMy.py）と **Google Find My Device**（GoogleFindMyTools）の両方に対応
- AirTag / iPhone など Apple 純正デバイス、OpenHaystack 互換自作デバイスに対応
- Google Find My Device 登録済みトラッカーにも対応（`secret.json` を配置するだけで利用可能）
- 取得した位置履歴を SQLite に蓄積（サーバー側の削除後も保持）
- ポイント間を線で接続してルート表示
- 同一タイムスタンプの複数レポートは平均座標にまとめて表示
- 表示期間の自由な選択（プリセット: 1h / 6h / 3d / 7d / 30d）
- デバイスごとの表示 / 非表示切り替え・名前変更
- ポイントタップで日時・座標・精度を表示
- Google Maps タイル（Roadmap / Satellite / Hybrid / Terrain）
- 15 分ごとの自動ポーリング（設定変更可）

## セットアップ

### 1. 依存パッケージのインストール

```bash
pip install -r requirements.txt
```

---

### Apple FindMy の設定

#### 2-A. Apple アカウント認証

```bash
python auth_setup.py
```

メールアドレス・パスワードを入力し、2FA コードで認証します。  
認証情報は `data/account.json` に保存されます（Git には含めないこと）。

#### 3-A. デバイスファイルの配置

`devices/` フォルダにデバイスキーファイルを配置します。

| デバイス種別 | ファイル形式 | 取得方法 |
|---|---|---|
| AirTag / iPhone | `.plist` | macOS の FindMy アプリのデータから取得（`~/Library/Application Support/com.apple.icloud.searchpartyd/`） |
| OpenHaystack 互換自作デバイス | `.json` | FindMy.py または macless-haystack で生成したキーファイル |

---

### Google Find My Device の設定

Google Find My Device 連携には [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) が必要です。  
認証は別のマシン（Chrome が使えるマシン）で済ませておく前提です。

#### 2-B. GoogleFindMyTools のクローンと依存インストール

```bash
git clone https://github.com/leonboe1/GoogleFindMyTools google_findmy_tools
pip install -r google_findmy_tools/requirements.txt
```

#### 3-B. 認証ファイルの配置

認証済みマシンの `google_findmy_tools/Auth/secrets.json` をこのプロジェクトのルートに `secret.json` としてコピーします。

```bash
# 認証済みマシンで実施
scp /path/to/GoogleFindMyTools/Auth/secrets.json user@thishost:/path/to/findmy-altclient/secret.json
```

`secret.json` の内容（参考）:

```json
{
  "username": "your@gmail.com",
  "aas_token": "aas_...",
  "fcm_credentials": { ... }
}
```

`secret.json` はサーバー起動時に自動的に `google_findmy_tools/Auth/secrets.json` へコピーされます。

---

### 4. サーバー起動

```bash
python server.py
```

ブラウザで `http://localhost:8080` を開くと地図が表示されます。

- サイドバーの **「Poll Apple」** ボタン: Apple FindMy を手動ポーリング
- サイドバーの **「Poll Google」** ボタン: Google Find My Device を手動ポーリング
- Google デバイスはデバイス名の横に **[Google]** バッジが表示されます

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `8080` | サーバーポート |
| `POLL_INTERVAL` | `900` | 自動ポーリング間隔（秒、Apple・Google 共通） |
| `ANISETTE_SERVER` | `None` | 外部 Anisette サーバーの URL（省略時: 組み込み） |
| `GOOGLE_LOCATION_TIMEOUT` | `30` | Google デバイスの FCM 応答待機タイムアウト（秒/台） |

## 注意事項

- `data/account.json` には Apple 認証トークンが含まれます。絶対に公開しないでください。
- `secret.json` には Google アカウントの認証トークンが含まれます。絶対に公開しないでください。
- `devices/` フォルダのファイルにはデバイスの秘密鍵が含まれます。`.gitignore` で除外されています。
- FindMy.py の Anisette 機能は初回起動時にライブラリをダウンロードします（`data/ani_libs.bin`）。
- Google Find My Device の位置取得は FCM（Firebase Cloud Messaging）を使用するため、デバイスごとに数秒〜30 秒かかります。

## 依存ライブラリ

- [FindMy.py](https://github.com/malmeloo/FindMy.py) — Apple FindMy ネットワークとのインターフェース
- [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) — Google Find My Device ネットワークとのインターフェース
- [Flask](https://flask.palletsprojects.com/) — Web サーバー
- [Leaflet.js](https://leafletjs.com/) — マップ表示
- Google Maps タイル（API キー不要）

# FindMy Location Tracker

AirTag・iPhone などの FindMy 対応デバイスおよび OpenHaystack 互換デバイスの位置履歴をローカルに保存してマップ表示するツール。

Apple のサーバーから位置情報が削除された後もローカルの SQLite データベースから閲覧できます。

## 特徴

- **FindMy.py** を使用して AirTag・iPhone など純正デバイスの位置情報を取得
- OpenHaystack 互換の自作デバイスにも対応
- 取得した位置履歴を SQLite に蓄積（Apple サーバーの 7 日制限を超えた履歴も保持）
- ポイント間を線で接続してルート表示
- 同一タイムスタンプの複数レポートは平均座標にまとめて表示
- 表示期間の自由な選択（プリセット: 1h / 6h / 24h / 3d / 7d / 30d）
- デバイスごとの表示 / 非表示切り替え
- ポイントタップで日時・座標・精度を表示
- Google Maps タイル（Roadmap / Satellite / Hybrid / Terrain）
- 15 分ごとの自動ポーリング（設定変更可）

## セットアップ

### 1. 依存パッケージのインストール

```bash
pip install -r requirements.txt
```

### 2. Apple アカウント認証

```bash
python auth_setup.py
```

メールアドレス・パスワードを入力し、2FA コードで認証します。  
認証情報は `data/account.json` に保存されます（Git には含めないこと）。

### 3. デバイスファイルの配置

`devices/` フォルダにデバイスキーファイルを配置します。

| デバイス種別 | ファイル形式 | 取得方法 |
|---|---|---|
| AirTag / iPhone | `.plist` | macOS の FindMy アプリのデータから取得（`~/Library/Application Support/com.apple.icloud.searchpartyd/`） |
| OpenHaystack 互換自作デバイス | `.json` | FindMy.py または macless-haystack で生成したキーファイル |

### 4. サーバー起動

```bash
python server.py
```

ブラウザで `http://localhost:8080` を開くと地図が表示されます。

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `8080` | サーバーポート |
| `POLL_INTERVAL` | `900` | 自動ポーリング間隔（秒） |
| `ANISETTE_SERVER` | `None` | 外部 Anisette サーバーの URL（省略時: 組み込み） |

## 注意事項

- `data/account.json` には Apple 認証トークンが含まれます。絶対に公開しないでください。
- `devices/` フォルダのファイルにはデバイスの秘密鍵が含まれます。`.gitignore` で除外されています。
- FindMy.py の Anisette 機能は初回起動時にライブラリをダウンロードします（`data/ani_libs.bin`）。

## 依存ライブラリ

- [FindMy.py](https://github.com/malmeloo/FindMy.py) — Apple FindMy ネットワークとのインターフェース
- [Flask](https://flask.palletsprojects.com/) — Web サーバー
- [Leaflet.js](https://leafletjs.com/) — マップ表示
- Google Maps タイル（API キー不要）

# S3 Glacier Deep Archive API

モバイルアプリ向けのS3 Glacier Deep Archiveアーカイブ保存APIです。

## 機能

- ファイルのアーカイブ保存（Deep Archive）
- アーカイブ一覧取得
- アーカイブファイルの復元・取得
- アーカイブの削除

## API エンドポイント

### 1. ファイルアーカイブ
```
POST /archive/upload
```

リクエスト例：
```json
{
  "fileName": "document.pdf",
  "fileContent": "base64エンコードされたファイル内容",
  "metadata": {
    "description": "重要な文書",
    "category": "documents"
  }
}
```

### 2. アーカイブ一覧取得
```
GET /archive/list?limit=50&continuationToken=xxx
```

### 3. アーカイブ取得・復元
```
GET /archive/{archiveId}
```

### 4. アーカイブ削除
```
DELETE /archive/{archiveId}
```

## ローカル開発

### 前提条件
- Node.js 18以上
- Python 3.8以上（moto用）

### 開発環境の選択肢

#### 1. 完全ローカル環境（moto使用）- 推奨
AWSサービスを完全にモックして、インターネット接続不要で開発

#### 2. 実AWS環境
実際のAWSリソースを使用した開発

### 完全ローカル環境（Docker + moto）のセットアップ

1. 前提条件：
```bash
# Docker と Docker Compose がインストール済みであることを確認
docker --version
docker-compose --version
```

2. 開発環境の起動：
```bash
# 簡単起動（推奨）
./scripts/dev-moto.sh start

# または手動でDocker Compose
npm run docker:up
```

3. API確認：
```bash
# 自動テスト実行
./scripts/dev-moto.sh test

# 手動確認
curl http://localhost:3000/health
curl http://localhost:3000/
```

### 開発用コマンド

```bash
# 環境管理
./scripts/dev-moto.sh start     # 環境起動
./scripts/dev-moto.sh stop      # 環境停止
./scripts/dev-moto.sh restart   # 環境再起動
./scripts/dev-moto.sh status    # 状態確認

# 開発・テスト
./scripts/dev-moto.sh test      # APIテスト実行
./scripts/dev-moto.sh logs      # ログ表示
./scripts/dev-moto.sh setup     # AWSリソース再作成

# クリーンアップ
./scripts/dev-moto.sh clean     # 完全削除
```

### 実AWS環境のセットアップ

1. 依存関係のインストール：
```bash
npm install
```

2. 環境変数の設定：
```bash
cp .env.example .env
# .envファイルを編集して適切な値を設定
```

3. ローカルサーバー起動：
```bash
npm run dev
```

### ローカル開発での認証

開発環境では簡易認証を使用：
```bash
# 認証が必要なエンドポイントのテスト
curl -H "Authorization: Bearer mock-token" \
     -H "Content-Type: application/json" \
     http://localhost:3000/archive/list
```

### moto環境の利点

- ✅ **完全オフライン**: インターネット接続不要
- ✅ **高速**: ローカルでの実行で高速
- ✅ **無料**: AWSコスト発生なし
- ✅ **リセット可能**: 簡単にデータリセット
- ✅ **Cognito対応**: 無料でCognitoもモック

## デプロイ

### 前提条件
- AWS CLI設定済み
- Node.js 18以上
- AWS CDK CLI インストール済み

### 初回セットアップ

1. 依存関係のインストール：
```bash
npm install
```

2. CDK Bootstrap（初回のみ）：
```bash
npx cdk bootstrap
```

### デプロイ手順

1. TypeScriptコンパイル：
```bash
npm run build
```

2. CDKスタック確認：
```bash
npm run diff
```

3. デプロイ：
```bash
npm run deploy
```

### 環境別デプロイ

```bash
# 開発環境
npx cdk deploy -c environment=dev

# ステージング環境
npx cdk deploy -c environment=staging

# 本番環境
npx cdk deploy -c environment=prod
```

### スタック削除

```bash
npm run destroy
```

## 重要な注意事項

### Deep Archiveの特徴
- 最低保存期間：180日
- 復元時間：12-48時間
- 非常に低コストだが、即座にアクセスできない

### 復元プロセス
1. 復元リクエスト送信
2. 12-48時間待機
3. 復元完了後にファイル取得可能
4. 復元されたファイルは1日間利用可能

### モバイルアプリでの使用方法

ファイルをBase64エンコードしてアップロード：
```javascript
// React Native例
const uploadFile = async (fileUri) => {
  const base64 = await RNFS.readFile(fileUri, 'base64');
  
  const response = await fetch('https://your-api-url/archive/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileName: 'myfile.jpg',
      fileContent: base64,
      metadata: {
        uploadedFrom: 'mobile-app'
      }
    })
  });
  
  const result = await response.json();
  console.log('Archive ID:', result.archiveId);
};
```

## コスト最適化

- Deep Archiveは長期保存に最適
- 頻繁にアクセスするファイルには不向き
- 復元コストも考慮して使用してください

## セキュリティ

- API GatewayでCORS設定済み
- 本番環境では認証機能の追加を推奨
- IAMロールで最小権限の原則を適用
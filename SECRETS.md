# GitHub Secrets Configuration

## 必要なSecrets

### AWS関連
- `AWS_ACCESS_KEY_ID` - 開発環境用AWSアクセスキー
- `AWS_SECRET_ACCESS_KEY` - 開発環境用AWSシークレットキー
- `AWS_ACCESS_KEY_ID_PROD` - 本番環境用AWSアクセスキー
- `AWS_SECRET_ACCESS_KEY_PROD` - 本番環境用AWSシークレットキー

### Stripe関連
- `STRIPE_SECRET_KEY_DEV` - 開発環境用Stripeシークレットキー (sk_test_...)
- `STRIPE_WEBHOOK_SECRET_DEV` - 開発環境用Webhook秘密鍵 (whsec_...)
- `STRIPE_SECRET_KEY_PROD` - 本番環境用Stripeシークレットキー (sk_live_...)
- `STRIPE_WEBHOOK_SECRET_PROD` - 本番環境用Webhook秘密鍵 (whsec_...)

## Secrets設定手順

1. GitHubリポジトリページに移動
2. Settings → Secrets and variables → Actions
3. "New repository secret" をクリック
4. 上記のsecret名と値を設定

## 環境別設定

### Development Environment
- ブランチ: `develop`
- AWS Account: 開発用アカウント
- Stripe: テストモード

### Production Environment  
- ブランチ: `main`
- AWS Account: 本番用アカウント
- Stripe: 本番モード

## セキュリティ注意事項

❌ **絶対にコミットしてはいけないもの:**
- AWS Access Keys
- Stripe Secret Keys
- Webhook Secrets
- 本番環境の設定値

✅ **コミットして良いもの:**
- 環境変数のテンプレート (.env.example)
- 設定ファイルの構造
- デプロイスクリプト
# GitHub Secrets Setup Guide

## 🔐 必須Secrets一覧

### AWS関連
```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_ACCESS_KEY_ID_PROD=AKIA...
AWS_SECRET_ACCESS_KEY_PROD=your-prod-secret-key
```

### Stripe関連
```
STRIPE_SECRET_KEY_DEV=sk_test_51...
STRIPE_WEBHOOK_SECRET_DEV=whsec_1...
STRIPE_SECRET_KEY_PROD=sk_live_51...
STRIPE_WEBHOOK_SECRET_PROD=whsec_1...
```

## 📋 設定手順

### 1. GitHubリポジトリでSecrets設定
1. リポジトリページ → **Settings**
2. **Secrets and variables** → **Actions**
3. **New repository secret** をクリック
4. 上記のsecretを一つずつ追加

### 2. Stripe Webhook Secret の取得方法
1. Stripe Dashboard → **Developers** → **Webhooks**
2. **Add endpoint** をクリック
3. Endpoint URL: `https://your-api-url.amazonaws.com/dev/webhook/stripe`
4. **Select events** で以下を選択：
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.created`
   - `customer.updated`
5. **Add endpoint** をクリック
6. 作成されたWebhookの **Signing secret** をコピー

### 3. AWS IAM設定
デプロイ用のIAMユーザーに以下の権限を付与：

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "cloudformation:*",
                "s3:*",
                "lambda:*",
                "apigateway:*",
                "iam:*",
                "cognito-idp:*",
                "dynamodb:*",
                "cloudfront:*",
                "logs:*",
                "sts:GetCallerIdentity"
            ],
            "Resource": "*"
        }
    ]
}
```

## ✅ 設定確認

### 1. Secrets確認
```bash
# GitHub Actions実行時にログで確認
echo "Stripe key configured: ${STRIPE_SECRET_KEY_DEV:0:7}..."
```

### 2. Webhook動作確認
```bash
# Stripe Dashboard → Webhooks → Test webhook
# または実際に決済テストを実行
```

## 🚨 セキュリティ注意事項

### ❌ 絶対にやってはいけないこと
- Stripe keyをコードにハードコード
- 本番keyをテスト環境で使用
- Webhook secretを公開リポジトリにコミット

### ✅ 推奨事項
- 定期的なkey rotation
- 最小権限の原則
- ログでの秘密情報マスキング
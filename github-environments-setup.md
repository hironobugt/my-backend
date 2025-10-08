# GitHub Environments Setup Guide

## 🌍 Environment設定

GitHub ActionsでのCI/CDパイプラインを安全に運用するため、Environment機能を使用します。

### 1. Environmentsの作成

1. GitHubリポジトリ → **Settings**
2. **Environments** をクリック
3. **New environment** をクリック

#### Development Environment
- **Name**: `development`
- **Deployment branches**: `develop` ブランチのみ
- **Environment secrets**: 開発環境用のsecrets

#### Production Environment  
- **Name**: `production`
- **Deployment branches**: `main` ブランチのみ
- **Required reviewers**: 本番デプロイ前の承認者を設定
- **Wait timer**: 本番デプロイ前の待機時間（オプション）
- **Environment secrets**: 本番環境用のsecrets

### 2. Environment Secrets設定

#### Development Environment Secrets
```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=your-dev-secret-key
STRIPE_SECRET_KEY_DEV=sk_test_51...
STRIPE_WEBHOOK_SECRET_DEV=whsec_1...
```

#### Production Environment Secrets
```
AWS_ACCESS_KEY_ID_PROD=AKIA...
AWS_SECRET_ACCESS_KEY_PROD=your-prod-secret-key
STRIPE_SECRET_KEY_PROD=sk_live_51...
STRIPE_WEBHOOK_SECRET_PROD=whsec_1...
```

### 3. Branch Protection Rules

#### Main Branch (本番)
1. **Settings** → **Branches**
2. **Add rule** をクリック
3. Branch name pattern: `main`
4. 設定項目：
   - ✅ Require a pull request before merging
   - ✅ Require approvals (1人以上)
   - ✅ Dismiss stale PR approvals when new commits are pushed
   - ✅ Require status checks to pass before merging
   - ✅ Require branches to be up to date before merging
   - ✅ Require linear history
   - ✅ Include administrators

#### Develop Branch (開発)
1. Branch name pattern: `develop`
2. 設定項目：
   - ✅ Require status checks to pass before merging
   - ✅ Require branches to be up to date before merging

## 🚀 デプロイフロー

### 自動デプロイ
```
feature/* → develop → 開発環境デプロイ
develop → main → 本番環境デプロイ（承認必要）
```

### 手動デプロイ
1. **Actions** タブ
2. **Manual Deploy** ワークフロー選択
3. **Run workflow** をクリック
4. 環境とオプションを選択して実行

## 🔒 セキュリティ設定

### IAM Policy（最小権限）
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "cloudformation:CreateStack",
                "cloudformation:UpdateStack",
                "cloudformation:DeleteStack",
                "cloudformation:DescribeStacks",
                "cloudformation:DescribeStackEvents",
                "cloudformation:DescribeStackResources",
                "cloudformation:GetTemplate",
                "s3:CreateBucket",
                "s3:DeleteBucket",
                "s3:GetBucketLocation",
                "s3:GetBucketPolicy",
                "s3:PutBucketPolicy",
                "s3:PutBucketVersioning",
                "s3:PutBucketNotification",
                "s3:PutObject",
                "s3:GetObject",
                "s3:DeleteObject",
                "lambda:CreateFunction",
                "lambda:UpdateFunctionCode",
                "lambda:UpdateFunctionConfiguration",
                "lambda:DeleteFunction",
                "lambda:GetFunction",
                "lambda:ListFunctions",
                "lambda:AddPermission",
                "lambda:RemovePermission",
                "apigateway:*",
                "iam:CreateRole",
                "iam:DeleteRole",
                "iam:GetRole",
                "iam:PassRole",
                "iam:AttachRolePolicy",
                "iam:DetachRolePolicy",
                "iam:PutRolePolicy",
                "iam:DeleteRolePolicy",
                "cognito-idp:CreateUserPool",
                "cognito-idp:DeleteUserPool",
                "cognito-idp:DescribeUserPool",
                "cognito-idp:UpdateUserPool",
                "cognito-idp:CreateUserPoolClient",
                "cognito-idp:DeleteUserPoolClient",
                "cognito-idp:DescribeUserPoolClient",
                "cognito-idp:UpdateUserPoolClient",
                "dynamodb:CreateTable",
                "dynamodb:DeleteTable",
                "dynamodb:DescribeTable",
                "dynamodb:UpdateTable",
                "cloudfront:CreateDistribution",
                "cloudfront:DeleteDistribution",
                "cloudfront:GetDistribution",
                "cloudfront:UpdateDistribution",
                "logs:CreateLogGroup",
                "logs:DeleteLogGroup",
                "logs:DescribeLogGroups",
                "sts:GetCallerIdentity"
            ],
            "Resource": "*"
        }
    ]
}
```

### Repository Secrets（共通）
```
# 通知用（オプション）
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

## 📊 モニタリング

### デプロイ状況の確認
1. **Actions** タブでワークフロー実行状況を確認
2. AWS CloudFormationコンソールでスタック状況を確認
3. API Gateway URLでサービス動作を確認

### 失敗時の対応
1. GitHub Actionsのログを確認
2. AWS CloudFormationのイベントを確認
3. 必要に応じて手動でロールバック

## 🎯 ベストプラクティス

### ✅ 推奨事項
- 本番デプロイには必ず承認プロセスを設定
- 環境別にAWSアカウントを分離
- Secretsの定期的なローテーション
- デプロイ前のテスト実行
- スモークテストの実装

### ❌ 避けるべきこと
- 本番環境への直接プッシュ
- Secretsのハードコード
- テストなしでのデプロイ
- 権限の過剰付与
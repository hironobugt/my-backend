# GitHub Secrets Setup Guide

## 🔐 Required Secrets

### AWS Development Environment
```
Name: AWS_ACCESS_KEY_ID
Value: AKIA... (your dev AWS access key)

Name: AWS_SECRET_ACCESS_KEY  
Value: your-dev-secret-access-key
```

### AWS Production Environment
```
Name: AWS_ACCESS_KEY_ID_PROD
Value: AKIA... (your prod AWS access key)

Name: AWS_SECRET_ACCESS_KEY_PROD
Value: your-prod-secret-access-key
```

### Stripe Development
```
Name: STRIPE_SECRET_KEY_DEV
Value: sk_test_... (your Stripe test secret key)

Name: STRIPE_WEBHOOK_SECRET_DEV
Value: whsec_... (your Stripe test webhook secret)
```

### Stripe Production
```
Name: STRIPE_SECRET_KEY_PROD
Value: sk_live_... (your Stripe live secret key)

Name: STRIPE_WEBHOOK_SECRET_PROD
Value: whsec_... (your Stripe live webhook secret)
```

## 🛠️ Setup Steps

1. Go to your GitHub repository
2. Click **Settings** tab
3. Click **Secrets and variables** → **Actions**
4. Click **New repository secret**
5. Add each secret above

## 🔒 Security Best Practices

✅ **DO:**
- Use separate AWS accounts for dev/prod
- Use Stripe test keys for development
- Rotate keys regularly
- Use least privilege IAM policies

❌ **DON'T:**
- Commit secrets to code
- Share secrets in chat/email
- Use production keys in development
- Give excessive permissions

## 📋 IAM Policy for AWS User

Minimum required permissions for deployment:

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

## 🧪 Testing Secrets

After setup, test with a manual workflow dispatch:
1. Go to **Actions** tab
2. Select **Deploy Glaceon API**
3. Click **Run workflow**
4. Choose environment and run
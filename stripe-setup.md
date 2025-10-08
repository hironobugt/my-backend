# Stripe設定ガイド

## 🏪 商品・価格設定

### 1. 基本料金プラン
```
商品名: Glacier Archive Base Plan
価格: $5.00/月
ID: price_base_plan_monthly
```

### 2. 従量課金項目

#### ストレージ料金
```
商品名: Storage Usage
価格: $0.01 per GB per month
ID: price_storage_gb_monthly
課金方式: Usage-based
```

#### アップロード料金
```
商品名: File Upload
価格: $0.05 per upload
ID: price_upload_per_file
課金方式: Usage-based
```

#### 復元料金
```
商品名: File Restore
価格: $0.10 per restore
ID: price_restore_per_file
課金方式: Usage-based
```

## 🔧 Stripe Dashboard設定手順

### 1. Products & Pricing
1. **Products** → **Add product**
2. 上記の商品を順番に作成
3. **Usage-based pricing** を選択（従量課金項目）
4. **Recurring pricing** を選択（基本料金）

### 2. Webhooks設定
```
Endpoint URL: https://your-api-url.amazonaws.com/dev/webhook/stripe
Events to send:
- customer.subscription.created
- customer.subscription.updated  
- customer.subscription.deleted
- invoice.payment_succeeded
- invoice.payment_failed
- customer.created
- customer.updated
```

### 3. API Keys
```
Test Mode:
- Publishable key: pk_test_...
- Secret key: sk_test_...

Live Mode:
- Publishable key: pk_live_...
- Secret key: sk_live_...
```

## 🔐 GitHub Secrets設定

```bash
# 開発環境
STRIPE_SECRET_KEY_DEV=sk_test_your_actual_test_key
STRIPE_WEBHOOK_SECRET_DEV=whsec_your_webhook_secret

# 本番環境  
STRIPE_SECRET_KEY_PROD=sk_live_your_actual_live_key
STRIPE_WEBHOOK_SECRET_PROD=whsec_your_webhook_secret_prod
```

## 📊 使用量レポート設定

Stripeで使用量を自動レポートするため、以下のAPIを使用：

```javascript
// 使用量の記録
await stripe.subscriptionItems.createUsageRecord(
  subscription_item_id,
  {
    quantity: usage_amount,
    timestamp: Math.floor(Date.now() / 1000),
    action: 'increment'
  }
);
```
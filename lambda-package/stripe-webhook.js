const Stripe = require('stripe');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { getAWSConfig } = require('./aws-config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const awsConfig = getAWSConfig();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

// 料金設定
const PRICING = {
    storage: 0.012,
    upload: 0.09,
    restore: 0.40,
    baseFee: 3.00,
    thumbnailDelivery: 0.0005,
    apiRequests: 0.000008
};

exports.handler = async (event) => {
    try {
        const sig = event.headers['stripe-signature'];
        const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

        let stripeEvent;
        try {
            stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
        } catch (err) {
            console.error('Webhook signature verification failed:', err.message);
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Webhook signature verification failed' })
            };
        }

        console.log('Received Stripe webhook:', stripeEvent.type);

        // 請求書作成前のイベントで使用量を追加
        if (stripeEvent.type === 'invoice.upcoming') {
            await handleUpcomingInvoice(stripeEvent.data.object);
        }

        // 請求書確定時の処理
        if (stripeEvent.type === 'invoice.finalized') {
            await handleInvoiceFinalized(stripeEvent.data.object);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ received: true })
        };

    } catch (error) {
        console.error('Webhook error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// 請求書作成前に使用量ベースの料金を追加
const handleUpcomingInvoice = async (invoice) => {
    try {
        console.log('Processing upcoming invoice:', invoice.id);

        // サブスクリプションから顧客情報を取得
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const customerId = subscription.customer;

        // メタデータから使用量課金が有効かチェック
        if (subscription.metadata.usage_billing_enabled !== 'true') {
            console.log('Usage billing not enabled for this subscription');
            return;
        }

        const userId = subscription.metadata.user_id;
        if (!userId) {
            console.log('No user_id found in subscription metadata');
            return;
        }

        // 請求期間を取得
        const periodStart = new Date(invoice.period_start * 1000);
        const periodMonth = periodStart.toISOString().slice(0, 7); // YYYY-MM

        console.log(`Adding usage charges for user ${userId}, period ${periodMonth}`);

        // 使用量データを取得
        const usageResponse = await dynamoClient.send(new GetCommand({
            TableName: process.env.USAGE_TABLE,
            Key: {
                userId: userId,
                periodMonth: periodMonth
            }
        }));

        const usage = usageResponse.Item || {
            storageGB: 0,
            uploadGB: 0,
            restoreGB: 0,
            thumbnailViews: 0,
            apiRequestCount: 0
        };

        // 使用量ベースの料金を計算
        const costs = {
            storage: usage.storageGB * PRICING.storage,
            uploads: usage.uploadGB * PRICING.upload,
            restores: (usage.restoreGB || 0) * PRICING.restore,
            thumbnails: (usage.thumbnailViews || 0) * PRICING.thumbnailDelivery,
            apiRequests: (usage.apiRequestCount || 0) * PRICING.apiRequests
        };

        // 使用量がある項目のみ請求書に追加
        if (costs.storage > 0) {
            await stripe.invoiceItems.create({
                customer: customerId,
                invoice: invoice.id,
                amount: Math.round(costs.storage * 100),
                currency: 'usd',
                description: `Storage: ${usage.storageGB.toFixed(3)} GB @ $${PRICING.storage}/GB`
            });
            console.log(`Added storage charge: $${costs.storage.toFixed(4)}`);
        }

        if (costs.uploads > 0) {
            await stripe.invoiceItems.create({
                customer: customerId,
                invoice: invoice.id,
                amount: Math.round(costs.uploads * 100),
                currency: 'usd',
                description: `Uploads: ${usage.uploadGB.toFixed(3)} GB @ $${PRICING.upload}/GB`
            });
            console.log(`Added upload charge: $${costs.uploads.toFixed(4)}`);
        }

        if (costs.restores > 0) {
            await stripe.invoiceItems.create({
                customer: customerId,
                invoice: invoice.id,
                amount: Math.round(costs.restores * 100),
                currency: 'usd',
                description: `Restores: ${(usage.restoreGB || 0).toFixed(3)} GB @ $${PRICING.restore}/GB`
            });
            console.log(`Added restore charge: $${costs.restores.toFixed(4)}`);
        }

        if (costs.thumbnails > 0) {
            await stripe.invoiceItems.create({
                customer: customerId,
                invoice: invoice.id,
                amount: Math.round(costs.thumbnails * 100),
                currency: 'usd',
                description: `Thumbnails: ${usage.thumbnailViews} views @ $${PRICING.thumbnailDelivery}/view`
            });
            console.log(`Added thumbnail charge: $${costs.thumbnails.toFixed(4)}`);
        }

        if (costs.apiRequests > 0) {
            await stripe.invoiceItems.create({
                customer: customerId,
                invoice: invoice.id,
                amount: Math.round(costs.apiRequests * 100),
                currency: 'usd',
                description: `API Requests: ${usage.apiRequestCount} requests @ $${PRICING.apiRequests}/request`
            });
            console.log(`Added API request charge: $${costs.apiRequests.toFixed(6)}`);
        }

        const totalUsageCost = Object.values(costs).reduce((sum, cost) => sum + cost, 0);
        console.log(`Total usage charges added: $${totalUsageCost.toFixed(4)}`);

    } catch (error) {
        console.error('Error handling upcoming invoice:', error);
        throw error;
    }
};

// 請求書確定時の処理
const handleInvoiceFinalized = async (invoice) => {
    try {
        console.log('Invoice finalized:', invoice.id, 'Amount:', invoice.amount_due / 100);
        
        // 必要に応じて追加の処理（ログ記録、通知など）
        
    } catch (error) {
        console.error('Error handling finalized invoice:', error);
    }
};
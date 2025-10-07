const Stripe = require('stripe');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { getAWSConfig } = require('./aws-config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const awsConfig = getAWSConfig();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

// 使用量データをStripeに同期
exports.handler = async (event) => {
    try {
        console.log('Starting usage sync to Stripe...');
        
        // 現在の月を取得
        const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
        
        // 全ユーザーの使用量データを取得
        const usageResponse = await dynamoClient.send(new ScanCommand({
            TableName: process.env.USAGE_TABLE,
            FilterExpression: 'periodMonth = :month',
            ExpressionAttributeValues: {
                ':month': currentMonth
            }
        }));

        const usageRecords = usageResponse.Items || [];
        console.log(`Found ${usageRecords.length} usage records for ${currentMonth}`);

        for (const usage of usageRecords) {
            try {
                await syncUserUsageToStripe(usage);
            } catch (error) {
                console.error(`Failed to sync usage for user ${usage.userId}:`, error);
                // 個別のエラーは続行
            }
        }

        console.log('Usage sync completed successfully');
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: `Synced usage data for ${usageRecords.length} users`,
                month: currentMonth
            })
        };

    } catch (error) {
        console.error('Usage sync error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: error.message
            })
        };
    }
};

// 個別ユーザーの使用量をStripeに同期
const syncUserUsageToStripe = async (usage) => {
    try {
        // 顧客情報を取得
        const customerResponse = await dynamoClient.send(new GetCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId: usage.userId }
        }));

        const customer = customerResponse.Item;
        if (!customer || !customer.subscriptionId) {
            console.log(`No active subscription for user ${usage.userId}`);
            return;
        }

        // Stripeサブスクリプションを取得
        const subscription = await stripe.subscriptions.retrieve(customer.subscriptionId);
        if (subscription.status !== 'active') {
            console.log(`Subscription not active for user ${usage.userId}: ${subscription.status}`);
            return;
        }

        // 各使用量タイプをStripeに報告
        const usageReports = [];

        // ストレージ使用量
        if (usage.storageGB > 0) {
            const storageItem = subscription.items.data.find(item => 
                item.price.recurring.usage_type === 'metered' && 
                item.price.unit_amount === Math.round(0.012 * 100) // storage price
            );
            if (storageItem) {
                usageReports.push({
                    subscription_item: storageItem.id,
                    quantity: Math.ceil(usage.storageGB * 1000), // GB to units (0.001 GB = 1 unit)
                    timestamp: Math.floor(Date.now() / 1000)
                });
            }
        }

        // アップロード使用量
        if (usage.uploadGB > 0) {
            const uploadItem = subscription.items.data.find(item => 
                item.price.recurring.usage_type === 'metered' && 
                item.price.unit_amount === Math.round(0.09 * 100) // upload price
            );
            if (uploadItem) {
                usageReports.push({
                    subscription_item: uploadItem.id,
                    quantity: Math.ceil(usage.uploadGB * 1000), // GB to units
                    timestamp: Math.floor(Date.now() / 1000)
                });
            }
        }

        // 復元使用量
        if (usage.restoreGB > 0) {
            const restoreItem = subscription.items.data.find(item => 
                item.price.recurring.usage_type === 'metered' && 
                item.price.unit_amount === Math.round(0.40 * 100) // restore price
            );
            if (restoreItem) {
                usageReports.push({
                    subscription_item: restoreItem.id,
                    quantity: Math.ceil(usage.restoreGB * 1000), // GB to units
                    timestamp: Math.floor(Date.now() / 1000)
                });
            }
        }

        // サムネイル表示使用量
        if (usage.thumbnailViews > 0) {
            const thumbnailItem = subscription.items.data.find(item => 
                item.price.recurring.usage_type === 'metered' && 
                item.price.unit_amount === Math.round(0.0005 * 100) // thumbnail price
            );
            if (thumbnailItem) {
                usageReports.push({
                    subscription_item: thumbnailItem.id,
                    quantity: usage.thumbnailViews,
                    timestamp: Math.floor(Date.now() / 1000)
                });
            }
        }

        // Stripeに使用量を報告
        for (const report of usageReports) {
            await stripe.subscriptionItems.createUsageRecord(
                report.subscription_item,
                {
                    quantity: report.quantity,
                    timestamp: report.timestamp,
                    action: 'set' // 累積値として設定
                }
            );
        }

        console.log(`Synced usage for user ${usage.userId}: ${usageReports.length} usage types`);

    } catch (error) {
        console.error(`Error syncing usage for user ${usage.userId}:`, error);
        throw error;
    }
};

// 手動実行用のエクスポート
module.exports.syncUserUsageToStripe = syncUserUsageToStripe;
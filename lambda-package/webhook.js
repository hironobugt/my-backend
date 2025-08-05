const Stripe = require('stripe');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const awsConfig = getAWSConfig();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

// Webhook署名検証用のエンドポイントシークレット
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

exports.handler = async (event) => {
    try {
        const sig = event.headers['stripe-signature'];
        
        if (!sig) {
            return createErrorResponse(400, 'Missing stripe-signature header');
        }

        let stripeEvent;
        
        try {
            // Webhook署名を検証
            stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
        } catch (err) {
            console.error('Webhook signature verification failed:', err.message);
            return createErrorResponse(400, `Webhook Error: ${err.message}`);
        }

        console.log('Received webhook event:', stripeEvent.type);

        // イベントタイプに応じて処理
        switch (stripeEvent.type) {
            case 'customer.subscription.created':
                await handleSubscriptionCreated(stripeEvent.data.object);
                break;
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(stripeEvent.data.object);
                break;
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(stripeEvent.data.object);
                break;
            case 'invoice.payment_succeeded':
                await handlePaymentSucceeded(stripeEvent.data.object);
                break;
            case 'invoice.payment_failed':
                await handlePaymentFailed(stripeEvent.data.object);
                break;
            case 'customer.subscription.trial_will_end':
                await handleTrialWillEnd(stripeEvent.data.object);
                break;
            case 'invoice.upcoming':
                await handleUpcomingInvoice(stripeEvent.data.object);
                break;
            default:
                console.log(`Unhandled event type: ${stripeEvent.type}`);
        }

        return createSuccessResponse({ received: true });

    } catch (error) {
        console.error('Webhook processing error:', error);
        return createErrorResponse(500, `Webhook Error: ${error.message}`);
    }
};

// サブスクリプション作成時の処理
const handleSubscriptionCreated = async (subscription) => {
    try {
        const customerId = subscription.customer;
        const userId = await getUserIdFromStripeCustomer(customerId);
        
        if (!userId) {
            console.error('User not found for customer:', customerId);
            return;
        }

        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId },
            UpdateExpression: 'SET subscriptionId = :subId, subscriptionStatus = :status, currentPeriodStart = :start, currentPeriodEnd = :end, updatedAt = :timestamp',
            ExpressionAttributeValues: {
                ':subId': subscription.id,
                ':status': subscription.status,
                ':start': subscription.current_period_start,
                ':end': subscription.current_period_end,
                ':timestamp': new Date().toISOString()
            }
        }));

        console.log(`Subscription created for user ${userId}: ${subscription.id}`);
    } catch (error) {
        console.error('Handle subscription created error:', error);
    }
};

// サブスクリプション更新時の処理
const handleSubscriptionUpdated = async (subscription) => {
    try {
        const customerId = subscription.customer;
        const userId = await getUserIdFromStripeCustomer(customerId);
        
        if (!userId) {
            console.error('User not found for customer:', customerId);
            return;
        }

        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId },
            UpdateExpression: 'SET subscriptionStatus = :status, currentPeriodStart = :start, currentPeriodEnd = :end, cancelAtPeriodEnd = :cancel, updatedAt = :timestamp',
            ExpressionAttributeValues: {
                ':status': subscription.status,
                ':start': subscription.current_period_start,
                ':end': subscription.current_period_end,
                ':cancel': subscription.cancel_at_period_end,
                ':timestamp': new Date().toISOString()
            }
        }));

        console.log(`Subscription updated for user ${userId}: ${subscription.status}`);
    } catch (error) {
        console.error('Handle subscription updated error:', error);
    }
};

// サブスクリプション削除時の処理
const handleSubscriptionDeleted = async (subscription) => {
    try {
        const customerId = subscription.customer;
        const userId = await getUserIdFromStripeCustomer(customerId);
        
        if (!userId) {
            console.error('User not found for customer:', customerId);
            return;
        }

        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId },
            UpdateExpression: 'SET subscriptionStatus = :status, subscriptionEndedAt = :endedAt, updatedAt = :timestamp',
            ExpressionAttributeValues: {
                ':status': 'canceled',
                ':endedAt': new Date().toISOString(),
                ':timestamp': new Date().toISOString()
            }
        }));

        console.log(`Subscription canceled for user ${userId}: ${subscription.id}`);
        
        // TODO: アカウント停止処理やデータアクセス制限の実装
        
    } catch (error) {
        console.error('Handle subscription deleted error:', error);
    }
};

// 支払い成功時の処理
const handlePaymentSucceeded = async (invoice) => {
    try {
        const customerId = invoice.customer;
        const userId = await getUserIdFromStripeCustomer(customerId);
        
        if (!userId) {
            console.error('User not found for customer:', customerId);
            return;
        }

        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId },
            UpdateExpression: 'SET lastPaymentSucceeded = :timestamp, paymentStatus = :status, updatedAt = :updateTime',
            ExpressionAttributeValues: {
                ':timestamp': new Date(invoice.created * 1000).toISOString(),
                ':status': 'paid',
                ':updateTime': new Date().toISOString()
            }
        }));

        console.log(`Payment succeeded for user ${userId}: $${invoice.amount_paid / 100}`);
        
        // TODO: 支払い成功通知メールの送信
        
    } catch (error) {
        console.error('Handle payment succeeded error:', error);
    }
};

// 支払い失敗時の処理
const handlePaymentFailed = async (invoice) => {
    try {
        const customerId = invoice.customer;
        const userId = await getUserIdFromStripeCustomer(customerId);
        
        if (!userId) {
            console.error('User not found for customer:', customerId);
            return;
        }

        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId },
            UpdateExpression: 'SET lastPaymentFailed = :timestamp, paymentStatus = :status, updatedAt = :updateTime',
            ExpressionAttributeValues: {
                ':timestamp': new Date(invoice.created * 1000).toISOString(),
                ':status': 'failed',
                ':updateTime': new Date().toISOString()
            }
        }));

        console.log(`Payment failed for user ${userId}: $${invoice.amount_due / 100}`);
        
        // TODO: 支払い失敗通知メールの送信
        // TODO: 一定期間後のアカウント停止処理
        
    } catch (error) {
        console.error('Handle payment failed error:', error);
    }
};

// トライアル終了予告の処理
const handleTrialWillEnd = async (subscription) => {
    try {
        const customerId = subscription.customer;
        const userId = await getUserIdFromStripeCustomer(customerId);
        
        if (!userId) {
            console.error('User not found for customer:', customerId);
            return;
        }

        console.log(`Trial will end for user ${userId} on ${new Date(subscription.trial_end * 1000)}`);
        
        // TODO: トライアル終了予告メールの送信
        
    } catch (error) {
        console.error('Handle trial will end error:', error);
    }
};

// 請求書発行予告の処理
const handleUpcomingInvoice = async (invoice) => {
    try {
        const customerId = invoice.customer;
        const userId = await getUserIdFromStripeCustomer(customerId);
        
        if (!userId) {
            console.error('User not found for customer:', customerId);
            return;
        }

        console.log(`Upcoming invoice for user ${userId}: $${invoice.amount_due / 100}`);
        
        // TODO: 請求予告メールの送信
        
    } catch (error) {
        console.error('Handle upcoming invoice error:', error);
    }
};

// Stripe顧客IDからユーザーIDを取得
const getUserIdFromStripeCustomer = async (stripeCustomerId) => {
    try {
        const queryParams = {
            TableName: process.env.CUSTOMER_TABLE,
            IndexName: 'StripeCustomerIndex',
            KeyConditionExpression: 'stripeCustomerId = :customerId',
            ExpressionAttributeValues: {
                ':customerId': stripeCustomerId
            }
        };

        const response = await dynamoClient.send(new QueryCommand(queryParams));
        
        if (response.Items && response.Items.length > 0) {
            return response.Items[0].userId;
        }
        
        return null;
    } catch (error) {
        console.error('Get user ID from Stripe customer error:', error);
        return null;
    }
};
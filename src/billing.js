const Stripe = require('stripe');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const awsConfig = getAWSConfig();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

// 料金プラン設定
const PRICING = {
    storage: 0.01, // $0.01 per GB per month
    upload: 0.05,  // $0.05 per upload
    restore: 0.10, // $0.10 per restore request
    baseFee: 5.00  // $5.00 monthly base fee
};

exports.handler = async (event) => {
    try {
        // 認証チェック
        const auth = await requireAuth(event);
        if (!auth.isValid) {
            return createErrorResponse(401, auth.error || 'Unauthorized');
        }

        const { action, ...params } = JSON.parse(event.body);

        switch (action) {
            case 'setup-customer':
                return await setupCustomer(auth, params);
            case 'add-payment-method':
                return await addPaymentMethod(auth, params);
            case 'create-subscription':
                return await createSubscription(auth, params);
            case 'get-billing-info':
                return await getBillingInfo(auth);
            case 'get-usage':
                return await getUsage(auth, params);
            case 'get-invoices':
                return await getInvoices(auth, params);
            case 'cancel-subscription':
                return await cancelSubscription(auth);
            default:
                return createErrorResponse(400, 'Invalid action');
        }

    } catch (error) {
        console.error('Billing error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};

// Stripe顧客とサブスクリプションのセットアップ
const setupCustomer = async (auth, { email, name }) => {
    try {
        // 既存の顧客情報を確認
        const existingCustomer = await getCustomerFromDB(auth.userId);
        if (existingCustomer && existingCustomer.stripeCustomerId) {
            return createErrorResponse(400, 'Customer already exists');
        }

        // Stripe顧客を作成
        const customer = await stripe.customers.create({
            email: email || auth.email,
            name: name || auth.username,
            metadata: {
                userId: auth.userId,
                username: auth.username
            }
        });

        // DynamoDBに顧客情報を保存
        const customerData = {
            userId: auth.userId,
            stripeCustomerId: customer.id,
            email: email || auth.email,
            name: name || auth.username,
            createdAt: new Date().toISOString(),
            subscriptionStatus: 'inactive',
            billingCycle: 'monthly'
        };

        await dynamoClient.send(new PutCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Item: customerData
        }));

        return createSuccessResponse({
            message: 'Customer setup completed',
            customerId: customer.id,
            customerData
        });

    } catch (error) {
        console.error('Setup customer error:', error);
        return createErrorResponse(500, error.message);
    }
};

// 支払い方法の追加
const addPaymentMethod = async (auth, { paymentMethodId }) => {
    try {
        if (!paymentMethodId) {
            return createErrorResponse(400, 'paymentMethodId is required');
        }

        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createErrorResponse(400, 'Customer not found. Please setup customer first.');
        }

        // 支払い方法を顧客にアタッチ
        await stripe.paymentMethods.attach(paymentMethodId, {
            customer: customer.stripeCustomerId
        });

        // デフォルトの支払い方法として設定
        await stripe.customers.update(customer.stripeCustomerId, {
            invoice_settings: {
                default_payment_method: paymentMethodId
            }
        });

        // DynamoDBを更新
        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId: auth.userId },
            UpdateExpression: 'SET defaultPaymentMethod = :pm, updatedAt = :timestamp',
            ExpressionAttributeValues: {
                ':pm': paymentMethodId,
                ':timestamp': new Date().toISOString()
            }
        }));

        return createSuccessResponse({
            message: 'Payment method added successfully',
            paymentMethodId
        });

    } catch (error) {
        console.error('Add payment method error:', error);
        return createErrorResponse(500, error.message);
    }
};

// サブスクリプション作成
const createSubscription = async (auth, { priceId }) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createErrorResponse(400, 'Customer not found. Please setup customer first.');
        }

        if (!customer.defaultPaymentMethod) {
            return createErrorResponse(400, 'Please add a payment method first.');
        }

        // 基本料金のサブスクリプションを作成
        const subscription = await stripe.subscriptions.create({
            customer: customer.stripeCustomerId,
            items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Glacier Archive Base Plan'
                        },
                        unit_amount: Math.round(PRICING.baseFee * 100), // セント単位
                        recurring: {
                            interval: 'month'
                        }
                    }
                }
            ],
            payment_behavior: 'default_incomplete',
            payment_settings: { save_default_payment_method: 'on_subscription' },
            expand: ['latest_invoice.payment_intent']
        });

        // DynamoDBを更新
        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId: auth.userId },
            UpdateExpression: 'SET subscriptionId = :subId, subscriptionStatus = :status, updatedAt = :timestamp',
            ExpressionAttributeValues: {
                ':subId': subscription.id,
                ':status': subscription.status,
                ':timestamp': new Date().toISOString()
            }
        }));

        return createSuccessResponse({
            message: 'Subscription created',
            subscriptionId: subscription.id,
            clientSecret: subscription.latest_invoice.payment_intent.client_secret,
            status: subscription.status
        });

    } catch (error) {
        console.error('Create subscription error:', error);
        return createErrorResponse(500, error.message);
    }
};

// 請求情報取得
const getBillingInfo = async (auth) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer) {
            return createErrorResponse(404, 'Customer not found');
        }

        let stripeCustomer = null;
        let subscription = null;
        let paymentMethods = [];

        if (customer.stripeCustomerId) {
            // Stripe顧客情報を取得
            stripeCustomer = await stripe.customers.retrieve(customer.stripeCustomerId);
            
            // 支払い方法を取得
            const paymentMethodsResponse = await stripe.paymentMethods.list({
                customer: customer.stripeCustomerId,
                type: 'card'
            });
            paymentMethods = paymentMethodsResponse.data;

            // サブスクリプション情報を取得
            if (customer.subscriptionId) {
                subscription = await stripe.subscriptions.retrieve(customer.subscriptionId);
            }
        }

        return createSuccessResponse({
            customer: {
                ...customer,
                stripeCustomer: stripeCustomer ? {
                    id: stripeCustomer.id,
                    email: stripeCustomer.email,
                    name: stripeCustomer.name
                } : null
            },
            subscription: subscription ? {
                id: subscription.id,
                status: subscription.status,
                current_period_start: subscription.current_period_start,
                current_period_end: subscription.current_period_end,
                cancel_at_period_end: subscription.cancel_at_period_end
            } : null,
            paymentMethods: paymentMethods.map(pm => ({
                id: pm.id,
                type: pm.type,
                card: pm.card ? {
                    brand: pm.card.brand,
                    last4: pm.card.last4,
                    exp_month: pm.card.exp_month,
                    exp_year: pm.card.exp_year
                } : null
            }))
        });

    } catch (error) {
        console.error('Get billing info error:', error);
        return createErrorResponse(500, error.message);
    }
};

// 使用量取得
const getUsage = async (auth, { month }) => {
    try {
        const targetMonth = month || new Date().toISOString().slice(0, 7); // YYYY-MM

        const usageResponse = await dynamoClient.send(new GetCommand({
            TableName: process.env.USAGE_TABLE,
            Key: {
                userId: auth.userId,
                periodMonth: targetMonth
            }
        }));

        const usage = usageResponse.Item || {
            userId: auth.userId,
            periodMonth: targetMonth,
            storageGB: 0,
            uploadCount: 0,
            restoreCount: 0,
            totalCost: 0
        };

        // 料金計算
        const costs = {
            storage: usage.storageGB * PRICING.storage,
            uploads: usage.uploadCount * PRICING.upload,
            restores: usage.restoreCount * PRICING.restore,
            baseFee: PRICING.baseFee
        };

        const totalCost = Object.values(costs).reduce((sum, cost) => sum + cost, 0);

        return createSuccessResponse({
            usage,
            costs,
            totalCost: Math.round(totalCost * 100) / 100, // 小数点以下2桁
            pricing: PRICING
        });

    } catch (error) {
        console.error('Get usage error:', error);
        return createErrorResponse(500, error.message);
    }
};

// 請求書一覧取得
const getInvoices = async (auth, { limit = 10 }) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createErrorResponse(404, 'Customer not found');
        }

        const invoices = await stripe.invoices.list({
            customer: customer.stripeCustomerId,
            limit: parseInt(limit)
        });

        return createSuccessResponse({
            invoices: invoices.data.map(invoice => ({
                id: invoice.id,
                amount_paid: invoice.amount_paid,
                amount_due: invoice.amount_due,
                currency: invoice.currency,
                status: invoice.status,
                created: invoice.created,
                period_start: invoice.period_start,
                period_end: invoice.period_end,
                hosted_invoice_url: invoice.hosted_invoice_url,
                invoice_pdf: invoice.invoice_pdf
            }))
        });

    } catch (error) {
        console.error('Get invoices error:', error);
        return createErrorResponse(500, error.message);
    }
};

// サブスクリプションキャンセル
const cancelSubscription = async (auth) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.subscriptionId) {
            return createErrorResponse(404, 'Subscription not found');
        }

        const subscription = await stripe.subscriptions.update(customer.subscriptionId, {
            cancel_at_period_end: true
        });

        // DynamoDBを更新
        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId: auth.userId },
            UpdateExpression: 'SET subscriptionStatus = :status, cancelAt = :cancelAt, updatedAt = :timestamp',
            ExpressionAttributeValues: {
                ':status': 'canceling',
                ':cancelAt': subscription.current_period_end,
                ':timestamp': new Date().toISOString()
            }
        }));

        return createSuccessResponse({
            message: 'Subscription will be canceled at the end of the current period',
            cancelAt: subscription.current_period_end
        });

    } catch (error) {
        console.error('Cancel subscription error:', error);
        return createErrorResponse(500, error.message);
    }
};

// ヘルパー関数：DynamoDBから顧客情報を取得
const getCustomerFromDB = async (userId) => {
    try {
        const response = await dynamoClient.send(new GetCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId }
        }));
        return response.Item;
    } catch (error) {
        console.error('Get customer from DB error:', error);
        return null;
    }
};
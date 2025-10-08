const Stripe = require('stripe');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { CognitoIdentityProviderClient, AdminDeleteUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');

// Billing専用のレスポンス関数
const createBillingSuccessResponse = (data, statusCode = 200) => {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
            success: true,
            data: data
        })
    };
};

const createBillingErrorResponse = (statusCode, error) => {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
            success: false,
            error: error
        })
    };
};
const { getAWSConfig } = require('./aws-config');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const awsConfig = getAWSConfig();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));
const s3Client = new S3Client(awsConfig);
const cognitoClient = new CognitoIdentityProviderClient(awsConfig);

// 料金プラン設定（競争力のある価格設定）
const PRICING = {
    // Glacier Deep Archive ストレージ（400%マージン - 競合対抗価格）
    storage: 0.012,   // $0.012 per GB per month (AWS実コスト: $0.003, 競合対抗で適正マージン)

    // アップロード処理（600%マージン）
    upload: 0.09,     // $0.09 per GB uploaded (AWS実コスト: $0.015, サムネイル生成・処理費・利益込み)

    // 復元処理（500%マージン）
    restore: 0.40,    // $0.40 per GB restored (AWS実コスト: $0.08, 高速配信・サポート・利益込み)

    // 基本料金（競合対抗価格）
    baseFee: 3.00,    // $3.00 monthly base fee (競合対抗、従量課金で収益補完)

    // サムネイル配信料金（500%マージン）
    thumbnailDelivery: 0.0005, // $0.0005 per thumbnail view (AWS実コスト: $0.0001 + 処理費)

    // API リクエスト料金（800%マージン）
    apiRequests: 0.000008 // $0.000008 per API request (AWS実コスト: $0.000001 + 処理費)
}

exports.handler = async (event) => {
    try {
        const { action, ...params } = JSON.parse(event.body);

        // Stripe設定取得は認証不要
        if (action === 'get-stripe-config') {
            return await getStripeConfig();
        }

        // その他のアクションは認証が必要
        let auth;
        if (event.requestContext && event.requestContext.authorizer) {
            // Lambda Authorizerからの認証情報を使用
            auth = {
                isValid: true,
                userId: event.requestContext.authorizer.userId,
                username: event.requestContext.authorizer.username,
                email: event.requestContext.authorizer.email
            };
        } else {
            // フォールバック：従来の認証方式
            auth = await requireAuth(event);
            if (!auth.isValid) {
                return createBillingErrorResponse(401, auth.error || 'Unauthorized');
            }
        }

        switch (action) {
            case 'setup-customer':
                return await setupCustomer(auth, params);
            case 'create-payment-intent':
                return await createPaymentIntent(auth, params);
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
            case 'reactivate-subscription':
                return await reactivateSubscription(auth);
            case 'complete-payment':
                return await completePayment(auth, params);
            case 'remove-payment-method':
                return await removePaymentMethod(auth, params);
            case 'delete-account':
                return await deleteAccount(auth, params);
            default:
                return createBillingErrorResponse(400, 'Invalid action');
        }

    } catch (error) {
        console.error('Billing error:', error);
        return createBillingErrorResponse(500, `Internal server error: ${error.message}`);
    }
};

// Stripe顧客とサブスクリプションのセットアップ
const setupCustomer = async (auth, { email, name }) => {
    try {
        // 既存の顧客情報を確認
        const existingCustomer = await getCustomerFromDB(auth.userId);
        if (existingCustomer && existingCustomer.stripeCustomerId) {
            return createBillingSuccessResponse({
                message: 'Customer already exists',
                customerId: existingCustomer.stripeCustomerId,
                customerData: existingCustomer
            });
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

        return createBillingSuccessResponse({
            message: 'Customer setup completed',
            customerId: customer.id,
            customerData
        });

    } catch (error) {
        console.error('Setup customer error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// Payment Intent作成（カード登録用）
const createPaymentIntent = async (auth, { amount = 0 }) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createBillingErrorResponse(400, 'Customer not found. Please setup customer first.');
        }

        // Setup Intent（カード登録用）を作成
        const setupIntent = await stripe.setupIntents.create({
            customer: customer.stripeCustomerId,
            payment_method_types: ['card'],
            usage: 'off_session'
        });

        return createBillingSuccessResponse({
            clientSecret: setupIntent.client_secret,
            setupIntentId: setupIntent.id
        });

    } catch (error) {
        console.error('Create payment intent error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// Stripe設定取得（公開可能キー）
const getStripeConfig = async () => {
    try {
        return createBillingSuccessResponse({
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
        });
    } catch (error) {
        console.error('Get Stripe config error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// 支払い方法の追加
const addPaymentMethod = async (auth, { paymentMethodId }) => {
    try {
        if (!paymentMethodId) {
            return createBillingErrorResponse(400, 'paymentMethodId is required');
        }

        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createBillingErrorResponse(400, 'Customer not found. Please setup customer first.');
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

        return createBillingSuccessResponse({
            message: 'Payment method added successfully',
            paymentMethodId
        });

    } catch (error) {
        console.error('Add payment method error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// サブスクリプション作成
const createSubscription = async (auth, { priceId = null }) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createBillingErrorResponse(400, 'Customer not found. Please setup customer first.');
        }

        // Stripeから最新の支払い方法を確認
        const paymentMethods = await stripe.paymentMethods.list({
            customer: customer.stripeCustomerId,
            type: 'card'
        });

        if (!paymentMethods.data || paymentMethods.data.length === 0) {
            return createBillingErrorResponse(400, 'Please add a payment method first.');
        }

        // 最初の支払い方法をデフォルトとして設定（まだ設定されていない場合）
        const defaultPaymentMethod = paymentMethods.data[0];
        await stripe.customers.update(customer.stripeCustomerId, {
            invoice_settings: {
                default_payment_method: defaultPaymentMethod.id
            }
        });

        // まずプロダクトを作成または取得
        let product;
        try {
            // 既存のプロダクトを取得を試行
            const products = await stripe.products.list({
                limit: 1,
                active: true
            });

            if (products.data.length > 0) {
                product = products.data[0];
            } else {
                // プロダクトが存在しない場合は作成
                product = await stripe.products.create({
                    name: 'Glacier Archive Base Plan',
                    description: 'Monthly subscription for Glacier Archive service',
                    type: 'service'
                });
            }
        } catch (error) {
            // プロダクト作成/取得に失敗した場合は新規作成
            product = await stripe.products.create({
                name: 'Glacier Archive Base Plan',
                description: 'Monthly subscription for Glacier Archive service',
                type: 'service'
            });
        }

        // 価格を作成
        const price = await stripe.prices.create({
            currency: 'usd',
            product: product.id,
            unit_amount: Math.round(PRICING.baseFee * 100), // セント単位 ($3.00 = 300 cents)
            recurring: {
                interval: 'month'
            }
        });

        // 基本料金のサブスクリプションを作成（完全自動請求）
        const subscription = await stripe.subscriptions.create({
            customer: customer.stripeCustomerId,
            items: [
                {
                    price: price.id
                }
            ],
            payment_behavior: 'allow_incomplete', // 支払い失敗でも継続、成功時は自動アクティブ化
            payment_settings: { 
                save_default_payment_method: 'on_subscription',
                payment_method_options: {
                    card: {
                        request_three_d_secure: 'automatic'
                    }
                }
            },
            collection_method: 'charge_automatically', // 自動請求を明示的に設定
            expand: ['latest_invoice.payment_intent'], // Payment Intentを展開
            // 使用量ベースの課金を月末に自動追加するためのWebhook設定
            metadata: {
                usage_billing_enabled: 'true',
                user_id: auth.userId
            }
        });

        // 初回支払いを自動で試行
        let finalStatus = subscription.status;
        let clientSecret = null;

        if (subscription.status === 'incomplete' && subscription.latest_invoice?.payment_intent) {
            const paymentIntent = subscription.latest_invoice.payment_intent;
            clientSecret = paymentIntent.client_secret;

            // 支払い方法が設定されている場合、自動で支払いを確認
            try {
                const confirmedPaymentIntent = await stripe.paymentIntents.confirm(paymentIntent.id);
                if (confirmedPaymentIntent.status === 'succeeded') {
                    // サブスクリプション状態を再取得
                    const updatedSubscription = await stripe.subscriptions.retrieve(subscription.id);
                    finalStatus = updatedSubscription.status;
                    console.log(`Payment confirmed, subscription status: ${finalStatus}`);
                }
            } catch (confirmError) {
                console.log('Payment confirmation failed, user will need to complete manually:', confirmError.message);
            }
        }

        // DynamoDBを更新
        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId: auth.userId },
            UpdateExpression: 'SET subscriptionId = :subId, subscriptionStatus = :status, updatedAt = :timestamp',
            ExpressionAttributeValues: {
                ':subId': subscription.id,
                ':status': finalStatus,
                ':timestamp': new Date().toISOString()
            }
        }));

        return createBillingSuccessResponse({
            message: finalStatus === 'active' ? 'Subscription created and activated' : 'Subscription created, payment confirmation required',
            subscriptionId: subscription.id,
            clientSecret: clientSecret,
            status: finalStatus,
            requiresAction: finalStatus === 'incomplete'
        });

    } catch (error) {
        console.error('Create subscription error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// 請求情報取得
const getBillingInfo = async (auth) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer) {
            return createBillingErrorResponse(404, 'Customer not found');
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

        return createBillingSuccessResponse({
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
        return createBillingErrorResponse(500, error.message);
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
            uploads: (usage.uploadGB || 0) * PRICING.upload,
            restores: (usage.restoreGB || 0) * PRICING.restore,
            thumbnails: (usage.thumbnailViews || 0) * PRICING.thumbnailDelivery,
            apiRequests: (usage.apiRequestCount || 0) * PRICING.apiRequests,
            baseFee: PRICING.baseFee
        };

        const totalCost = Object.values(costs).reduce((sum, cost) => sum + cost, 0);

        return createBillingSuccessResponse({
            usage,
            costs,
            totalCost: Math.round(totalCost * 100) / 100, // 小数点以下2桁
            pricing: PRICING
        });

    } catch (error) {
        console.error('Get usage error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// 請求書一覧取得
const getInvoices = async (auth, { limit = 10 }) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createBillingErrorResponse(404, 'Customer not found');
        }

        const invoices = await stripe.invoices.list({
            customer: customer.stripeCustomerId,
            limit: parseInt(limit)
        });

        return createBillingSuccessResponse({
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
        return createBillingErrorResponse(500, error.message);
    }
};

// 支払い方法の削除
const removePaymentMethod = async (auth, { paymentMethodId }) => {
    try {
        if (!paymentMethodId) {
            return createBillingErrorResponse(400, 'paymentMethodId is required');
        }

        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createBillingErrorResponse(400, 'Customer not found');
        }

        // 支払い方法をデタッチ
        await stripe.paymentMethods.detach(paymentMethodId);

        // もしこれがデフォルトの支払い方法だった場合、他の支払い方法をデフォルトに設定
        const paymentMethods = await stripe.paymentMethods.list({
            customer: customer.stripeCustomerId,
            type: 'card'
        });

        if (paymentMethods.data.length > 0) {
            // 残っている最初の支払い方法をデフォルトに設定
            await stripe.customers.update(customer.stripeCustomerId, {
                invoice_settings: {
                    default_payment_method: paymentMethods.data[0].id
                }
            });
        } else {
            // 支払い方法がなくなった場合、デフォルトをクリア
            await stripe.customers.update(customer.stripeCustomerId, {
                invoice_settings: {
                    default_payment_method: null
                }
            });
        }

        return createBillingSuccessResponse({
            message: 'Payment method removed successfully'
        });

    } catch (error) {
        console.error('Remove payment method error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// サブスクリプションキャンセル
const cancelSubscription = async (auth) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.subscriptionId) {
            return createBillingErrorResponse(404, 'Subscription not found');
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

        return createBillingSuccessResponse({
            message: 'Subscription will be canceled at the end of the current period',
            cancelAt: subscription.current_period_end
        });

    } catch (error) {
        console.error('Cancel subscription error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// サブスクリプション再開
const reactivateSubscription = async (auth) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createBillingErrorResponse(400, 'Customer not found. Please setup customer first.');
        }

        // 支払い方法があるかチェック
        const paymentMethods = await stripe.paymentMethods.list({
            customer: customer.stripeCustomerId,
            type: 'card'
        });

        if (!paymentMethods.data || paymentMethods.data.length === 0) {
            return createBillingErrorResponse(400, 'Please add a payment method first.');
        }

        let subscription = null;
        let subscriptionId = customer.subscriptionId;

        // 既存のサブスクリプションがある場合
        if (subscriptionId) {
            try {
                // Stripeからサブスクリプション情報を取得
                subscription = await stripe.subscriptions.retrieve(subscriptionId);
                
                // サブスクリプションの状態をチェック
                if (subscription.status === 'canceled') {
                    // 完全にキャンセルされている場合は新しいサブスクリプションを作成
                    console.log('Subscription is canceled, creating new subscription');
                    subscription = null;
                    subscriptionId = null;
                } else if (subscription.cancel_at_period_end) {
                    // キャンセル予定の場合は再開
                    console.log('Reactivating subscription that was set to cancel');
                    subscription = await stripe.subscriptions.update(subscriptionId, {
                        cancel_at_period_end: false
                    });
                } else if (subscription.status === 'active') {
                    // 既にアクティブな場合
                    console.log('Subscription is already active');
                } else {
                    // その他の状態（incomplete, past_due等）の場合は新しいサブスクリプションを作成
                    console.log(`Subscription status is ${subscription.status}, creating new subscription`);
                    subscription = null;
                    subscriptionId = null;
                }
            } catch (error) {
                console.log('Failed to retrieve existing subscription, creating new one:', error.message);
                subscription = null;
                subscriptionId = null;
            }
        }

        // 新しいサブスクリプションを作成する必要がある場合
        if (!subscription) {
            console.log('Creating new subscription');
            
            // プロダクトを取得または作成
            let product;
            try {
                const products = await stripe.products.list({
                    limit: 1,
                    active: true
                });

                if (products.data.length > 0) {
                    product = products.data[0];
                } else {
                    product = await stripe.products.create({
                        name: 'Glacier Archive Base Plan',
                        description: 'Monthly subscription for Glacier Archive service',
                        type: 'service'
                    });
                }
            } catch (error) {
                product = await stripe.products.create({
                    name: 'Glacier Archive Base Plan',
                    description: 'Monthly subscription for Glacier Archive service',
                    type: 'service'
                });
            }

            // 価格を作成
            const price = await stripe.prices.create({
                currency: 'usd',
                product: product.id,
                unit_amount: Math.round(PRICING.baseFee * 100),
                recurring: {
                    interval: 'month'
                }
            });

            // 新しいサブスクリプションを作成
            subscription = await stripe.subscriptions.create({
                customer: customer.stripeCustomerId,
                items: [{ price: price.id }],
                payment_behavior: 'default_incomplete',
                payment_settings: { save_default_payment_method: 'on_subscription' },
                expand: ['latest_invoice.payment_intent']
            });

            subscriptionId = subscription.id;
        }

        // DynamoDBを更新
        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId: auth.userId },
            UpdateExpression: 'SET subscriptionId = :subId, subscriptionStatus = :status, updatedAt = :timestamp REMOVE cancelAt',
            ExpressionAttributeValues: {
                ':subId': subscriptionId,
                ':status': subscription.status,
                ':timestamp': new Date().toISOString()
            }
        }));

        const response = {
            message: 'Subscription reactivated successfully',
            subscriptionId: subscriptionId,
            status: subscription.status
        };

        // 新しいサブスクリプションの場合はclientSecretも返す
        if (subscription.latest_invoice && subscription.latest_invoice.payment_intent) {
            response.clientSecret = subscription.latest_invoice.payment_intent.client_secret;
        }

        return createBillingSuccessResponse(response);

    } catch (error) {
        console.error('Reactivate subscription error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};

// 支払い完了処理
const completePayment = async (auth, { paymentIntentId }) => {
    try {
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.subscriptionId) {
            return createBillingErrorResponse(404, 'Subscription not found');
        }

        // Stripeからサブスクリプション情報を取得
        const subscription = await stripe.subscriptions.retrieve(customer.subscriptionId, {
            expand: ['latest_invoice.payment_intent']
        });

        if (subscription.status !== 'incomplete') {
            return createBillingSuccessResponse({
                message: 'Subscription is already active',
                status: subscription.status
            });
        }

        // 最新の請求書のPayment Intentを確認
        const paymentIntent = subscription.latest_invoice.payment_intent;
        
        if (!paymentIntent) {
            return createBillingErrorResponse(400, 'No payment intent found for this subscription');
        }

        // Payment Intentの状態を確認
        if (paymentIntent.status === 'succeeded') {
            // 支払いが既に成功している場合、サブスクリプション状態を更新
            const updatedSubscription = await stripe.subscriptions.retrieve(customer.subscriptionId);
            
            // DynamoDBを更新
            await dynamoClient.send(new UpdateCommand({
                TableName: process.env.CUSTOMER_TABLE,
                Key: { userId: auth.userId },
                UpdateExpression: 'SET subscriptionStatus = :status, updatedAt = :timestamp',
                ExpressionAttributeValues: {
                    ':status': updatedSubscription.status,
                    ':timestamp': new Date().toISOString()
                }
            }));

            return createBillingSuccessResponse({
                message: 'Payment completed successfully',
                subscriptionId: subscription.id,
                status: updatedSubscription.status
            });
        } else if (paymentIntent.status === 'requires_payment_method') {
            // 支払い方法が必要な場合
            return createBillingErrorResponse(400, 'Payment method required. Please add a valid payment method.');
        } else {
            // その他の状態の場合、client_secretを返して支払いを完了させる
            return createBillingSuccessResponse({
                message: 'Payment confirmation required',
                clientSecret: paymentIntent.client_secret,
                paymentIntentId: paymentIntent.id,
                status: paymentIntent.status
            });
        }

    } catch (error) {
        console.error('Complete payment error:', error);
        return createBillingErrorResponse(500, error.message);
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

// 完全なアカウント削除機能
const deleteAccount = async (auth, { confirmPassword, reason }) => {
    try {
        console.log(`Account deletion requested for user: ${auth.userId}`);

        // 削除理由の記録（オプション）
        if (reason) {
            console.log(`Deletion reason: ${reason}`);
        }

        // Step 1: Stripeサブスクリプションとカスタマーの削除
        await deleteStripeData(auth.userId);

        // Step 2: S3からユーザーデータを削除
        await deleteS3UserData(auth.userId);

        // Step 3: DynamoDBからユーザーデータを削除
        await deleteDynamoDBUserData(auth.userId);

        // Step 4: Cognitoユーザーを削除
        await deleteCognitoUser(auth.userId);

        console.log(`Account deletion completed for user: ${auth.userId}`);

        return createBillingSuccessResponse({
            message: 'Account has been permanently deleted',
            deletedAt: new Date().toISOString(),
            userId: auth.userId
        });

    } catch (error) {
        console.error('Delete account error:', error);
        return createBillingErrorResponse(500, `Account deletion failed: ${error.message}`);
    }
};

// Stripeデータの削除
const deleteStripeData = async (userId) => {
    try {
        const customer = await getCustomerFromDB(userId);
        if (!customer || !customer.stripeCustomerId) {
            console.log(`No Stripe customer found for user: ${userId}`);
            return;
        }

        // サブスクリプションがある場合は即座にキャンセル
        if (customer.subscriptionId) {
            try {
                await stripe.subscriptions.cancel(customer.subscriptionId);
                console.log(`Subscription canceled: ${customer.subscriptionId}`);
            } catch (error) {
                console.warn(`Failed to cancel subscription: ${error.message}`);
            }
        }

        // Stripe顧客を削除
        try {
            await stripe.customers.del(customer.stripeCustomerId);
            console.log(`Stripe customer deleted: ${customer.stripeCustomerId}`);
        } catch (error) {
            console.warn(`Failed to delete Stripe customer: ${error.message}`);
        }

    } catch (error) {
        console.error('Delete Stripe data error:', error);
        throw error;
    }
};

// S3からユーザーデータを削除
const deleteS3UserData = async (userId) => {
    try {
        const bucketName = process.env.ARCHIVE_BUCKET;

        // アーカイブファイルを削除
        await deleteS3Objects(bucketName, `archives/${userId}/`);

        // サムネイルを削除
        await deleteS3Objects(bucketName, `thumbnails/${userId}/`);

        console.log(`S3 user data deleted for user: ${userId}`);

    } catch (error) {
        console.error('Delete S3 user data error:', error);
        throw error;
    }
};

// S3オブジェクトの一括削除
const deleteS3Objects = async (bucketName, prefix) => {
    try {
        let continuationToken = undefined;
        let totalDeleted = 0;

        do {
            // オブジェクト一覧を取得
            const listResponse = await s3Client.send(new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: prefix,
                ContinuationToken: continuationToken,
                MaxKeys: 1000
            }));

            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                break;
            }

            // 削除対象オブジェクトのリストを作成
            const objectsToDelete = listResponse.Contents.map(obj => ({
                Key: obj.Key
            }));

            // オブジェクトを一括削除
            if (objectsToDelete.length > 0) {
                await s3Client.send(new DeleteObjectsCommand({
                    Bucket: bucketName,
                    Delete: {
                        Objects: objectsToDelete,
                        Quiet: true
                    }
                }));

                totalDeleted += objectsToDelete.length;
                console.log(`Deleted ${objectsToDelete.length} objects from ${prefix}`);
            }

            continuationToken = listResponse.NextContinuationToken;

        } while (continuationToken);

        console.log(`Total deleted objects from ${prefix}: ${totalDeleted}`);

    } catch (error) {
        console.error(`Delete S3 objects error for prefix ${prefix}:`, error);
        throw error;
    }
};

// DynamoDBからユーザーデータを削除
const deleteDynamoDBUserData = async (userId) => {
    try {
        // アーカイブメタデータを削除
        await deleteArchiveMetadata(userId);

        // 使用量データを削除
        await deleteUsageData(userId);

        // 顧客データを削除
        await deleteCustomerData(userId);

        console.log(`DynamoDB user data deleted for user: ${userId}`);

    } catch (error) {
        console.error('Delete DynamoDB user data error:', error);
        throw error;
    }
};

// アーカイブメタデータの削除
const deleteArchiveMetadata = async (userId) => {
    try {
        const tableName = process.env.ARCHIVE_TABLE;
        let lastEvaluatedKey = undefined;
        let totalDeleted = 0;

        do {
            // ユーザーのアーカイブを検索
            const scanResponse = await dynamoClient.send(new ScanCommand({
                TableName: tableName,
                FilterExpression: 'userId = :userId',
                ExpressionAttributeValues: {
                    ':userId': userId
                },
                ExclusiveStartKey: lastEvaluatedKey,
                Limit: 100
            }));

            if (scanResponse.Items && scanResponse.Items.length > 0) {
                // 各アーカイブを削除
                for (const item of scanResponse.Items) {
                    await dynamoClient.send(new DeleteCommand({
                        TableName: tableName,
                        Key: {
                            userId: item.userId,
                            archiveId: item.archiveId
                        }
                    }));
                    totalDeleted++;
                }
            }

            lastEvaluatedKey = scanResponse.LastEvaluatedKey;

        } while (lastEvaluatedKey);

        console.log(`Deleted ${totalDeleted} archive metadata records for user: ${userId}`);

    } catch (error) {
        console.error('Delete archive metadata error:', error);
        throw error;
    }
};

// 使用量データの削除
const deleteUsageData = async (userId) => {
    try {
        const usageTable = process.env.USAGE_TABLE;
        const usageEventsTable = process.env.USAGE_EVENTS_TABLE;

        // 使用量データを削除
        let lastEvaluatedKey = undefined;
        let totalDeleted = 0;

        do {
            const queryResponse = await dynamoClient.send(new QueryCommand({
                TableName: usageTable,
                KeyConditionExpression: 'userId = :userId',
                ExpressionAttributeValues: {
                    ':userId': userId
                },
                ExclusiveStartKey: lastEvaluatedKey,
                Limit: 100
            }));

            if (queryResponse.Items && queryResponse.Items.length > 0) {
                for (const item of queryResponse.Items) {
                    await dynamoClient.send(new DeleteCommand({
                        TableName: usageTable,
                        Key: {
                            userId: item.userId,
                            periodMonth: item.periodMonth
                        }
                    }));
                    totalDeleted++;
                }
            }

            lastEvaluatedKey = queryResponse.LastEvaluatedKey;

        } while (lastEvaluatedKey);

        // 使用量イベントデータを削除
        lastEvaluatedKey = undefined;
        let totalEventsDeleted = 0;

        do {
            const queryResponse = await dynamoClient.send(new QueryCommand({
                TableName: usageEventsTable,
                KeyConditionExpression: 'userId = :userId',
                ExpressionAttributeValues: {
                    ':userId': userId
                },
                ExclusiveStartKey: lastEvaluatedKey,
                Limit: 100
            }));

            if (queryResponse.Items && queryResponse.Items.length > 0) {
                for (const item of queryResponse.Items) {
                    await dynamoClient.send(new DeleteCommand({
                        TableName: usageEventsTable,
                        Key: {
                            userId: item.userId,
                            timestamp: item.timestamp
                        }
                    }));
                    totalEventsDeleted++;
                }
            }

            lastEvaluatedKey = queryResponse.LastEvaluatedKey;

        } while (lastEvaluatedKey);

        console.log(`Deleted ${totalDeleted} usage records and ${totalEventsDeleted} usage events for user: ${userId}`);

    } catch (error) {
        console.error('Delete usage data error:', error);
        throw error;
    }
};

// 顧客データの削除
const deleteCustomerData = async (userId) => {
    try {
        await dynamoClient.send(new DeleteCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId }
        }));

        console.log(`Customer data deleted for user: ${userId}`);

    } catch (error) {
        console.error('Delete customer data error:', error);
        throw error;
    }
};

// Cognitoユーザーの削除
const deleteCognitoUser = async (userId) => {
    try {
        await cognitoClient.send(new AdminDeleteUserCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: userId
        }));

        console.log(`Cognito user deleted: ${userId}`);

    } catch (error) {
        console.error('Delete Cognito user error:', error);
        // Cognitoユーザーの削除に失敗してもアカウント削除は続行
        console.warn(`Failed to delete Cognito user, but continuing with account deletion: ${error.message}`);
    }
};
// 使用量ベースの請求書を手動作成
const createUsageInvoice = async (auth, { month }) => {
    try {
        const targetMonth = month || new Date().toISOString().slice(0, 7);
        
        const customer = await getCustomerFromDB(auth.userId);
        if (!customer || !customer.stripeCustomerId) {
            return createBillingErrorResponse(404, 'Customer not found');
        }

        // 使用量データを取得
        const usageResponse = await dynamoClient.send(new GetCommand({
            TableName: process.env.USAGE_TABLE,
            Key: {
                userId: auth.userId,
                periodMonth: targetMonth
            }
        }));

        const usage = usageResponse.Item || {
            storageGB: 0,
            uploadGB: 0,
            restoreGB: 0,
            thumbnailViews: 0,
            apiRequestCount: 0
        };

        // 料金計算
        const costs = {
            storage: usage.storageGB * PRICING.storage,
            uploads: usage.uploadGB * PRICING.upload,
            restores: (usage.restoreGB || 0) * PRICING.restore,
            thumbnails: (usage.thumbnailViews || 0) * PRICING.thumbnailDelivery,
            apiRequests: (usage.apiRequestCount || 0) * PRICING.apiRequests,
            baseFee: PRICING.baseFee
        };

        const totalCost = Object.values(costs).reduce((sum, cost) => sum + cost, 0);

        // Stripeで請求書を作成
        const invoice = await stripe.invoices.create({
            customer: customer.stripeCustomerId,
            description: `Usage-based billing for ${targetMonth}`,
            metadata: {
                userId: auth.userId,
                month: targetMonth,
                type: 'usage-based'
            }
        });

        // 基本料金を追加
        await stripe.invoiceItems.create({
            customer: customer.stripeCustomerId,
            invoice: invoice.id,
            amount: Math.round(costs.baseFee * 100),
            currency: 'usd',
            description: 'Monthly base fee'
        });

        // 使用量ベースの料金を追加
        if (costs.storage > 0) {
            await stripe.invoiceItems.create({
                customer: customer.stripeCustomerId,
                invoice: invoice.id,
                amount: Math.round(costs.storage * 100),
                currency: 'usd',
                description: `Storage: ${usage.storageGB.toFixed(3)} GB`
            });
        }

        if (costs.uploads > 0) {
            await stripe.invoiceItems.create({
                customer: customer.stripeCustomerId,
                invoice: invoice.id,
                amount: Math.round(costs.uploads * 100),
                currency: 'usd',
                description: `Uploads: ${usage.uploadGB.toFixed(3)} GB`
            });
        }

        if (costs.restores > 0) {
            await stripe.invoiceItems.create({
                customer: customer.stripeCustomerId,
                invoice: invoice.id,
                amount: Math.round(costs.restores * 100),
                currency: 'usd',
                description: `Restores: ${(usage.restoreGB || 0).toFixed(3)} GB`
            });
        }

        if (costs.thumbnails > 0) {
            await stripe.invoiceItems.create({
                customer: customer.stripeCustomerId,
                invoice: invoice.id,
                amount: Math.round(costs.thumbnails * 100),
                currency: 'usd',
                description: `Thumbnails: ${usage.thumbnailViews} views`
            });
        }

        if (costs.apiRequests > 0) {
            await stripe.invoiceItems.create({
                customer: customer.stripeCustomerId,
                invoice: invoice.id,
                amount: Math.round(costs.apiRequests * 100),
                currency: 'usd',
                description: `API Requests: ${usage.apiRequestCount} requests`
            });
        }

        // 請求書を確定
        const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);

        return createBillingSuccessResponse({
            invoice: {
                id: finalizedInvoice.id,
                amount_due: finalizedInvoice.amount_due,
                currency: finalizedInvoice.currency,
                status: finalizedInvoice.status,
                hosted_invoice_url: finalizedInvoice.hosted_invoice_url,
                invoice_pdf: finalizedInvoice.invoice_pdf
            },
            usage: usage,
            costs: costs,
            totalCost: Math.round(totalCost * 100) / 100
        });

    } catch (error) {
        console.error('Create usage invoice error:', error);
        return createBillingErrorResponse(500, error.message);
    }
};
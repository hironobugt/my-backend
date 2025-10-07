const jwt = require('jsonwebtoken');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { getAWSConfig } = require('./aws-config');

const awsConfig = getAWSConfig();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

exports.handler = async (event) => {
    console.log('Authorizer event:', JSON.stringify(event, null, 2));
    
    try {
        const token = event.authorizationToken;
        
        if (!token) {
            console.log('No authorization token provided');
            return generatePolicy('user', 'Deny', event.methodArn);
        }
        
        // Bearerプレフィックスを削除
        const cleanToken = token.replace('Bearer ', '');
        
        // 開発環境では簡単なトークン検証のみ
        if (process.env.NODE_ENV === 'development') {
            // 開発用の簡単なトークン
            if (cleanToken === 'test-token') {
                console.log('Development mode: Test token accepted');
                // テストユーザーのサブスクリプション状態をチェック
                const isSubscriptionValid = await checkSubscriptionStatus('test-user-id');
                if (!isSubscriptionValid) {
                    console.log('Test user subscription expired or invalid');
                    return generatePolicy('test-user-id', 'Deny', event.methodArn);
                }
                
                const policy = generatePolicy('test-user-id', 'Allow', event.methodArn);
                policy.context = {
                    userId: 'test-user-id',
                    username: 'testuser',
                    email: 'test@example.com'
                };
                return policy;
            }
            
            try {
                // JWTトークンをデコード（検証なし）
                const decoded = jwt.decode(cleanToken);
                
                if (decoded && decoded.username && decoded.sub) {
                    console.log('Development mode: Token accepted for user:', decoded.username);
                    
                    // 課金関連のエンドポイントかチェック
                    const isBillingEndpoint = isBillingRelatedEndpoint(event.methodArn);
                    
                    // 課金関連でない場合のみサブスクリプション状態をチェック
                    if (!isBillingEndpoint) {
                        const isSubscriptionValid = await checkSubscriptionStatus(decoded.sub);
                        if (!isSubscriptionValid) {
                            console.log('User subscription expired or invalid:', decoded.username);
                            return generatePolicy(decoded.sub, 'Deny', event.methodArn);
                        }
                    } else {
                        console.log('Billing endpoint - allowing access for expired subscription:', decoded.username);
                    }
                    
                    const policy = generatePolicy(decoded.sub, 'Allow', event.methodArn);
                    policy.context = {
                        userId: decoded.sub,
                        username: decoded.username,
                        email: decoded.email || 'dev@example.com'
                    };
                    return policy;
                } else {
                    console.log('Invalid token format');
                    return generatePolicy('user', 'Deny', event.methodArn);
                }
            } catch (error) {
                console.error('Token decode error:', error);
                return generatePolicy('user', 'Deny', event.methodArn);
            }
        }
        
        // 本番環境では完全な検証を実装
        // TODO: 本番環境でのjwks-client検証を実装
        console.log('Production mode not fully implemented');
        return generatePolicy('user', 'Deny', event.methodArn);
        
    } catch (error) {
        console.error('Authorizer error:', error);
        return generatePolicy('user', 'Deny', event.methodArn);
    }
};

// 課金関連のエンドポイントかチェックする関数
const isBillingRelatedEndpoint = (methodArn) => {
    // methodArnの例: arn:aws:execute-api:ap-northeast-1:471511831486:xm2tp4qdul/dev/POST/billing
    console.log('Checking if billing endpoint:', methodArn);
    
    // 課金関連のエンドポイント一覧
    const billingEndpoints = [
        '/billing',           // 課金API全般
        '/register'           // ユーザー登録（新規ユーザーがサブスクリプション作成するため）
    ];
    
    // methodArnから実際のパスを抽出
    const arnParts = methodArn.split('/');
    if (arnParts.length >= 4) {
        const path = '/' + arnParts.slice(3).join('/');
        console.log('Extracted path:', path);
        
        // 課金関連エンドポイントかチェック
        const isBilling = billingEndpoints.some(endpoint => path.startsWith(endpoint));
        console.log('Is billing endpoint:', isBilling);
        return isBilling;
    }
    
    return false;
};

// サブスクリプション状態をチェックする関数
const checkSubscriptionStatus = async (userId) => {
    try {
        // DynamoDBから顧客情報を取得
        const response = await dynamoClient.send(new GetCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId }
        }));

        const customer = response.Item;
        if (!customer) {
            console.log('Customer not found:', userId);
            return false;
        }

        // サブスクリプション状態をチェック
        const subscriptionStatus = customer.subscriptionStatus;
        const cancelAt = customer.cancelAt;

        console.log(`User ${userId} subscription status: ${subscriptionStatus}, cancelAt: ${cancelAt}`);

        // アクティブなサブスクリプションの場合
        if (subscriptionStatus === 'active') {
            return true;
        }

        // 不完全だが支払い処理中のサブスクリプション（一時的に許可）
        if (subscriptionStatus === 'incomplete') {
            console.log(`User ${userId} subscription is incomplete but allowing access for payment completion`);
            return true;
        }

        // キャンセル予定だが期限内の場合
        if (subscriptionStatus === 'canceling' && cancelAt) {
            const currentTime = Math.floor(Date.now() / 1000); // Unix timestamp
            const cancelTime = typeof cancelAt === 'number' ? cancelAt : Math.floor(new Date(cancelAt).getTime() / 1000);
            
            if (currentTime < cancelTime) {
                console.log(`User ${userId} subscription is canceling but still valid until ${new Date(cancelTime * 1000)}`);
                return true;
            }
        }

        // その他の状態（inactive, canceled, past_due等）は無効
        console.log(`User ${userId} subscription is invalid: ${subscriptionStatus}`);
        return false;

    } catch (error) {
        console.error('Error checking subscription status:', error);
        // エラーの場合は安全側に倒してアクセスを拒否
        return false;
    }
};

const generatePolicy = (principalId, effect, resource) => {
    const authResponse = {
        principalId: principalId
    };
    
    if (effect && resource) {
        const policyDocument = {
            Version: '2012-10-17',
            Statement: [
                {
                    Action: 'execute-api:Invoke',
                    Effect: effect,
                    Resource: resource
                }
            ]
        };
        authResponse.policyDocument = policyDocument;
    }
    
    return authResponse;
};
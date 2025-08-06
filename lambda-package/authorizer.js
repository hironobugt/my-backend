const jwt = require('jsonwebtoken');

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
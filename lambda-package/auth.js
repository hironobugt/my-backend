const jwt = require('jsonwebtoken');

// JWKS クライアントの設定（開発環境では無効化）
let client = null;
let jwksClient = null;

// 本番環境でのみjwks-clientを読み込み
if (process.env.NODE_ENV !== 'development' && process.env.USE_MOTO !== 'true') {
    try {
        jwksClient = require('jwks-client');
        client = jwksClient({
            jwksUri: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}/.well-known/jwks.json`,
            cache: true,
            cacheMaxEntries: 5,
            cacheMaxAge: 600000 // 10分
        });
    } catch (error) {
        console.warn('jwks-client not available in development mode');
    }
}

// JWTトークンの検証
const verifyToken = async (token) => {
    try {
        // Bearerプレフィックスを削除
        const cleanToken = token.replace('Bearer ', '');
        
        // JWTヘッダーをデコード
        const decoded = jwt.decode(cleanToken, { complete: true });
        if (!decoded) {
            throw new Error('Invalid token format');
        }

        // 公開鍵を取得
        const key = await client.getSigningKey(decoded.header.kid);
        const signingKey = key.getPublicKey();

        // トークンを検証
        const payload = jwt.verify(cleanToken, signingKey, {
            algorithms: ['RS256'],
            audience: process.env.USER_POOL_CLIENT_ID,
            issuer: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}`
        });

        return {
            isValid: true,
            userId: payload.sub,
            username: payload['cognito:username'] || payload.username,
            email: payload.email,
            payload
        };
    } catch (error) {
        console.error('Token verification failed:', error);
        return {
            isValid: false,
            error: error.message
        };
    }
};

// API Gateway イベントから認証情報を取得
const getAuthFromEvent = (event) => {
    // Cognito Authorizerが設定されている場合
    if (event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.claims) {
        const claims = event.requestContext.authorizer.claims;
        return {
            isValid: true,
            userId: claims.sub,
            username: claims['cognito:username'] || claims.username,
            email: claims.email
        };
    }

    // 手動でAuthorizationヘッダーから取得する場合
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) {
        return {
            isValid: false,
            error: 'No authorization header'
        };
    }

    return null; // verifyTokenを呼び出す必要がある
};

// 認証ミドルウェア
const requireAuth = async (event) => {
    // 開発環境ではモック認証を使用
    if (process.env.NODE_ENV === 'development') {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader) {
            return {
                isValid: false,
                error: 'Authorization header is required'
            };
        }

        // モック認証：任意のBearerトークンを受け入れ
        if (authHeader.startsWith('Bearer ')) {
            return {
                isValid: true,
                userId: 'dev-user-123',
                username: 'testuser',
                email: 'test@example.com'
            };
        }

        return {
            isValid: false,
            error: 'Invalid authorization format'
        };
    }

    // 本番環境では実際のCognito認証
    const authFromEvent = getAuthFromEvent(event);
    if (authFromEvent) {
        return authFromEvent;
    }

    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) {
        return {
            isValid: false,
            error: 'Authorization header is required'
        };
    }

    return await verifyToken(authHeader);
};

// エラーレスポンスの生成
const createErrorResponse = (statusCode, message) => {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({
            error: message
        })
    };
};

// 成功レスポンスの生成
const createSuccessResponse = (data, statusCode = 200) => {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify(data)
    };
};

module.exports = {
    verifyToken,
    getAuthFromEvent,
    requireAuth,
    createErrorResponse,
    createSuccessResponse
};
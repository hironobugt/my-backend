const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// 環境変数を読み込み（moto使用時は.env.motoを優先）
if (process.env.USE_MOTO === 'true') {
    dotenv.config({ path: '.env.moto' });
} else {
    dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ローカル開発用の環境変数設定
if (!process.env.AWS_REGION) {
    process.env.AWS_REGION = 'ap-northeast-1';
}

// Lambda関数をExpressルートとして変換するヘルパー
const lambdaToExpress = (lambdaHandler) => {
    return async (req, res) => {
        try {
            // Lambda event形式に変換
            const event = {
                httpMethod: req.method,
                path: req.path,
                pathParameters: req.params,
                queryStringParameters: req.query,
                headers: req.headers,
                body: JSON.stringify(req.body),
                requestContext: {
                    authorizer: req.user ? { claims: req.user } : null
                }
            };

            // Lambda関数を実行
            const result = await lambdaHandler(event);

            // レスポンスを返す
            res.status(result.statusCode);

            if (result.headers) {
                Object.keys(result.headers).forEach(key => {
                    res.set(key, result.headers[key]);
                });
            }

            // サムネイルエンドポイントの特別処理
            if (result.isBase64Encoded && result.body) {
                const buffer = Buffer.from(result.body, 'base64');
                res.send(buffer);
            } else {
                const body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
                res.json(body);
            }

        } catch (error) {
            console.error('Lambda handler error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    };
};
// 簡易認証ミドルウェア（開発用）
const mockAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        // 開発用のモックユーザー
        req.user = {
            sub: 'dev-user-123',
            'cognito:username': 'testuser',
            email: 'test@example.com'
        };
    }

    next();
};

// Lambda関数をインポート
const registerHandler = require('./src/register').handler;
const uploadHandler = require('./src/upload').handler;
const listHandler = require('./src/list').handler;
const getHandler = require('./src/get').handler;
const deleteHandler = require('./src/delete').handler;
const billingHandler = require('./src/billing').handler;
const usageHandler = require('./src/usage').handler;
const webhookHandler = require('./src/webhook').handler;
const thumbnailHandler = require('./src/thumbnail-cloudfront').handler;
const thumbnailBatchHandler = require('./src/thumbnail-cloudfront').handlerBatch;

// ルート定義
app.post('/auth/register', lambdaToExpress(registerHandler));

// 認証が必要なルート
app.use('/archive', mockAuth);
app.use('/billing', mockAuth);
app.use('/usage', mockAuth);

app.post('/archive/upload', lambdaToExpress(uploadHandler));
app.get('/archive/list', lambdaToExpress(listHandler));
app.get('/archive/:archiveId', lambdaToExpress(getHandler));
app.get('/archive/:archiveId/thumbnail', lambdaToExpress(thumbnailHandler));
app.post('/archive/thumbnails/batch', lambdaToExpress(thumbnailBatchHandler));
app.delete('/archive/:archiveId', lambdaToExpress(deleteHandler));

app.post('/billing', lambdaToExpress(billingHandler));
app.post('/usage', lambdaToExpress(usageHandler));

// ローカル開発用サムネイル配信（認証不要、CloudFrontの代替）
app.get('/local-thumbnail/:thumbnailKey(*)', async (req, res) => {
    try {
        const thumbnailKey = decodeURIComponent(req.params.thumbnailKey);

        // S3からサムネイルを取得
        const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
        const { getAWSConfig } = require('./src/aws-config');

        const awsConfig = getAWSConfig();
        const s3Client = new S3Client(awsConfig);

        const response = await s3Client.send(new GetObjectCommand({
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: thumbnailKey
        }));

        // ストリームをバッファに変換
        const chunks = [];
        for await (const chunk of response.Body) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // CloudFrontと同様のキャッシュヘッダーを設定
        res.set({
            'Content-Type': response.ContentType || 'image/jpeg',
            'Content-Length': buffer.length,
            'Cache-Control': 'public, max-age=86400', // ローカルでは24時間
            'Access-Control-Allow-Origin': '*'
        });

        res.send(buffer);

    } catch (error) {
        console.error('Local thumbnail serve error:', error);
        res.status(404).json({ error: 'Thumbnail not found' });
    }
});

// Webhook（認証不要）
app.post('/webhook/stripe', lambdaToExpress(webhookHandler));

// ヘルスチェック
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: 'local-development'
    });
});

// API情報
app.get('/', (req, res) => {
    res.json({
        name: 'Glacier Archive API',
        version: '1.0.0',
        environment: 'local-development',
        endpoints: {
            auth: {
                'POST /auth/register': 'User registration'
            },
            archive: {
                'POST /archive/upload': 'Upload file (requires auth)',
                'GET /archive/list': 'List archives with thumbnail info (requires auth)',
                'GET /archive/:id': 'Get/restore archive (requires auth)',
                'GET /archive/:id/thumbnail': 'Get archive thumbnail (requires auth)',
                'DELETE /archive/:id': 'Delete archive (requires auth)'
            },
            billing: {
                'POST /billing': 'Billing operations (requires auth)'
            },
            usage: {
                'POST /usage': 'Usage tracking (requires auth)'
            },
            webhook: {
                'POST /webhook/stripe': 'Stripe webhooks'
            }
        },
        mockAuth: {
            note: 'Use "Bearer mock-token" in Authorization header for testing'
        }
    });
});

// エラーハンドリング
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// 404ハンドリング
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// サーバー起動
app.listen(PORT, () => {
    console.log(`🚀 Glacier Archive API running on http://localhost:${PORT}`);
    console.log(`📖 API Documentation: http://localhost:${PORT}`);
    console.log(`💚 Health Check: http://localhost:${PORT}/health`);
    console.log('');
    console.log('🔧 Development Mode:');
    console.log('- Mock authentication enabled');
    console.log('- Use "Bearer mock-token" for testing authenticated endpoints');
    console.log('- AWS services will use your local AWS credentials');
});

module.exports = app;
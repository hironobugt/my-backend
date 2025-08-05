// 最適化されたサムネイル取得エンドポイント
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { requireAuth, createErrorResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

const awsConfig = getAWSConfig();
const s3Client = new S3Client(awsConfig);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

// 直接バイナリデータを返すバージョン（より効率的）
exports.handlerBinary = async (event) => {
    try {
        // 認証チェック
        const auth = await requireAuth(event);
        if (!auth.isValid) {
            return createErrorResponse(401, auth.error || 'Unauthorized');
        }

        const { archiveId } = event.pathParameters || {};
        
        if (!archiveId) {
            return createErrorResponse(400, 'archiveId is required');
        }

        // メタデータを取得
        const metadataResponse = await dynamoClient.send(new GetCommand({
            TableName: process.env.METADATA_TABLE,
            Key: {
                userId: auth.userId,
                archiveId: archiveId
            }
        }));

        if (!metadataResponse.Item) {
            return createErrorResponse(404, 'Archive not found');
        }

        const { thumbnailKey, hasThumbnail } = metadataResponse.Item;

        if (!hasThumbnail || !thumbnailKey) {
            return createErrorResponse(404, 'Thumbnail not available for this file');
        }

        // S3からサムネイルを取得
        const thumbnailResponse = await s3Client.send(new GetObjectCommand({
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: thumbnailKey
        }));

        // ストリームをバッファに変換
        const chunks = [];
        for await (const chunk of thumbnailResponse.Body) {
            chunks.push(chunk);
        }
        const thumbnailBuffer = Buffer.concat(chunks);

        // バイナリデータとして直接返す（API Gatewayでバイナリメディアタイプが設定されている場合）
        return {
            statusCode: 200,
            headers: {
                'Content-Type': thumbnailResponse.ContentType || 'image/jpeg',
                'Content-Length': thumbnailBuffer.length.toString(),
                'Cache-Control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type'
            },
            body: thumbnailBuffer.toString('base64'),
            isBase64Encoded: true
        };

    } catch (error) {
        console.error('Get thumbnail error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};

// 複数のサムネイルを一括取得するエンドポイント
exports.handlerBatch = async (event) => {
    try {
        const auth = await requireAuth(event);
        if (!auth.isValid) {
            return createErrorResponse(401, auth.error || 'Unauthorized');
        }

        const { archiveIds } = JSON.parse(event.body || '{}');
        
        if (!archiveIds || !Array.isArray(archiveIds)) {
            return createErrorResponse(400, 'archiveIds array is required');
        }

        const thumbnails = {};
        
        // 並列でサムネイルを取得
        await Promise.all(archiveIds.map(async (archiveId) => {
            try {
                // メタデータ取得
                const metadataResponse = await dynamoClient.send(new GetCommand({
                    TableName: process.env.METADATA_TABLE,
                    Key: {
                        userId: auth.userId,
                        archiveId: archiveId
                    }
                }));

                if (!metadataResponse.Item || !metadataResponse.Item.hasThumbnail) {
                    thumbnails[archiveId] = null;
                    return;
                }

                // S3からサムネイル取得
                const thumbnailResponse = await s3Client.send(new GetObjectCommand({
                    Bucket: process.env.ARCHIVE_BUCKET,
                    Key: metadataResponse.Item.thumbnailKey
                }));

                const chunks = [];
                for await (const chunk of thumbnailResponse.Body) {
                    chunks.push(chunk);
                }
                const thumbnailBuffer = Buffer.concat(chunks);

                thumbnails[archiveId] = {
                    data: thumbnailBuffer.toString('base64'),
                    contentType: thumbnailResponse.ContentType || 'image/jpeg'
                };

            } catch (error) {
                console.error(`Failed to get thumbnail for ${archiveId}:`, error);
                thumbnails[archiveId] = null;
            }
        }));

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ thumbnails })
        };

    } catch (error) {
        console.error('Batch thumbnail error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};
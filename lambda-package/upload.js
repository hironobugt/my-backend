const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');
const { generateAndSaveThumbnail } = require('./thumbnail-cloudfront');

// 使用量記録関数（ローカル実装）
const recordUsageEvent = async (userId, eventType, eventData) => {
    try {
        console.log(`Usage event recorded: ${eventType} for user ${userId}`, eventData);
        // ローカル開発では簡単なログ出力のみ
        return true;
    } catch (error) {
        console.error('Record usage event error:', error);
        return false;
    }
};

const awsConfig = getAWSConfig();
const s3Client = new S3Client(awsConfig);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

exports.handler = async (event) => {
    try {
        // 認証チェック（API Gatewayの認証コンテキストを使用）
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
                return createErrorResponse(401, auth.error || 'Unauthorized');
            }
        }

        // APIリクエストの使用量を記録
        const { recordUsageEvent } = require('./usage');
        await recordUsageEvent(auth.userId, 'api_request', {
            endpoint: 'upload',
            method: event.httpMethod
        });

        const { fileName, fileContent, metadata = {} } = JSON.parse(event.body);
        
        if (!fileName || !fileContent) {
            return createErrorResponse(400, 'fileName and fileContent are required');
        }

        const archiveId = uuidv4();
        const key = `archives/${auth.userId}/${archiveId}/${fileName}`;
        const timestamp = new Date().toISOString();
        
        // Base64デコード（モバイルアプリからはBase64エンコードされたデータを想定）
        const buffer = Buffer.from(fileContent, 'base64');
        
        const uploadParams = {
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: key,
            Body: buffer,
            Metadata: {
                'archive-id': archiveId,
                'user-id': auth.userId,
                'original-filename': fileName,
                'upload-timestamp': timestamp,
                ...metadata
            },
            StorageClass: 'DEEP_ARCHIVE'
        };

        // S3にアップロード
        await s3Client.send(new PutObjectCommand(uploadParams));

        // DynamoDBにメタデータを保存
        const metadataItem = {
            userId: auth.userId,
            archiveId: archiveId,
            fileName: fileName,
            s3Key: key,
            fileSize: buffer.length,
            uploadTimestamp: timestamp,
            status: 'archived',
            storageClass: 'DEEP_ARCHIVE',
            metadata: metadata,
            username: auth.username,
            email: auth.email
        };

        await dynamoClient.send(new PutCommand({
            TableName: process.env.METADATA_TABLE,
            Item: metadataItem
        }));

        // サムネイル生成（非同期で実行、失敗してもアップロードは成功とする）
        let thumbnailResult = null;
        try {
            thumbnailResult = await generateAndSaveThumbnail(auth.userId, archiveId, fileName, buffer);
            console.log('Thumbnail generation result:', thumbnailResult);
        } catch (thumbnailError) {
            console.error('Thumbnail generation failed:', thumbnailError);
            // サムネイル生成の失敗はアップロード処理を止めない
        }

        // 使用量イベントを記録
        try {
            await recordUsageEvent(auth.userId, 'upload', {
                archiveId: archiveId,
                fileName: fileName,
                fileSize: buffer.length,
                fileSizeGB: buffer.length / (1024 * 1024 * 1024)
            });
        } catch (usageError) {
            console.error('Failed to record usage event:', usageError);
            // 使用量記録の失敗はアップロード処理を止めない
        }

        const response = {
            archiveId,
            fileName,
            fileSize: buffer.length,
            s3Key: key,
            message: 'File archived successfully',
            estimatedRetrievalTime: '12-48 hours',
            uploadTimestamp: timestamp
        };

        // サムネイル情報を追加
        if (thumbnailResult) {
            response.thumbnail = {
                available: thumbnailResult.success,
                fileType: thumbnailResult.fileType,
                message: thumbnailResult.message
            };
        }

        return createSuccessResponse(response);

    } catch (error) {
        console.error('Upload error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};
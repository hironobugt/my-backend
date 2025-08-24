const { S3Client, HeadObjectCommand, PutObjectTaggingCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

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

        const { archiveId } = event.pathParameters;
        
        if (!archiveId) {
            return createErrorResponse(400, 'archiveId is required');
        }

        // DynamoDBからアーカイブメタデータを取得
        const getItemParams = {
            TableName: process.env.METADATA_TABLE,
            Key: {
                userId: auth.userId,
                archiveId: archiveId
            }
        };

        const metadataResponse = await dynamoClient.send(new GetCommand(getItemParams));
        
        if (!metadataResponse.Item) {
            return createErrorResponse(404, 'Archive not found or access denied');
        }

        const archiveMetadata = metadataResponse.Item;
        const key = archiveMetadata.s3Key;
        
        // オブジェクトの現在の状態を確認
        const headParams = {
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: key
        };
        
        const headResponse = await s3Client.send(new HeadObjectCommand(headParams));
        
        // 復元状態を確認
        const isRestored = headResponse.Restore && headResponse.Restore.includes('ongoing-request="false"');
        const isRestoring = headResponse.Restore && headResponse.Restore.includes('ongoing-request="true"');
        
        console.log('Current restore status:', {
            StorageClass: headResponse.StorageClass,
            Restore: headResponse.Restore,
            isRestored,
            isRestoring
        });
        
        // 復元されていない場合はエラー
        if (!isRestored) {
            if (isRestoring) {
                return createErrorResponse(409, 'File is currently being restored. Cannot re-archive while restoration is in progress.');
            } else {
                return createErrorResponse(400, 'File is not currently restored. Only restored files can be moved back to Deep Archive.');
            }
        }
        
        // Deep Archiveストレージクラスのタグを設定
        // S3では復元されたオブジェクトは自動的に元のストレージクラスに戻るため、
        // ここでは明示的にDeep Archiveタグを設定してライフサイクルポリシーで管理
        const taggingParams = {
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: key,
            Tagging: {
                TagSet: [
                    {
                        Key: 'StorageClass',
                        Value: 'DEEP_ARCHIVE'
                    },
                    {
                        Key: 'ReArchiveRequested',
                        Value: new Date().toISOString()
                    },
                    {
                        Key: 'UserId',
                        Value: auth.userId
                    }
                ]
            }
        };
        
        await s3Client.send(new PutObjectTaggingCommand(taggingParams));
        
        // DynamoDBのステータスを更新
        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.METADATA_TABLE,
            Key: {
                userId: auth.userId,
                archiveId: archiveId
            },
            UpdateExpression: 'SET #status = :status, reArchiveRequestedAt = :timestamp',
            ExpressionAttributeNames: {
                '#status': 'status'
            },
            ExpressionAttributeValues: {
                ':status': 'archived',
                ':timestamp': new Date().toISOString()
            }
        }));

        // 再アーカイブ使用量イベントを記録
        try {
            await recordUsageEvent(auth.userId, 'rearchive', {
                archiveId: archiveId,
                fileName: archiveMetadata.fileName,
                fileSize: archiveMetadata.fileSize
            });
        } catch (usageError) {
            console.error('Failed to record rearchive usage event:', usageError);
            // 使用量記録の失敗は処理を止めない
        }
        
        return createSuccessResponse({
            archiveId,
            fileName: archiveMetadata.fileName,
            status: 'archived',
            message: 'File has been moved back to Deep Archive storage. This will help reduce storage costs.',
            reArchiveRequestedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('Re-archive error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};
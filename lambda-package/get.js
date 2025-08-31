const { S3Client, HeadObjectCommand, RestoreObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');
const { sendRestoreCompleteNotification } = require('./notification');

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
        const queryParams = event.queryStringParameters || {};
        const statusOnly = queryParams.statusOnly === 'true';
        const downloadRequested = queryParams.download === 'true';
        
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
        
        // オブジェクトのメタデータを取得
        const headParams = {
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: key
        };
        
        const headResponse = await s3Client.send(new HeadObjectCommand(headParams));
        
        // デバッグ用：復元状態の詳細ログ
        console.log('S3 Object Details:', {
            StorageClass: headResponse.StorageClass,
            Restore: headResponse.Restore,
            LastModified: headResponse.LastModified,
            ContentLength: headResponse.ContentLength
        });
        
        // Deep Archiveからの復元状況を確認
        const isRestored = headResponse.Restore && headResponse.Restore.includes('ongoing-request="false"');
        const isRestoring = headResponse.Restore && headResponse.Restore.includes('ongoing-request="true"');
        
        console.log('Restore Status Check:', {
            hasRestore: !!headResponse.Restore,
            isRestored,
            isRestoring,
            restoreString: headResponse.Restore,
            storageClass: headResponse.StorageClass
        });
        
        // Deep Archiveの場合、復元が完了していてもストレージクラスはDEEP_ARCHIVEのまま
        // 復元状態はRestoreヘッダーで判定する
        const isDeepArchive = headResponse.StorageClass === 'DEEP_ARCHIVE';
        const canAccess = !isDeepArchive || isRestored;
        
        if (!isRestored && !isRestoring) {
            if (statusOnly) {
                // 状態確認のみ - 復元リクエストは送信しない
                return createSuccessResponse({
                    archiveId,
                    fileName: archiveMetadata.fileName,
                    status: 'archived',
                    message: 'File is archived. No restore request has been initiated.',
                    metadata: archiveMetadata.metadata
                }, 200);
            }
            
            // 復元リクエストを開始
            const restoreParams = {
                Bucket: process.env.ARCHIVE_BUCKET,
                Key: key,
                RestoreRequest: {
                    Days: 1, // 復元後の保持日数
                    GlacierJobParameters: {
                        Tier: 'Standard' // Standard (12時間), Expedited (利用不可), Bulk (48時間)
                    }
                }
            };
            
            await s3Client.send(new RestoreObjectCommand(restoreParams));
            
            // DynamoDBのステータスを更新
            await dynamoClient.send(new UpdateCommand({
                TableName: process.env.METADATA_TABLE,
                Key: {
                    userId: auth.userId,
                    archiveId: archiveId
                },
                UpdateExpression: 'SET #status = :status, restoreRequestedAt = :timestamp',
                ExpressionAttributeNames: {
                    '#status': 'status'
                },
                ExpressionAttributeValues: {
                    ':status': 'restore_requested',
                    ':timestamp': new Date().toISOString()
                }
            }));

            // 復元使用量イベントを記録
            try {
                await recordUsageEvent(auth.userId, 'restore', {
                    archiveId: archiveId,
                    fileName: archiveMetadata.fileName,
                    fileSize: archiveMetadata.fileSize,
                    restoreTier: 'Standard'
                });
            } catch (usageError) {
                console.error('Failed to record restore usage event:', usageError);
                // 使用量記録の失敗は復元処理を止めない
            }
            
            return createSuccessResponse({
                archiveId,
                fileName: archiveMetadata.fileName,
                status: 'restore_initiated',
                message: 'Restore request initiated. Please check back in 12-48 hours.',
                estimatedRestoreTime: '12-48 hours',
                metadata: archiveMetadata.metadata
            }, 202);
        }
        
        if (isRestoring) {
            if (downloadRequested) {
                // ダウンロードが要求されたが、まだ復元中
                return createSuccessResponse({
                    archiveId,
                    fileName: archiveMetadata.fileName,
                    status: 'not_ready',
                    message: 'File is still being restored. Please wait for restoration to complete.',
                    metadata: archiveMetadata.metadata
                }, 409);
            }
            
            // DynamoDBのステータスを更新
            await dynamoClient.send(new UpdateCommand({
                TableName: process.env.METADATA_TABLE,
                Key: {
                    userId: auth.userId,
                    archiveId: archiveId
                },
                UpdateExpression: 'SET #status = :status',
                ExpressionAttributeNames: {
                    '#status': 'status'
                },
                ExpressionAttributeValues: {
                    ':status': 'restoring'
                }
            }));

            return createSuccessResponse({
                archiveId,
                fileName: archiveMetadata.fileName,
                status: 'restoring',
                message: 'Restore in progress. Please check back later.',
                metadata: archiveMetadata.metadata
            }, 202);
        }
        
        // Deep Archiveで復元されていない場合のエラーハンドリング
        if (isDeepArchive && !isRestored) {
            console.log(`Archive ${archiveId} is in Deep Archive but not restored`);
            
            // DynamoDBのステータスを正しい状態に修正
            await dynamoClient.send(new UpdateCommand({
                TableName: process.env.METADATA_TABLE,
                Key: {
                    userId: auth.userId,
                    archiveId: archiveId
                },
                UpdateExpression: 'SET #status = :status',
                ExpressionAttributeNames: {
                    '#status': 'status'
                },
                ExpressionAttributeValues: {
                    ':status': 'archived'
                }
            }));
            
            return createErrorResponse(409, 'File is in Deep Archive storage and not currently restored. Please initiate a restore request first.');
        }
        
        // 復元完了 - ファイルを取得
        try {
            const getParams = {
                Bucket: process.env.ARCHIVE_BUCKET,
                Key: key
            };
            
            const getResponse = await s3Client.send(new GetObjectCommand(getParams));
            const body = await getResponse.Body.transformToByteArray();
            const base64Content = Buffer.from(body).toString('base64');
            
            // 復元完了通知を送信（初回復元完了時のみ）
            const wasRestoring = archiveMetadata.status === 'restoring' || archiveMetadata.status === 'restore_requested';
            if (wasRestoring) {
                try {
                    await sendRestoreCompleteNotification(auth.userId, archiveId, archiveMetadata.fileName);
                    console.log(`Restore complete notification sent for archive: ${archiveId}`);
                } catch (notificationError) {
                    console.error('Failed to send restore notification:', notificationError);
                    // 通知の失敗はファイル取得を止めない
                }
            }
            
            // 実際にファイルが取得できた場合のみDynamoDBのステータスを更新
            await dynamoClient.send(new UpdateCommand({
                TableName: process.env.METADATA_TABLE,
                Key: {
                    userId: auth.userId,
                    archiveId: archiveId
                },
                UpdateExpression: 'SET #status = :status, lastAccessedAt = :timestamp, notificationSent = :notificationSent',
                ExpressionAttributeNames: {
                    '#status': 'status'
                },
                ExpressionAttributeValues: {
                    ':status': 'restored',
                    ':timestamp': new Date().toISOString(),
                    ':notificationSent': wasRestoring ? new Date().toISOString() : archiveMetadata.notificationSent
                }
            }));
            
            return createSuccessResponse({
                archiveId,
                fileName: archiveMetadata.fileName,
                content: base64Content,
                contentType: getResponse.ContentType,
                fileSize: getResponse.ContentLength,
                uploadTimestamp: archiveMetadata.uploadTimestamp,
                metadata: archiveMetadata.metadata,
                status: 'restored'
            });
            
        } catch (getError) {
            console.error(`Failed to get object ${key}:`, getError);
            
            // ファイル取得に失敗した場合、DynamoDBのステータスを修正
            await dynamoClient.send(new UpdateCommand({
                TableName: process.env.METADATA_TABLE,
                Key: {
                    userId: auth.userId,
                    archiveId: archiveId
                },
                UpdateExpression: 'SET #status = :status',
                ExpressionAttributeNames: {
                    '#status': 'status'
                },
                ExpressionAttributeValues: {
                    ':status': 'archived'
                }
            }));
            
            if (getError.name === 'InvalidObjectState') {
                return createErrorResponse(409, 'File is not currently available for download. It may still be in Deep Archive or restoration may have expired.');
            }
            
            throw getError;
        }

    } catch (error) {
        console.error('Get archive error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};
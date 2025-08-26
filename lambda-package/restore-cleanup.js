const { S3Client, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { getAWSConfig } = require('./aws-config');

const awsConfig = getAWSConfig();
const s3Client = new S3Client(awsConfig);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

exports.handler = async (event) => {
    try {
        console.log('Starting restore cleanup process...');
        
        // DynamoDBから復元済みのアーカイブを検索
        const scanParams = {
            TableName: process.env.METADATA_TABLE,
            FilterExpression: '#status = :status',
            ExpressionAttributeNames: {
                '#status': 'status'
            },
            ExpressionAttributeValues: {
                ':status': 'restored'
            }
        };
        
        const scanResult = await dynamoClient.send(new ScanCommand(scanParams));
        
        if (!scanResult.Items || scanResult.Items.length === 0) {
            console.log('No restored archives found');
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'No restored archives to process',
                    processedCount: 0
                })
            };
        }
        
        let processedCount = 0;
        let errorCount = 0;
        
        for (const item of scanResult.Items) {
            try {
                await processRestoredArchive(item);
                processedCount++;
            } catch (error) {
                console.error(`Failed to process archive ${item.archiveId}:`, error);
                errorCount++;
            }
        }
        
        console.log(`Restore cleanup completed. Processed: ${processedCount}, Errors: ${errorCount}`);
        
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Restore cleanup completed',
                processedCount,
                errorCount
            })
        };
        
    } catch (error) {
        console.error('Restore cleanup error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Internal server error',
                message: error.message
            })
        };
    }
};

const processRestoredArchive = async (archiveItem) => {
    const { userId, archiveId, s3Key, fileName } = archiveItem;
    
    console.log(`Processing restored archive: ${archiveId} (${fileName})`);
    
    // S3オブジェクトの現在の状態を確認
    const headParams = {
        Bucket: process.env.ARCHIVE_BUCKET,
        Key: s3Key
    };
    
    const headResponse = await s3Client.send(new HeadObjectCommand(headParams));
    
    // 復元期限を確認
    const isRestored = headResponse.Restore && headResponse.Restore.includes('ongoing-request="false"');
    
    if (!isRestored) {
        console.log(`Archive ${archiveId} is not in restored state, skipping`);
        return;
    }
    
    // 復元期限が近い場合（6時間以内）、Glacier Deep Archiveに戻す
    // 24時間から6時間に変更して、ユーザーがダウンロードする時間を確保
    const restoreExpiry = extractRestoreExpiry(headResponse.Restore);
    const now = new Date();
    const expiryTime = new Date(restoreExpiry);
    const hoursUntilExpiry = (expiryTime - now) / (1000 * 60 * 60);
    
    if (hoursUntilExpiry <= 6) {
        console.log(`Archive ${archiveId} expires in ${hoursUntilExpiry.toFixed(1)} hours, moving back to Deep Archive`);
        
        // オブジェクトをGlacier Deep Archiveストレージクラスでコピー
        const copyParams = {
            Bucket: process.env.ARCHIVE_BUCKET,
            CopySource: `${process.env.ARCHIVE_BUCKET}/${s3Key}`,
            Key: s3Key,
            StorageClass: 'DEEP_ARCHIVE',
            MetadataDirective: 'COPY'
        };
        
        await s3Client.send(new CopyObjectCommand(copyParams));
        
        console.log(`Archive ${archiveId} moved back to Glacier Deep Archive`);
        
        // DynamoDBのステータスを更新
        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.METADATA_TABLE,
            Key: {
                userId: userId,
                archiveId: archiveId
            },
            UpdateExpression: 'SET #status = :status, restoredToDeepArchiveAt = :timestamp',
            ExpressionAttributeNames: {
                '#status': 'status'
            },
            ExpressionAttributeValues: {
                ':status': 'archived',
                ':timestamp': new Date().toISOString()
            }
        }));
        
        console.log(`Archive ${archiveId} status updated to archived`);
    } else {
        console.log(`Archive ${archiveId} expires in ${hoursUntilExpiry.toFixed(1)} hours, no action needed yet`);
    }
};

const extractRestoreExpiry = (restoreString) => {
    // Extract expiry date from restore string
    // Format: 'ongoing-request="false", expiry-date="Wed, 25 Jan 2025 12:00:00 GMT"'
    const match = restoreString.match(/expiry-date="([^"]+)"/);
    return match ? match[1] : null;
};
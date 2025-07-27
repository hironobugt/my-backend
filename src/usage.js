const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

const awsConfig = getAWSConfig();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

// 使用量イベントタイプ
const EVENT_TYPES = {
    UPLOAD: 'upload',
    RESTORE: 'restore',
    DELETE: 'delete',
    STORAGE_CALCULATION: 'storage_calc',
    THUMBNAIL_VIEW: 'thumbnail_view',
    API_REQUEST: 'api_request'
};

exports.handler = async (event) => {
    try {
        // 認証チェック
        const auth = await requireAuth(event);
        if (!auth.isValid) {
            return createErrorResponse(401, auth.error || 'Unauthorized');
        }

        const { action, ...params } = JSON.parse(event.body);

        switch (action) {
            case 'get-current-usage':
                return await getCurrentUsage(auth, params);
            case 'get-usage-history':
                return await getUsageHistory(auth, params);
            case 'get-usage-events':
                return await getUsageEvents(auth, params);
            case 'calculate-storage':
                return await calculateStorageUsage(auth);
            default:
                return createErrorResponse(400, 'Invalid action');
        }

    } catch (error) {
        console.error('Usage error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};

// 現在の使用量取得
const getCurrentUsage = async (auth, { month }) => {
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
            uploadGB: 0,
            restoreGB: 0,
            uploadCount: 0,
            restoreCount: 0,
            deleteCount: 0,
            totalFiles: 0,
            lastUpdated: new Date().toISOString()
        };

        // 料金計算（競争力のある価格設定）
        const pricing = {
            storage: 0.012,   // $0.012 per GB per month (AWS実コスト: $0.003, 400%マージン)
            upload: 0.09,     // $0.09 per GB uploaded (AWS実コスト: $0.015, 600%マージン)
            restore: 0.40,    // $0.40 per GB restored (AWS実コスト: $0.08, 500%マージン)
            baseFee: 3.00,    // $3.00 monthly base fee (競合対抗価格)
            thumbnailDelivery: 0.0005, // $0.0005 per thumbnail view (500%マージン)
            apiRequests: 0.000008      // $0.000008 per API request (800%マージン)
        };

        const costs = {
            storage: usage.storageGB * pricing.storage,
            uploads: usage.uploadGB * pricing.upload,
            restores: usage.restoreGB * pricing.restore,
            thumbnails: (usage.thumbnailViews || 0) * pricing.thumbnailDelivery,
            apiRequests: (usage.apiRequestCount || 0) * pricing.apiRequests,
            baseFee: pricing.baseFee
        };

        const totalCost = Object.values(costs).reduce((sum, cost) => sum + cost, 0);

        return createSuccessResponse({
            usage,
            costs,
            totalCost: Math.round(totalCost * 100) / 100,
            pricing
        });

    } catch (error) {
        console.error('Get current usage error:', error);
        return createErrorResponse(500, error.message);
    }
};

// 使用量履歴取得
const getUsageHistory = async (auth, { months = 6 }) => {
    try {
        const currentDate = new Date();
        const history = [];

        for (let i = 0; i < months; i++) {
            const targetDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
            const monthKey = targetDate.toISOString().slice(0, 7);

            const usageResponse = await dynamoClient.send(new GetCommand({
                TableName: process.env.USAGE_TABLE,
                Key: {
                    userId: auth.userId,
                    periodMonth: monthKey
                }
            }));

            const usage = usageResponse.Item || {
                userId: auth.userId,
                periodMonth: monthKey,
                storageGB: 0,
                uploadCount: 0,
                restoreCount: 0,
                deleteCount: 0,
                totalFiles: 0
            };

            history.push(usage);
        }

        return createSuccessResponse({
            history: history.reverse(), // 古い順にソート
            totalMonths: months
        });

    } catch (error) {
        console.error('Get usage history error:', error);
        return createErrorResponse(500, error.message);
    }
};

// 使用量イベント取得
const getUsageEvents = async (auth, { limit = 50, startDate, endDate }) => {
    try {
        const now = new Date();
        const start = startDate ? new Date(startDate) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30日前
        const end = endDate ? new Date(endDate) : now;

        const queryParams = {
            TableName: process.env.USAGE_EVENTS_TABLE,
            KeyConditionExpression: 'userId = :userId AND #timestamp BETWEEN :start AND :end',
            ExpressionAttributeNames: {
                '#timestamp': 'timestamp'
            },
            ExpressionAttributeValues: {
                ':userId': auth.userId,
                ':start': start.toISOString(),
                ':end': end.toISOString()
            },
            Limit: parseInt(limit),
            ScanIndexForward: false // 新しい順
        };

        const response = await dynamoClient.send(new QueryCommand(queryParams));

        return createSuccessResponse({
            events: response.Items || [],
            count: response.Items?.length || 0
        });

    } catch (error) {
        console.error('Get usage events error:', error);
        return createErrorResponse(500, error.message);
    }
};

// ストレージ使用量計算
const calculateStorageUsage = async (auth) => {
    try {
        // アーカイブメタデータから現在のストレージ使用量を計算
        const queryParams = {
            TableName: process.env.METADATA_TABLE,
            KeyConditionExpression: 'userId = :userId',
            ExpressionAttributeValues: {
                ':userId': auth.userId
            }
        };

        const response = await dynamoClient.send(new QueryCommand(queryParams));
        const archives = response.Items || [];

        let totalSizeBytes = 0;
        let fileCount = 0;

        archives.forEach(archive => {
            if (archive.fileSize) {
                totalSizeBytes += archive.fileSize;
                fileCount++;
            }
        });

        const totalSizeGB = totalSizeBytes / (1024 * 1024 * 1024); // バイトからGBに変換

        // 現在の月の使用量を更新
        const currentMonth = new Date().toISOString().slice(0, 7);

        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.USAGE_TABLE,
            Key: {
                userId: auth.userId,
                periodMonth: currentMonth
            },
            UpdateExpression: 'SET storageGB = :storage, totalFiles = :files, lastStorageCalculation = :timestamp',
            ExpressionAttributeValues: {
                ':storage': Math.round(totalSizeGB * 1000) / 1000, // 小数点以下3桁
                ':files': fileCount,
                ':timestamp': new Date().toISOString()
            }
        }));

        // 使用量イベントを記録
        await recordUsageEvent(auth.userId, EVENT_TYPES.STORAGE_CALCULATION, {
            storageGB: totalSizeGB,
            fileCount: fileCount,
            totalSizeBytes: totalSizeBytes
        });

        return createSuccessResponse({
            storageGB: Math.round(totalSizeGB * 1000) / 1000,
            totalFiles: fileCount,
            totalSizeBytes: totalSizeBytes,
            calculatedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('Calculate storage usage error:', error);
        return createErrorResponse(500, error.message);
    }
};

// 使用量イベント記録（他のLambda関数から呼び出される）
const recordUsageEvent = async (userId, eventType, eventData = {}) => {
    try {
        const timestamp = new Date().toISOString();
        const ttl = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60); // 90日後に削除

        const eventItem = {
            userId: userId,
            timestamp: timestamp,
            eventType: eventType,
            eventData: eventData,
            ttl: ttl
        };

        await dynamoClient.send(new PutCommand({
            TableName: process.env.USAGE_EVENTS_TABLE,
            Item: eventItem
        }));

        // 月次使用量を更新
        await updateMonthlyUsage(userId, eventType, eventData);

    } catch (error) {
        console.error('Record usage event error:', error);
        throw error;
    }
};

// 月次使用量更新
const updateMonthlyUsage = async (userId, eventType, eventData) => {
    try {
        const currentMonth = new Date().toISOString().slice(0, 7);

        let updateExpression = 'SET lastUpdated = :timestamp';
        let expressionAttributeValues = {
            ':timestamp': new Date().toISOString()
        };

        switch (eventType) {
            case EVENT_TYPES.UPLOAD:
                updateExpression += ', uploadCount = if_not_exists(uploadCount, :zero) + :one';
                updateExpression += ', uploadGB = if_not_exists(uploadGB, :zeroGB) + :sizeGB';
                expressionAttributeValues[':zero'] = 0;
                expressionAttributeValues[':one'] = 1;
                expressionAttributeValues[':zeroGB'] = 0;
                expressionAttributeValues[':sizeGB'] = eventData.fileSizeGB || 0;
                break;
            case EVENT_TYPES.RESTORE:
                updateExpression += ', restoreCount = if_not_exists(restoreCount, :zero) + :one';
                updateExpression += ', restoreGB = if_not_exists(restoreGB, :zeroGB) + :sizeGB';
                expressionAttributeValues[':zero'] = 0;
                expressionAttributeValues[':one'] = 1;
                expressionAttributeValues[':zeroGB'] = 0;
                expressionAttributeValues[':sizeGB'] = eventData.fileSizeGB || 0;
                break;
            case EVENT_TYPES.DELETE:
                updateExpression += ', deleteCount = if_not_exists(deleteCount, :zero) + :one';
                expressionAttributeValues[':zero'] = 0;
                expressionAttributeValues[':one'] = 1;
                break;
            case EVENT_TYPES.THUMBNAIL_VIEW:
                updateExpression += ', thumbnailViews = if_not_exists(thumbnailViews, :zero) + :one';
                expressionAttributeValues[':zero'] = 0;
                expressionAttributeValues[':one'] = 1;
                break;
            case EVENT_TYPES.API_REQUEST:
                updateExpression += ', apiRequestCount = if_not_exists(apiRequestCount, :zero) + :one';
                expressionAttributeValues[':zero'] = 0;
                expressionAttributeValues[':one'] = 1;
                break;
        }

        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.USAGE_TABLE,
            Key: {
                userId: userId,
                periodMonth: currentMonth
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues
        }));

    } catch (error) {
        console.error('Update monthly usage error:', error);
        throw error;
    }
};

// エクスポート（他のLambda関数から使用）
module.exports.recordUsageEvent = recordUsageEvent;
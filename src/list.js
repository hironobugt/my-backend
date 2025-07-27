const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

const awsConfig = getAWSConfig();
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

exports.handler = async (event) => {
    try {
        // 認証チェック
        const auth = await requireAuth(event);
        if (!auth.isValid) {
            return createErrorResponse(401, auth.error || 'Unauthorized');
        }

        const { limit = 50, lastEvaluatedKey, sortBy = 'uploadTimestamp', sortOrder = 'desc' } = event.queryStringParameters || {};

        // ユーザーのアーカイブ一覧を取得
        const queryParams = {
            TableName: process.env.METADATA_TABLE,
            KeyConditionExpression: 'userId = :userId',
            ExpressionAttributeValues: {
                ':userId': auth.userId
            },
            Limit: parseInt(limit),
            ScanIndexForward: sortOrder === 'asc' // false = desc, true = asc
        };

        // ページネーション
        if (lastEvaluatedKey) {
            try {
                queryParams.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastEvaluatedKey));
            } catch (e) {
                return createErrorResponse(400, 'Invalid lastEvaluatedKey format');
            }
        }

        const response = await dynamoClient.send(new QueryCommand(queryParams));

        const archives = response.Items?.map(item => ({
            archiveId: item.archiveId,
            fileName: item.fileName,
            fileSize: item.fileSize,
            uploadTimestamp: item.uploadTimestamp,
            status: item.status,
            storageClass: item.storageClass,
            metadata: item.metadata || {},
            s3Key: item.s3Key,
            fileType: item.fileType || 'other',
            hasThumbnail: item.hasThumbnail || false,
            thumbnailKey: item.thumbnailKey || null
        })) || [];

        // ソート処理（DynamoDBのソートキーがarchiveIdなので、他の項目でソートする場合はアプリケーション側で処理）
        if (sortBy !== 'archiveId') {
            archives.sort((a, b) => {
                const aVal = a[sortBy];
                const bVal = b[sortBy];

                if (sortOrder === 'desc') {
                    return bVal > aVal ? 1 : bVal < aVal ? -1 : 0;
                } else {
                    return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
                }
            });
        }

        // 統計情報を計算
        const totalSize = archives.reduce((sum, archive) => sum + (archive.fileSize || 0), 0);
        const statusCounts = archives.reduce((counts, archive) => {
            counts[archive.status] = (counts[archive.status] || 0) + 1;
            return counts;
        }, {});

        const result = {
            archives,
            count: archives.length,
            totalSize,
            statusCounts,
            pagination: {
                hasMore: !!response.LastEvaluatedKey,
                lastEvaluatedKey: response.LastEvaluatedKey ?
                    encodeURIComponent(JSON.stringify(response.LastEvaluatedKey)) : null
            },
            user: {
                userId: auth.userId,
                username: auth.username,
                email: auth.email
            }
        };

        return createSuccessResponse(result);

    } catch (error) {
        console.error('List error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};
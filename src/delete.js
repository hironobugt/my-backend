const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

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
        
        // S3からオブジェクトを削除
        const deleteS3Params = {
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: key
        };
        
        await s3Client.send(new DeleteObjectCommand(deleteS3Params));

        // DynamoDBからメタデータを削除
        const deleteDynamoParams = {
            TableName: process.env.METADATA_TABLE,
            Key: {
                userId: auth.userId,
                archiveId: archiveId
            }
        };
        
        await dynamoClient.send(new DeleteCommand(deleteDynamoParams));

        return createSuccessResponse({
            archiveId,
            fileName: archiveMetadata.fileName,
            message: 'Archive deleted successfully',
            deletedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('Delete archive error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const sharp = require('sharp');
const { requireAuth, createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

const awsConfig = getAWSConfig();
const s3Client = new S3Client(awsConfig);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

// サポートされる画像形式
const SUPPORTED_IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'bmp'];
const SUPPORTED_VIDEO_TYPES = ['mp4', 'avi', 'mov', 'mkv', 'webm'];

// ファイル拡張子を取得
const getFileExtension = (fileName) => {
    return fileName.split('.').pop().toLowerCase();
};

// ファイルタイプを判定
const getFileType = (fileName) => {
    const ext = getFileExtension(fileName);
    
    if (SUPPORTED_IMAGE_TYPES.includes(ext)) {
        return 'image';
    } else if (SUPPORTED_VIDEO_TYPES.includes(ext)) {
        return 'video';
    } else {
        return 'other';
    }
};

// 画像サムネイル生成
const generateImageThumbnail = async (buffer) => {
    try {
        const thumbnail = await sharp(buffer)
            .resize(200, 200, {
                fit: 'cover',
                position: 'center'
            })
            .jpeg({ quality: 70 })
            .toBuffer();
        
        return {
            buffer: thumbnail,
            contentType: 'image/jpeg'
        };
    } catch (error) {
        console.error('Image thumbnail generation error:', error);
        return null;
    }
};

// 動画サムネイル生成（プレースホルダー）
const generateVideoThumbnail = async (buffer) => {
    try {
        const placeholder = await sharp({
            create: {
                width: 200,
                height: 200,
                channels: 3,
                background: { r: 100, g: 100, b: 100 }
            }
        })
        .png()
        .composite([{
            input: Buffer.from(`
                <svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
                    <rect width="200" height="200" fill="#666"/>
                    <polygon points="75,60 75,140 140,100" fill="white"/>
                    <text x="100" y="170" text-anchor="middle" fill="white" font-size="12">VIDEO</text>
                </svg>
            `),
            top: 0,
            left: 0
        }])
        .jpeg({ quality: 70 })
        .toBuffer();
        
        return {
            buffer: placeholder,
            contentType: 'image/jpeg'
        };
    } catch (error) {
        console.error('Video thumbnail generation error:', error);
        return null;
    }
};

// サムネイル生成メイン関数
const generateThumbnail = async (fileName, fileBuffer) => {
    const fileType = getFileType(fileName);
    
    switch (fileType) {
        case 'image':
            return await generateImageThumbnail(fileBuffer);
        case 'video':
            return await generateVideoThumbnail(fileBuffer);
        default:
            return null;
    }
};

// サムネイルをS3に保存（CloudFront用の設定付き）
const saveThumbnailToS3 = async (userId, archiveId, thumbnailData) => {
    try {
        const thumbnailKey = `thumbnails/${userId}/${archiveId}/thumbnail.jpg`;
        
        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: thumbnailKey,
            Body: thumbnailData.buffer,
            ContentType: thumbnailData.contentType,
            CacheControl: 'public, max-age=31536000', // 1年間キャッシュ
            Metadata: {
                'user-id': userId,
                'archive-id': archiveId,
                'thumbnail': 'true'
            }
        }));
        
        return thumbnailKey;
    } catch (error) {
        console.error('Save thumbnail to S3 error:', error);
        return null;
    }
};

// DynamoDBにサムネイル情報を更新
const updateThumbnailMetadata = async (userId, archiveId, thumbnailKey, fileType) => {
    try {
        await dynamoClient.send(new UpdateCommand({
            TableName: process.env.METADATA_TABLE,
            Key: {
                userId: userId,
                archiveId: archiveId
            },
            UpdateExpression: 'SET thumbnailKey = :thumbnailKey, fileType = :fileType, hasThumbnail = :hasThumbnail',
            ExpressionAttributeValues: {
                ':thumbnailKey': thumbnailKey,
                ':fileType': fileType,
                ':hasThumbnail': true
            }
        }));
        
        return true;
    } catch (error) {
        console.error('Update thumbnail metadata error:', error);
        return false;
    }
};

// CloudFront URL生成（ローカル開発対応）
const generateCloudFrontUrl = (thumbnailKey) => {
    const cloudFrontDomain = process.env.CLOUDFRONT_DOMAIN;
    
    // ローカル開発環境の場合
    if (process.env.NODE_ENV === 'development' || process.env.USE_MOTO === 'true') {
        const localServerUrl = process.env.LOCAL_SERVER_URL || 'http://localhost:3000';
        return `${localServerUrl}/local-thumbnail/${encodeURIComponent(thumbnailKey)}`;
    }
    
    if (!cloudFrontDomain) {
        console.warn('CLOUDFRONT_DOMAIN not configured, falling back to S3 direct access');
        return null;
    }
    
    return `https://${cloudFrontDomain}/${thumbnailKey}`;
};

// サムネイル生成処理（アップロード時に呼び出される）
exports.generateAndSaveThumbnail = async (userId, archiveId, fileName, fileBuffer) => {
    try {
        const fileType = getFileType(fileName);
        
        // サムネイル生成
        const thumbnailData = await generateThumbnail(fileName, fileBuffer);
        
        if (!thumbnailData) {
            // サムネイル生成できない場合はファイルタイプのみ更新
            await updateThumbnailMetadata(userId, archiveId, null, fileType);
            return {
                success: false,
                fileType: fileType,
                message: 'Thumbnail generation not supported for this file type'
            };
        }
        
        // S3に保存
        const thumbnailKey = await saveThumbnailToS3(userId, archiveId, thumbnailData);
        
        if (!thumbnailKey) {
            return {
                success: false,
                fileType: fileType,
                message: 'Failed to save thumbnail to S3'
            };
        }
        
        // メタデータ更新
        const metadataUpdated = await updateThumbnailMetadata(userId, archiveId, thumbnailKey, fileType);
        
        // CloudFront URLを生成
        const cloudFrontUrl = generateCloudFrontUrl(thumbnailKey);
        
        return {
            success: metadataUpdated,
            fileType: fileType,
            thumbnailKey: thumbnailKey,
            cloudFrontUrl: cloudFrontUrl,
            message: metadataUpdated ? 'Thumbnail generated successfully' : 'Failed to update metadata'
        };
        
    } catch (error) {
        console.error('Generate and save thumbnail error:', error);
        return {
            success: false,
            message: error.message
        };
    }
};

// サムネイルURL取得エンドポイント（CloudFront URL返却）
exports.handler = async (event) => {
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

        // メタデータを取得してサムネイルキーを確認
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

        const { thumbnailKey, fileType, hasThumbnail } = metadataResponse.Item;

        if (!hasThumbnail || !thumbnailKey) {
            return createErrorResponse(404, 'Thumbnail not available for this file');
        }

        // CloudFront URLを生成
        const cloudFrontUrl = generateCloudFrontUrl(thumbnailKey);
        
        if (!cloudFrontUrl) {
            return createErrorResponse(500, 'CloudFront not configured');
        }

        // サムネイル配信の使用量を記録
        const { recordUsageEvent } = require('./usage');
        await recordUsageEvent(auth.userId, 'thumbnail_view', {
            archiveId: archiveId,
            thumbnailKey: thumbnailKey,
            fileType: fileType
        });

        return createSuccessResponse({
            thumbnailUrl: cloudFrontUrl,
            fileType: fileType,
            cacheInfo: {
                maxAge: 31536000, // 1年
                provider: 'CloudFront'
            }
        });

    } catch (error) {
        console.error('Get thumbnail URL error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};

// 複数のサムネイルURL一括取得
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

        const thumbnailUrls = {};
        
        // 並列でメタデータを取得
        await Promise.all(archiveIds.map(async (archiveId) => {
            try {
                const metadataResponse = await dynamoClient.send(new GetCommand({
                    TableName: process.env.METADATA_TABLE,
                    Key: {
                        userId: auth.userId,
                        archiveId: archiveId
                    }
                }));

                if (!metadataResponse.Item || !metadataResponse.Item.hasThumbnail) {
                    thumbnailUrls[archiveId] = null;
                    return;
                }

                const cloudFrontUrl = generateCloudFrontUrl(metadataResponse.Item.thumbnailKey);
                thumbnailUrls[archiveId] = cloudFrontUrl;

            } catch (error) {
                console.error(`Failed to get thumbnail URL for ${archiveId}:`, error);
                thumbnailUrls[archiveId] = null;
            }
        }));

        return createSuccessResponse({ thumbnailUrls });

    } catch (error) {
        console.error('Batch thumbnail URL error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};
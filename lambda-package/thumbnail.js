const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
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

// 動画サムネイル生成（簡易版 - 実際の実装ではffmpegが必要）
const generateVideoThumbnail = async (buffer) => {
    try {
        // 実際の実装では ffmpeg を使用して動画の最初のフレームを抽出
        // ここでは簡易的にプレースホルダー画像を生成
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
        .toBuffer();
        
        return {
            buffer: placeholder,
            contentType: 'image/png'
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

// サムネイルをS3に保存
const saveThumbnailToS3 = async (userId, archiveId, thumbnailData) => {
    try {
        const thumbnailKey = `thumbnails/${userId}/${archiveId}/thumbnail.jpg`;
        
        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.ARCHIVE_BUCKET,
            Key: thumbnailKey,
            Body: thumbnailData.buffer,
            ContentType: thumbnailData.contentType,
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
        
        return {
            success: metadataUpdated,
            fileType: fileType,
            thumbnailKey: thumbnailKey,
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

// サムネイル取得エンドポイント
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

        return {
            statusCode: 200,
            headers: {
                'Content-Type': thumbnailResponse.ContentType || 'image/jpeg',
                'Content-Length': thumbnailBuffer.length,
                'Cache-Control': 'public, max-age=86400', // 24時間キャッシュ
                'Access-Control-Allow-Origin': '*'
            },
            body: thumbnailBuffer.toString('base64'),
            isBase64Encoded: true
        };

    } catch (error) {
        console.error('Get thumbnail error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};
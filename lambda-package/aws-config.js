// AWS SDK設定（moto対応）
const getAWSConfig = () => {
    const config = {
        region: process.env.AWS_REGION || 'us-east-1'
    };

    // moto使用時の設定
    if (process.env.USE_MOTO === 'true') {
        config.endpoint = process.env.AWS_ENDPOINT_URL || 'http://localhost:5000';
        config.credentials = {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'testing',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'testing'
        };
        config.forcePathStyle = true; // S3用（重要：motoではバケット名をパスに含める）
        config.s3ForcePathStyle = true; // 古いバージョン対応
    }

    return config;
};

module.exports = { getAWSConfig };
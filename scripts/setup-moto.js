const { 
    S3Client, 
    CreateBucketCommand,
    PutBucketLifecycleConfigurationCommand 
} = require('@aws-sdk/client-s3');
const { 
    DynamoDBClient, 
    CreateTableCommand 
} = require('@aws-sdk/client-dynamodb');
const { 
    CognitoIdentityProviderClient,
    CreateUserPoolCommand,
    CreateUserPoolClientCommand
} = require('@aws-sdk/client-cognito-identity-provider');

// moto用のAWS設定
const awsConfig = {
    region: 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL || 'http://localhost:5000',
    credentials: {
        accessKeyId: 'testing',
        secretAccessKey: 'testing'
    },
    forcePathStyle: true, // S3用（重要：motoではバケット名をパスに含める）
    s3ForcePathStyle: true // 古いバージョン対応
};

async function setupMotoResources() {
    console.log('🚀 Setting up moto resources...');

    try {
        // S3バケット作成
        await setupS3();
        
        // DynamoDBテーブル作成
        await setupDynamoDB();
        
        // Cognitoユーザープール作成
        await setupCognito();
        
        console.log('✅ All moto resources created successfully!');
        
    } catch (error) {
        console.error('❌ Error setting up moto resources:', error);
        process.exit(1);
    }
}

async function setupS3() {
    console.log('📦 Creating S3 bucket...');
    
    const s3Client = new S3Client(awsConfig);
    
    // バケット作成（us-east-1では CreateBucketConfiguration は不要）
    await s3Client.send(new CreateBucketCommand({
        Bucket: 'glacier-archive-dev-test'
    }));
    
    // 注意: motoではライフサイクル設定はサポートされていないため、開発環境では省略
    
    console.log('✅ S3 bucket created');
}

async function setupDynamoDB() {
    console.log('🗄️  Creating DynamoDB tables...');
    
    const dynamoClient = new DynamoDBClient(awsConfig);
    
    // アーカイブメタデータテーブル
    await dynamoClient.send(new CreateTableCommand({
        TableName: 'glacier-archive-metadata-dev',
        KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'archiveId', KeyType: 'RANGE' }
        ],
        AttributeDefinitions: [
            { AttributeName: 'userId', AttributeType: 'S' },
            { AttributeName: 'archiveId', AttributeType: 'S' }
        ],
        GlobalSecondaryIndexes: [
            {
                IndexName: 'ArchiveIdIndex',
                KeySchema: [
                    { AttributeName: 'archiveId', KeyType: 'HASH' }
                ],
                Projection: { ProjectionType: 'ALL' },
                ProvisionedThroughput: {
                    ReadCapacityUnits: 5,
                    WriteCapacityUnits: 5
                }
            }
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5
        }
    }));
    
    // 顧客テーブル
    await dynamoClient.send(new CreateTableCommand({
        TableName: 'glacier-customers-dev',
        KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' }
        ],
        AttributeDefinitions: [
            { AttributeName: 'userId', AttributeType: 'S' },
            { AttributeName: 'stripeCustomerId', AttributeType: 'S' }
        ],
        GlobalSecondaryIndexes: [
            {
                IndexName: 'StripeCustomerIndex',
                KeySchema: [
                    { AttributeName: 'stripeCustomerId', KeyType: 'HASH' }
                ],
                Projection: { ProjectionType: 'ALL' },
                ProvisionedThroughput: {
                    ReadCapacityUnits: 5,
                    WriteCapacityUnits: 5
                }
            }
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5
        }
    }));
    
    // 使用量テーブル
    await dynamoClient.send(new CreateTableCommand({
        TableName: 'glacier-usage-dev',
        KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'periodMonth', KeyType: 'RANGE' }
        ],
        AttributeDefinitions: [
            { AttributeName: 'userId', AttributeType: 'S' },
            { AttributeName: 'periodMonth', AttributeType: 'S' }
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5
        }
    }));
    
    // 使用量イベントテーブル
    await dynamoClient.send(new CreateTableCommand({
        TableName: 'glacier-usage-events-dev',
        KeySchema: [
            { AttributeName: 'userId', KeyType: 'HASH' },
            { AttributeName: 'timestamp', KeyType: 'RANGE' }
        ],
        AttributeDefinitions: [
            { AttributeName: 'userId', AttributeType: 'S' },
            { AttributeName: 'timestamp', AttributeType: 'S' }
        ],
        ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5
        }
    }));
    
    console.log('✅ DynamoDB tables created');
}

async function setupCognito() {
    console.log('🔐 Creating Cognito User Pool...');
    
    const cognitoClient = new CognitoIdentityProviderClient(awsConfig);
    
    // ユーザープール作成
    const userPoolResponse = await cognitoClient.send(new CreateUserPoolCommand({
        PoolName: 'glacier-archive-users-dev',
        Policies: {
            PasswordPolicy: {
                MinimumLength: 8,
                RequireUppercase: true,
                RequireLowercase: true,
                RequireNumbers: true,
                RequireSymbols: false
            }
        },
        AutoVerifiedAttributes: ['email'],
        UsernameAttributes: ['email'],
        Schema: [
            {
                Name: 'email',
                AttributeDataType: 'String',
                Required: true,
                Mutable: true
            }
        ]
    }));
    
    const userPoolId = userPoolResponse.UserPool.Id;
    
    // ユーザープールクライアント作成
    const clientResponse = await cognitoClient.send(new CreateUserPoolClientCommand({
        UserPoolId: userPoolId,
        ClientName: 'glacier-archive-client-dev',
        GenerateSecret: false,
        ExplicitAuthFlows: [
            'ALLOW_USER_PASSWORD_AUTH',
            'ALLOW_USER_SRP_AUTH',
            'ALLOW_REFRESH_TOKEN_AUTH'
        ]
    }));
    
    console.log('✅ Cognito User Pool created');
    console.log(`   User Pool ID: ${userPoolId}`);
    console.log(`   Client ID: ${clientResponse.UserPoolClient.ClientId}`);
    
    // 環境変数ファイルを更新
    const fs = require('fs');
    const envContent = `# AWS Configuration (moto)
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=http://localhost:5000
AWS_ACCESS_KEY_ID=testing
AWS_SECRET_ACCESS_KEY=testing

# DynamoDB Tables
METADATA_TABLE=glacier-archive-metadata-dev
CUSTOMER_TABLE=glacier-customers-dev
USAGE_TABLE=glacier-usage-dev
USAGE_EVENTS_TABLE=glacier-usage-events-dev

# S3 Bucket
ARCHIVE_BUCKET=glacier-archive-dev-test

# Cognito
USER_POOL_ID=${userPoolId}
USER_POOL_CLIENT_ID=${clientResponse.UserPoolClient.ClientId}

# Stripe Configuration (テスト用)
STRIPE_SECRET_KEY=sk_test_placeholder
STRIPE_WEBHOOK_SECRET=whsec_placeholder

# Server Configuration
PORT=3000
NODE_ENV=development
USE_MOTO=true
`;
    
    fs.writeFileSync('.env.moto', envContent);
    console.log('✅ Environment file (.env.moto) created');
}

if (require.main === module) {
    setupMotoResources();
}

module.exports = { setupMotoResources };
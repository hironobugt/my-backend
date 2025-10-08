// Jest setup file
// テスト環境の初期化やモックの設定を行う

// AWS SDKのモック設定
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/client-glacier');
jest.mock('@aws-sdk/client-cognito-identity-provider');

// 環境変数のモック設定
process.env.NODE_ENV = 'test';
process.env.AWS_REGION = 'ap-northeast-1';
process.env.ARCHIVE_BUCKET = 'test-bucket';
process.env.METADATA_TABLE = 'test-metadata-table';
process.env.CUSTOMER_TABLE = 'test-customer-table';
process.env.USAGE_TABLE = 'test-usage-table';
process.env.USAGE_EVENTS_TABLE = 'test-usage-events-table';
process.env.USER_POOL_ID = 'test-user-pool-id';
process.env.USER_POOL_CLIENT_ID = 'test-client-id';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock_key';

// タイムアウトの設定
jest.setTimeout(30000);
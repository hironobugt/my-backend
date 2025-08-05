import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export class GlacierArchiveApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 環境変数
    const environment = this.node.tryGetContext('environment') || 'dev';

    // Cognito User Pool（認証用）
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `glacier-archive-users-${environment}`,
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
        username: true
      },
      autoVerify: {
        email: true
      },
      // メール設定（SES使用の場合）
      email: environment === 'prod' 
        ? cognito.UserPoolEmail.withSES({
            fromEmail: 'noreply@yourdomain.com',
            fromName: 'Glaceon Archive',
            sesRegion: 'us-east-1'
          })
        : cognito.UserPoolEmail.withCognito(), // 開発環境はCognito内蔵メール
      standardAttributes: {
        email: {
          required: true,
          mutable: true
        },
        givenName: {
          required: false,
          mutable: true
        },
        familyName: {
          required: false,
          mutable: true
        }
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Cognito User Pool Client（モバイルアプリ用）
    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: `glacier-archive-client-${environment}`,
      generateSecret: false, // モバイルアプリでは秘密鍵を使わない
      authFlows: {
        userPassword: true,
        userSrp: true,
        custom: true,
        adminUserPassword: true
      },
      // OAuth設定を削除（モバイルアプリでは不要）
      // oAuth設定なし
      refreshTokenValidity: cdk.Duration.days(30),
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1)
    });

    // DynamoDB テーブル（アーカイブメタデータ用）
    const archiveMetadataTable = new dynamodb.Table(this, 'ArchiveMetadataTable', {
      tableName: `glacier-archive-metadata-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'archiveId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true
    });

    // GSI for archiveId lookup
    archiveMetadataTable.addGlobalSecondaryIndex({
      indexName: 'ArchiveIdIndex',
      partitionKey: {
        name: 'archiveId',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // DynamoDB テーブル（顧客・サブスクリプション管理用）
    const customerTable = new dynamodb.Table(this, 'CustomerTable', {
      tableName: `glacier-customers-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true
    });

    // GSI for Stripe customer ID lookup
    customerTable.addGlobalSecondaryIndex({
      indexName: 'StripeCustomerIndex',
      partitionKey: {
        name: 'stripeCustomerId',
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // DynamoDB テーブル（使用量トラッキング用）
    const usageTable = new dynamodb.Table(this, 'UsageTable', {
      tableName: `glacier-usage-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'periodMonth', // YYYY-MM format
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true
    });

    // DynamoDB テーブル（使用量イベント記録用）
    const usageEventsTable = new dynamodb.Table(this, 'UsageEventsTable', {
      tableName: `glacier-usage-events-${environment}`,
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl' // 90日後に自動削除
    });

    // S3バケット（Deep Archive用）
    const archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      bucketName: `glacier-archive-${environment}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: 'DeepArchiveRule',
          enabled: true,
          prefix: 'archives/', // アーカイブファイルのみ対象
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(1)
            }
          ]
        },
        {
          id: 'ThumbnailRule',
          enabled: true,
          prefix: 'thumbnails/', // サムネイルは標準ストレージのまま
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30) // 30日後にIA（低頻度アクセス）
            }
          ]
        }
      ]
    });

    // CloudFront Distribution（サムネイル配信用）
    const thumbnailDistribution = new cloudfront.Distribution(this, 'ThumbnailDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(archiveBucket, {
          originPath: '/thumbnails'
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // 最も安価なエッジロケーション
      comment: `Thumbnail distribution for ${environment}`,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
    });

    // Lambda関数用の共通設定
    const lambdaEnvironment = {
      ARCHIVE_BUCKET: archiveBucket.bucketName,
      METADATA_TABLE: archiveMetadataTable.tableName,
      CUSTOMER_TABLE: customerTable.tableName,
      USAGE_TABLE: usageTable.tableName,
      USAGE_EVENTS_TABLE: usageEventsTable.tableName,
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      CLOUDFRONT_DOMAIN: thumbnailDistribution.distributionDomainName,
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder',
      NODE_OPTIONS: '--enable-source-maps'
    };

    const lambdaProps = {
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnvironment,
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['jsonwebtoken', 'jwks-client', 'uuid', 'sharp', 'stripe'],
        minify: true,
        sourceMap: true
      }
    };

    // Lambda関数群
    const uploadFunction = new lambda.Function(this, 'UploadFunction', {
      ...lambdaProps,
      functionName: `glacier-upload-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'upload.handler',
      description: 'Upload files to Glacier Deep Archive'
    });

    const listFunction = new lambda.Function(this, 'ListFunction', {
      ...lambdaProps,
      functionName: `glacier-list-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'list.handler',
      description: 'List archived files'
    });

    const getFunction = new lambda.Function(this, 'GetFunction', {
      ...lambdaProps,
      functionName: `glacier-get-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'get.handler',
      timeout: cdk.Duration.seconds(60), // 復元処理のため長めに設定
      description: 'Get/restore archived files'
    });

    const deleteFunction = new lambda.Function(this, 'DeleteFunction', {
      ...lambdaProps,
      functionName: `glacier-delete-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'delete.handler',
      description: 'Delete archived files'
    });

    // 新規登録関数
    const registerFunction = new lambda.Function(this, 'RegisterFunction', {
      ...lambdaProps,
      functionName: `glacier-register-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'register.handler',
      description: 'User registration and email verification'
    });

    // 決済管理関数
    const billingFunction = new lambda.Function(this, 'BillingFunction', {
      ...lambdaProps,
      functionName: `glacier-billing-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'billing.handler',
      description: 'Stripe billing and subscription management'
    });

    // 使用量トラッキング関数
    const usageFunction = new lambda.Function(this, 'UsageFunction', {
      ...lambdaProps,
      functionName: `glacier-usage-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'usage.handler',
      description: 'Usage tracking and reporting'
    });

    // Stripe Webhook処理関数
    const webhookFunction = new lambda.Function(this, 'WebhookFunction', {
      ...lambdaProps,
      functionName: `glacier-webhook-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'webhook.handler',
      description: 'Stripe webhook processing'
    });

    // サムネイル処理関数
    const thumbnailFunction = new lambda.Function(this, 'ThumbnailFunction', {
      ...lambdaProps,
      functionName: `glacier-thumbnail-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'thumbnail-cloudfront.handler',
      description: 'Get thumbnail URLs (CloudFront)'
      // Sharp layerを削除 - npm packageのsharpを使用
    });

    // サムネイル一括取得関数
    const thumbnailBatchFunction = new lambda.Function(this, 'ThumbnailBatchFunction', {
      ...lambdaProps,
      functionName: `glacier-thumbnail-batch-${environment}`,
      code: lambda.Code.fromAsset('src'),
      handler: 'thumbnail-cloudfront.handlerBatch',
      description: 'Get multiple thumbnail URLs (CloudFront)'
    });

    // S3権限の付与
    archiveBucket.grantWrite(uploadFunction);
    archiveBucket.grantRead(listFunction);
    archiveBucket.grantReadWrite(getFunction);
    archiveBucket.grantReadWrite(deleteFunction);
    
    // サムネイル関連のS3権限
    archiveBucket.grantReadWrite(uploadFunction); // サムネイル生成・保存用
    archiveBucket.grantRead(thumbnailFunction);
    archiveBucket.grantRead(thumbnailBatchFunction);

    // DynamoDB権限の付与
    archiveMetadataTable.grantReadWriteData(uploadFunction);
    archiveMetadataTable.grantReadData(listFunction);
    archiveMetadataTable.grantReadData(getFunction);
    archiveMetadataTable.grantReadWriteData(deleteFunction);
    
    // サムネイル関連のDynamoDB権限
    archiveMetadataTable.grantReadData(thumbnailFunction);
    archiveMetadataTable.grantReadData(thumbnailBatchFunction);

    // 決済・使用量関連のDynamoDB権限
    customerTable.grantReadWriteData(registerFunction);
    customerTable.grantReadWriteData(billingFunction);
    customerTable.grantReadData(usageFunction);
    customerTable.grantReadWriteData(webhookFunction);

    usageTable.grantReadWriteData(uploadFunction);
    usageTable.grantReadWriteData(getFunction);
    usageTable.grantReadWriteData(usageFunction);
    usageTable.grantReadData(billingFunction);

    usageEventsTable.grantWriteData(uploadFunction);
    usageEventsTable.grantWriteData(getFunction);
    usageEventsTable.grantWriteData(deleteFunction);
    usageEventsTable.grantReadWriteData(usageFunction);

    // Glacier復元権限の追加
    getFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:RestoreObject',
        's3:GetObjectAttributes'
      ],
      resources: [`${archiveBucket.bucketArn}/*`]
    }));

    // Cognito Authorizer
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: `glacier-archive-authorizer-${environment}`,
      identitySource: 'method.request.header.Authorization'
    });

    // API Gateway
    const api = new apigateway.RestApi(this, 'GlacierArchiveApi', {
      restApiName: `glacier-archive-api-${environment}`,
      description: 'S3 Glacier Deep Archive API for mobile applications',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token'
        ]
      },
      deployOptions: {
        stageName: environment,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200
      }
    });

    // API リソースとメソッドの定義
    const archiveResource = api.root.addResource('archive');

    // POST /archive/upload (認証必須)
    archiveResource
      .addResource('upload')
      .addMethod('POST', new apigateway.LambdaIntegration(uploadFunction), {
        authorizer: cognitoAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '400' },
          { statusCode: '401' },
          { statusCode: '500' }
        ]
      });

    // GET /archive/list (認証必須)
    archiveResource
      .addResource('list')
      .addMethod('GET', new apigateway.LambdaIntegration(listFunction), {
        authorizer: cognitoAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        requestParameters: {
          'method.request.querystring.limit': false,
          'method.request.querystring.continuationToken': false
        },
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '401' },
          { statusCode: '500' }
        ]
      });

    // GET /archive/{archiveId} (認証必須)
    const archiveIdResource = archiveResource.addResource('{archiveId}');
    archiveIdResource.addMethod('GET', new apigateway.LambdaIntegration(getFunction), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      requestParameters: {
        'method.request.path.archiveId': true
      },
      methodResponses: [
        { statusCode: '200' },
        { statusCode: '202' },
        { statusCode: '401' },
        { statusCode: '404' },
        { statusCode: '500' }
      ]
    });

    // DELETE /archive/{archiveId} (認証必須)
    archiveIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(deleteFunction), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      requestParameters: {
        'method.request.path.archiveId': true
      },
      methodResponses: [
        { statusCode: '200' },
        { statusCode: '401' },
        { statusCode: '404' },
        { statusCode: '500' }
      ]
    });

    // GET /archive/{archiveId}/thumbnail (認証必須)
    archiveIdResource
      .addResource('thumbnail')
      .addMethod('GET', new apigateway.LambdaIntegration(thumbnailFunction), {
        authorizer: cognitoAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        requestParameters: {
          'method.request.path.archiveId': true
        },
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '401' },
          { statusCode: '404' },
          { statusCode: '500' }
        ]
      });

    // POST /archive/thumbnails/batch (認証必須)
    archiveResource
      .addResource('thumbnails')
      .addResource('batch')
      .addMethod('POST', new apigateway.LambdaIntegration(thumbnailBatchFunction), {
        authorizer: cognitoAuthorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '400' },
          { statusCode: '401' },
          { statusCode: '500' }
        ]
      });

    // 認証関連のAPI エンドポイント
    const authResource = api.root.addResource('auth');
    
    // POST /auth (統一された認証エンドポイント - 認証不要)
    authResource.addMethod('POST', new apigateway.LambdaIntegration(registerFunction), {
      methodResponses: [
        { statusCode: '200' },
        { statusCode: '201' },
        { statusCode: '400' },
        { statusCode: '500' }
      ]
    });
    
    // POST /auth/register (認証不要) - 後方互換性のため残す
    authResource
      .addResource('register')
      .addMethod('POST', new apigateway.LambdaIntegration(registerFunction), {
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '201' },
          { statusCode: '400' },
          { statusCode: '500' }
        ]
      });

    // 決済関連のAPI エンドポイント
    const billingResource = api.root.addResource('billing');
    
    // POST /billing (認証必須)
    billingResource.addMethod('POST', new apigateway.LambdaIntegration(billingFunction), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      methodResponses: [
        { statusCode: '200' },
        { statusCode: '201' },
        { statusCode: '202' },
        { statusCode: '400' },
        { statusCode: '401' },
        { statusCode: '404' },
        { statusCode: '500' }
      ]
    });

    // 使用量関連のAPI エンドポイント
    const usageResource = api.root.addResource('usage');
    
    // POST /usage (認証必須)
    usageResource.addMethod('POST', new apigateway.LambdaIntegration(usageFunction), {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      methodResponses: [
        { statusCode: '200' },
        { statusCode: '401' },
        { statusCode: '500' }
      ]
    });

    // Stripe Webhook エンドポイント (認証不要)
    const webhookResource = api.root.addResource('webhook');
    webhookResource
      .addResource('stripe')
      .addMethod('POST', new apigateway.LambdaIntegration(webhookFunction), {
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '400' },
          { statusCode: '500' }
        ]
      });

    // CloudWatch Logs権限
    [uploadFunction, listFunction, getFunction, deleteFunction, registerFunction, billingFunction, usageFunction, webhookFunction, thumbnailFunction, thumbnailBatchFunction].forEach(fn => {
      fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents'
        ],
        resources: ['*']
      }));
    });

    // 出力
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
      exportName: `${this.stackName}-ApiUrl`
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: archiveBucket.bucketName,
      description: 'S3 Archive Bucket Name',
      exportName: `${this.stackName}-BucketName`
    });

    new cdk.CfnOutput(this, 'Region', {
      value: this.region,
      description: 'AWS Region',
      exportName: `${this.stackName}-Region`
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: `${this.stackName}-UserPoolId`
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: `${this.stackName}-UserPoolClientId`
    });

    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: thumbnailDistribution.distributionDomainName,
      description: 'CloudFront Distribution Domain for Thumbnails',
      exportName: `${this.stackName}-CloudFrontDomain`
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: thumbnailDistribution.distributionId,
      description: 'CloudFront Distribution ID',
      exportName: `${this.stackName}-CloudFrontDistributionId`
    });
  }
}
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
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
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // SESを使用してEメール送信
      email: cognito.UserPoolEmail.withSES({
        fromEmail: environment === 'prod' ? 'noreply@yourdomain.com' : 'frederic170617@gmail.com',
        fromName: 'Glacier Archive',
        replyTo: environment === 'prod' ? 'support@yourdomain.com' : 'frederic170617@gmail.com'
      })
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
      FROM_EMAIL: environment === 'prod' ? 'noreply@yourdomain.com' : 'noreply@glacierarchive.com',
      APP_URL: environment === 'prod' ? 'https://yourapp.com' : 'https://dev.yourapp.com',
      NODE_OPTIONS: '--enable-source-maps'
    };

    const lambdaProps = {
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(30),
      environment: lambdaEnvironment
    };

    // Lambda関数群
    const uploadFunction = new lambda.Function(this, 'UploadFunction', {
      ...lambdaProps,
      functionName: `glacier-upload-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'upload.handler',
      description: 'Upload files to Glacier Deep Archive'
    });

    const listFunction = new lambda.Function(this, 'ListFunction', {
      ...lambdaProps,
      functionName: `glacier-list-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'list.handler',
      description: 'List archived files'
    });

    const getFunction = new lambda.Function(this, 'GetFunction', {
      ...lambdaProps,
      functionName: `glacier-get-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'get.handler',
      timeout: cdk.Duration.seconds(60), // 復元処理のため長めに設定
      description: 'Get/restore archived files'
    });

    const deleteFunction = new lambda.Function(this, 'DeleteFunction', {
      ...lambdaProps,
      functionName: `glacier-delete-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'delete.handler',
      description: 'Delete archived files'
    });

    // 新規登録関数
    const registerFunction = new lambda.Function(this, 'RegisterFunction', {
      ...lambdaProps,
      functionName: `glacier-register-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'register.handler',
      description: 'User registration and email verification'
    });

    // 決済管理関数
    const billingFunction = new lambda.Function(this, 'BillingFunction', {
      ...lambdaProps,
      functionName: `glacier-billing-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'billing.handler',
      description: 'Stripe billing and subscription management'
    });

    // 使用量トラッキング関数
    const usageFunction = new lambda.Function(this, 'UsageFunction', {
      ...lambdaProps,
      functionName: `glacier-usage-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'usage.handler',
      description: 'Usage tracking and reporting'
    });

    // Stripe Webhook処理関数
    const webhookFunction = new lambda.Function(this, 'WebhookFunction', {
      ...lambdaProps,
      functionName: `glacier-webhook-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'stripe-webhook.handler',
      description: 'Stripe webhook processing for usage-based billing',
      environment: {
        ...lambdaEnvironment,
        STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder'
      }
    });

    // 復元クリーンアップ関数
    const restoreCleanupFunction = new lambda.Function(this, 'RestoreCleanupFunction', {
      ...lambdaProps,
      functionName: `glacier-restore-cleanup-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'restore-cleanup.handler',
      timeout: cdk.Duration.minutes(15), // 大量のファイル処理のため長めに設定
      description: 'Cleanup restored files and move back to Deep Archive'
    });

    // EventBridge Rule for scheduled cleanup (毎時実行)
    const cleanupRule = new cdk.aws_events.Rule(this, 'RestoreCleanupRule', {
      ruleName: `glacier-restore-cleanup-${environment}`,
      description: 'Trigger restore cleanup function every hour',
      schedule: cdk.aws_events.Schedule.rate(cdk.Duration.hours(1))
    });

    // Lambda関数をEventBridgeのターゲットに追加
    cleanupRule.addTarget(new cdk.aws_events_targets.LambdaFunction(restoreCleanupFunction));



    // サムネイル処理関数
    const thumbnailFunction = new lambda.Function(this, 'ThumbnailFunction', {
      ...lambdaProps,
      functionName: `glacier-thumbnail-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'thumbnail-cloudfront.handler',
      description: 'Get thumbnail URLs (CloudFront)'
      // Sharp layerを削除 - npm packageのsharpを使用
    });

    // サムネイル一括取得関数
    const thumbnailBatchFunction = new lambda.Function(this, 'ThumbnailBatchFunction', {
      ...lambdaProps,
      functionName: `glacier-thumbnail-batch-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
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
    archiveMetadataTable.grantReadWriteData(getFunction);
    archiveMetadataTable.grantReadWriteData(deleteFunction);

    // サムネイル関連のDynamoDB権限
    archiveMetadataTable.grantReadData(thumbnailFunction);
    archiveMetadataTable.grantReadData(thumbnailBatchFunction);

    // 決済・使用量関連のDynamoDB権限
    customerTable.grantReadWriteData(registerFunction);
    customerTable.grantReadWriteData(billingFunction);
    customerTable.grantReadData(usageFunction);
    customerTable.grantReadWriteData(webhookFunction);

    // webhook関数に使用量テーブルの読み取り権限を追加
    usageTable.grantReadData(webhookFunction);

    // usage関数にarchiveMetadataTableの読み取り権限を追加（ストレージ計算用）
    archiveMetadataTable.grantReadData(usageFunction);

    usageTable.grantReadWriteData(uploadFunction);
    usageTable.grantReadWriteData(getFunction);
    usageTable.grantReadWriteData(usageFunction);
    usageTable.grantReadData(billingFunction);
    usageTable.grantReadWriteData(thumbnailFunction);
    usageTable.grantReadWriteData(thumbnailBatchFunction);

    usageEventsTable.grantWriteData(uploadFunction);
    usageEventsTable.grantWriteData(getFunction);
    usageEventsTable.grantWriteData(deleteFunction);
    usageEventsTable.grantReadWriteData(thumbnailFunction);
    usageEventsTable.grantReadWriteData(thumbnailBatchFunction);
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

    // SES権限の追加（復元完了通知用）
    getFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ses:SendEmail',
        'ses:SendRawEmail'
      ],
      resources: ['*'] // SESは特定のリソースARNを持たない
    }));

    // テスト用通知関数（開発環境のみ）
    const testNotificationFunction = new lambda.Function(this, 'TestNotificationFunction', {
      ...lambdaProps,
      functionName: `glacier-test-notification-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'test-notification.handler',
      description: 'Test notification functionality'
    });

    // テスト関数にも必要な権限を付与
    customerTable.grantReadData(testNotificationFunction);
    testNotificationFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ses:SendEmail',
        'ses:SendRawEmail'
      ],
      resources: ['*']
    }));

    // 復元クリーンアップ関数の権限
    archiveMetadataTable.grantReadWriteData(restoreCleanupFunction);
    archiveBucket.grantReadWrite(restoreCleanupFunction);
    customerTable.grantReadData(restoreCleanupFunction); // 通知送信用
    
    restoreCleanupFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:CopyObject',
        's3:DeleteObject',
        's3:GetObjectAttributes',
        's3:PutObjectTagging'
      ],
      resources: [`${archiveBucket.bucketArn}/*`]
    }));

    // restore-cleanup関数にもSES権限を追加（通知送信用）
    restoreCleanupFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ses:SendEmail',
        'ses:SendRawEmail'
      ],
      resources: ['*']
    }));



    // Lambda Authorizer Function
    const authorizerFunction = new lambda.Function(this, 'AuthorizerFunction', {
      ...lambdaProps,
      functionName: `glacier-authorizer-${environment}`,
      code: lambda.Code.fromAsset('lambda-package'),
      handler: 'authorizer.handler',
      description: 'Custom Lambda Authorizer for JWT token validation',
      environment: {
        ...lambdaEnvironment,
        NODE_ENV: 'development' // 開発環境では簡単な認証を使用
      }
    });

    // Lambda Authorizer
    const lambdaAuthorizer = new apigateway.TokenAuthorizer(this, 'LambdaAuthorizer', {
      handler: authorizerFunction,
      authorizerName: `glacier-lambda-authorizer-${environment}`,
      identitySource: 'method.request.header.Authorization',
      resultsCacheTtl: cdk.Duration.seconds(0) // キャッシュを無効化してデバッグ
    });

    // Cognito Authorizerは削除（Lambda Authorizerに統一）

    // API Gateway CloudWatch Role
    const apiGatewayCloudWatchRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs')
      ]
    });

    // API Gateway Account設定
    new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGatewayCloudWatchRole.roleArn
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
        throttlingBurstLimit: 200,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true
      }
    });

    // API リソースとメソッドの定義
    const archiveResource = api.root.addResource('archive');

    // POST /archive/upload (認証必須 - Lambda Authorizer使用)
    archiveResource
      .addResource('upload')
      .addMethod('POST', new apigateway.LambdaIntegration(uploadFunction), {
        authorizer: lambdaAuthorizer,
        authorizationType: apigateway.AuthorizationType.CUSTOM,
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '400' },
          { statusCode: '401' },
          { statusCode: '500' }
        ]
      });

    // GET /archive/list (認証必須 - Lambda Authorizer使用)
    archiveResource
      .addResource('list')
      .addMethod('GET', new apigateway.LambdaIntegration(listFunction), {
        authorizer: lambdaAuthorizer,
        authorizationType: apigateway.AuthorizationType.CUSTOM,
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
      authorizer: lambdaAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
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
      authorizer: lambdaAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
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
        authorizer: lambdaAuthorizer,
        authorizationType: apigateway.AuthorizationType.CUSTOM,
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
        authorizer: lambdaAuthorizer,
        authorizationType: apigateway.AuthorizationType.CUSTOM,
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
      authorizer: lambdaAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
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
      authorizer: lambdaAuthorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
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
#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GlacierArchiveApiStack } from '../src/glacier-archive-api-stack';

const app = new cdk.App();

// 環境変数から環境を取得（デフォルトは dev）
const environment = app.node.tryGetContext('environment') || 'dev';

// AWSアカウントとリージョンの設定
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'ap-northeast-1'
};

// スタック名を環境に応じて設定
const stackName = `GlacierArchiveApiStack${environment.charAt(0).toUpperCase() + environment.slice(1)}`;

new GlacierArchiveApiStack(app, stackName, {
  env,
  description: `S3 Glacier Deep Archive API for mobile applications (${environment})`,
  tags: {
    Environment: environment,
    Project: 'GlacierArchiveApi',
    ManagedBy: 'CDK'
  }
});

app.synth();
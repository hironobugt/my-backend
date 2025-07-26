#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GlacierArchiveApiStack } from '../lib/glacier-archive-api-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1'
};

new GlacierArchiveApiStack(app, 'GlacierArchiveApiStack', {
  env,
  description: 'S3 Glacier Deep Archive API for mobile applications'
});
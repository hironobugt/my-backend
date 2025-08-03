#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GlacierArchiveApiStack } from '../src/glacier-archive-api-stack';
import { DefaultStackSynthesizer } from 'aws-cdk-lib';

const app = new cdk.App();

const qualifier = app.node.tryGetContext('@aws-cdk/core:bootstrapQualifier');

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1'
};

new GlacierArchiveApiStack(app, 'GlacierArchiveApiStack', {
  env,
  synthesizer: new DefaultStackSynthesizer({
    qualifier: qualifier || 'hnb659fds' // Fallback for local dev
  }),
  description: 'S3 Glacier Deep Archive API for mobile applications'
});
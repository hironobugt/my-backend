#!/bin/bash

# Glaceon API SAM Deployment Script

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="dev"
REGION="ap-northeast-1"
PROFILE="default"
CI_MODE=false
STACK_NAME=""

# Detect CI environment
if [ "$GITHUB_ACTIONS" = "true" ]; then
    CI_MODE=true
    PROFILE=""
fi

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -r|--region)
            REGION="$2"
            shift 2
            ;;
        -p|--profile)
            PROFILE="$2"
            shift 2
            ;;
        -s|--stack-name)
            STACK_NAME="$2"
            shift 2
            ;;
        --ci)
            CI_MODE=true
            PROFILE=""
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  -e, --environment ENV    Environment (dev/staging/prod) [default: dev]"
            echo "  -r, --region REGION      AWS Region [default: ap-northeast-1]"
            echo "  -p, --profile PROFILE    AWS Profile [default: default]"
            echo "  -s, --stack-name NAME    CloudFormation stack name"
            echo "  --ci                     CI mode (no profile needed)"
            echo "  -h, --help              Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option $1"
            exit 1
            ;;
    esac
done

# Set default stack name if not provided
if [ -z "$STACK_NAME" ]; then
    STACK_NAME="glaceon-api-$ENVIRONMENT"
fi

echo -e "${BLUE}🚀 Glaceon API SAM Deployment${NC}"
echo -e "${BLUE}Environment: ${YELLOW}$ENVIRONMENT${NC}"
echo -e "${BLUE}Region: ${YELLOW}$REGION${NC}"
echo -e "${BLUE}Stack Name: ${YELLOW}$STACK_NAME${NC}"
if [ "$CI_MODE" = "true" ]; then
    echo -e "${BLUE}Mode: ${YELLOW}CI/CD${NC}"
else
    echo -e "${BLUE}Profile: ${YELLOW}$PROFILE${NC}"
fi
echo ""

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed${NC}"
    exit 1
fi

# Check if SAM CLI is installed
if ! command -v sam &> /dev/null; then
    echo -e "${RED}❌ AWS SAM CLI is not installed${NC}"
    echo -e "${YELLOW}Install with: pip install aws-sam-cli${NC}"
    exit 1
fi

# Check AWS credentials
echo -e "${BLUE}🔐 Checking AWS credentials...${NC}"
if [ "$CI_MODE" = "true" ]; then
    # In CI, credentials are provided via environment variables
    if ! aws sts get-caller-identity > /dev/null 2>&1; then
        echo -e "${RED}❌ AWS credentials not configured${NC}"
        exit 1
    fi
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
else
    # Local development with profile
    if ! aws sts get-caller-identity --profile $PROFILE > /dev/null 2>&1; then
        echo -e "${RED}❌ AWS credentials not configured for profile: $PROFILE${NC}"
        exit 1
    fi
    ACCOUNT_ID=$(aws sts get-caller-identity --profile $PROFILE --query Account --output text)
fi

echo -e "${GREEN}✅ AWS Account: $ACCOUNT_ID${NC}"

# Load environment variables
if [ "$ENVIRONMENT" = "prod" ]; then
    if [ -f ".env.production" ]; then
        echo -e "${BLUE}📄 Loading production environment variables...${NC}"
        export $(cat .env.production | grep -v '^#' | xargs)
    else
        echo -e "${YELLOW}⚠️  .env.production not found, using defaults${NC}"
    fi
elif [ -f ".env" ]; then
    echo -e "${BLUE}📄 Loading environment variables...${NC}"
    export $(cat .env | grep -v '^#' | xargs)
fi

# Install dependencies (skip in CI if already cached)
if [ "$CI_MODE" = "false" ] || [ ! -d "node_modules" ]; then
    echo -e "${BLUE}📦 Installing dependencies...${NC}"
    npm ci
fi

# Build TypeScript (skip in CI if already built)
if [ "$CI_MODE" = "false" ] || [ ! -d "lib" ]; then
    echo -e "${BLUE}🔨 Building TypeScript...${NC}"
    npm run build
fi

# Prepare SAM parameters
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY:-"sk_test_placeholder"}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-"whsec_placeholder"}

# Create parameter overrides
PARAMETER_OVERRIDES="Environment=$ENVIRONMENT StripeSecretKey=$STRIPE_SECRET_KEY StripeWebhookSecret=$STRIPE_WEBHOOK_SECRET"

# Prepare SAM deploy command
SAM_DEPLOY_CMD="sam deploy --template-file template.yaml --stack-name $STACK_NAME --region $REGION --capabilities CAPABILITY_IAM --parameter-overrides $PARAMETER_OVERRIDES --no-confirm-changeset --no-fail-on-empty-changeset --resolve-s3"

if [ "$CI_MODE" = "false" ]; then
    SAM_DEPLOY_CMD="$SAM_DEPLOY_CMD --profile $PROFILE"
fi

# Deploy with SAM
echo -e "${BLUE}🚀 Deploying with SAM...${NC}"
echo -e "${BLUE}Command: $SAM_DEPLOY_CMD${NC}"
echo ""

if eval $SAM_DEPLOY_CMD; then
    echo ""
    echo -e "${GREEN}✅ Deployment successful!${NC}"
    echo ""
    
    # Get stack outputs
    echo -e "${BLUE}📋 Stack Outputs:${NC}"
    
    if [ "$CI_MODE" = "true" ]; then
        OUTPUTS=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs' --output table)
    else
        OUTPUTS=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --profile $PROFILE --query 'Stacks[0].Outputs' --output table)
    fi
    
    echo "$OUTPUTS"
    echo ""
    
    # Extract API URL for Android app configuration
    if [ "$CI_MODE" = "true" ]; then
        API_URL=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
        USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)
        USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' --output text)
    else
        API_URL=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --profile $PROFILE --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
        USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --profile $PROFILE --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)
        USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --profile $PROFILE --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' --output text)
    fi
    
    if [ ! -z "$API_URL" ]; then
        echo -e "${YELLOW}📱 Update your Android app configuration:${NC}"
        echo -e "${YELLOW}API_BASE_URL_RELEASE=$API_URL${NC}"
        
        if [ ! -z "$USER_POOL_ID" ]; then
            echo -e "${YELLOW}USER_POOL_ID=$USER_POOL_ID${NC}"
        fi
        
        if [ ! -z "$USER_POOL_CLIENT_ID" ]; then
            echo -e "${YELLOW}USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID${NC}"
        fi
        echo ""
    fi
    
    echo -e "${GREEN}🎉 Glaceon API is now live!${NC}"
    
    # In CI mode, create a summary
    if [ "$CI_MODE" = "true" ] && [ ! -z "$GITHUB_STEP_SUMMARY" ]; then
        echo "## 🚀 SAM Deployment Summary" >> $GITHUB_STEP_SUMMARY
        echo "" >> $GITHUB_STEP_SUMMARY
        echo "- **Environment:** $ENVIRONMENT" >> $GITHUB_STEP_SUMMARY
        echo "- **Region:** $REGION" >> $GITHUB_STEP_SUMMARY
        echo "- **Stack Name:** $STACK_NAME" >> $GITHUB_STEP_SUMMARY
        echo "- **Account:** $ACCOUNT_ID" >> $GITHUB_STEP_SUMMARY
        
        if [ ! -z "$API_URL" ]; then
            echo "- **API URL:** $API_URL" >> $GITHUB_STEP_SUMMARY
        fi
        
        echo "" >> $GITHUB_STEP_SUMMARY
        echo "✅ SAM deployment completed successfully!" >> $GITHUB_STEP_SUMMARY
    fi
    
    # Create outputs file for compatibility
    if [ ! -z "$API_URL" ]; then
        echo "{\"GlaceonApiStack\":{\"ApiUrl\":\"$API_URL\",\"UserPoolId\":\"$USER_POOL_ID\",\"UserPoolClientId\":\"$USER_POOL_CLIENT_ID\"}}" > sam-outputs.json
        echo -e "${BLUE}📄 Created sam-outputs.json for compatibility${NC}"
    fi
    
else
    echo -e "${RED}❌ Deployment failed${NC}"
    exit 1
fi
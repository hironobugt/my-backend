#!/bin/bash

# CDK Bootstrap Fix Script - Handles existing S3 bucket conflicts

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
REGION="ap-northeast-1"
PROFILE="default"
CI_MODE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--region)
            REGION="$2"
            shift 2
            ;;
        -p|--profile)
            PROFILE="$2"
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
            echo "  -r, --region REGION      AWS Region [default: ap-northeast-1]"
            echo "  -p, --profile PROFILE    AWS Profile [default: default]"
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

echo -e "${BLUE}🔍 Comprehensive CDK bootstrap check and fix...${NC}"

# Get AWS account ID
if [ "$CI_MODE" = "true" ]; then
    if ! aws sts get-caller-identity > /dev/null 2>&1; then
        echo -e "${RED}❌ AWS credentials not configured${NC}"
        exit 1
    fi
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    AWS_CMD="aws"
else
    if ! aws sts get-caller-identity --profile $PROFILE > /dev/null 2>&1; then
        echo -e "${RED}❌ AWS credentials not configured for profile: $PROFILE${NC}"
        exit 1
    fi
    ACCOUNT_ID=$(aws sts get-caller-identity --profile $PROFILE --query Account --output text)
    AWS_CMD="aws --profile $PROFILE"
fi

BUCKET_NAME="cdk-hnb659fds-assets-$ACCOUNT_ID-$REGION"
STACK_NAME="CDKToolkit"

# Check CloudFormation stack status
STACK_STATUS=$(eval "$AWS_CMD cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].StackStatus' --output text" 2>/dev/null || echo "NOT_FOUND")
echo "CDKToolkit stack status: $STACK_STATUS"

# Check if S3 bucket exists
if eval "$AWS_CMD s3 ls s3://$BUCKET_NAME" >/dev/null 2>&1; then
    echo "S3 bucket exists: $BUCKET_NAME"
    BUCKET_EXISTS=true
else
    echo "S3 bucket does not exist: $BUCKET_NAME"
    BUCKET_EXISTS=false
fi

# Handle different scenarios
if [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ]; then
    echo -e "${BLUE}🧹 Cleaning up failed CDKToolkit stack...${NC}"
    
    # Delete the failed stack
    if [ "$CI_MODE" = "true" ]; then
        aws cloudformation delete-stack --stack-name $STACK_NAME
    else
        aws cloudformation delete-stack --stack-name $STACK_NAME --profile $PROFILE
    fi
    
    # Wait for stack deletion
    echo -e "${BLUE}⏳ Waiting for cleanup to complete...${NC}"
    if [ "$CI_MODE" = "true" ]; then
        aws cloudformation wait stack-delete-complete --stack-name $STACK_NAME
    else
        aws cloudformation wait stack-delete-complete --stack-name $STACK_NAME --profile $PROFILE
    fi
fi

# If S3 bucket exists, try bootstrap with existing bucket
if [ "$BUCKET_EXISTS" = "true" ]; then
    echo -e "${BLUE}🔄 Attempting bootstrap with existing S3 bucket...${NC}"
    
    # Try bootstrap with existing bucket name
    CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION --bootstrap-bucket-name $BUCKET_NAME"
    
    if [ "$CI_MODE" = "false" ]; then
        CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --profile $PROFILE"
    fi
    
    if eval $CDK_BOOTSTRAP_CMD; then
        echo -e "${GREEN}✅ Bootstrap with existing bucket successful${NC}"
        exit 0
    else
        echo -e "${YELLOW}⚠️ Bootstrap with existing bucket failed, trying alternative approach...${NC}"
        
        # Try with a shorter custom qualifier (8 characters max)
        CUSTOM_QUALIFIER="hnb659fd"
        CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION --qualifier $CUSTOM_QUALIFIER"
        
        if [ "$CI_MODE" = "false" ]; then
            CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --profile $PROFILE"
        fi
        
        echo "Using custom qualifier: $CUSTOM_QUALIFIER"
        
        if eval $CDK_BOOTSTRAP_CMD; then
            echo -e "${GREEN}✅ Bootstrap with custom qualifier successful${NC}"
            exit 0
        else
            echo -e "${RED}❌ All bootstrap attempts failed${NC}"
            exit 1
        fi
    fi
else
    # Standard bootstrap if no bucket exists
    echo -e "${BLUE}🔄 Running standard CDK bootstrap...${NC}"
    
    CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION"
    
    if [ "$CI_MODE" = "false" ]; then
        CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --profile $PROFILE"
    fi
    
    if eval $CDK_BOOTSTRAP_CMD; then
        echo -e "${GREEN}✅ Standard bootstrap successful${NC}"
        exit 0
    else
        echo -e "${RED}❌ Standard bootstrap failed${NC}"
        exit 1
    fi
fi
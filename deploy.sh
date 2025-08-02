#!/bin/bash

# CDK Bootstrap Fix Script
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ACCOUNT_ID="471511831486"
REGION="ap-northeast-1"
BUCKET_NAME="cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}"

echo -e "${BLUE}🔧 CDK Bootstrap Fix Script${NC}"
echo -e "${BLUE}Account: ${YELLOW}$ACCOUNT_ID${NC}"
echo -e "${BLUE}Region: ${YELLOW}$REGION${NC}"
echo -e "${BLUE}Bucket: ${YELLOW}$BUCKET_NAME${NC}"
echo ""

# Step 1: Check and clean up failed CloudFormation stack
echo -e "${BLUE}1️⃣ Checking CDKToolkit stack status...${NC}"
STACK_STATUS=$(aws cloudformation describe-stacks --stack-name CDKToolkit --region $REGION --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT_EXISTS")

echo "Current stack status: $STACK_STATUS"

if [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ] || [ "$STACK_STATUS" = "CREATE_FAILED" ] || [ "$STACK_STATUS" = "UPDATE_FAILED" ]; then
    echo -e "${YELLOW}🧹 Deleting failed CDKToolkit stack...${NC}"
    aws cloudformation delete-stack --stack-name CDKToolkit --region $REGION
    
    echo -e "${BLUE}⏳ Waiting for stack deletion to complete...${NC}"
    aws cloudformation wait stack-delete-complete --stack-name CDKToolkit --region $REGION
    echo -e "${GREEN}✅ Stack deleted successfully${NC}"
elif [ "$STACK_STATUS" = "CREATE_COMPLETE" ] || [ "$STACK_STATUS" = "UPDATE_COMPLETE" ]; then
    echo -e "${GREEN}✅ Stack is already in good state${NC}"
    exit 0
fi

# Step 2: Check S3 bucket
echo -e "${BLUE}2️⃣ Checking S3 bucket status...${NC}"
if aws s3 ls "s3://$BUCKET_NAME" >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️ S3 bucket $BUCKET_NAME already exists${NC}"
    
    # Check if bucket belongs to current account
    BUCKET_OWNER=$(aws s3api get-bucket-location --bucket $BUCKET_NAME --query 'LocationConstraint' --output text 2>/dev/null || echo "ACCESS_DENIED")
    
    if [ "$BUCKET_OWNER" = "ACCESS_DENIED" ]; then
        echo -e "${RED}❌ Cannot access bucket - it may belong to another account${NC}"
        echo -e "${YELLOW}💡 Try using a different qualifier or region${NC}"
        exit 1
    else
        echo -e "${GREEN}✅ Bucket is accessible - will reuse it${NC}"
    fi
else
    echo -e "${GREEN}✅ S3 bucket does not exist - will create new one${NC}"
fi

# Step 3: Attempt bootstrap with different strategies
echo -e "${BLUE}3️⃣ Attempting CDK bootstrap...${NC}"

# Strategy 1: Try with --force flag
echo -e "${BLUE}Strategy 1: Bootstrap with --force${NC}"
if cdk bootstrap aws://$ACCOUNT_ID/$REGION --force --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess 2>/dev/null; then
    echo -e "${GREEN}✅ Bootstrap successful with --force${NC}"
    exit 0
fi

# Strategy 2: Try with custom qualifier to avoid conflicts
echo -e "${BLUE}Strategy 2: Bootstrap with custom qualifier${NC}"
CUSTOM_QUALIFIER="hnb659fds$(date +%s | tail -c 5)"
echo "Using qualifier: $CUSTOM_QUALIFIER"

if cdk bootstrap aws://$ACCOUNT_ID/$REGION --qualifier $CUSTOM_QUALIFIER --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess; then
    echo -e "${GREEN}✅ Bootstrap successful with custom qualifier${NC}"
    echo -e "${YELLOW}⚠️ Remember to use this qualifier in your CDK app:${NC}"
    echo -e "${YELLOW}   DefaultStackSynthesizer.DEFAULT_QUALIFIER = '$CUSTOM_QUALIFIER'${NC}"
    exit 0
fi

# Strategy 3: Manual cleanup and retry
echo -e "${BLUE}Strategy 3: Manual S3 cleanup and retry${NC}"
echo -e "${YELLOW}⚠️ Attempting to empty and delete the conflicting S3 bucket...${NC}"

# Empty the bucket first
if aws s3 rm "s3://$BUCKET_NAME" --recursive 2>/dev/null; then
    echo "Emptied bucket contents"
fi

# Delete the bucket
if aws s3 rb "s3://$BUCKET_NAME" --force 2>/dev/null; then
    echo "Deleted bucket"
    
    # Wait a bit for eventual consistency
    sleep 10
    
    # Try bootstrap again
    if cdk bootstrap aws://$ACCOUNT_ID/$REGION --force --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess; then
        echo -e "${GREEN}✅ Bootstrap successful after manual cleanup${NC}"
        exit 0
    fi
fi

echo -e "${RED}❌ All bootstrap strategies failed${NC}"
echo -e "${YELLOW}💡 Manual steps required:${NC}"
echo -e "${YELLOW}1. Go to AWS Console → S3${NC}"
echo -e "${YELLOW}2. Delete bucket: $BUCKET_NAME${NC}"
echo -e "${YELLOW}3. Go to CloudFormation and ensure CDKToolkit stack is deleted${NC}"
echo -e "${YELLOW}4. Run: cdk bootstrap aws://$ACCOUNT_ID/$REGION --force${NC}"
exit 1
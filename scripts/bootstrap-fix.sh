#!/bin/bash

# CDK Bootstrap Check Script - Simple and standard approach

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
QUALIFIER=""

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
        --qualifier)
            QUALIFIER="$2"
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
            echo "  --qualifier QUALIFIER    CDK Bootstrap qualifier"
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

echo -e "${BLUE}🔍 CDK bootstrap check...${NC}"

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

# Set stack name based on qualifier
if [ -n "$QUALIFIER" ]; then
    STACK_NAME="CDKToolkit-$QUALIFIER"
else
    STACK_NAME="CDKToolkit"
fi

# Check CloudFormation stack status
STACK_STATUS=$(eval "$AWS_CMD cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].StackStatus' --output text" 2>/dev/null || echo "NOT_FOUND")
echo "CDK stack status: $STACK_STATUS"

# Check if CDK is already properly bootstrapped
if [ "$STACK_STATUS" = "CREATE_COMPLETE" ] || [ "$STACK_STATUS" = "UPDATE_COMPLETE" ]; then
    echo -e "${GREEN}✅ CDK is already properly bootstrapped${NC}"
    echo -e "${BLUE}ℹ️  Stack: $STACK_NAME${NC}"
    echo -e "${BLUE}ℹ️  Status: $STACK_STATUS${NC}"
    exit 0
fi

# Handle ROLLBACK_COMPLETE state
if [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ]; then
    echo -e "${YELLOW}⚠️  CDK stack is in ROLLBACK_COMPLETE state${NC}"
    echo -e "${BLUE}🧹 Cleaning up failed stack...${NC}"
    
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
    
    echo -e "${GREEN}✅ Failed stack cleaned up${NC}"
fi

# Run standard CDK bootstrap
echo -e "${BLUE}🔄 Running CDK bootstrap...${NC}"

CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION"

if [ -n "$QUALIFIER" ]; then
    CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --qualifier $QUALIFIER"
fi

if [ "$CI_MODE" = "false" ]; then
    CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --profile $PROFILE"
fi

echo -e "${BLUE}Command: $CDK_BOOTSTRAP_CMD${NC}"

if eval $CDK_BOOTSTRAP_CMD; then
    echo -e "${GREEN}✅ CDK bootstrap successful${NC}"
    exit 0
else
    echo -e "${RED}❌ CDK bootstrap failed${NC}"
    echo -e "${YELLOW}💡 If this is due to existing resources, they will be reused${NC}"
    
    # Check if the stack was created despite the error
    FINAL_STATUS=$(eval "$AWS_CMD cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].StackStatus' --output text" 2>/dev/null || echo "NOT_FOUND")
    if [ "$FINAL_STATUS" = "CREATE_COMPLETE" ] || [ "$FINAL_STATUS" = "UPDATE_COMPLETE" ]; then
        echo -e "${GREEN}✅ CDK stack is actually in good state: $FINAL_STATUS${NC}"
        exit 0
    fi
    
    exit 1
fi
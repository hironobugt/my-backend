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

# Set bucket name and stack name based on qualifier
if [ -n "$QUALIFIER" ]; then
    BUCKET_NAME="cdk-$QUALIFIER-assets-$ACCOUNT_ID-$REGION"
    STACK_NAME="CDKToolkit-$QUALIFIER"
else
    BUCKET_NAME="cdk-hnb659fds-assets-$ACCOUNT_ID-$REGION"
    STACK_NAME="CDKToolkit"
fi

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

# Check if CDK is already properly bootstrapped
if [ "$STACK_STATUS" = "CREATE_COMPLETE" ] || [ "$STACK_STATUS" = "UPDATE_COMPLETE" ]; then
    if [ "$BUCKET_EXISTS" = "true" ]; then
        echo -e "${GREEN}✅ CDK is already properly bootstrapped${NC}"
        echo -e "${BLUE}ℹ️  Stack status: $STACK_STATUS${NC}"
        echo -e "${BLUE}ℹ️  S3 bucket: $BUCKET_NAME${NC}"
        echo -e "${BLUE}ℹ️  No action needed - skipping bootstrap${NC}"
        exit 0
    fi
fi

# Check if we need to fix anything
NEEDS_FIX=false

if [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ]; then
    echo -e "${YELLOW}⚠️  CDKToolkit stack is in ROLLBACK_COMPLETE state - needs fix${NC}"
    NEEDS_FIX=true
elif [ "$STACK_STATUS" = "NOT_FOUND" ] && [ "$BUCKET_EXISTS" = "true" ]; then
    echo -e "${YELLOW}⚠️  S3 bucket exists but no CDKToolkit stack - needs fix${NC}"
    NEEDS_FIX=true
elif [ "$STACK_STATUS" = "NOT_FOUND" ] && [ "$BUCKET_EXISTS" = "false" ]; then
    echo -e "${BLUE}ℹ️  Clean environment - running standard bootstrap${NC}"
    NEEDS_FIX=false
fi

if [ "$NEEDS_FIX" = "false" ] && [ "$STACK_STATUS" = "NOT_FOUND" ] && [ "$BUCKET_EXISTS" = "false" ]; then
    # Standard bootstrap for clean environment
    echo -e "${BLUE}🔄 Running standard CDK bootstrap...${NC}"
    
    CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION --verbose"
    
    if [ -n "$QUALIFIER" ]; then
        CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --qualifier $QUALIFIER"
    fi
    
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

if [ "$NEEDS_FIX" = "false" ]; then
    echo -e "${GREEN}✅ CDK bootstrap is in good state - no action needed${NC}"
    exit 0
fi

echo -e "${YELLOW}🔧 CDK bootstrap needs fixing - proceeding with repair...${NC}"

# Handle ROLLBACK_COMPLETE state first
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
    
    echo -e "${GREEN}✅ Failed stack cleaned up${NC}"
fi

# Now handle bootstrap based on bucket existence
if [ "$BUCKET_EXISTS" = "true" ]; then
    echo -e "${BLUE}🔄 Handling existing S3 bucket conflict...${NC}"
    
    # Strategy: Temporarily rename the existing bucket, run bootstrap, then restore content
    BACKUP_BUCKET_NAME="$BUCKET_NAME-backup-$(date +%s)"
    
    echo -e "${BLUE}📦 Creating backup of existing bucket content...${NC}"
    
    # Create a backup bucket
    if [ "$CI_MODE" = "true" ]; then
        aws s3 mb "s3://$BACKUP_BUCKET_NAME" --region $REGION
        # Copy all content from original to backup
        aws s3 sync "s3://$BUCKET_NAME" "s3://$BACKUP_BUCKET_NAME" --quiet
        # Delete the original bucket
        aws s3 rb "s3://$BUCKET_NAME" --force
    else
        aws s3 mb "s3://$BACKUP_BUCKET_NAME" --region $REGION --profile $PROFILE
        # Copy all content from original to backup
        aws s3 sync "s3://$BUCKET_NAME" "s3://$BACKUP_BUCKET_NAME" --quiet --profile $PROFILE
        # Delete the original bucket
        aws s3 rb "s3://$BUCKET_NAME" --force --profile $PROFILE
    fi
    
    echo -e "${GREEN}✅ Backup created: $BACKUP_BUCKET_NAME${NC}"
    
    # Now run standard bootstrap
    echo -e "${BLUE}🔄 Running CDK bootstrap with clean slate...${NC}"
    
    CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION --verbose"
    
    if [ -n "$QUALIFIER" ]; then
        CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --qualifier $QUALIFIER"
    fi
    
    if [ "$CI_MODE" = "false" ]; then
        CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --profile $PROFILE"
    fi
    
    if eval $CDK_BOOTSTRAP_CMD; then
        echo -e "${GREEN}✅ CDK bootstrap successful${NC}"
        
        # Restore the original content
        echo -e "${BLUE}🔄 Restoring original bucket content...${NC}"
        
        if [ "$CI_MODE" = "true" ]; then
            # Sync backup content to the new bootstrap bucket
            aws s3 sync "s3://$BACKUP_BUCKET_NAME" "s3://$BUCKET_NAME" --quiet
            # Clean up backup bucket
            aws s3 rb "s3://$BACKUP_BUCKET_NAME" --force
        else
            # Sync backup content to the new bootstrap bucket
            aws s3 sync "s3://$BACKUP_BUCKET_NAME" "s3://$BUCKET_NAME" --quiet --profile $PROFILE
            # Clean up backup bucket
            aws s3 rb "s3://$BACKUP_BUCKET_NAME" --force --profile $PROFILE
        fi
        
        echo -e "${GREEN}✅ Original content restored and backup cleaned up${NC}"
        exit 0
    else
        echo -e "${RED}❌ CDK bootstrap failed${NC}"
        
        # Restore the original bucket since bootstrap failed
        echo -e "${BLUE}🔄 Restoring original bucket due to bootstrap failure...${NC}"
        
        if [ "$CI_MODE" = "true" ]; then
            # Recreate original bucket and restore content
            aws s3 mb "s3://$BUCKET_NAME" --region $REGION
            aws s3 sync "s3://$BACKUP_BUCKET_NAME" "s3://$BUCKET_NAME" --quiet
            aws s3 rb "s3://$BACKUP_BUCKET_NAME" --force
        else
            # Recreate original bucket and restore content
            aws s3 mb "s3://$BUCKET_NAME" --region $REGION --profile $PROFILE
            aws s3 sync "s3://$BACKUP_BUCKET_NAME" "s3://$BUCKET_NAME" --quiet --profile $PROFILE
            aws s3 rb "s3://$BACKUP_BUCKET_NAME" --force --profile $PROFILE
        fi
        
        echo -e "${YELLOW}⚠️ Original bucket restored after bootstrap failure${NC}"
        exit 1
    fi
else
    # Standard bootstrap if no bucket exists
    echo -e "${BLUE}🔄 Running standard CDK bootstrap...${NC}"
    
    CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION --verbose"
    
    if [ -n "$QUALIFIER" ]; then
        CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --qualifier $QUALIFIER"
    fi
    
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
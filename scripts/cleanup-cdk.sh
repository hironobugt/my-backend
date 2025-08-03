#!/bin/bash

# CDK Resources Cleanup Script

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

echo -e "${BLUE}🧹 CDK Resources Cleanup${NC}"
echo -e "${BLUE}Region: ${YELLOW}$REGION${NC}"
if [ "$CI_MODE" = "true" ]; then
    echo -e "${BLUE}Mode: ${YELLOW}CI/CD${NC}"
else
    echo -e "${BLUE}Profile: ${YELLOW}$PROFILE${NC}"
fi
echo ""

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

echo -e "${GREEN}✅ AWS Account: $ACCOUNT_ID${NC}"
echo ""

# List of CDK stacks to check and delete
CDK_STACKS=(
    "CDKToolkit"
    "CDKToolkit-glaceon"
    "GlacierArchiveApiStack"
    "glaceon-api-dev"
    "glaceon-api-prod"
)

echo -e "${BLUE}🔍 Checking for CDK CloudFormation stacks...${NC}"

for STACK_NAME in "${CDK_STACKS[@]}"; do
    echo -n "  Checking stack: $STACK_NAME... "
    
    STACK_STATUS=$(eval "$AWS_CMD cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].StackStatus' --output text" 2>/dev/null || echo "NOT_FOUND")
    
    if [ "$STACK_STATUS" != "NOT_FOUND" ]; then
        echo -e "${YELLOW}EXISTS ($STACK_STATUS)${NC}"
        
        if [ "$STACK_STATUS" = "DELETE_FAILED" ] || [ "$STACK_STATUS" = "ROLLBACK_COMPLETE" ] || [ "$STACK_STATUS" = "CREATE_FAILED" ]; then
            echo -e "${BLUE}    🗑️  Deleting failed stack: $STACK_NAME${NC}"
            
            if [ "$CI_MODE" = "true" ]; then
                aws cloudformation delete-stack --stack-name $STACK_NAME
            else
                aws cloudformation delete-stack --stack-name $STACK_NAME --profile $PROFILE
            fi
            
            echo -e "${BLUE}    ⏳ Waiting for deletion to complete...${NC}"
            if [ "$CI_MODE" = "true" ]; then
                aws cloudformation wait stack-delete-complete --stack-name $STACK_NAME
            else
                aws cloudformation wait stack-delete-complete --stack-name $STACK_NAME --profile $PROFILE
            fi
            
            echo -e "${GREEN}    ✅ Stack deleted: $STACK_NAME${NC}"
        else
            echo -e "${YELLOW}    ⚠️  Stack exists but not in failed state. Skipping deletion.${NC}"
            echo -e "${YELLOW}    💡 If you want to delete this stack, run: aws cloudformation delete-stack --stack-name $STACK_NAME${NC}"
        fi
    else
        echo -e "${GREEN}NOT_FOUND${NC}"
    fi
done

echo ""
echo -e "${BLUE}🔍 Checking for CDK IAM roles...${NC}"

# List of CDK IAM roles to check and delete
CDK_ROLES=(
    "cdk-hnb659fds-cfn-exec-role-$ACCOUNT_ID-$REGION"
    "cdk-hnb659fds-deploy-role-$ACCOUNT_ID-$REGION"
    "cdk-hnb659fds-file-publishing-role-$ACCOUNT_ID-$REGION"
    "cdk-hnb659fds-image-publishing-role-$ACCOUNT_ID-$REGION"
    "cdk-hnb659fds-lookup-role-$ACCOUNT_ID-$REGION"
    "cdk-glaceon-cfn-exec-role-$ACCOUNT_ID-$REGION"
    "cdk-glaceon-deploy-role-$ACCOUNT_ID-$REGION"
    "cdk-glaceon-file-publishing-role-$ACCOUNT_ID-$REGION"
    "cdk-glaceon-image-publishing-role-$ACCOUNT_ID-$REGION"
    "cdk-glaceon-lookup-role-$ACCOUNT_ID-$REGION"
)

for ROLE_NAME in "${CDK_ROLES[@]}"; do
    echo -n "  Checking role: $ROLE_NAME... "
    
    if eval "$AWS_CMD iam get-role --role-name $ROLE_NAME" >/dev/null 2>&1; then
        echo -e "${YELLOW}EXISTS${NC}"
        echo -e "${BLUE}    🗑️  Deleting IAM role: $ROLE_NAME${NC}"
        
        # First, detach all policies
        ATTACHED_POLICIES=$(eval "$AWS_CMD iam list-attached-role-policies --role-name $ROLE_NAME --query 'AttachedPolicies[].PolicyArn' --output text" 2>/dev/null || echo "")
        
        if [ ! -z "$ATTACHED_POLICIES" ]; then
            for POLICY_ARN in $ATTACHED_POLICIES; do
                echo -e "${BLUE}      Detaching policy: $POLICY_ARN${NC}"
                if [ "$CI_MODE" = "true" ]; then
                    aws iam detach-role-policy --role-name $ROLE_NAME --policy-arn $POLICY_ARN
                else
                    aws iam detach-role-policy --role-name $ROLE_NAME --policy-arn $POLICY_ARN --profile $PROFILE
                fi
            done
        fi
        
        # Delete inline policies
        INLINE_POLICIES=$(eval "$AWS_CMD iam list-role-policies --role-name $ROLE_NAME --query 'PolicyNames' --output text" 2>/dev/null || echo "")
        
        if [ ! -z "$INLINE_POLICIES" ]; then
            for POLICY_NAME in $INLINE_POLICIES; do
                echo -e "${BLUE}      Deleting inline policy: $POLICY_NAME${NC}"
                if [ "$CI_MODE" = "true" ]; then
                    aws iam delete-role-policy --role-name $ROLE_NAME --policy-name $POLICY_NAME
                else
                    aws iam delete-role-policy --role-name $ROLE_NAME --policy-name $POLICY_NAME --profile $PROFILE
                fi
            done
        fi
        
        # Delete the role
        if [ "$CI_MODE" = "true" ]; then
            aws iam delete-role --role-name $ROLE_NAME
        else
            aws iam delete-role --role-name $ROLE_NAME --profile $PROFILE
        fi
        
        echo -e "${GREEN}    ✅ Role deleted: $ROLE_NAME${NC}"
    else
        echo -e "${GREEN}NOT_FOUND${NC}"
    fi
done

echo ""
echo -e "${BLUE}🔍 Checking for CDK S3 buckets...${NC}"

# List of CDK S3 buckets to check
CDK_BUCKETS=(
    "cdk-hnb659fds-assets-$ACCOUNT_ID-$REGION"
    "cdk-glaceon-assets-$ACCOUNT_ID-$REGION"
)

for BUCKET_NAME in "${CDK_BUCKETS[@]}"; do
    echo -n "  Checking bucket: $BUCKET_NAME... "
    
    if eval "$AWS_CMD s3 ls s3://$BUCKET_NAME" >/dev/null 2>&1; then
        echo -e "${YELLOW}EXISTS${NC}"
        echo -e "${BLUE}    🗑️  Emptying and deleting S3 bucket: $BUCKET_NAME${NC}"
        
        # Empty the bucket first
        if [ "$CI_MODE" = "true" ]; then
            aws s3 rm "s3://$BUCKET_NAME" --recursive
            aws s3 rb "s3://$BUCKET_NAME"
        else
            aws s3 rm "s3://$BUCKET_NAME" --recursive --profile $PROFILE
            aws s3 rb "s3://$BUCKET_NAME" --profile $PROFILE
        fi
        
        echo -e "${GREEN}    ✅ Bucket deleted: $BUCKET_NAME${NC}"
    else
        echo -e "${GREEN}NOT_FOUND${NC}"
    fi
done

echo ""
echo -e "${BLUE}🔍 Checking for CDK SSM parameters...${NC}"

# List of CDK SSM parameters to check
CDK_PARAMETERS=(
    "/cdk-bootstrap/hnb659fds/version"
    "/cdk-bootstrap/glaceon/version"
)

for PARAM_NAME in "${CDK_PARAMETERS[@]}"; do
    echo -n "  Checking parameter: $PARAM_NAME... "
    
    if eval "$AWS_CMD ssm get-parameter --name $PARAM_NAME" >/dev/null 2>&1; then
        echo -e "${YELLOW}EXISTS${NC}"
        echo -e "${BLUE}    🗑️  Deleting SSM parameter: $PARAM_NAME${NC}"
        
        if [ "$CI_MODE" = "true" ]; then
            aws ssm delete-parameter --name $PARAM_NAME
        else
            aws ssm delete-parameter --name $PARAM_NAME --profile $PROFILE
        fi
        
        echo -e "${GREEN}    ✅ Parameter deleted: $PARAM_NAME${NC}"
    else
        echo -e "${GREEN}NOT_FOUND${NC}"
    fi
done

echo ""
echo -e "${GREEN}🎉 CDK cleanup completed!${NC}"
echo -e "${BLUE}ℹ️  You can now run SAM deploy without CDK conflicts${NC}"
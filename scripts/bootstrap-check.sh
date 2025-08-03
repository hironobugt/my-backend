#!/bin/bash

# CDK Bootstrap Check and Repair Script

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
FORCE_BOOTSTRAP=false

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
        --force)
            FORCE_BOOTSTRAP=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  -r, --region REGION      AWS Region [default: ap-northeast-1]"
            echo "  -p, --profile PROFILE    AWS Profile [default: default]"
            echo "  --ci                     CI mode (no profile needed)"
            echo "  --force                  Force bootstrap even if resources exist"
            echo "  -h, --help              Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option $1"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}🔍 CDK Bootstrap Check${NC}"
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

# Check CDK bootstrap resources
echo -e "${BLUE}🔍 Checking CDK bootstrap resources...${NC}"

BUCKET_NAME="cdk-hnb659fds-assets-$ACCOUNT_ID-$REGION"
STACK_NAME="CDKToolkit"

# Check S3 bucket
echo -n "  S3 Assets Bucket ($BUCKET_NAME): "
if eval "$AWS_CMD s3 ls s3://$BUCKET_NAME" >/dev/null 2>&1; then
    echo -e "${GREEN}✅ EXISTS${NC}"
    BUCKET_EXISTS=true
else
    echo -e "${RED}❌ NOT FOUND${NC}"
    BUCKET_EXISTS=false
fi

# Check CloudFormation stack
echo -n "  CloudFormation Stack ($STACK_NAME): "
if eval "$AWS_CMD cloudformation describe-stacks --stack-name $STACK_NAME" >/dev/null 2>&1; then
    STACK_STATUS=$(eval "$AWS_CMD cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].StackStatus' --output text")
    if [ "$STACK_STATUS" = "CREATE_COMPLETE" ] || [ "$STACK_STATUS" = "UPDATE_COMPLETE" ]; then
        echo -e "${GREEN}✅ $STACK_STATUS${NC}"
        STACK_EXISTS=true
    else
        echo -e "${YELLOW}⚠️  $STACK_STATUS${NC}"
        STACK_EXISTS=false
    fi
else
    echo -e "${RED}❌ NOT FOUND${NC}"
    STACK_EXISTS=false
fi

# Check IAM roles
echo -n "  CDK Execution Role: "
EXECUTION_ROLE_NAME="cdk-hnb659fds-cfn-exec-role-$ACCOUNT_ID-$REGION"
if eval "$AWS_CMD iam get-role --role-name $EXECUTION_ROLE_NAME" >/dev/null 2>&1; then
    echo -e "${GREEN}✅ EXISTS${NC}"
    EXECUTION_ROLE_EXISTS=true
else
    echo -e "${RED}❌ NOT FOUND${NC}"
    EXECUTION_ROLE_EXISTS=false
fi

echo -n "  CDK Deploy Role: "
DEPLOY_ROLE_NAME="cdk-hnb659fds-deploy-role-$ACCOUNT_ID-$REGION"
if eval "$AWS_CMD iam get-role --role-name $DEPLOY_ROLE_NAME" >/dev/null 2>&1; then
    echo -e "${GREEN}✅ EXISTS${NC}"
    DEPLOY_ROLE_EXISTS=true
else
    echo -e "${RED}❌ NOT FOUND${NC}"
    DEPLOY_ROLE_EXISTS=false
fi

echo ""

# Determine if bootstrap is needed
BOOTSTRAP_NEEDED=false

if [ "$FORCE_BOOTSTRAP" = "true" ]; then
    echo -e "${YELLOW}🔧 Force bootstrap requested${NC}"
    BOOTSTRAP_NEEDED=true
elif [ "$BUCKET_EXISTS" = "false" ] || [ "$STACK_EXISTS" = "false" ] || [ "$EXECUTION_ROLE_EXISTS" = "false" ] || [ "$DEPLOY_ROLE_EXISTS" = "false" ]; then
    echo -e "${YELLOW}⚠️  Some CDK bootstrap resources are missing${NC}"
    BOOTSTRAP_NEEDED=true
else
    echo -e "${GREEN}✅ All CDK bootstrap resources are available${NC}"
fi

if [ "$BOOTSTRAP_NEEDED" = "true" ]; then
    echo -e "${BLUE}🔧 Running CDK bootstrap...${NC}"
    
    # Prepare CDK bootstrap command
    CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION --verbose"
    
    if [ "$CI_MODE" = "false" ]; then
        CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --profile $PROFILE"
    fi
    
    echo -e "${BLUE}Command: $CDK_BOOTSTRAP_CMD${NC}"
    echo ""
    
    # Run bootstrap
    if eval $CDK_BOOTSTRAP_CMD; then
        echo ""
        echo -e "${GREEN}✅ CDK bootstrap completed successfully${NC}"
        
        # Verify resources after bootstrap
        echo -e "${BLUE}🔍 Verifying bootstrap resources...${NC}"
        
        sleep 5  # Wait for resources to be fully created
        
        # Re-check resources
        if eval "$AWS_CMD s3 ls s3://$BUCKET_NAME" >/dev/null 2>&1 && \
           eval "$AWS_CMD cloudformation describe-stacks --stack-name $STACK_NAME" >/dev/null 2>&1; then
            echo -e "${GREEN}✅ Bootstrap verification successful${NC}"
        else
            echo -e "${YELLOW}⚠️  Bootstrap completed but some resources may still be initializing${NC}"
        fi
    else
        BOOTSTRAP_EXIT_CODE=$?
        echo ""
        echo -e "${RED}❌ CDK bootstrap failed with exit code $BOOTSTRAP_EXIT_CODE${NC}"
        
        # Check if this is a "already exists" error
        if [ $BOOTSTRAP_EXIT_CODE -eq 1 ]; then
            echo -e "${YELLOW}💡 This might be due to existing resources. Checking...${NC}"
            
            # Re-check resources
            if eval "$AWS_CMD s3 ls s3://$BUCKET_NAME" >/dev/null 2>&1 && \
               eval "$AWS_CMD cloudformation describe-stacks --stack-name $STACK_NAME" >/dev/null 2>&1; then
                echo -e "${GREEN}✅ Bootstrap resources are actually available${NC}"
                echo -e "${BLUE}ℹ️  The error was likely due to existing resources${NC}"
                exit 0
            fi
        fi
        
        echo -e "${RED}❌ Bootstrap failed and resources are not available${NC}"
        echo -e "${YELLOW}💡 Troubleshooting tips:${NC}"
        echo -e "${YELLOW}   1. Check AWS permissions${NC}"
        echo -e "${YELLOW}   2. Verify AWS CLI configuration${NC}"
        echo -e "${YELLOW}   3. Try running with --force flag${NC}"
        echo -e "${YELLOW}   4. Check CloudFormation console for stack events${NC}"
        exit 1
    fi
else
    echo -e "${BLUE}ℹ️  No bootstrap needed - all resources are available${NC}"
fi

echo ""
echo -e "${GREEN}🎉 CDK bootstrap check completed successfully!${NC}"
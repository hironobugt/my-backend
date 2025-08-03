#!/bin/bash

# CDK Bootstrap Script - Ensures the CDK environment is bootstrapped.

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
        -q|--qualifier)
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
            echo "  -q, --qualifier QUAL     CDK bootstrap qualifier"
            echo "  --ci                     CI mode (no profile needed)"
            echo "  -h, --help               Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option $1"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}🚀 Bootstrapping CDK environment...${NC}"
echo -e "${BLUE}Region: ${YELLOW}$REGION${NC}"
if [ ! -z "$QUALIFIER" ]; then
    echo -e "${BLUE}Qualifier: ${YELLOW}$QUALIFIER${NC}"
fi

# Get AWS account ID
if [ "$CI_MODE" = "true" ]; then
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    AWS_CMD_CONTEXT=""
else
    ACCOUNT_ID=$(aws sts get-caller-identity --profile $PROFILE --query Account --output text)
    AWS_CMD_CONTEXT="--profile $PROFILE"
fi

echo -e "${BLUE}Account: ${YELLOW}$ACCOUNT_ID${NC}"

# Construct the bootstrap command
# We use --force to handle cases where the stack might be in a rollback state.
# The qualifier ensures we have a unique, project-specific bootstrap stack.
CDK_BOOTSTRAP_CMD="cdk bootstrap aws://$ACCOUNT_ID/$REGION --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess --force $AWS_CMD_CONTEXT"

if [ ! -z "$QUALIFIER" ]; then
    CDK_BOOTSTRAP_CMD="$CDK_BOOTSTRAP_CMD --qualifier $QUALIFIER"
fi

echo "Executing: $CDK_BOOTSTRAP_CMD"

# Execute the command
if eval $CDK_BOOTSTRAP_CMD; then
    echo -e "${GREEN}✅ CDK bootstrap successful${NC}"
    exit 0
else
    echo -e "${RED}❌ CDK bootstrap failed${NC}"
    exit 1
fi
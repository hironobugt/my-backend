#!/bin/bash

# Glaceon API Deployment Script

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

echo -e "${BLUE}🚀 Glaceon API Deployment${NC}"
echo -e "${BLUE}Environment: ${YELLOW}$ENVIRONMENT${NC}"
echo -e "${BLUE}Region: ${YELLOW}$REGION${NC}"
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

# Check if CDK is installed
if ! command -v cdk &> /dev/null; then
    echo -e "${RED}❌ AWS CDK is not installed${NC}"
    echo -e "${YELLOW}Install with: npm install -g aws-cdk${NC}"
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

# CDK Bootstrap Management
QUALIFIER="glaceon" # Unique qualifier for this project's CDK resources
echo -e "${BLUE}🏗️  Checking CDK bootstrap resources (Qualifier: $QUALIFIER)...${NC}"

# Run bootstrap fix directly to avoid issues with `eval` and argument parsing.
CMD_ARGS=("--region" "$REGION" "--qualifier" "$QUALIFIER")
if [ "$CI_MODE" = "true" ]; then
    CMD_ARGS+=("--ci")
else
    CMD_ARGS+=("--profile" "$PROFILE")
fi

if ./scripts/bootstrap-fix.sh "${CMD_ARGS[@]}"; then
    echo -e "${GREEN}✅ CDK bootstrap completed successfully${NC}"
else
    echo -e "${RED}❌ CDK bootstrap failed${NC}"
    exit 1
fi

# Prepare CDK deploy command
# Qualifier is now set in cdk.json, so we don't need to pass it via command line
CDK_DEPLOY_CMD="cdk deploy --context environment=$ENVIRONMENT --require-approval never --outputs-file cdk-outputs.json"

if [ "$CI_MODE" = "false" ]; then
    CDK_DEPLOY_CMD="$CDK_DEPLOY_CMD --profile $PROFILE"
fi

# Deploy stack
echo -e "${BLUE}🚀 Deploying stack...${NC}"
eval $CDK_DEPLOY_CMD

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Deployment successful!${NC}"
    echo ""
    
    # Display outputs
    if [ -f "cdk-outputs.json" ]; then
        echo -e "${BLUE}📋 Stack Outputs:${NC}"
        
        # Check if jq is available
        if command -v jq &> /dev/null; then
            cat cdk-outputs.json | jq -r 'to_entries[] | .value | to_entries[] | "  \(.key): \(.value)"'
        else
            echo "  (Install jq for formatted output)"
            cat cdk-outputs.json
        fi
        echo ""
        
        # Extract API URL for Android app configuration
        if command -v jq &> /dev/null; then
            API_URL=$(cat cdk-outputs.json | jq -r '.[] | .ApiUrl // empty')
            USER_POOL_ID=$(cat cdk-outputs.json | jq -r '.[] | .UserPoolId // empty')
            USER_POOL_CLIENT_ID=$(cat cdk-outputs.json | jq -r '.[] | .UserPoolClientId // empty')
            
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
        fi
    fi
    
    echo -e "${GREEN}🎉 Glaceon API is now live!${NC}"
    
    # In CI mode, create a summary
    if [ "$CI_MODE" = "true" ] && [ ! -z "$GITHUB_STEP_SUMMARY" ]; then
        echo "## 🚀 Deployment Summary" >> $GITHUB_STEP_SUMMARY
        echo "" >> $GITHUB_STEP_SUMMARY
        echo "- **Environment:** $ENVIRONMENT" >> $GITHUB_STEP_SUMMARY
        echo "- **Region:** $REGION" >> $GITHUB_STEP_SUMMARY
        echo "- **Account:** $ACCOUNT_ID" >> $GITHUB_STEP_SUMMARY
        
        if [ ! -z "$API_URL" ]; then
            echo "- **API URL:** $API_URL" >> $GITHUB_STEP_SUMMARY
        fi
        
        echo "" >> $GITHUB_STEP_SUMMARY
        echo "✅ Deployment completed successfully!" >> $GITHUB_STEP_SUMMARY
    fi
    
else
    echo -e "${RED}❌ Deployment failed${NC}"
    exit 1
fi
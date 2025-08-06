#!/bin/bash

# テストユーザーを削除するスクリプト
USER_POOL_ID="ap-northeast-1_ljl94EBCM"
REGION="ap-northeast-1"

# 削除対象のテストユーザー名（パターンマッチング）
TEST_USERS=(
    "testuser"
    "testuser2"
    "testuser3"
    "testuser4"
    "frederic170617"
    "frederic"
    "redmagic0099"
    "redmagic"
    "re"
)

echo "🧹 Cleaning up test users from Cognito User Pool..."

for username in "${TEST_USERS[@]}"; do
    echo "Deleting user: $username"
    aws cognito-idp admin-delete-user \
        --user-pool-id $USER_POOL_ID \
        --username $username \
        --region $REGION 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "✅ Successfully deleted: $username"
    else
        echo "⚠️  User not found or already deleted: $username"
    fi
done

echo ""
echo "🔍 Remaining users in the pool:"
aws cognito-idp list-users --user-pool-id $USER_POOL_ID --region $REGION --query 'Users[].Username' --output table
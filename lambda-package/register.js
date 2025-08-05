const { 
    CognitoIdentityProviderClient, 
    SignUpCommand, 
    ConfirmSignUpCommand, 
    ResendConfirmationCodeCommand,
    ForgotPasswordCommand,
    ConfirmForgotPasswordCommand
} = require('@aws-sdk/client-cognito-identity-provider');
const { createErrorResponse, createSuccessResponse } = require('./auth');
const { getAWSConfig } = require('./aws-config');

const awsConfig = getAWSConfig();
const cognitoClient = new CognitoIdentityProviderClient(awsConfig);

exports.handler = async (event) => {
    try {
        const { action, ...params } = JSON.parse(event.body);

        switch (action) {
            case 'signup':
            case 'register':  // Androidアプリとの互換性のためのエイリアス
                return await handleSignUp(params);
            case 'confirm':
                return await handleConfirmSignUp(params);
            case 'resend':
                return await handleResendConfirmation(params);
            case 'forgot-password':
                return await handleForgotPassword(params);
            case 'reset-password':
                return await handleResetPassword(params);
            default:
                return createErrorResponse(400, 'Invalid action. Use: signup, register, confirm, resend, forgot-password, or reset-password');
        }

    } catch (error) {
        console.error('Registration error:', error);
        return createErrorResponse(500, `Internal server error: ${error.message}`);
    }
};

// 新規ユーザー登録
const handleSignUp = async ({ email, password, username, givenName, familyName }) => {
    try {
        if (!email || !password || !username) {
            return createErrorResponse(400, 'email, password, and username are required');
        }

        // パスワード強度チェック
        if (password.length < 8) {
            return createErrorResponse(400, 'Password must be at least 8 characters long');
        }

        const userAttributes = [
            {
                Name: 'email',
                Value: email
            }
        ];

        // オプション属性を追加
        if (givenName) {
            userAttributes.push({
                Name: 'given_name',
                Value: givenName
            });
        }

        if (familyName) {
            userAttributes.push({
                Name: 'family_name',
                Value: familyName
            });
        }

        const signUpParams = {
            ClientId: process.env.USER_POOL_CLIENT_ID,
            Username: username,
            Password: password,
            UserAttributes: userAttributes
        };

        const response = await cognitoClient.send(new SignUpCommand(signUpParams));

        return createSuccessResponse({
            message: 'User registered successfully. Please check your email for verification code.',
            userId: response.UserSub,
            username: username,
            email: email,
            confirmationRequired: !response.UserConfirmed
        }, 201);

    } catch (error) {
        console.error('SignUp error:', error);
        
        // Cognitoエラーを分かりやすいメッセージに変換
        let errorMessage = error.message;
        
        if (error.name === 'UsernameExistsException') {
            errorMessage = 'Username already exists';
        } else if (error.name === 'InvalidPasswordException') {
            errorMessage = 'Password does not meet requirements';
        } else if (error.name === 'InvalidParameterException') {
            errorMessage = 'Invalid email format or parameter';
        }

        return createErrorResponse(400, errorMessage);
    }
};

// メール認証コード確認
const handleConfirmSignUp = async ({ username, confirmationCode }) => {
    try {
        if (!username || !confirmationCode) {
            return createErrorResponse(400, 'username and confirmationCode are required');
        }

        const confirmParams = {
            ClientId: process.env.USER_POOL_CLIENT_ID,
            Username: username,
            ConfirmationCode: confirmationCode
        };

        await cognitoClient.send(new ConfirmSignUpCommand(confirmParams));

        return createSuccessResponse({
            message: 'Email verified successfully. You can now sign in.',
            username: username,
            confirmed: true
        });

    } catch (error) {
        console.error('ConfirmSignUp error:', error);
        
        let errorMessage = error.message;
        
        if (error.name === 'CodeMismatchException') {
            errorMessage = 'Invalid verification code';
        } else if (error.name === 'ExpiredCodeException') {
            errorMessage = 'Verification code has expired';
        } else if (error.name === 'UserNotFoundException') {
            errorMessage = 'User not found';
        }

        return createErrorResponse(400, errorMessage);
    }
};

// 認証コード再送信
const handleResendConfirmation = async ({ username }) => {
    try {
        if (!username) {
            return createErrorResponse(400, 'username is required');
        }

        const resendParams = {
            ClientId: process.env.USER_POOL_CLIENT_ID,
            Username: username
        };

        await cognitoClient.send(new ResendConfirmationCodeCommand(resendParams));

        return createSuccessResponse({
            message: 'Verification code resent. Please check your email.',
            username: username
        });

    } catch (error) {
        console.error('ResendConfirmation error:', error);
        
        let errorMessage = error.message;
        
        if (error.name === 'UserNotFoundException') {
            errorMessage = 'User not found';
        } else if (error.name === 'InvalidParameterException') {
            errorMessage = 'User is already confirmed';
        }

        return createErrorResponse(400, errorMessage);
    }
};

// パスワードリセット要求
const handleForgotPassword = async ({ username }) => {
    try {
        if (!username) {
            return createErrorResponse(400, 'username is required');
        }

        const forgotPasswordParams = {
            ClientId: process.env.USER_POOL_CLIENT_ID,
            Username: username
        };

        await cognitoClient.send(new ForgotPasswordCommand(forgotPasswordParams));

        return createSuccessResponse({
            message: 'Password reset code sent to your email. Please check your inbox.',
            username: username,
            nextStep: 'Enter the verification code and new password to complete the reset.'
        });

    } catch (error) {
        console.error('ForgotPassword error:', error);
        
        let errorMessage = error.message;
        
        if (error.name === 'UserNotFoundException') {
            errorMessage = 'User not found';
        } else if (error.name === 'InvalidParameterException') {
            errorMessage = 'Invalid username format';
        } else if (error.name === 'LimitExceededException') {
            errorMessage = 'Too many requests. Please try again later.';
        } else if (error.name === 'NotAuthorizedException') {
            errorMessage = 'User account is not confirmed or disabled';
        }

        return createErrorResponse(400, errorMessage);
    }
};

// パスワードリセット確認
const handleResetPassword = async ({ username, confirmationCode, newPassword }) => {
    try {
        if (!username || !confirmationCode || !newPassword) {
            return createErrorResponse(400, 'username, confirmationCode, and newPassword are required');
        }

        // パスワード強度チェック
        if (newPassword.length < 8) {
            return createErrorResponse(400, 'New password must be at least 8 characters long');
        }

        // パスワード複雑性チェック
        const hasUpperCase = /[A-Z]/.test(newPassword);
        const hasLowerCase = /[a-z]/.test(newPassword);
        const hasNumbers = /\d/.test(newPassword);
        
        if (!hasUpperCase || !hasLowerCase || !hasNumbers) {
            return createErrorResponse(400, 'Password must contain at least one uppercase letter, one lowercase letter, and one number');
        }

        const confirmForgotPasswordParams = {
            ClientId: process.env.USER_POOL_CLIENT_ID,
            Username: username,
            ConfirmationCode: confirmationCode,
            Password: newPassword
        };

        await cognitoClient.send(new ConfirmForgotPasswordCommand(confirmForgotPasswordParams));

        return createSuccessResponse({
            message: 'Password reset successfully. You can now sign in with your new password.',
            username: username,
            passwordReset: true
        });

    } catch (error) {
        console.error('ConfirmForgotPassword error:', error);
        
        let errorMessage = error.message;
        
        if (error.name === 'CodeMismatchException') {
            errorMessage = 'Invalid verification code';
        } else if (error.name === 'ExpiredCodeException') {
            errorMessage = 'Verification code has expired. Please request a new one.';
        } else if (error.name === 'UserNotFoundException') {
            errorMessage = 'User not found';
        } else if (error.name === 'InvalidPasswordException') {
            errorMessage = 'Password does not meet requirements';
        } else if (error.name === 'LimitExceededException') {
            errorMessage = 'Too many attempts. Please try again later.';
        }

        return createErrorResponse(400, errorMessage);
    }
};
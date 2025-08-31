const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { getAWSConfig } = require('./aws-config');

const awsConfig = getAWSConfig();
const sesClient = new SESClient(awsConfig);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

// 復元完了通知を送信
const sendRestoreCompleteNotification = async (userId, archiveId, fileName) => {
    try {
        // ユーザー情報を取得
        const userResponse = await dynamoClient.send(new GetCommand({
            TableName: process.env.CUSTOMER_TABLE,
            Key: { userId }
        }));

        // 顧客情報がない場合はテスト用のデフォルト値を使用
        let userEmail, userName;
        
        if (!userResponse.Item || !userResponse.Item.email) {
            console.log(`No customer info found for user: ${userId}, using test defaults`);
            // テスト用のデフォルト値（実際の運用では削除）
            userEmail = 'frederic170617@gmail.com'; // あなたの実際のメールアドレスに変更してください
            userName = 'テストユーザー';
        } else {
            userEmail = userResponse.Item.email;
            userName = userResponse.Item.name || 'ユーザー';
        }

        // 通知設定を確認（オプション）
        const notificationEnabled = userResponse.Item?.notificationSettings?.restoreComplete !== false;
        if (userResponse.Item && !notificationEnabled) {
            console.log(`Restore notification disabled for user: ${userId}`);
            return false;
        }

        // メール送信
        const emailParams = {
            Source: process.env.FROM_EMAIL || 'noreply@glacierarchive.com',
            Destination: {
                ToAddresses: [userEmail]
            },
            Message: {
                Subject: {
                    Data: '📁 ファイル復元完了のお知らせ',
                    Charset: 'UTF-8'
                },
                Body: {
                    Html: {
                        Data: createRestoreCompleteEmailHtml(userName, fileName, archiveId),
                        Charset: 'UTF-8'
                    },
                    Text: {
                        Data: createRestoreCompleteEmailText(userName, fileName),
                        Charset: 'UTF-8'
                    }
                }
            }
        };

        await sesClient.send(new SendEmailCommand(emailParams));
        
        console.log(`Restore complete notification sent to: ${userEmail} for file: ${fileName}`);
        return true;

    } catch (error) {
        console.error('Send restore notification error:', error);
        return false;
    }
};

// HTMLメール本文を生成
const createRestoreCompleteEmailHtml = (userName, fileName, archiveId) => {
    const appUrl = process.env.APP_URL || 'https://yourapp.com';
    
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>ファイル復元完了</title>
    <style>
        body { font-family: 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 10px 10px; }
        .file-info { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #28a745; }
        .download-btn { display: inline-block; background: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 20px 0; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 6px; margin: 20px 0; }
        .footer { text-align: center; color: #666; font-size: 12px; margin-top: 30px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📁 ファイル復元完了</h1>
            <p>お待たせしました！ファイルのダウンロードが可能になりました</p>
        </div>
        
        <div class="content">
            <p>こんにちは、${userName}さん</p>
            
            <div class="file-info">
                <h3>📄 復元完了ファイル</h3>
                <p><strong>${fileName}</strong></p>
                <p>復元ID: <code>${archiveId}</code></p>
            </div>
            
            <div class="warning">
                <h4>⏰ 重要：ダウンロード期限について</h4>
                <p>復元されたファイルは<strong>約18時間後</strong>に自動的に再アーカイブされます。</p>
                <p>お早めにダウンロードしてください。</p>
            </div>
            
            <div style="text-align: center;">
                <a href="${appUrl}/archive/${archiveId}" class="download-btn">
                    📥 今すぐダウンロード
                </a>
            </div>
            
            <p>アプリからもダウンロードできます：</p>
            <ol>
                <li>Glacier Archiveアプリを開く</li>
                <li>アーカイブ一覧から該当ファイルを選択</li>
                <li>「ダウンロード」ボタンをタップ</li>
            </ol>
        </div>
        
        <div class="footer">
            <p>このメールは自動送信されています。</p>
            <p>通知設定の変更は、アプリの設定画面から行えます。</p>
        </div>
    </div>
</body>
</html>`;
};

// テキストメール本文を生成
const createRestoreCompleteEmailText = (userName, fileName) => {
    return `
こんにちは、${userName}さん

ファイル復元完了のお知らせ

復元完了ファイル: ${fileName}

復元されたファイルのダウンロードが可能になりました。

【重要】ダウンロード期限について
復元されたファイルは約18時間後に自動的に再アーカイブされます。
お早めにダウンロードしてください。

ダウンロード方法：
1. Glacier Archiveアプリを開く
2. アーカイブ一覧から該当ファイルを選択  
3. 「ダウンロード」ボタンをタップ

このメールは自動送信されています。
通知設定の変更は、アプリの設定画面から行えます。

Glacier Archive チーム
`;
};

module.exports = {
    sendRestoreCompleteNotification
};
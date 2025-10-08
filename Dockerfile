FROM node:22-alpine

ENV NODE_ENV=development

# 作業ディレクトリを設定
WORKDIR /app

# package.jsonとpackage-lock.jsonをコピー
COPY package*.json ./

# 依存関係をインストール（開発環境用）
RUN npm install

# アプリケーションのソースコードをコピー
COPY . .

# ポート3000を公開
EXPOSE 3000

# デフォルトコマンド
CMD ["npm", "run", "dev"]
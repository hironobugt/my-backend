# Branching Strategy

## 🌿 Branch Structure

```
main (production)
├── develop (development)
├── feature/payment-integration
├── feature/file-upload-optimization
└── hotfix/critical-bug-fix
```

## 🚀 Deployment Flow

### Development Deployment
- **Trigger:** Push to `develop` branch
- **Environment:** Development AWS account
- **Stripe:** Test mode
- **URL:** `https://xxx-dev.execute-api.ap-northeast-1.amazonaws.com/dev/`

### Production Deployment  
- **Trigger:** Push to `main` branch
- **Environment:** Production AWS account
- **Stripe:** Live mode
- **URL:** `https://xxx-prod.execute-api.ap-northeast-1.amazonaws.com/prod/`

## 📋 Workflow

### Feature Development
```bash
# 1. Create feature branch from develop
git checkout develop
git pull origin develop
git checkout -b feature/new-feature

# 2. Develop and commit
git add .
git commit -m "feat: add new feature"
git push origin feature/new-feature

# 3. Create PR to develop
# → Triggers development deployment for testing

# 4. Merge to develop
# → Automatically deploys to development environment
```

### Production Release
```bash
# 1. Create PR from develop to main
git checkout main
git pull origin main
git checkout develop
git pull origin develop

# Create PR: develop → main

# 2. Merge to main
# → Automatically deploys to production environment
# → Creates GitHub release
```

### Hotfix
```bash
# 1. Create hotfix branch from main
git checkout main
git pull origin main
git checkout -b hotfix/critical-fix

# 2. Fix and commit
git add .
git commit -m "fix: critical bug fix"
git push origin hotfix/critical-fix

# 3. Create PR to main
# → Triggers production deployment

# 4. Also merge back to develop
git checkout develop
git merge hotfix/critical-fix
git push origin develop
```

## 🔄 Manual Deployment

You can also trigger deployments manually:

1. Go to **Actions** tab in GitHub
2. Select **Deploy Glaceon API** workflow
3. Click **Run workflow**
4. Choose environment (dev/prod)
5. Click **Run workflow**

## 🛡️ Branch Protection

Recommended branch protection rules:

### `main` branch:
- Require pull request reviews
- Require status checks to pass
- Require branches to be up to date
- Restrict pushes to admins only

### `develop` branch:
- Require pull request reviews
- Require status checks to pass
- Allow force pushes (for development flexibility)
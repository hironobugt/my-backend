#!/bin/bash

# Glacier Archive API - Moto Development Environment
# Docker Composeを使ってmotoとアプリケーションを起動

set -e

# 色付きログ用の関数
log_info() {
    echo -e "\033[1;34m[INFO]\033[0m $1"
}

log_success() {
    echo -e "\033[1;32m[SUCCESS]\033[0m $1"
}

log_error() {
    echo -e "\033[1;31m[ERROR]\033[0m $1"
}

log_warning() {
    echo -e "\033[1;33m[WARNING]\033[0m $1"
}

# ヘルプ表示
show_help() {
    echo "Glacier Archive API - Moto Development Environment"
    echo ""
    echo "Usage: $0 [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  start     Start moto server and application"
    echo "  stop      Stop all services"
    echo "  restart   Restart all services"
    echo "  setup     Setup AWS resources in moto"
    echo "  test      Run API tests"
    echo "  logs      Show application logs"
    echo "  clean     Clean up Docker containers and volumes"
    echo "  status    Show service status"
    echo "  help      Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 start    # Start development environment"
    echo "  $0 test     # Run API tests"
    echo "  $0 clean    # Clean up everything"
}

# サービス状態確認
check_status() {
    log_info "Checking service status..."
    
    if docker compose ps | grep -q "Up"; then
        log_success "Services are running:"
        docker compose ps
    else
        log_warning "No services are currently running"
        docker compose ps
    fi
}

# moto環境の起動
start_services() {
    log_info "Starting Glacier Archive API with moto..."
    
    # 既存のコンテナを停止
    docker compose down 2>/dev/null || true
    
    # motoサーバーを起動
    log_info "Starting moto server..."
    docker compose up -d moto
    
    # motoの起動を待機
    log_info "Waiting for moto server to be ready..."
    timeout=60
    counter=0
    while ! curl -s http://localhost:5000 >/dev/null 2>&1; do
        if [ $counter -ge $timeout ]; then
            log_error "Moto server failed to start within $timeout seconds"
            exit 1
        fi
        sleep 1
        counter=$((counter + 1))
        echo -n "."
    done
    echo ""
    log_success "Moto server is ready!"
    
    # AWSリソースをセットアップ
    log_info "Setting up AWS resources..."
    docker compose run --rm setup
    
    # アプリケーションを起動
    log_info "Starting application server..."
    docker compose up -d app
    
    log_success "All services started successfully!"
    log_info "API is available at: http://localhost:3000"
    log_info "Moto server is available at: http://localhost:5000"
    
    # サービス状態を表示
    check_status
}

# サービス停止
stop_services() {
    log_info "Stopping all services..."
    docker compose down
    log_success "All services stopped"
}

# サービス再起動
restart_services() {
    log_info "Restarting services..."
    stop_services
    start_services
}

# AWSリソースセットアップ
setup_resources() {
    log_info "Setting up AWS resources in moto..."
    
    # motoが起動しているか確認
    if ! curl -s http://localhost:5000 >/dev/null 2>&1; then
        log_error "Moto server is not running. Please start it first with: $0 start"
        exit 1
    fi
    
    docker compose run --rm setup
    log_success "AWS resources setup completed"
}

# APIテスト実行
run_tests() {
    log_info "Running API tests..."
    
    # サービスが起動しているか確認
    if ! curl -s http://localhost:3000/health >/dev/null 2>&1; then
        log_error "Application is not running. Please start it first with: $0 start"
        exit 1
    fi
    
    log_info "Testing API endpoints..."
    
    # ヘルスチェック
    echo "1. Health Check:"
    curl -s http://localhost:3000/health | jq '.' || echo "Failed"
    echo ""
    
    # API情報
    echo "2. API Info:"
    curl -s http://localhost:3000/ | jq '.' || echo "Failed"
    echo ""
    
    # 認証テスト（アーカイブ一覧）
    echo "3. Archive List (with auth):"
    curl -s -H "Authorization: Bearer mock-token" \
         -H "Content-Type: application/json" \
         http://localhost:3000/archive/list | jq '.' || echo "Failed"
    echo ""
    
    # ユーザー登録テスト
    echo "4. User Registration:"
    curl -s -X POST \
         -H "Content-Type: application/json" \
         -d '{"action":"signup","email":"test@example.com","password":"TestPass123","username":"testuser"}' \
         http://localhost:3000/auth/register | jq '.' || echo "Failed"
    echo ""
    
    log_success "API tests completed"
}

# ログ表示
show_logs() {
    log_info "Showing application logs..."
    docker compose logs -f app
}

# クリーンアップ
clean_up() {
    log_warning "This will remove all Docker containers, images, and volumes related to this project"
    read -p "Are you sure? (y/N): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        log_info "Cleaning up Docker resources..."
        docker compose down -v --rmi all --remove-orphans 2>/dev/null || true
        docker system prune -f 2>/dev/null || true
        log_success "Cleanup completed"
    else
        log_info "Cleanup cancelled"
    fi
}

# メイン処理
main() {
    case "${1:-help}" in
        start)
            start_services
            ;;
        stop)
            stop_services
            ;;
        restart)
            restart_services
            ;;
        setup)
            setup_resources
            ;;
        test)
            run_tests
            ;;
        logs)
            show_logs
            ;;
        clean)
            clean_up
            ;;
        status)
            check_status
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "Unknown command: $1"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

# スクリプト実行
main "$@"
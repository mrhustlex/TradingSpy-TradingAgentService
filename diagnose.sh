#!/bin/bash

# TradingSpy Diagnostic Script
# Run this to quickly identify issues

echo "TradingSpy Diagnostic Report"
echo "=========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check Docker
echo "📦 Docker Status"
echo "----------------"
if command -v docker &> /dev/null; then
    echo -e "${GREEN}✓${NC} Docker installed: $(docker --version)"
else
    echo -e "${RED}✗${NC} Docker not found"
    exit 1
fi

if command -v docker compose &> /dev/null; then
    echo -e "${GREEN}✓${NC} Docker Compose installed: $(docker compose version)"
else
    echo -e "${RED}✗${NC} Docker Compose not found"
    exit 1
fi
echo ""

# Check Containers
echo "🐳 Container Status"
echo "-------------------"
CONTAINERS=$(docker compose ps --format json 2>/dev/null)
if [ $? -eq 0 ]; then
    BACKEND_STATUS=$(docker compose ps backend --format "{{.State}}" 2>/dev/null)
    FRONTEND_STATUS=$(docker compose ps frontend --format "{{.State}}" 2>/dev/null)
    SEARXNG_STATUS=$(docker compose ps searxng --format "{{.State}}" 2>/dev/null)
    
    if [ "$BACKEND_STATUS" = "running" ]; then
        echo -e "${GREEN}✓${NC} Backend: Running"
    else
        echo -e "${RED}✗${NC} Backend: $BACKEND_STATUS"
    fi
    
    if [ "$FRONTEND_STATUS" = "running" ]; then
        echo -e "${GREEN}✓${NC} Frontend: Running"
    else
        echo -e "${RED}✗${NC} Frontend: $FRONTEND_STATUS"
    fi
    
    if [ "$SEARXNG_STATUS" = "running" ]; then
        echo -e "${GREEN}✓${NC} SearXNG: Running"
    else
        echo -e "${YELLOW}⚠${NC} SearXNG: $SEARXNG_STATUS (optional)"
    fi
else
    echo -e "${RED}✗${NC} No containers running. Start with: docker compose up -d"
fi
echo ""

# Check Ports
echo "🔌 Port Availability"
echo "--------------------"
check_port() {
    PORT=$1
    NAME=$2
    if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} Port $PORT ($NAME): In use"
    else
        echo -e "${YELLOW}⚠${NC} Port $PORT ($NAME): Not listening"
    fi
}

check_port 3000 "Frontend"
check_port 8000 "Backend"
check_port 8080 "SearXNG"
echo ""

# Check Backend Health
echo "🏥 Backend Health Check"
echo "-----------------------"
HEALTH_RESPONSE=$(curl -s http://localhost:8000/health 2>/dev/null)
if [ $? -eq 0 ]; then
    if echo "$HEALTH_RESPONSE" | grep -q "ok"; then
        echo -e "${GREEN}✓${NC} Backend health: OK"
        echo "   Response: $HEALTH_RESPONSE"
    else
        echo -e "${YELLOW}⚠${NC} Backend responding but health check failed"
        echo "   Response: $HEALTH_RESPONSE"
    fi
else
    echo -e "${RED}✗${NC} Backend not responding"
    echo "   Try: docker compose logs backend"
fi
echo ""

# Check Frontend
echo "🌐 Frontend Check"
echo "-----------------"
FRONTEND_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null)
if [ "$FRONTEND_RESPONSE" = "200" ]; then
    echo -e "${GREEN}✓${NC} Frontend: Accessible (HTTP $FRONTEND_RESPONSE)"
elif [ "$FRONTEND_RESPONSE" = "000" ]; then
    echo -e "${RED}✗${NC} Frontend: Not responding"
else
    echo -e "${YELLOW}⚠${NC} Frontend: HTTP $FRONTEND_RESPONSE"
fi
echo ""

# Check Environment
echo "🔐 Environment Variables"
echo "------------------------"
if [ -f .env ]; then
    echo -e "${GREEN}✓${NC} .env file exists"
    
    # Check for API keys (without showing values)
    if grep -q "MISTRAL_API_KEY=" .env && [ -n "$(grep "MISTRAL_API_KEY=" .env | cut -d'=' -f2)" ]; then
        echo -e "${GREEN}✓${NC} MISTRAL_API_KEY: Set"
    else
        echo -e "${YELLOW}⚠${NC} MISTRAL_API_KEY: Not set"
    fi
    
    if grep -q "OPENAI_API_KEY=" .env && [ -n "$(grep "OPENAI_API_KEY=" .env | cut -d'=' -f2)" ]; then
        echo -e "${GREEN}✓${NC} OPENAI_API_KEY: Set"
    else
        echo -e "${YELLOW}⚠${NC} OPENAI_API_KEY: Not set"
    fi
    
    if grep -q "DEFAULT_PROVIDER=" .env && [ -n "$(grep "DEFAULT_PROVIDER=" .env | cut -d'=' -f2)" ]; then
        PROVIDER=$(grep "DEFAULT_PROVIDER=" .env | cut -d'=' -f2)
        echo -e "${GREEN}✓${NC} DEFAULT_PROVIDER: $PROVIDER"
    else
        echo -e "${YELLOW}⚠${NC} DEFAULT_PROVIDER: Not set"
    fi
else
    echo -e "${RED}✗${NC} .env file not found"
    echo "   Copy .env.example to .env and configure"
fi
echo ""

# Check Recent Errors
echo "⚠️  Recent Backend Errors"
echo "-------------------------"
if docker compose ps backend --format "{{.State}}" 2>/dev/null | grep -q "running"; then
    ERRORS=$(docker compose logs backend --tail=50 2>/dev/null | grep -i "error" | tail -5)
    if [ -z "$ERRORS" ]; then
        echo -e "${GREEN}✓${NC} No recent errors"
    else
        echo -e "${YELLOW}⚠${NC} Found errors in logs:"
        echo "$ERRORS" | while IFS= read -r line; do
            echo "   $line"
        done
    fi
else
    echo -e "${YELLOW}⚠${NC} Backend not running, cannot check logs"
fi
echo ""

# Summary
echo "📊 Summary"
echo "----------"
ALL_GOOD=true

if [ "$BACKEND_STATUS" != "running" ]; then
    ALL_GOOD=false
    echo -e "${RED}✗${NC} Backend is not running"
fi

if [ "$FRONTEND_STATUS" != "running" ]; then
    ALL_GOOD=false
    echo -e "${RED}✗${NC} Frontend is not running"
fi

if ! echo "$HEALTH_RESPONSE" | grep -q "ok" 2>/dev/null; then
    ALL_GOOD=false
    echo -e "${RED}✗${NC} Backend health check failed"
fi

if [ ! -f .env ]; then
    ALL_GOOD=false
    echo -e "${RED}✗${NC} .env file missing"
fi

if $ALL_GOOD; then
    echo -e "${GREEN}✓${NC} All systems operational!"
    echo ""
    echo "🚀 Quick Start:"
    echo "   Frontend: http://localhost:3000"
    echo "   Backend:  http://localhost:8000"
    echo "   API Docs: http://localhost:8000/docs"
else
    echo -e "${YELLOW}⚠${NC} Some issues detected. See above for details."
    echo ""
    echo "🔧 Common Fixes:"
    echo "   1. Start services:  docker compose up -d"
    echo "   2. View logs:       docker compose logs -f"
    echo "   3. Restart:         docker compose restart"
    echo "   4. Rebuild:         docker compose build --no-cache"
fi
echo ""

# Offer to show logs
echo "📋 Need more info?"
echo "------------------"
echo "View logs with:"
echo "  docker compose logs backend -f    # Backend logs"
echo "  docker compose logs frontend -f   # Frontend logs"
echo "  docker compose logs -f            # All logs"
echo ""
echo "Run tests with:"
echo "  cd debug_test && python3 server.py"
echo "  Then open: http://localhost:8001"
echo ""

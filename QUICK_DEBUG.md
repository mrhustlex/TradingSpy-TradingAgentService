# 🚨 Quick Debug Reference Card

## 🏥 Health Check (30 seconds)

```bash
# 1. Check containers
docker compose ps

# 2. Test backend
curl http://localhost:8000/health

# 3. Run diagnostics
./diagnose.sh

# 4. Test chat
./test_chat.sh
```

**Expected:** All ✅ green checkmarks

---

## 🔥 Common Problems → Quick Fixes

### Problem: ChatBot not responding
```bash
# Fix 1: Check API key in browser Settings tab
# Fix 2: Restart backend
docker compose restart backend

# Fix 3: Check logs
docker compose logs backend --tail=50
```

### Problem: Containers not running
```bash
docker compose up -d
```

### Problem: Port conflicts
```bash
# Stop everything
docker compose down

# Check ports
lsof -i :3000
lsof -i :8000
lsof -i :8080

# Restart
docker compose up -d
```

### Problem: Tools not working
```bash
# Check tool loading
docker compose logs backend | grep -i "tool"

# Restart backend
docker compose restart backend
```

### Problem: Streaming broken
```bash
# Check browser Network tab (F12)
# Look for EventStream connection
# Verify endpoint: /api/backtest/ai/chat-with-tools
```

---

## 📊 Quick Status Check

```bash
# One-liner status check
docker compose ps && curl -s http://localhost:8000/health && echo " ✅ All good!"
```

---

## 🔧 Emergency Reset

```bash
# Nuclear option - rebuild everything
docker compose down
docker compose build --no-cache
docker compose up -d

# Wait 30 seconds, then test
sleep 30 && curl http://localhost:8000/health
```

---

## 📱 Access Points

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Backend | http://localhost:8000 |
| API Docs | http://localhost:8000/docs |
| SearXNG | http://localhost:8080 |
| Debug Server | http://localhost:8001 (if started) |

---

## 🎯 Test Messages

Try these in ChatBot:

1. **Simple**: "What is 2+2?"
2. **Quote**: "What's the price of NVDA?"
3. **Analysis**: "Analyze TSLA"
4. **Full**: "Is AAPL bullish right now?"

---

## 📋 Logs Cheat Sheet

```bash
# All logs (real-time)
docker compose logs -f

# Backend only
docker compose logs backend -f

# Last 50 lines
docker compose logs --tail=50

# Errors only
docker compose logs | grep ERROR

# Tool execution
docker compose logs backend | grep "Tool"

# LLM calls
docker compose logs backend | grep "LLM Call"
```

---

## 🔑 API Key Check

```bash
# Check if keys are set in .env
grep "MISTRAL_API_KEY" .env
grep "OPENAI_API_KEY" .env

# Test Mistral key
curl https://api.mistral.ai/v1/models \
  -H "Authorization: Bearer YOUR_KEY"
```

---

## 🐛 Debug Mode

```bash
# Start debug test server
cd debug_test
python3 server.py

# Open in browser
open http://localhost:8001

# Run all 4 tests
# Switch between Test Server (8001) and Docker Backend (8000)
```

---

## ⚡ Performance Issues

```bash
# Check resource usage
docker stats

# Restart to free memory
docker compose restart

# Clear old data
docker system prune -a
```

---

## 🆘 Still Stuck?

1. Run full diagnostics:
   ```bash
   ./diagnose.sh > debug_report.txt
   ./test_chat.sh >> debug_report.txt
   docker compose logs --tail=100 >> debug_report.txt
   ```

2. Check browser console (F12 → Console)

3. Check browser network tab (F12 → Network)

4. Read DEBUG_GUIDE.md for detailed help

5. Read DEBUGGING_SUMMARY.md for comprehensive guide

---

## ✅ Success Indicators

You're good when you see:

- ✅ `docker compose ps` shows all "running"
- ✅ `curl http://localhost:8000/health` returns `{"status":"ok"}`
- ✅ Frontend loads at http://localhost:3000
- ✅ ChatBot responds to messages
- ✅ No errors in browser console
- ✅ Backend logs show tool executions

---

**Quick Start:** `docker compose up -d && ./diagnose.sh`

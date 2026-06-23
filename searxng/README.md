# SearXNG Integration - Free, Lightweight Web Search

## What is SearXNG?

SearXNG is a **free, open-source metasearch engine** that:
- ✅ **Aggregates results** from Google, Bing, DuckDuckGo, Brave, and 70+ engines
- ✅ **No API keys needed** - completely free
- ✅ **Privacy-focused** - no tracking, no ads
- ✅ **Self-hosted** - runs in Docker alongside your app
- ✅ **Lightweight** - ~50MB Docker image
- ✅ **Fast** - parallel queries to multiple engines

## Why SearXNG?

| Feature | SearXNG | Tavily | DuckDuckGo API |
|---------|---------|--------|----------------|
| Cost | Free | 1000/month free | Free but limited |
| Setup | Docker | API key | No setup |
| Quality | Excellent (multi-engine) | Excellent (AI) | Good |
| Speed | Fast | Fast | Slow |
| Privacy | High | Medium | High |

## Architecture

```
User asks: "Search for NVDA earnings news"
    ↓
web_search tool tries in order:
    1. SearXNG (self-hosted) ← PRIMARY
    2. Tavily (if API key set) ← FALLBACK 1
    3. DuckDuckGo API ← FALLBACK 2
    ↓
Returns aggregated results from multiple engines
```

## Setup (2 minutes)

### Option 1: Integrated Setup (Recommended)

SearXNG is already configured in the main `docker-compose.yml`. Just start everything:

```bash
docker-compose up -d
```

This starts:
- Backend (port 8000)
- Frontend (port 3000)
- SearXNG (port 8080) ← NEW

### Option 2: Standalone Setup

If you want to run SearXNG separately:

```bash
cd searxng
docker-compose up -d
```

## Verify It's Working

1. **Check SearXNG is running**:
```bash
curl http://localhost:8080/healthz
# Should return: OK
```

2. **Test search directly**:
```bash
curl "http://localhost:8080/search?q=NVDA+earnings&format=json" | jq
```

3. **Test via ChatBot**:
```
User: "Search for the latest AI chip news"
```

You should see in logs:
```
INFO: web_search via SearXNG: 8 results
```

## Configuration

### Customize Search Engines

Edit `searxng/settings.yml` to enable/disable engines:

```yaml
engines:
  - name: google
    disabled: false  # Change to true to disable
    
  - name: bing
    disabled: false
    
  - name: reddit
    disabled: false  # Great for sentiment analysis
```

### Performance Tuning

For faster searches, disable slow engines:

```yaml
engines:
  - name: youtube
    disabled: true  # Disable if you don't need video results
    
  - name: twitter
    disabled: true  # Often rate-limited
```

## Search Priority

The `web_search` tool tries engines in this order:

1. **SearXNG** (primary):
   - Aggregates Google, Bing, DuckDuckGo, Brave
   - No API key needed
   - Fast parallel queries
   - Best for general web search

2. **Tavily** (fallback 1):
   - AI-powered summaries
   - Requires API key (1000 free/month)
   - Best for research questions

3. **DuckDuckGo** (fallback 2):
   - Direct API, no key needed
   - Limited results
   - Slowest option

## Usage Examples

### Via ChatBot

```
User: "Search for Fed rate decision news"
AI: *uses web_search via SearXNG*
    Returns: 8 results from Google, Bing, DuckDuckGo, Brave

User: "What's the latest on semiconductor shortage?"
AI: *uses web_search via SearXNG*
    Returns: Aggregated news from multiple sources

User: "Search for NVDA analyst price targets"
AI: *uses web_search via SearXNG*
    Returns: Financial news and analyst reports
```

### Direct API Test

```bash
# Test SearXNG directly
curl "http://localhost:8080/search?q=TSLA+earnings&format=json&language=en" | jq '.results[] | {title, url, content}'
```

### Python Test

```python
import requests

response = requests.get(
    "http://localhost:8080/search",
    params={"q": "NVDA stock news", "format": "json", "language": "en"}
)

results = response.json()["results"]
for r in results[:5]:
    print(f"{r['title']}: {r['url']}")
```

## Advantages Over Other Solutions

### vs Tavily
- ✅ No API key needed
- ✅ No rate limits
- ✅ Aggregates more sources
- ❌ No AI-generated summaries (but you have LLM for that!)

### vs DuckDuckGo API
- ✅ More comprehensive results
- ✅ Faster (parallel queries)
- ✅ More sources (Google, Bing, Brave, etc.)
- ✅ Better for financial news

### vs Google Custom Search API
- ✅ Free (Google charges after 100 queries/day)
- ✅ No API key management
- ✅ More privacy-focused
- ✅ Aggregates multiple engines

## Monitoring

### Check SearXNG logs
```bash
docker logs searxng --tail 50 -f
```

### Check which engine was used
```bash
# In backend logs
docker logs tradingspy-service-backend-1 --tail 100 | grep "web_search via"
```

You'll see:
```
INFO: web_search via SearXNG: 8 results
```

## Troubleshooting

### SearXNG not starting
```bash
# Check logs
docker logs searxng

# Restart
docker-compose restart searxng
```

### Search returns no results
```bash
# Test directly
curl "http://localhost:8080/search?q=test&format=json"

# Check if engines are enabled in settings.yml
cat searxng/settings.yml | grep -A 3 "name: google"
```

### Slow searches
- Disable slow engines in `settings.yml`
- Reduce number of engines
- Check Docker resource allocation

## Resource Usage

SearXNG is very lightweight:
- **Memory**: ~50-100MB
- **CPU**: Minimal (only during searches)
- **Disk**: ~50MB image
- **Network**: Only when searching

## Privacy & Security

SearXNG:
- ✅ No tracking
- ✅ No logs (by default)
- ✅ No cookies
- ✅ Proxies requests (hides your IP from search engines)
- ✅ Open source (audit the code)

## Advanced Configuration

### Add More Engines

Edit `searxng/settings.yml`:

```yaml
engines:
  - name: yahoo
    engine: yahoo
    shortcut: yh
    disabled: false
    
  - name: qwant
    engine: qwant
    shortcut: qw
    disabled: false
```

See full list: https://docs.searxng.org/admin/engines/configured_engines.html

### Enable Categories

```yaml
categories_as_tabs:
  general:
  news:
  files:
  science:
```

### Custom Shortcuts

```yaml
engines:
  - name: google
    shortcut: g  # Use !g in search
    
  - name: reddit
    shortcut: r  # Use !r in search
```

## Integration with TradingSpy

The `web_search` tool automatically uses SearXNG:

```python
# In tool_calling_agent.py
@tool
def web_search(query: str) -> dict:
    # 1. Try SearXNG first (self-hosted, free)
    searxng_url = os.getenv("SEARXNG_URL", "http://searxng:8080")
    response = requests.get(f"{searxng_url}/search", ...)
    
    # 2. Fallback to Tavily if SearXNG fails
    # 3. Fallback to DuckDuckGo if both fail
```

## Cost Comparison

| Solution | Monthly Cost | Queries/Month | Notes |
|----------|--------------|---------------|-------|
| SearXNG | $0 | Unlimited | Self-hosted |
| Tavily | $0 (free tier) | 1,000 | Then $10/10k |
| Google CSE | $0 (free tier) | 100/day | Then $5/1k |
| Bing Search | $0 (free tier) | 1,000 | Then $7/1k |

**SearXNG wins**: Unlimited free searches!

## Maintenance

SearXNG requires minimal maintenance:

1. **Update occasionally**:
```bash
docker-compose pull searxng
docker-compose up -d searxng
```

2. **Monitor logs** (optional):
```bash
docker logs searxng --tail 100
```

3. **Backup settings** (optional):
```bash
cp searxng/settings.yml searxng/settings.yml.backup
```

## Uninstall

If you want to remove SearXNG:

```bash
# Stop and remove
docker-compose down searxng
docker rmi searxng/searxng:latest

# Remove config
rm -rf searxng/
```

Then remove from `docker-compose.yml`.

## Summary

✅ **Free** - No API keys, no rate limits
✅ **Fast** - Parallel queries to multiple engines
✅ **Private** - No tracking, self-hosted
✅ **Lightweight** - ~50MB, minimal resources
✅ **Reliable** - Fallback to Tavily/DuckDuckGo if needed
✅ **Easy** - One command to start

Perfect for trading AI that needs unlimited web search!

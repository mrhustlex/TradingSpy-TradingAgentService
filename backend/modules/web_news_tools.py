"""
Web search and news tools for the trading assistant
"""

from langchain_core.tools import tool
import yfinance as yf
import os
import requests
import logging
import ipaddress
import socket
from urllib.parse import urlparse, urljoin

logger = logging.getLogger(__name__)


def _validate_public_http_url(raw_url: str) -> str:
    parsed = urlparse(str(raw_url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Invalid URL")
    addr_infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    for info in addr_infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise ValueError("Private or local URLs are not allowed")
    return parsed.geturl()


@tool
def get_news(ticker: str, limit: int = 6) -> dict:
    """Get latest Yahoo Finance news headlines for a stock ticker.
    
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, MU
        limit: Number of headlines (default 6)
    
    Returns:
        dict with 'symbol' and 'news' list containing title, publisher, link
    """
    try:
        t = yf.Ticker(ticker.upper())
        news = t.news[:limit] if hasattr(t, 'news') and t.news else []
        formatted_news = []
        for item in news:
            formatted_news.append({
                "title": item.get("title", ""),
                "publisher": item.get("publisher", ""),
                "link": item.get("link", ""),
                "published": item.get("providerPublishTime", "")
            })
        return {"symbol": ticker.upper(), "news": formatted_news, "count": len(formatted_news)}
    except Exception as e:
        logger.error(f"get_news error for {ticker}: {e}")
        return {"symbol": ticker, "error": str(e), "news": []}


@tool
def web_search(query: str) -> dict:
    """Search the web for financial news, analysis, or any topic using SearXNG.
    Use this to find current news, analyst opinions, market sentiment, or research on any stock or topic.
    
    Args:
        query: Search query e.g. 'MU stock news today', 'NVDA analyst price target', 'Fed rate decision'
    
    Returns:
        dict with 'query', 'results' list (title, snippet, url, source), and 'source' (SearXNG)
    """
    try:
        # Use SearXNG (local meta search engine)
        searxng_url = os.getenv("SEARXNG_URL", "http://localhost:8080")
        logger.info(f"web_search: Using SearXNG at {searxng_url} for query: {query}")
        
        resp = requests.get(
            f"{searxng_url}/search",
            params={
                "q": query,
                "format": "json",
                "pageno": 1,
            },
            headers={"User-Agent": "Mozilla/5.0", "X-Forwarded-For": "127.0.0.1"},
            timeout=15,
        )
        
        logger.info(f"web_search: SearXNG response status {resp.status_code}")
        
        if resp.status_code != 200:
            logger.warning(f"SearXNG search failed with status {resp.status_code}, trying fallback")
            return _fallback_duckduckgo_search(query)
        
        data = resp.json()
        raw_results = data.get("results", [])
        logger.info(f"web_search: SearXNG returned {len(raw_results)} raw results")
        
        results = []
        
        # Process results from SearXNG
        for result in raw_results[:10]:
            snippet = result.get("content", "")
            if not snippet:
                snippet = result.get("title", "")
            
            results.append({
                "title": result.get("title", ""),
                "snippet": snippet[:300] if snippet else "",
                "url": result.get("url", ""),
                "source": result.get("engine", "SearXNG"),
            })
        
        logger.info(f"web_search: Processed {len(results)} results")
        
        if results:
            logger.info(f"web_search via SearXNG: {len(results)} results for '{query}'")
            return {"query": query, "results": results, "source": "SearXNG", "count": len(results)}
        else:
            logger.info(f"web_search via SearXNG: no results for '{query}'")
            return _fallback_duckduckgo_search(query)
    
    except Exception as e:
        logger.warning(f"SearXNG search error: {e}, trying fallback")
        import traceback
        logger.warning(f"Traceback: {traceback.format_exc()}")
        return _fallback_duckduckgo_search(query)


@tool
def fetch_website(url: str) -> dict:
    """Fetch and extract content from a website URL.
    Use this to get the full content from a specific URL found via web_search.
    
    Args:
        url: The website URL to fetch (e.g., 'https://example.com/article')
    
    Returns:
        dict with 'url', 'title', 'content', and 'status'
    """
    try:
        url = _validate_public_http_url(url)
        logger.info(f"fetch_website: Fetching {url}")
        
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        resp = None
        for _ in range(4):
            resp = requests.get(url, headers=headers, timeout=15, allow_redirects=False)
            if resp.status_code not in {301, 302, 303, 307, 308}:
                break
            location = resp.headers.get("location")
            if not location:
                break
            url = _validate_public_http_url(urljoin(url, location))
        if resp is None:
            return {"url": url, "error": "No response", "status": "failed"}
        
        if resp.status_code != 200:
            logger.warning(f"fetch_website: Failed with status {resp.status_code}")
            return {
                "url": url,
                "status": "error",
                "error": f"HTTP {resp.status_code}",
                "content": ""
            }
        
        # Try to extract title and content
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(resp.text, 'html.parser')
            
            # Get title
            title = ""
            if soup.title:
                title = soup.title.string
            elif soup.find('h1'):
                title = soup.find('h1').get_text()
            
            # Remove script and style elements
            for script in soup(["script", "style"]):
                script.decompose()
            
            # Get text
            text = soup.get_text()
            lines = (line.strip() for line in text.splitlines())
            chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
            content = ' '.join(chunk for chunk in chunks if chunk)
            
            # Limit content to first 2000 characters
            content = content[:2000]
            
            logger.info(f"fetch_website: Successfully fetched {len(content)} chars from {url}")
            
            return {
                "url": url,
                "status": "success",
                "title": title,
                "content": content,
                "length": len(content)
            }
        except ImportError:
            # BeautifulSoup not available, return raw text
            content = resp.text[:2000]
            return {
                "url": url,
                "status": "success",
                "title": "Content fetched",
                "content": content,
                "length": len(content),
                "note": "Raw HTML (BeautifulSoup not available)"
            }
    
    except Exception as e:
        logger.error(f"fetch_website error: {e}")
        return {
            "url": url,
            "status": "error",
            "error": str(e),
            "content": ""
        }


def _fallback_duckduckgo_search(query: str) -> dict:
    """Fallback to DuckDuckGo if SearXNG is unavailable"""
    try:
        resp = requests.get(
            "https://api.duckduckgo.com/",
            params={"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10,
        )
        if resp.status_code != 200:
            return {"error": f"Search failed: HTTP {resp.status_code}", "query": query, "results": []}

        data = resp.json()
        results = []

        # Abstract (main answer)
        if data.get("AbstractText"):
            results.append({
                "title": data.get("Heading", "Summary"),
                "snippet": data["AbstractText"],
                "url": data.get("AbstractURL", ""),
                "source": data.get("AbstractSource", ""),
            })

        # Related topics
        for topic in data.get("RelatedTopics", [])[:6]:
            if isinstance(topic, dict) and topic.get("Text"):
                results.append({
                    "title": topic.get("Text", "")[:80],
                    "snippet": topic.get("Text", ""),
                    "url": topic.get("FirstURL", ""),
                    "source": "DuckDuckGo",
                })

        if not results:
            logger.info(f"web_search via DuckDuckGo fallback: no results for '{query}'")
            return {
                "query": query,
                "message": "No instant results found. Try a more specific query or use get_news for ticker-specific news.",
                "results": [],
                "source": "DuckDuckGo",
                "count": 0
            }

        logger.info(f"web_search via DuckDuckGo fallback: {len(results)} results for '{query}'")
        return {"query": query, "results": results, "source": "DuckDuckGo", "count": len(results)}

    except Exception as e:
        logger.error(f"DuckDuckGo fallback error: {e}")
        return {"error": str(e), "query": query, "results": []}

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
import time
from io import BytesIO
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
def fetch_website(url: str, max_chars: int = 2000) -> dict:
    """Fetch and extract content from a website URL.
    Use this to get the full content from a specific URL found via web_search.
    
    Args:
        url: The website URL to fetch (e.g., 'https://example.com/article')
        max_chars: Maximum extracted text to return (bounded to 20,000)
    
    Returns:
        dict with 'url', 'title', 'content', and 'status'
    """
    try:
        url = _validate_public_http_url(url)
        max_chars = max(500, min(int(max_chars or 2000), 20000))
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
            
            content = content[:max_chars]
            
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
            content = resp.text[:max_chars]
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


@tool
def fetch_pdf_text(url: str, max_chars: int = 12000) -> dict:
    """Download a public PDF and extract a bounded amount of text."""
    try:
        url = _validate_public_http_url(url)
        max_chars = max(1000, min(int(max_chars or 12000), 20000))
        headers = {"User-Agent": "TradingSpy/1.0 (public research mode)"}
        response = None
        for _ in range(4):
            response = requests.get(url, headers=headers, timeout=25, allow_redirects=False)
            if response.status_code not in {301, 302, 303, 307, 308}:
                break
            location = response.headers.get("location")
            if not location:
                break
            url = _validate_public_http_url(urljoin(url, location))
        if response is None or response.status_code != 200:
            status = response.status_code if response is not None else "no response"
            return {"url": url, "status": "error", "error": f"HTTP {status}", "content": ""}
        if len(response.content) > 12 * 1024 * 1024:
            return {"url": url, "status": "error", "error": "PDF exceeds the 12 MB research limit", "content": ""}

        from pypdf import PdfReader
        reader = PdfReader(BytesIO(response.content))
        chunks = []
        for page in reader.pages[:20]:
            chunks.append(page.extract_text() or "")
            if sum(len(chunk) for chunk in chunks) >= max_chars:
                break
        content = " ".join(" ".join(chunks).split())[:max_chars]
        return {
            "url": url,
            "status": "success" if content else "error",
            "title": "PDF document",
            "content": content,
            "length": len(content),
            "pages_scanned": min(len(reader.pages), 20),
        }
    except Exception as exc:
        logger.warning("fetch_pdf_text error for %s: %s", url, exc)
        return {"url": url, "status": "error", "error": str(exc), "content": ""}


def _fallback_duckduckgo_search(query: str) -> dict:
    """Fallback to DuckDuckGo HTML search if SearXNG is unavailable.

    Uses html.duckduckgo.com/html/ to get actual search results with
    titles, snippets, and URLs (not just instant answers).
    """
    import re as _re
    try:
        from bs4 import BeautifulSoup as _BeautifulSoup
    except ImportError:
        _BeautifulSoup = None

    try:
        # Try HTML search first (real search results)
        if _BeautifulSoup:
            html_results = _scrape_duckduckgo_html(query)
            if html_results and len(html_results) > 0:
                logger.info(
                    "web_search via DuckDuckGo HTML fallback: %s results for '%s'",
                    len(html_results), query,
                )
                return {
                    "query": query,
                    "results": html_results,
                    "source": "DuckDuckGo",
                    "count": len(html_results),
                }

        # Fall back to instant answer API
        resp = None
        for attempt in range(3):
            resp = requests.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"},
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                    "Accept": "application/json,text/plain,*/*",
                },
                timeout=10,
            )
            if resp.status_code != 202:
                break
            logger.info("DuckDuckGo API returned HTTP 202 for '%s' on attempt %s", query, attempt + 1)
            time.sleep(0.6 * (attempt + 1))

        if resp is None:
            return {"query": query, "results": [], "source": "DuckDuckGo", "count": 0, "message": "Search provider did not return a response."}

        if resp.status_code != 200:
            return {
                "query": query,
                "results": [],
                "source": "DuckDuckGo",
                "count": 0,
                "message": f"Search provider temporarily unavailable (HTTP {resp.status_code}).",
                "warning": f"DuckDuckGo API HTTP {resp.status_code}",
            }

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
            logger.info("web_search via DuckDuckGo API fallback: no results for '%s'", query)
            return {
                "query": query,
                "message": "No instant results found.",
                "results": [],
                "source": "DuckDuckGo",
                "count": 0,
            }

        logger.info("web_search via DuckDuckGo API fallback: %s results for '%s'", len(results), query)
        return {"query": query, "results": results, "source": "DuckDuckGo", "count": len(results)}

    except Exception as e:
        logger.error("DuckDuckGo fallback error: %s", e)
        return {"error": str(e), "query": query, "results": []}


def _scrape_duckduckgo_html(query: str) -> list:
    """Scrape DuckDuckGo HTML search results for actual web results.

    Returns a list of dicts with title, snippet, url keys.
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        logger.warning("BeautifulSoup not available for DuckDuckGo HTML scraping")
        return []

    try:
        resp = requests.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query},
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/131.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            },
            timeout=15,
        )
        if resp.status_code != 200:
            logger.warning("DuckDuckGo HTML search HTTP %s for '%s'", resp.status_code, query)
            return []

        soup = BeautifulSoup(resp.text, "html.parser")
        results = []

        for result in soup.select(".result"):
            link_el = result.select_one(".result__a")
            snippet_el = result.select_one(".result__snippet")

            if not link_el:
                continue

            url = link_el.get("href", "")
            # DDG wraps URLs: extract from redirect
            if url.startswith("//"):
                url = "https:" + url
            import re as _re
            m = _re.search(r'uddg=([^&]+)', str(url))
            if m:
                from urllib.parse import unquote
                url = unquote(m.group(1))

            title = link_el.get_text(strip=True)
            snippet = snippet_el.get_text(strip=True) if snippet_el else ""

            if url and title:
                results.append({
                    "title": title[:180],
                    "snippet": snippet[:300],
                    "url": url,
                    "source": "DuckDuckGo",
                })

        return results

    except Exception as e:
        logger.error("DuckDuckGo HTML scrape error: %s", e)
        return []

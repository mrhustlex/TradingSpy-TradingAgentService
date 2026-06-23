"""
LangGraph Trading Agent - Full Integration
Sequential tool execution, guaranteed output, all APIs + yfinance + web search
"""
import logging
import os
import time
import requests
from typing import TypedDict, Annotated, Sequence
from langchain_core.messages import BaseMessage, AIMessage, SystemMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
import yfinance as yf
from datetime import datetime

logger = logging.getLogger(__name__)

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")


# ── State ─────────────────────────────────────────────────────────────────────
class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], "conversation messages"]
    available_files: list[str]
    available_strategies: list[str]


# ── Internal helpers ──────────────────────────────────────────────────────────
def _api(method: str, path: str, **kwargs) -> dict:
    try:
        url = f"{BACKEND_URL}{path}"
        resp = getattr(requests, method)(url, timeout=kwargs.pop("timeout", 30), **kwargs)
        return resp.json() if resp.status_code == 200 else {"error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
    except Exception as e:
        return {"error": str(e)}


def _yf_quote(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    hist = t.history(period="1d", interval="1m")
    if hist.empty:
        hist = t.history(period="5d", interval="1d")
    if hist.empty:
        return {"symbol": ticker, "error": "No data"}
    latest = hist.iloc[-1]
    info = t.info
    price = float(latest["Close"])
    prev = info.get("previousClose", float(latest["Open"]))
    chg = price - prev
    return {
        "symbol": ticker, "name": info.get("shortName", ticker),
        "price": round(price, 2), "change": round(chg, 2),
        "change_percent": round(chg / prev * 100 if prev else 0, 2),
        "volume": int(latest["Volume"]),
        "high": round(float(latest["High"]), 2), "low": round(float(latest["Low"]), 2),
        "market_cap": info.get("marketCap"), "pe_ratio": info.get("trailingPE"),
        "52w_high": info.get("fiftyTwoWeekHigh"), "52w_low": info.get("fiftyTwoWeekLow"),
        "timestamp": datetime.now().isoformat(),
    }


def _yf_technicals(ticker: str, period: str = "6mo") -> dict:
    t = yf.Ticker(ticker)
    hist = t.history(period=period)
    if hist.empty:
        return {"symbol": ticker, "error": "No data"}
    close = hist["Close"]
    sma20  = close.rolling(20).mean().iloc[-1]  if len(close) >= 20  else None
    sma50  = close.rolling(50).mean().iloc[-1]  if len(close) >= 50  else None
    sma200 = close.rolling(200).mean().iloc[-1] if len(close) >= 200 else None
    delta = close.diff()
    gain = delta.where(delta > 0, 0).rolling(14).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
    rsi = (100 - 100 / (1 + gain / loss)).iloc[-1]
    price = float(close.iloc[-1])
    trend = "neutral"
    if sma20 is not None and sma50 is not None:
        if price > float(sma20) > float(sma50):   trend = "bullish"
        elif price < float(sma20) < float(sma50): trend = "bearish"
    return {
        "symbol": ticker, "price": round(price, 2),
        "rsi_14": round(float(rsi), 2) if rsi else None,
        "sma_20":  round(float(sma20),  2) if sma20  is not None else None,
        "sma_50":  round(float(sma50),  2) if sma50  is not None else None,
        "sma_200": round(float(sma200), 2) if sma200 is not None else None,
        "support":    round(float(close.tail(20).min()), 2),
        "resistance": round(float(close.tail(20).max()), 2),
        "trend": trend,
        "volatility_pct": round(float(close.pct_change().std() * (252 ** 0.5) * 100), 2),
        "timestamp": datetime.now().isoformat(),
    }


# ── Market Data Tools ─────────────────────────────────────────────────────────
@tool
def get_quote(ticker: str) -> dict:
    """Get real-time price quote for a stock ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM, NVDA
    """
    try:
        r = _api("get", f"/api/intelligence/quote/{ticker.upper()}")
        return r if "error" not in r else _yf_quote(ticker.upper())
    except Exception as e:
        return {"symbol": ticker, "error": str(e)}


@tool
def get_technicals(ticker: str) -> dict:
    """Get technical indicators: RSI, SMA20/50/200, trend, support/resistance, volatility.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
    """
    try:
        r = _api("get", f"/api/intelligence/technicals/{ticker.upper()}")
        return r if "error" not in r else _yf_technicals(ticker.upper())
    except Exception as e:
        return {"symbol": ticker, "error": str(e)}


@tool
def get_news(ticker: str, limit: int = 6) -> dict:
    """Get latest Yahoo Finance news headlines for a stock ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
        limit: Number of headlines (default 6)
    """
    try:
        r = _api("get", f"/api/intelligence/news/{ticker.upper()}?limit={limit}")
        if "error" not in r:
            return r
        t = yf.Ticker(ticker.upper())
        news = t.news[:limit] if hasattr(t, 'news') else []
        return {"symbol": ticker.upper(), "news": news}
    except Exception as e:
        return {"symbol": ticker, "error": str(e)}


@tool
def fetch_article(url: str) -> dict:
    """Fetch and read the full text content of any news article or webpage URL.
    Args:
        url: Full URL to the article or webpage
    """
    try:
        resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        if resp.status_code != 200:
            return {"url": url, "error": f"HTTP {resp.status_code}"}
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(resp.text, 'html.parser')
        for script in soup(["script", "style"]):
            script.decompose()
        text = soup.get_text(separator='\n', strip=True)
        lines = [line.strip() for line in text.split('\n') if line.strip()]
        content = '\n'.join(lines[:500])
        return {"url": url, "content": content[:3000], "length": len(content)}
    except Exception as e:
        return {"url": url, "error": str(e)}


@tool
def web_search(query: str) -> dict:
    """Search the web for financial news, analysis, or any topic.
    Use this to find current news, analyst opinions, or research on any stock or topic.
    Args:
        query: Search query e.g. 'TSM earnings 2025', 'NVDA analyst price target', 'Fed rate decision'
    """
    try:
        # Try Tavily first (more reliable, designed for AI agents, free tier: 1000/month)
        tavily_key = os.getenv("TAVILY_API_KEY")
        if tavily_key:
            try:
                resp = requests.post(
                    "https://api.tavily.com/search",
                    json={
                        "api_key": tavily_key,
                        "query": query,
                        "max_results": 8,
                        "include_answer": True,
                    },
                    timeout=15,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    results = []
                    
                    # Add the AI-generated answer if available
                    if data.get("answer"):
                        results.append({
                            "title": "Summary",
                            "snippet": data["answer"],
                            "url": "",
                            "source": "Tavily AI",
                        })
                    
                    # Add search results
                    for result in data.get("results", [])[:7]:
                        results.append({
                            "title": result.get("title", ""),
                            "snippet": result.get("content", "")[:300],
                            "url": result.get("url", ""),
                            "source": result.get("source", ""),
                        })
                    
                    if results:
                        logger.info(f"web_search via Tavily: {len(results)} results")
                        return {"query": query, "results": results, "source": "Tavily"}
            except Exception as e:
                logger.warning(f"Tavily search failed: {e}, falling back to DuckDuckGo")
        
        # Fallback: DuckDuckGo (no key needed)
        resp = requests.get(
            "https://api.duckduckgo.com/",
            params={"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10,
        )
        if resp.status_code != 200:
            return {"error": f"Search failed: HTTP {resp.status_code}", "query": query}

        data = resp.json()
        results = []

        # Abstract (main answer)
        if data.get("AbstractText"):
            results.append({
                "title":   data.get("Heading", "Summary"),
                "snippet": data["AbstractText"],
                "url":     data.get("AbstractURL", ""),
                "source":  data.get("AbstractSource", ""),
            })

        # Related topics
        for topic in data.get("RelatedTopics", [])[:6]:
            if isinstance(topic, dict) and topic.get("Text"):
                results.append({
                    "title":   topic.get("Text", "")[:80],
                    "snippet": topic.get("Text", ""),
                    "url":     topic.get("FirstURL", ""),
                    "source":  "DuckDuckGo",
                })

        if not results:
            return {
                "query": query,
                "message": "No instant results found. Try fetch_article with a specific URL, or use get_news for ticker-specific news.",
                "results": [],
                "source": "DuckDuckGo",
            }

        logger.info(f"web_search via DuckDuckGo: {len(results)} results")
        return {"query": query, "results": results, "source": "DuckDuckGo"}
    except Exception as e:
        logger.error(f"web_search error: {e}")
        return {"query": query, "error": str(e)}


@tool
def get_full_analysis(ticker: str) -> dict:
    """Get comprehensive analysis: quote + technicals + news + earnings + analyst recommendations.
    Use this for 'analyse', 'should I buy', 'what do you think about X' questions.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
    """
    try:
        ticker = ticker.upper()
        quote   = _api("get", f"/api/intelligence/quote/{ticker}")
        if "error" in quote:   quote   = _yf_quote(ticker)
        techs   = _api("get", f"/api/intelligence/technicals/{ticker}")
        if "error" in techs:   techs   = _yf_technicals(ticker)
        news    = _api("get", f"/api/intelligence/news/{ticker}?limit=5")
        earnings = _api("get", f"/api/intelligence/earnings/{ticker}")
        recs     = _api("get", f"/api/intelligence/recommendations/{ticker}")
        return {"quote": quote, "technicals": techs, "news": news, "earnings": earnings, "recommendations": recs}
    except Exception as e:
        return {"error": str(e)}


@tool
def get_market_overview() -> dict:
    """Get market overview: S&P 500, Dow Jones, NASDAQ, Russell 2000 indices."""
    try:
        r = _api("get", "/api/intelligence/market-overview")
        if "error" not in r:
            return r
        indices = {"^GSPC": "S&P 500", "^DJI": "Dow Jones", "^IXIC": "NASDAQ", "^RUT": "Russell 2000"}
        data = {}
        for sym, name in indices.items():
            try:
                data[sym] = {"name": name, **_yf_quote(sym)}
            except Exception:
                pass
        return {"indices": data, "timestamp": datetime.now().isoformat()}
    except Exception as e:
        return {"error": str(e)}


# ── yfinance Search & Discovery Tools ─────────────────────────────────────────
@tool
def search_ticker(query: str, max_results: int = 10) -> dict:
    """Search for stocks, ETFs, indices by name or symbol using yfinance.
    Use this to find tickers when user mentions a company name.
    Args:
        query: Company name or partial ticker e.g. 'Apple', 'Tesla', 'Nvidia'
        max_results: Max number of results to return (default 10)
    """
    try:
        search = yf.Search(query, max_results=max_results)
        quotes = search.quotes if hasattr(search, 'quotes') else []
        results = []
        for q in quotes[:max_results]:
            results.append({
                "symbol": q.get("symbol", ""),
                "name": q.get("shortname", q.get("longname", "")),
                "type": q.get("quoteType", ""),
                "exchange": q.get("exchange", ""),
                "industry": q.get("industry", ""),
            })
        return {"query": query, "results": results, "count": len(results)}
    except Exception as e:
        logger.warning(f"search_ticker error: {e}")
        return {"query": query, "error": str(e), "results": []}


@tool
def lookup_ticker(query: str, asset_type: str = "stock") -> dict:
    """Look up tickers by asset type: stock, etf, index, future, currency, cryptocurrency.
    Use this to discover specific asset classes.
    Args:
        query: Search term e.g. 'AAPL', 'QQQ', 'BTC'
        asset_type: One of: stock, etf, index, future, currency, cryptocurrency (default: stock)
    """
    try:
        lookup = yf.Lookup(query)
        
        # Map asset_type to yfinance lookup method
        type_map = {
            "stock": "stock",
            "etf": "etf",
            "index": "index",
            "future": "future",
            "currency": "currency",
            "cryptocurrency": "cryptocurrency",
        }
        
        attr_name = type_map.get(asset_type.lower(), "stock")
        results = getattr(lookup, attr_name, [])
        
        # Convert to list if it's a single result
        if not isinstance(results, list):
            results = [results] if results else []
        
        formatted = []
        for r in results[:20]:
            if isinstance(r, dict):
                formatted.append(r)
            else:
                formatted.append({"symbol": str(r)})
        
        return {
            "query": query,
            "asset_type": asset_type,
            "results": formatted,
            "count": len(formatted)
        }
    except Exception as e:
        logger.warning(f"lookup_ticker error: {e}")
        return {"query": query, "asset_type": asset_type, "error": str(e), "results": []}


@tool
def get_ticker_info(ticker: str) -> dict:
    """Get detailed company/ticker information: sector, industry, website, description, etc.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
    """
    try:
        t = yf.Ticker(ticker.upper())
        info = t.info
        return {
            "symbol": ticker.upper(),
            "name": info.get("shortName", ""),
            "sector": info.get("sector", ""),
            "industry": info.get("industry", ""),
            "website": info.get("website", ""),
            "description": info.get("longBusinessSummary", "")[:500],
            "employees": info.get("fullTimeEmployees", ""),
            "founded": info.get("founded", ""),
            "country": info.get("country", ""),
            "currency": info.get("currency", ""),
        }
    except Exception as e:
        logger.warning(f"get_ticker_info error: {e}")
        return {"symbol": ticker.upper(), "error": str(e)}


@tool
def get_earnings_dates(ticker: str) -> dict:
    """Get upcoming earnings dates and historical earnings for a ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
    """
    try:
        t = yf.Ticker(ticker.upper())
        info = t.info
        
        # Get earnings dates
        earnings_dates = t.quarterly_financials.columns.tolist() if hasattr(t, 'quarterly_financials') else []
        
        return {
            "symbol": ticker.upper(),
            "earnings_date": info.get("earningsDate", ""),
            "earnings_average": info.get("epsTrailingTwelveMonths", ""),
            "earnings_growth": info.get("earningsGrowth", ""),
            "next_earnings_date": info.get("nextFiscalYearEnd", ""),
            "quarterly_earnings_dates": earnings_dates[:4] if earnings_dates else [],
        }
    except Exception as e:
        logger.warning(f"get_earnings_dates error: {e}")
        return {"symbol": ticker.upper(), "error": str(e)}


@tool
def get_dividends(ticker: str, period: str = "5y") -> dict:
    """Get dividend history for a ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
        period: Time period e.g. '1y', '5y', '10y' (default: 5y)
    """
    try:
        t = yf.Ticker(ticker.upper())
        divs = t.dividends
        
        if divs.empty:
            return {"symbol": ticker.upper(), "dividends": [], "message": "No dividend data available"}
        
        # Get recent dividends
        recent = divs.tail(12)
        div_list = [{"date": str(d.date()), "amount": float(v)} for d, v in recent.items()]
        
        # Calculate yield
        info = t.info
        current_price = info.get("currentPrice", 0)
        annual_div = divs.tail(4).sum()  # Last 4 quarters
        div_yield = (annual_div / current_price * 100) if current_price else 0
        
        return {
            "symbol": ticker.upper(),
            "dividends": div_list,
            "annual_dividend": round(float(annual_div), 2),
            "dividend_yield_pct": round(float(div_yield), 2),
            "ex_dividend_date": info.get("exDividendDate", ""),
        }
    except Exception as e:
        logger.warning(f"get_dividends error: {e}")
        return {"symbol": ticker.upper(), "error": str(e)}


@tool
def get_options_chain(ticker: str) -> dict:
    """Get options chain data: available expiration dates and strike prices.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
    """
    try:
        t = yf.Ticker(ticker.upper())
        expirations = t.options
        
        if not expirations:
            return {"symbol": ticker.upper(), "message": "No options data available"}
        
        # Get first expiration's chain
        first_exp = expirations[0]
        chain = t.option_chain(first_exp)
        
        calls = chain.calls
        puts = chain.puts
        
        return {
            "symbol": ticker.upper(),
            "available_expirations": expirations[:10],
            "first_expiration": first_exp,
            "call_count": len(calls),
            "put_count": len(puts),
            "atm_call_volume": int(calls[calls['strike'] == calls['strike'].iloc[len(calls)//2]]['volume'].sum()) if len(calls) > 0 else 0,
            "atm_put_volume": int(puts[puts['strike'] == puts['strike'].iloc[len(puts)//2]]['volume'].sum()) if len(puts) > 0 else 0,
        }
    except Exception as e:
        logger.warning(f"get_options_chain error: {e}")
        return {"symbol": ticker.upper(), "error": str(e)}


# ── Platform / Backtest Tools ─────────────────────────────────────────────────
@tool
def list_datasets() -> dict:
    """List all downloaded market data files available for backtesting."""
    return _api("get", "/api/market-data/files")


@tool
def list_strategies() -> dict:
    """List all saved trading strategies available for backtesting."""
    return _api("get", "/api/backtest/strategies")


@tool
def download_market_data(ticker: str, interval: str = "1d", period: str = "5y") -> dict:
    """Download historical market data for a ticker.
    Args:
        ticker: Stock symbol e.g. AAPL, TSLA, TSM
        interval: Candle interval e.g. '1m', '5m', '1h', '1d' (default: 1d)
        period: Time period e.g. '1mo', '3mo', '1y', '5y' (default: 5y)
    """
    return _api("post", "/api/market-data/download", json={"ticker": ticker.upper(), "interval": interval, "period": period})


@tool
def run_backtest(strategy_name: str, dataset_filename: str) -> dict:
    """Start a backtest. Always call list_strategies + list_datasets first to get exact names.
    Args:
        strategy_name: Name of the strategy to backtest
        dataset_filename: Name of the dataset file to use
    """
    return _api("post", "/api/backtest/run", json={"strategy": strategy_name, "dataset": dataset_filename})


@tool
def wait_for_task(task_id: str, poll_endpoint: str = "/api/backtest/results/{task_id}",
                  max_wait_seconds: int = 120) -> dict:
    """Wait for ANY async task to complete: backtest, strategy generation, or download.
    Polls every 5 seconds until task is done or timeout.
    Args:
        task_id: The task ID returned by run_backtest, generate_strategy, or download_market_data
        poll_endpoint: API endpoint to poll (default: /api/backtest/results/{task_id})
        max_wait_seconds: Max seconds to wait (default: 120)
    """
    start = time.time()
    while time.time() - start < max_wait_seconds:
        endpoint = poll_endpoint.format(task_id=task_id)
        result = _api("get", endpoint)
        if result.get("status") in ["completed", "done", "success"]:
            return result
        if result.get("status") == "error":
            return result
        time.sleep(5)
    return {"task_id": task_id, "status": "timeout", "error": f"Task did not complete within {max_wait_seconds}s"}


@tool
def get_task_status(task_id: str, endpoint: str = "/api/backtest/results/{task_id}") -> dict:
    """Check the current status of any async task without waiting.
    Args:
        task_id: The task ID to check
        endpoint: API endpoint (default: /api/backtest/results/{task_id})
    """
    return _api("get", endpoint.format(task_id=task_id))


@tool
def generate_strategy(prompt: str, ticker: str = None, mode: str = "agnostic") -> dict:
    """Generate a new AI trading strategy from a description.
    Args:
        prompt: Description of the strategy e.g. 'RSI oversold bounce strategy'
        ticker: Optional ticker to optimize for
        mode: 'agnostic' (any ticker) or 'specific' (for given ticker)
    """
    return _api("post", "/api/backtest/generate-strategy", json={"prompt": prompt, "ticker": ticker, "mode": mode})


@tool
def get_strategy_code(strategy_name: str) -> dict:
    """Get the full Python code of a saved strategy.
    Args:
        strategy_name: Name of the strategy
    """
    return _api("get", f"/api/backtest/strategy-code/{strategy_name}")


@tool
def get_backtest_history() -> dict:
    """Get the history of all past backtests with their results."""
    return _api("get", "/api/backtest/history")


@tool
def get_watchlist() -> dict:
    """Get the user's watchlist of tracked tickers."""
    return _api("get", "/api/market-data/watch")


@tool
def add_to_watchlist(ticker: str) -> dict:
    """Add a ticker to the user's watchlist.
    Args:
        ticker: Stock symbol e.g. AAPL
    """
    return _api("post", "/api/market-data/watch", json=[ticker.upper()])


# ── All tools list ────────────────────────────────────────────────────────────
ALL_TOOLS = [
    # Market data
    get_quote, get_technicals, get_news, get_full_analysis, get_market_overview,
    # yfinance Search & Discovery
    search_ticker, lookup_ticker, get_ticker_info, get_earnings_dates, get_dividends, get_options_chain,
    # Web / news reading
    fetch_article, web_search,
    # Platform
    list_datasets, list_strategies, download_market_data,
    run_backtest, wait_for_task, get_task_status,
    generate_strategy, get_strategy_code, get_backtest_history,
    get_watchlist, add_to_watchlist,
]


# ── Graph ─────────────────────────────────────────────────────────────────────
def create_agent(model: str = "gpt-4o", api_key: str = None, base_url: str = None, provider: str = "openai"):
    """Build and compile the LangGraph agent."""
    # Support multiple LLM providers
    if provider == "mistral":
        from langchain_mistralai.chat_models import ChatMistralAI
        llm = ChatMistralAI(model=model, api_key=api_key, temperature=0)
        # LangChain's Mistral integration handles message conversion automatically
        use_tools = True
    elif provider == "groq":
        from langchain_groq import ChatGroq
        llm = ChatGroq(model=model, api_key=api_key, temperature=0)
        use_tools = True
    elif provider == "openrouter":
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(model=model, api_key=api_key, base_url=base_url or "https://openrouter.ai/api/v1", temperature=0)
        use_tools = True
    else:  # openai or default
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(model=model, api_key=api_key, base_url=base_url, temperature=0)
        use_tools = True
    
    # Only bind tools for providers that support it properly
    if use_tools:
        llm_with_tools = llm.bind_tools(ALL_TOOLS)
    else:
        llm_with_tools = llm

    def agent_node(state: AgentState) -> dict:
        messages = list(state["messages"])
        
        # LangChain's provider integrations handle message format conversion automatically
        # No need for custom conversion logic
        response = llm_with_tools.invoke(messages)
        
        # Guarantee a response is always produced
        if not response.content or not response.content.strip():
            # If LLM didn't produce content, create a default response
            if getattr(response, "tool_calls", None):
                # Tool calls were made, that's fine
                response.content = "Processing your request..."
            else:
                # No tool calls and no content — force a response
                response = AIMessage(content="I'm ready to help. What would you like to know?")
        return {"messages": [response]}

    def should_continue(state: AgentState) -> str:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", ToolNode(ALL_TOOLS))
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")  # tools always return to agent for reasoning + reply
    return graph.compile()


# ── System Prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are a sharp, no-BS trading assistant with real-time market data, web search, and full platform access.

TOOLS:
Market data (yfinance):
  get_quote           — live price, change%, volume, market cap, 52w high/low
  get_technicals      — RSI, SMA20/50/200, trend, support/resistance, volatility
  get_news            — latest Yahoo Finance headlines for any ticker
  get_full_analysis   — quote + technicals + news + earnings + analyst recs in one shot
  get_market_overview — S&P 500, Dow, NASDAQ, Russell 2000

Discovery & Research (yfinance):
  search_ticker       — find stocks/ETFs/indices by company name (e.g. "Apple", "Tesla")
  lookup_ticker       — discover tickers by asset type (stock, etf, index, future, currency, crypto)
  get_ticker_info     — company info: sector, industry, website, description, employees
  get_earnings_dates  — upcoming earnings dates and historical earnings data
  get_dividends       — dividend history, annual yield, ex-dividend dates
  get_options_chain   — options expiration dates, strike prices, volume data

Web / research:
  web_search          — search the web for any financial news, analyst opinions, macro events (uses Tavily AI + DuckDuckGo)
  fetch_article       — read the full text of any news article or financial website URL

Platform:
  list_datasets        — see all downloaded data files
  list_strategies      — see all saved strategies
  download_market_data — download historical OHLCV data for any ticker
  run_backtest         — start a backtest (returns task_id)
  wait_for_task        — wait for ANY async task to finish (backtest, generation, download)
  get_task_status      — check status of any task without waiting
  generate_strategy    — create a new AI strategy from a description
  get_strategy_code    — get the Python code of a saved strategy
  get_backtest_history — see all past backtest results
  get_watchlist        — see the user's watchlist
  add_to_watchlist     — add a ticker to the watchlist

STANDARD OPERATING PROCEDURES (SOPs):

1. TRADING STRATEGY OPTIMIZATION
   When user asks to optimize a strategy:
   a) List available strategies (list_strategies)
   b) Select the strategy to optimize
   c) Get market data for the time range (download_market_data or use existing dataset)
   d) Generate an improved version based on market conditions (generate_strategy with context)
   e) Backtest both original and new strategy (run_backtest for each)
   f) Compare results: Sharpe ratio, max drawdown, win rate, total return
   g) If new strategy is better: save it and report improvements
   h) If not better: explain why and suggest alternative approaches

2. STOCK RESEARCH & ANALYSIS
   When user asks for stock analysis, provide:
   a) FUNDAMENTALS: get_ticker_info + get_earnings_dates + get_dividends
      - P/E ratio, market cap, sector, industry
      - Earnings growth, dividend yield
      - Company description and business model
   b) TECHNICALS: get_technicals + get_quote
      - RSI (overbought/oversold), SMA trends
      - Support/resistance levels, volatility
      - Price action relative to moving averages
   c) NEWS & SENTIMENT: get_news + web_search
      - Recent headlines and sentiment
      - Analyst opinions and price targets
      - Macro events affecting the stock
   d) OPTIONS: get_options_chain (if applicable)
      - IV levels, put/call ratio
      - Upcoming earnings impact on options
   e) VALUATION: Compare to peers and historical averages
      - Is it cheap or expensive relative to sector?
      - Growth prospects vs current valuation
   f) RECOMMENDATION: Synthesize all data into actionable insight
      - Buy/hold/sell with clear reasoning
      - Risk/reward assessment
      - Entry/exit levels if applicable

ADDITIONAL OPTIMIZATION SUGGESTIONS:
- For strategy optimization: test multiple time periods (bull, bear, sideways markets)
- For stock research: check insider transactions and institutional ownership
- For risk management: always calculate max drawdown and Sharpe ratio
- For trend analysis: compare current price to 200-day SMA (long-term trend)
- For momentum: check RSI + MACD divergences for reversal signals
- For earnings: check historical volatility around earnings dates
- For dividends: verify ex-dividend dates and payout consistency
- For macro: monitor Fed decisions, inflation, interest rates affecting sector

RULES:
- ALWAYS use tools to get real data — never invent numbers or prices
- For discovery: use search_ticker or lookup_ticker when user mentions a company name
- For deep analysis: use get_full_analysis (one call gets everything)
- For company research: use get_ticker_info, get_earnings_dates, get_dividends
- For options research: use get_options_chain to see available expirations and volume
- For news research: use get_news first, then fetch_article to read full articles
- For web research: use web_search to find analyst opinions, macro news, earnings previews
- For backtests: list_datasets + list_strategies → run_backtest → wait_for_task
- wait_for_task works for ANY task_id — backtest, strategy generation, or download
- Execute tools one at a time, wait for each result before the next
- ALWAYS produce a final text response — never end silently
- If a tool errors, tell the user what happened and suggest next steps

TONE:
- Talk like a knowledgeable trader, not a report writer
- Lead with the most interesting insight
- Use numbers naturally: "RSI at 28 — that's oversold territory"
- Short sentences, no fluff, no bullet walls
- Have opinions: "This looks like a bounce setup" or "I'd wait for a break above resistance"
- Ask follow-up questions when relevant
- Always give the user something actionable at the end"""

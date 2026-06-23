"""
Market Intelligence Module
Provides real-time market data, news, and analytics using yfinance
"""
import yfinance as yf
import pandas as pd
import math
import logging
import threading
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional
import requests

logger = logging.getLogger(__name__)

MOVEMENT_TICKERS = [
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO",
    "JPM", "V", "MA", "BAC", "WFC", "GS", "MS", "BLK",
    "JNJ", "UNH", "LLY", "ABBV", "MRK", "PFE", "TMO", "AMGN",
    "WMT", "COST", "HD", "MCD", "SBUX", "NKE", "LOW", "DIS",
    "XOM", "CVX", "COP", "SLB", "EOG",
    "CAT", "BA", "GE", "HON", "MMM", "UPS", "RTX", "LMT",
    "NFLX", "CMCSA", "VZ", "T", "TMUS",
    "ORCL", "CRM", "ADBE", "CSCO", "AMD", "INTC", "IBM", "QCOM",
    "PYPL", "UBER", "XYZ", "SNAP",
    "PG", "KO", "PEP", "PM",
]


class MarketIntelligence:
    """Handles real-time market data, news, and analytics"""
    
    def __init__(self):
        self.cache = {}
        self.cache_ttl = 60  # seconds
        self.cache_lock = threading.Lock()
        self.yf_download_lock = threading.Lock()
        self.prewarm_lock = threading.Lock()
        self.prewarm_running = False

    def _get_cached(self, key: str, ttl: Optional[int] = None):
        ttl = ttl or self.cache_ttl
        with self.cache_lock:
            entry = self.cache.get(key)
            if not entry:
                return None
            if time.time() - entry["ts"] >= ttl:
                self.cache.pop(key, None)
                return None
            return entry["value"]

    def _set_cached(self, key: str, value):
        with self.cache_lock:
            self.cache[key] = {"ts": time.time(), "value": value}

    def _extract_history_frame(self, dataset: pd.DataFrame, ticker: str) -> pd.DataFrame:
        if dataset is None or dataset.empty:
            return pd.DataFrame()
        if not isinstance(dataset.columns, pd.MultiIndex):
            return dataset.copy()
        if ticker in dataset.columns.get_level_values(0):
            return dataset[ticker].copy()
        if ticker in dataset.columns.get_level_values(-1):
            return dataset.xs(ticker, axis=1, level=-1).copy()
        return pd.DataFrame()

    def _build_quote_from_history(self, ticker: str, hist: pd.DataFrame, name: Optional[str] = None, metadata: Optional[Dict] = None) -> Dict:
        if hist is None or hist.empty:
            return {"symbol": ticker, "error": "No data available"}

        if "Close" not in hist:
            return {"symbol": ticker, "error": "Incomplete price data"}

        close = hist["Close"].dropna()
        if close.empty:
            return {"symbol": ticker, "error": "Incomplete price data"}

        current_price = close.iloc[-1]
        latest_idx = close.index[-1]
        latest = hist.loc[latest_idx] if latest_idx in hist.index else hist.iloc[-1]
        previous_close = None
        if len(close) >= 2 and pd.notna(close.iloc[-2]):
            previous_close = close.iloc[-2]
        elif "Open" in hist and pd.notna(latest.get("Open")):
            previous_close = latest.get("Open")

        metadata = metadata or {}
        previous_close = metadata.get("previousClose", previous_close)

        if pd.isna(current_price) or previous_close in (None, 0) or pd.isna(previous_close):
            return {"symbol": ticker, "error": "Incomplete price data"}

        change = float(current_price) - float(previous_close)
        change_pct = (change / float(previous_close) * 100) if previous_close else 0

        volume = latest.get("Volume")
        high = latest.get("High")
        low = latest.get("Low")
        open_price = latest.get("Open")

        return {
            "symbol": ticker,
            "name": name or ticker,
            "price": round(float(current_price), 2),
            "change": round(float(change), 2),
            "change_percent": round(float(change_pct), 2),
            "volume": int(volume) if pd.notna(volume) else 0,
            "high": round(float(high), 2) if pd.notna(high) else None,
            "low": round(float(low), 2) if pd.notna(low) else None,
            "open": round(float(open_price), 2) if pd.notna(open_price) else None,
            "previous_close": round(float(previous_close), 2),
            "timestamp": datetime.now().isoformat(),
            "market_cap": metadata.get("marketCap"),
            "pe_ratio": metadata.get("trailingPE")
        }
    
    def get_ticker_info(self, ticker: str) -> Dict:
        """Get comprehensive ticker information"""
        try:
            ticker = ticker.upper()
            t = yf.Ticker(ticker)
            info = t.info
            
            # Extract key metrics
            eps_est = None
            pe_next_q = None
            cal = {}
            try:
                cal = t.calendar or {}
                if "Earnings Average" in cal and cal["Earnings Average"]:
                    eps_est = float(cal["Earnings Average"])
                    price = info.get("currentPrice") or info.get("regularMarketPrice")
                    if price and eps_est:
                        pe_next_q = round(price / (eps_est * 4), 2)
            except Exception:
                pass
            return {
                "symbol": ticker,
                "name": info.get("longName", ticker),
                "sector": info.get("sector", "N/A"),
                "industry": info.get("industry", "N/A"),
                "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
                "previous_close": info.get("previousClose"),
                "open": info.get("open") or info.get("regularMarketOpen"),
                "day_high": info.get("dayHigh") or info.get("regularMarketDayHigh"),
                "day_low": info.get("dayLow") or info.get("regularMarketDayLow"),
                "volume": info.get("volume") or info.get("regularMarketVolume"),
                "avg_volume": info.get("averageVolume"),
                "market_cap": info.get("marketCap"),
                "pe_ratio": info.get("trailingPE"),
                "forward_pe": info.get("forwardPE"),
                "dividend_yield": info.get("dividendYield"),
                "beta": info.get("beta"),
                "52w_high": info.get("fiftyTwoWeekHigh"),
                "52w_low": info.get("fiftyTwoWeekLow"),
                "50d_avg": info.get("fiftyDayAverage"),
                "200d_avg": info.get("twoHundredDayAverage"),
                "description": info.get("longBusinessSummary", ""),
                "website": info.get("website", ""),
                "employees": info.get("fullTimeEmployees"),
                "eps_estimate_next_q": eps_est,
                "pe_next_q": pe_next_q,
                "next_earnings_date": str(cal.get("Earnings Date", [None])[0]) if cal and cal.get("Earnings Date") else None,
                "eps_growth": info.get("earningsQuarterlyGrowth"),
                "eps_current_year": info.get("epsCurrentYear"),
                "eps_forward": info.get("epsForward"),
                "eps_ttm": info.get("epsTrailingTwelveMonths"),
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error fetching info for {ticker}: {e}")
            return {"symbol": ticker, "error": str(e)}
    
    def get_ticker_quote(self, ticker: str) -> Dict:
        """Get real-time quote (lightweight version)"""
        ticker = ticker.upper()
        cache_key = f"quote:{ticker}"
        cached = self._get_cached(cache_key, ttl=15)
        if cached:
            return cached

        try:
            t = yf.Ticker(ticker)

            hist = t.history(period="1d", interval="1m")
            if hist.empty:
                hist = t.history(period="5d", interval="1d")

            info = {}
            fast_info = getattr(t, "fast_info", None)
            if fast_info:
                try:
                    info = dict(fast_info)
                except Exception:
                    info = {}

            quote = self._build_quote_from_history(
                ticker,
                hist,
                name=info.get("shortName") or info.get("longName") or ticker,
                metadata=info
            )
            self._set_cached(cache_key, quote)
            return quote
        except Exception as e:
            logger.error(f"Error fetching quote for {ticker}: {e}")
            return {"symbol": ticker, "error": str(e)}

    def get_batch_quotes(self, tickers: List[str]) -> List[Dict]:
        normalized = []
        seen = set()
        for ticker in tickers:
            symbol = str(ticker).upper().strip()
            if not symbol or symbol in seen:
                continue
            normalized.append(symbol)
            seen.add(symbol)

        if not normalized:
            return []

        quotes_map = {}
        missing = []

        for ticker in normalized:
            cached = self._get_cached(f"quote:{ticker}", ttl=120)
            if cached:
                quotes_map[ticker] = cached
            else:
                missing.append(ticker)

        if missing:
            try:
                with self.yf_download_lock:
                    dataset = yf.download(
                        tickers=" ".join(missing),
                        period="1d",
                        interval="1m",
                        group_by="ticker",
                        auto_adjust=False,
                        progress=False,
                        threads=False,
                    )
            except Exception as exc:
                logger.warning(f"Batch intraday quote fetch failed: {exc}")
                dataset = pd.DataFrame()

            fallback_missing = []
            for ticker in missing:
                hist = self._extract_history_frame(dataset, ticker)
                if hist.empty:
                    fallback_missing.append(ticker)
                    continue
                quote = self._build_quote_from_history(ticker, hist)
                quotes_map[ticker] = quote
                self._set_cached(f"quote:{ticker}", quote)

            if fallback_missing:
                try:
                    with self.yf_download_lock:
                        fallback_dataset = yf.download(
                            tickers=" ".join(fallback_missing),
                            period="5d",
                            interval="1d",
                            group_by="ticker",
                            auto_adjust=False,
                            progress=False,
                            threads=False,
                        )
                except Exception as exc:
                    logger.warning(f"Batch daily quote fallback failed: {exc}")
                    fallback_dataset = pd.DataFrame()

                for ticker in fallback_missing:
                    hist = self._extract_history_frame(fallback_dataset, ticker)
                    if hist.empty:
                        quote = {"symbol": ticker, "error": "No data available"}
                    else:
                        quote = self._build_quote_from_history(ticker, hist)
                    quotes_map[ticker] = quote
                    self._set_cached(f"quote:{ticker}", quote)

        return [quotes_map.get(ticker, {"symbol": ticker, "error": "No data available"}) for ticker in normalized]
    
    def get_ticker_news(self, ticker: str, limit: int = 10) -> List[Dict]:
        """Get recent news for a ticker"""
        ticker = ticker.upper()
        cache_key = f"news:{ticker}:{limit}"
        cached = self._get_cached(cache_key, ttl=300)
        if cached is not None:
            return cached

        try:
            t = yf.Ticker(ticker)
            
            # Try to get news
            try:
                news = t.news
            except AttributeError:
                logger.warning(f"News attribute not available for {ticker}")
                self._set_cached(cache_key, [])
                return []
            
            logger.info(f"Fetching news for {ticker}, got {len(news) if news else 0} articles")
            
            if not news or not isinstance(news, list):
                logger.warning(f"No news available or invalid format for {ticker}")
                self._set_cached(cache_key, [])
                return []
            
            parsed_news = []
            for i, article in enumerate(news[:limit]):
                try:
                    if not isinstance(article, dict):
                        logger.warning(f"Article {i} is not a dict, skipping")
                        continue
                    
                    # yfinance changed structure - news is now nested under 'content'
                    content = article.get('content', article)  # Fallback to article if no content key
                    
                    # Log structure for first article
                    if i == 0:
                        logger.info(f"News structure for {ticker}: top-level keys={list(article.keys())}, content keys={list(content.keys()) if isinstance(content, dict) else 'N/A'}")
                    
                    # Extract fields from new structure
                    title = content.get('title', 'No title')
                    
                    # Publisher is nested under provider
                    provider = content.get('provider', {})
                    publisher = provider.get('displayName', 'Unknown') if isinstance(provider, dict) else 'Unknown'
                    
                    # Link can be in clickThroughUrl or canonicalUrl
                    click_through = content.get('clickThroughUrl', {})
                    canonical = content.get('canonicalUrl', {})
                    link = ''
                    if isinstance(click_through, dict):
                        link = click_through.get('url', '')
                    if not link and isinstance(canonical, dict):
                        link = canonical.get('url', '')
                    
                    # Published date is now in ISO format string
                    pub_date = content.get('pubDate') or content.get('displayTime')
                    published = None
                    if pub_date:
                        try:
                            # It's already in ISO format, just validate and use it
                            if isinstance(pub_date, str):
                                published = pub_date
                            else:
                                published = datetime.fromisoformat(str(pub_date).replace('Z', '+00:00')).isoformat()
                        except Exception as e:
                            logger.warning(f"Error parsing publish date for article {i}: {e}")
                    
                    # Thumbnail
                    thumbnail_url = None
                    thumbnail = content.get('thumbnail', {})
                    if isinstance(thumbnail, dict):
                        resolutions = thumbnail.get('resolutions', [])
                        if resolutions and len(resolutions) > 0 and isinstance(resolutions[0], dict):
                            thumbnail_url = resolutions[0].get('url')
                    
                    parsed_article = {
                        "title": title,
                        "publisher": publisher,
                        "link": link,
                        "published": published,
                        "type": content.get('contentType', 'article'),
                        "thumbnail": thumbnail_url
                    }
                    
                    parsed_news.append(parsed_article)
                    
                except Exception as e:
                    logger.warning(f"Error parsing article {i} for {ticker}: {e}")
                    continue
            
            logger.info(f"Successfully parsed {len(parsed_news)} news articles for {ticker}")
            self._set_cached(cache_key, parsed_news)
            return parsed_news
        except Exception as e:
            logger.error(f"Error fetching news for {ticker}: {e}", exc_info=True)
            return []
    
    def get_market_movers(self, period: str = "1d", interval: str = None) -> Dict:
        """Get market movers (gainers, losers, most active)"""
        cache_key = f"market_movers:{period}:{interval or 'default'}"
        cached = self._get_cached(cache_key, ttl=30)
        if cached:
            return cached

        try:
            gainers = []
            losers = []
            most_active = []

            # Yahoo often blocks direct index symbols such as ^DJI/^RUT. Use liquid ETF
            # proxies for fast, accessible overview data while keeping user-facing names.
            indices = {
                "SPY": "S&P 500",
                "DIA": "Dow Jones",
                "QQQ": "NASDAQ 100",
                "IWM": "Russell 2000"
            }
            
            index_data = {}

            if not interval and period == "1d":
                for quote in self.get_batch_quotes(list(indices.keys())):
                    symbol = quote.get("symbol")
                    if not symbol or quote.get("error"):
                        continue
                    index_data[symbol] = {
                        "name": indices.get(symbol, symbol),
                        "symbol": symbol,
                        "price": quote.get("price"),
                        "change": quote.get("change"),
                        "change_percent": quote.get("change_percent"),
                    }
                result = {
                    "indices": index_data,
                    "gainers": gainers,
                    "losers": losers,
                    "most_active": most_active,
                    "timestamp": datetime.now().isoformat()
                }
                self._set_cached(cache_key, result)
                threading.Thread(target=self._prewarm_movement_quotes, daemon=True).start()
                return result

            history_kwargs = {"progress": False, "threads": False, "auto_adjust": False, "group_by": "ticker"}
            if not interval and period == "1d":
                history_kwargs["period"] = "2d"
            else:
                history_kwargs["period"] = "1d" if interval in {"1d", "5d"} else period
                if interval:
                    history_kwargs["interval"] = interval

            with self.yf_download_lock:
                dataset = yf.download(tickers=" ".join(indices.keys()), **history_kwargs)

            for symbol, name in indices.items():
                hist = self._extract_history_frame(dataset, symbol)
                if hist.empty or "Close" not in hist:
                    continue

                close = hist["Close"].dropna()
                if close.empty:
                    continue

                end = close.iloc[-1]
                if not interval and period == "1d":
                    start = close.iloc[0] if len(close) < 2 else close.iloc[-2]
                else:
                    start = close.iloc[0]

                if pd.isna(start) or pd.isna(end) or float(start) == 0:
                    continue

                index_data[symbol] = {
                    "name": name,
                    "symbol": symbol,
                    "price": round(float(end), 2),
                    "change": round(float(end - start), 2),
                    "change_percent": round(float((end - start) / start * 100), 2),
                }

            result = {
                "indices": index_data,
                "gainers": gainers,
                "losers": losers,
                "most_active": most_active,
                "timestamp": datetime.now().isoformat()
            }
            self._set_cached(cache_key, result)
            threading.Thread(target=self._prewarm_movement_quotes, daemon=True).start()
            return result
        except Exception as e:
            logger.error(f"Error fetching market movers: {e}")
            return {"error": str(e)}

    def _prewarm_movement_quotes(self):
        with self.prewarm_lock:
            if self.prewarm_running:
                return
            self.prewarm_running = True
        try:
            missing = [
                ticker for ticker in MOVEMENT_TICKERS
                if self._get_cached(f"quote:{ticker}", ttl=120) is None
            ]
            if missing:
                self.get_batch_quotes(missing)
        except Exception as exc:
            logger.warning(f"Movement quote prewarm failed: {exc}")
        finally:
            with self.prewarm_lock:
                self.prewarm_running = False
    
    def get_ticker_technicals(self, ticker: str, period: str = "3mo") -> Dict:
        """Calculate technical indicators for a ticker"""
        try:
            ticker = ticker.upper()
            t = yf.Ticker(ticker)
            hist = t.history(period=period)
            
            if hist.empty:
                return {"symbol": ticker, "error": "No data available"}
            
            # Calculate indicators
            close = hist['Close']
            
            # Moving averages
            sma_20 = close.rolling(window=20).mean().iloc[-1] if len(close) >= 20 else None
            sma_50 = close.rolling(window=50).mean().iloc[-1] if len(close) >= 50 else None
            sma_200 = close.rolling(window=200).mean().iloc[-1] if len(close) >= 200 else None
            
            # RSI
            delta = close.diff()
            gain = (delta.where(delta > 0, 0)).rolling(window=14).mean()
            loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
            rs = gain / loss
            rsi = 100 - (100 / (1 + rs))
            current_rsi = rsi.iloc[-1] if len(rsi) > 0 else None
            
            # Volatility
            returns = close.pct_change()
            volatility = returns.std() * (252 ** 0.5) * 100  # Annualized
            
            # Support/Resistance (simple)
            recent_high = close.tail(20).max()
            recent_low = close.tail(20).min()
            
            current_price = close.iloc[-1]
            
            # Trend determination
            trend = "neutral"
            if sma_20 and sma_50:
                if current_price > sma_20 > sma_50:
                    trend = "bullish"
                elif current_price < sma_20 < sma_50:
                    trend = "bearish"
            
            return {
                "symbol": ticker,
                "current_price": round(float(current_price), 2),
                "sma_20": round(float(sma_20), 2) if sma_20 else None,
                "sma_50": round(float(sma_50), 2) if sma_50 else None,
                "sma_200": round(float(sma_200), 2) if sma_200 else None,
                "rsi_14": round(float(current_rsi), 2) if current_rsi else None,
                "volatility": round(float(volatility), 2),
                "support": round(float(recent_low), 2),
                "resistance": round(float(recent_high), 2),
                "trend": trend,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error calculating technicals for {ticker}: {e}")
            return {"symbol": ticker, "error": str(e)}
    
    def get_earnings_calendar(self, ticker: str) -> Dict:
        """Get earnings calendar for a ticker"""
        try:
            ticker = ticker.upper()
            t = yf.Ticker(ticker)
            
            calendar = t.calendar
            if calendar is None or calendar.empty:
                return {"symbol": ticker, "earnings": None}
            
            # Parse earnings date
            earnings_date = None
            if isinstance(calendar, pd.DataFrame) and 'Earnings Date' in calendar.columns:
                earnings_date = calendar['Earnings Date'].iloc[0]
                if pd.notna(earnings_date):
                    earnings_date = earnings_date.isoformat()
            
            return {
                "symbol": ticker,
                "earnings_date": earnings_date,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error fetching earnings for {ticker}: {e}")
            return {"symbol": ticker, "error": str(e)}
    
    def get_insider_transactions(self, tickers: List[str], limit: int = 50, offset: int = 0, days_back: int = 365) -> Dict:
        """Get recent insider transactions for a list of tickers with pagination"""
        results = []
        seen = set()
        cutoff = datetime.now() - timedelta(days=days_back) if days_back > 0 else None
        # Build holdings lookup per ticker: insider name sanitized -> shares owned
        holdings_cache = {}
        ticker_meta = {}
        for ticker in tickers:
            meta = {}
            try:
                t = yf.Ticker(ticker.upper())
                roster = t.insider_roster_holders
                if roster is not None and not roster.empty:
                    cache = {}
                    for _, r in roster.iterrows():
                        name = str(r.get('Name', '')).strip().upper() if pd.notna(r.get('Name')) else ''
                        shares_raw = r.get('Shares Owned Directly')
                        title_raw = r.get('Position', '')
                        title = str(title_raw).strip() if pd.notna(title_raw) and title_raw else ''
                        last_tx = str(r.get('Most Recent Transaction', '')).strip() if pd.notna(r.get('Most Recent Transaction')) else ''
                        last_tx_date = str(r.get('Latest Transaction Date', ''))[:10] if pd.notna(r.get('Latest Transaction Date')) else ''
                        if name and pd.notna(shares_raw):
                            try:
                                cache[name] = {"shares": float(shares_raw), "title": title, "last_tx": last_tx, "last_tx_date": last_tx_date}
                            except (ValueError, TypeError):
                                pass
                    holdings_cache[ticker.upper()] = cache

                ip = t.insider_purchases
                if ip is not None and not ip.empty:
                    for _, r in ip.iterrows():
                        label = str(r.get('Insider Purchases Last 6m', '')).strip()
                        if 'purchases' in label.lower() and 'net' not in label.lower() and '%' not in label.lower():
                            meta['buy_6m_shares'] = int(r.get('Shares', 0)) if pd.notna(r.get('Shares')) else 0
                            meta['buy_6m_count'] = int(r.get('Trans', 0)) if pd.notna(r.get('Trans')) else 0
                        elif 'sales' in label.lower() and 'net' not in label.lower() and '%' not in label.lower():
                            meta['sell_6m_shares'] = int(r.get('Shares', 0)) if pd.notna(r.get('Shares')) else 0
                            meta['sell_6m_count'] = int(r.get('Trans', 0)) if pd.notna(r.get('Trans')) else 0

                mh = t.major_holders
                if mh is not None and not mh.empty:
                    for idx, r in mh.iterrows():
                        label = str(idx).strip()
                        if 'insiderspercentheld' in label.lower().replace(' ', '').replace('_', ''):
                            val = r.get('Value')
                            meta['insiders_pct_held'] = round(val * 100, 2) if pd.notna(val) else None
            except Exception as e:
                logger.error(f"Error fetching insider metadata for {ticker}: {e}")
            ticker_meta[ticker.upper()] = meta

        for ticker in tickers:
            try:
                t = yf.Ticker(ticker.upper())
                transactions = t.insider_transactions
                if transactions is not None and not transactions.empty:
                    df = transactions.copy()
                    # Normalize column names (yfinance may vary)
                    col_map = {
                        'Shares': 'shares', 'Value': 'value', 'Date': 'date',
                        'Start Date': 'date', 'Transaction': 'transaction',
                        'Insider Name': 'insider', 'Insider': 'insider',
                        'Price': 'price', 'Shares Traded': 'shares',
                        'Average Price': 'price', 'Acquired/Disposed': 'transaction',
                        'Acq/ Disp Type': 'transaction',
                    }
                    df = df.rename(columns={k: v for k, v in col_map.items() if k in df.columns})
                    for _, row in df.iterrows():
                        try:
                            raw_shares = row.get('shares', row.get('Shares', 0))
                            raw_value = row.get('value', row.get('Value', 0))
                        except (ValueError, TypeError):
                            continue
                        shares = 0.0
                        value = 0.0
                        if pd.notna(raw_shares):
                            try:
                                shares = float(raw_shares)
                            except (ValueError, TypeError):
                                shares = 0.0
                        if pd.notna(raw_value):
                            try:
                                value = float(raw_value)
                            except (ValueError, TypeError):
                                value = 0.0
                        if math.isnan(shares) or math.isinf(shares):
                            shares = 0.0
                        if math.isnan(value) or math.isinf(value):
                            value = 0.0
                        date_val = row.get('date', row.get('Date'))
                        date_str = str(date_val)[:10] if pd.notna(date_val) and date_val else ''
                        # Filter by date range
                        if cutoff and date_str:
                            try:
                                row_date = datetime.strptime(date_str, '%Y-%m-%d')
                                if row_date < cutoff:
                                    continue
                            except ValueError:
                                pass
                        # Check both 'transaction' (renamed from 'Transaction', may be NaN) and 'Text' column for type
                        raw_transaction = row.get('transaction', row.get('Text', ''))
                        if pd.isna(raw_transaction) or not raw_transaction:
                            raw_transaction = str(row.get('Text', ''))
                        raw_transaction = str(raw_transaction).lower()
                        is_buy = 'buy' in raw_transaction or 'acq' in raw_transaction or 'purchase' in raw_transaction or 'award' in raw_transaction or 'grant' in raw_transaction
                        is_sale = 'sale' in raw_transaction or 'sell' in raw_transaction or 'disposed' in raw_transaction
                        insider = row.get('insider', row.get('Insider', row.get('Insider Name', '')))
                        if pd.isna(insider):
                            insider = ''
                        price = row.get('price', row.get('Price'))
                        try:
                            if pd.notna(price):
                                price = float(price)
                            else:
                                price = abs(value / shares) if shares != 0 else None
                        except (ValueError, TypeError):
                            price = None
                        if price is not None and (math.isnan(price) or math.isinf(price)):
                            price = None
                        # Deduplicate
                        dedup_key = f"{ticker.upper()}|{date_str}|{insider}|{shares}"
                        if dedup_key in seen:
                            continue
                        seen.add(dedup_key)
                        position = row.get('Position', row.get('position', ''))
                        if pd.isna(position):
                            position = ''
                        ownership = row.get('Ownership', row.get('ownership', ''))
                        if pd.isna(ownership):
                            ownership = ''
                        url = row.get('URL', row.get('url', ''))
                        if pd.isna(url):
                            url = ''
                        ttype = "Buy" if is_buy else ("Sell" if is_sale else "Other")
                        abs_shares = abs(int(shares))
                        # Look up current holdings, title, and last transaction from roster
                        owned = None
                        pct = None
                        roster_title = ''
                        roster_last_tx = ''
                        roster_last_tx_date = ''
                        insider_key = str(insider).strip().upper() if insider else ''
                        cache = holdings_cache.get(ticker.upper(), {})
                        if insider_key in cache:
                            entry = cache[insider_key]
                            owned = int(entry["shares"])
                            roster_title = entry.get("title", "")
                            roster_last_tx = entry.get("last_tx", "")
                            roster_last_tx_date = entry.get("last_tx_date", "")
                            if owned > 0 and abs_shares > 0:
                                pct = round(abs_shares / owned * 100, 2)
                        # Prefer roster title (more specific) over transaction generic position
                        if roster_title:
                            position = roster_title
                        results.append({
                            "ticker": ticker.upper(),
                            "date": date_str,
                            "insider": str(insider)[:60] if insider else 'N/A',
                            "transaction_type": ttype,
                            "shares": abs_shares,
                            "shares_owned": owned,
                            "portfolio_pct": pct,
                            "price": round(price, 2) if price is not None else None,
                            "value": round(abs(value), 2) if value and not math.isnan(value) else None,
                            "position": str(position)[:80] if position else '',
                            "ownership_change": str(ownership)[:20] if ownership else '',
                            "last_tx": roster_last_tx,
                            "last_tx_date": roster_last_tx_date,
                            "url": str(url) if url else '',
                            "text": str(row.get('Text', row.get('text', '')))[:120] if row.get('Text', row.get('text', '')) and pd.notna(row.get('Text', row.get('text', ''))) else '',
                        })
            except Exception as e:
                logger.error(f"Error fetching insider transactions for {ticker}: {e}")
        # Sort by date descending
        results.sort(key=lambda x: x.get('date', ''), reverse=True)
        total = len(results)
        page = results[offset:offset + limit]
        return {"trades": page, "total": total, "offset": offset, "limit": limit, "ticker_meta": ticker_meta}

    def get_analyst_recommendations(self, ticker: str) -> Dict:
        """Get analyst recommendations"""
        try:
            ticker = ticker.upper()
            t = yf.Ticker(ticker)
            
            recommendations = t.recommendations
            if recommendations is None or recommendations.empty:
                return {"symbol": ticker, "recommendations": []}
            
            # Get most recent recommendations
            recent = recommendations.tail(10).to_dict('records')
            
            # Get recommendation summary from info
            info = t.info
            recommendation = info.get("recommendationKey", "N/A")
            target_price = info.get("targetMeanPrice")
            
            return {
                "symbol": ticker,
                "current_recommendation": recommendation,
                "target_price": target_price,
                "recent_changes": recent,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error fetching recommendations for {ticker}: {e}")
            return {"symbol": ticker, "error": str(e)}


# Singleton instance
market_intel = MarketIntelligence()

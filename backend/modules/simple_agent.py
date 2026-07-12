"""
Simple Trading Agent
A straightforward agent that uses yfinance and available APIs to respond to user queries.
No complex workflows, no state machines - just natural conversation.
"""

import json
import logging
import yfinance as yf
from typing import Dict, List, Optional, Any
from datetime import datetime

logger = logging.getLogger(__name__)


class SimpleTradingAgent:
    """Simple agent that can fetch market data and respond naturally."""
    
    def __init__(self, llm_caller):
        """
        Args:
            llm_caller: Async function to call LLM with signature:
                async def call_llm(provider, model, system_prompt, user_prompt, api_key, json_mode, history)
        """
        self.llm_caller = llm_caller
        self.available_tools = {
            "get_quote": self._get_quote,
            "get_technicals": self._get_technicals,
            "get_news": self._get_news,
            "get_chart": self._get_chart,
            "get_full_analysis": self._get_full_analysis,
        }
    
    async def chat(
        self,
        message: str,
        provider: str = "openai",
        model: str = "gpt-4o",
        api_key: Optional[str] = None,
        provider_config: Optional[Dict[str, Any]] = None,
        history: Optional[List[Dict]] = None,
        available_files: Optional[List[str]] = None,
        available_strategies: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Process a user message and return a response.
        
        Returns:
            {
                "response": str,  # Natural language response
                "data": dict,     # Any structured data (quotes, technicals, etc.)
                "actions": list,  # Any actions taken
            }
        """
        try:
            # Build system prompt
            system_prompt = self._build_system_prompt(available_files, available_strategies)
            
            # Build user prompt with context
            user_prompt = f"""User message: {message}

Please analyze this request and:
1. Determine what data/actions are needed
2. Fetch any required market data
3. Provide a natural, conversational response

Respond in JSON format:
{{
    "thinking": "your internal reasoning",
    "tools_needed": ["tool1", "tool2"],  // which tools to call
    "tool_params": {{"tool1": {{"ticker": "AAPL"}}}},  // parameters for each tool
    "response_draft": "your natural response using the data"
}}"""
            
            # Get LLM decision
            llm_response = await self.llm_caller(
                provider=provider,
                model=model,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                api_key=api_key,
                provider_config=provider_config,
                json_mode=True,
                history=history or []
            )
            
            plan = json.loads(llm_response)
            logger.info(f"Agent plan: {plan.get('thinking', 'N/A')}")
            
            # Execute tools
            tool_results = {}
            tools_needed = plan.get("tools_needed", [])
            tool_params = plan.get("tool_params", {})
            
            for tool_name in tools_needed:
                if tool_name in self.available_tools:
                    params = tool_params.get(tool_name, {})
                    try:
                        result = self.available_tools[tool_name](**params)
                        tool_results[tool_name] = result
                        logger.info(f"Tool {tool_name} executed successfully")
                    except Exception as e:
                        logger.error(f"Tool {tool_name} failed: {e}")
                        tool_results[tool_name] = {"error": str(e)}
            
            # Generate final response with tool results
            if tool_results:
                final_prompt = f"""User message: {message}

Data retrieved:
{json.dumps(tool_results, indent=2)}

Please provide a natural, conversational response based on this data. Be direct, insightful, and talk like a knowledgeable trader. No bullet points, no corporate speak.

Respond in JSON format:
{{
    "response": "your natural response",
    "key_insights": ["insight1", "insight2"]  // optional
}}"""
                
                final_response = await self.llm_caller(
                    provider=provider,
                    model=model,
                    system_prompt=system_prompt,
                    user_prompt=final_prompt,
                    api_key=api_key,
                    provider_config=provider_config,
                    json_mode=True,
                    history=history or []
                )
                
                final_data = json.loads(final_response)
                response_text = final_data.get("response", plan.get("response_draft", "I couldn't process that request."))
            else:
                # No tools needed, use draft response
                response_text = plan.get("response_draft", "I'm not sure how to help with that.")
            
            return {
                "response": response_text,
                "data": tool_results,
                "actions": [{"tool": t, "status": "completed"} for t in tools_needed],
                "thinking": plan.get("thinking", "")
            }
            
        except Exception as e:
            logger.error(f"Agent error: {e}", exc_info=True)
            return {
                "response": f"Sorry, I ran into an issue: {str(e)}",
                "data": {},
                "actions": [],
                "error": str(e)
            }
    
    def _build_system_prompt(self, available_files: Optional[List[str]], available_strategies: Optional[List[str]]) -> str:
        """Build the system prompt for the agent."""
        current_datetime = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p %Z")
        return f"""You are a sharp, knowledgeable trading assistant. You have access to real-time market data via yfinance and can help users analyze stocks, understand technicals, and make informed decisions.

📅 CURRENT DATE & TIME: {current_datetime}
⚠️ CRITICAL: Always use this date/time as your reference point. When analyzing market data, news, or trends, base your analysis on THIS date, not your training data cutoff.

Available tools:
- get_quote: Get real-time price, change%, volume, market cap for a ticker
- get_technicals: Get RSI, moving averages, trend analysis, support/resistance
- get_news: Get latest news headlines for a ticker
- get_chart: Get OHLCV price data for charting
- get_full_analysis: Get comprehensive analysis (quote + technicals + news)

Available datasets: {available_files or []}
Available strategies: {available_strategies or []}

Your personality:
- Talk like a knowledgeable trader, not a corporate bot
- Be direct and insightful
- Use numbers naturally: "RSI's at 21 — that's oversold" not "The RSI indicator is at 21.54"
- Short sentences, no fluff
- Have opinions: "This looks like a bounce setup" or "I'd wait for confirmation"
- Ask follow-up questions when relevant
- Never use bullet points in responses — write naturally

When analyzing:
- Lead with the most interesting insight
- Use actual data, never make up numbers
- Be honest about limitations
- Suggest next steps when appropriate

Keep it conversational and helpful."""
    
    def _get_quote(self, ticker: str) -> Dict:
        """Get real-time quote for a ticker."""
        try:
            ticker = ticker.upper()
            t = yf.Ticker(ticker)
            
            # Get most recent data
            hist = t.history(period="1d", interval="1m")
            if hist.empty:
                hist = t.history(period="5d", interval="1d")
            
            if hist.empty:
                return {"symbol": ticker, "error": "No data available"}
            
            latest = hist.iloc[-1]
            info = t.info
            
            current_price = latest['Close']
            prev_close = info.get('previousClose', latest['Open'])
            change = current_price - prev_close
            change_pct = (change / prev_close * 100) if prev_close else 0
            
            return {
                "symbol": ticker,
                "name": info.get("shortName", ticker),
                "price": round(float(current_price), 2),
                "change": round(float(change), 2),
                "change_percent": round(float(change_pct), 2),
                "volume": int(latest['Volume']),
                "high": round(float(latest['High']), 2),
                "low": round(float(latest['Low']), 2),
                "open": round(float(latest['Open']), 2),
                "previous_close": round(float(prev_close), 2),
                "market_cap": info.get("marketCap"),
                "pe_ratio": info.get("trailingPE"),
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error fetching quote for {ticker}: {e}")
            return {"symbol": ticker, "error": str(e)}
    
    def _get_technicals(self, ticker: str, period: str = "3mo") -> Dict:
        """Get technical indicators for a ticker."""
        try:
            ticker = ticker.upper()
            t = yf.Ticker(ticker)
            hist = t.history(period=period)
            
            if hist.empty:
                return {"symbol": ticker, "error": "No data available"}
            
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
            volatility = returns.std() * (252 ** 0.5) * 100
            
            # Support/Resistance
            recent_high = close.tail(20).max()
            recent_low = close.tail(20).min()
            
            current_price = close.iloc[-1]
            
            # Trend
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
    
    def _get_news(self, ticker: str, limit: int = 10) -> Dict:
        """Get recent news for a ticker."""
        try:
            ticker = ticker.upper()
            t = yf.Ticker(ticker)
            
            try:
                news = t.news
            except AttributeError:
                return {"symbol": ticker, "news": []}
            
            if not news or not isinstance(news, list):
                return {"symbol": ticker, "news": []}
            
            parsed_news = []
            for article in news[:limit]:
                if not isinstance(article, dict):
                    continue
                
                content = article.get('content', article)
                
                title = content.get('title', 'No title')
                provider = content.get('provider', {})
                publisher = provider.get('displayName', 'Unknown') if isinstance(provider, dict) else 'Unknown'
                
                click_through = content.get('clickThroughUrl', {})
                canonical = content.get('canonicalUrl', {})
                link = ''
                if isinstance(click_through, dict):
                    link = click_through.get('url', '')
                if not link and isinstance(canonical, dict):
                    link = canonical.get('url', '')
                
                pub_date = content.get('pubDate') or content.get('displayTime')
                
                parsed_news.append({
                    "title": title,
                    "publisher": publisher,
                    "link": link,
                    "published": pub_date,
                })
            
            return {
                "symbol": ticker,
                "news": parsed_news,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error fetching news for {ticker}: {e}")
            return {"symbol": ticker, "error": str(e)}
    
    def _get_chart(self, ticker: str, period: str = "1mo", interval: str = "1d") -> Dict:
        """Get OHLCV chart data."""
        try:
            ticker = ticker.upper()
            t = yf.Ticker(ticker)
            hist = t.history(period=period, interval=interval)
            
            if hist.empty:
                return {"symbol": ticker, "error": "No data available"}
            
            # Convert to list of dicts
            data = []
            for idx, row in hist.iterrows():
                data.append({
                    "date": idx.isoformat(),
                    "open": round(float(row['Open']), 2),
                    "high": round(float(row['High']), 2),
                    "low": round(float(row['Low']), 2),
                    "close": round(float(row['Close']), 2),
                    "volume": int(row['Volume'])
                })
            
            return {
                "symbol": ticker,
                "period": period,
                "interval": interval,
                "data": data,
                "timestamp": datetime.now().isoformat()
            }
        except Exception as e:
            logger.error(f"Error fetching chart for {ticker}: {e}")
            return {"symbol": ticker, "error": str(e)}
    
    def _get_full_analysis(self, ticker: str) -> Dict:
        """Get comprehensive analysis (quote + technicals + news)."""
        return {
            "quote": self._get_quote(ticker),
            "technicals": self._get_technicals(ticker),
            "news": self._get_news(ticker, limit=5)
        }

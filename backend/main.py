import os
import requests
import uuid
import logging
import importlib.util
import re
import json
import datetime
import sys
import threading
import asyncio
import time
import random
import math
import ast
import ipaddress
import socket
from urllib.parse import urlparse, urljoin
from functools import wraps
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, BackgroundTasks, HTTPException, WebSocket, WebSocketDisconnect, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar
from datetime import datetime, timedelta
from tinydb import TinyDB, Query
from tinydb.storages import JSONStorage
from dotenv import load_dotenv
from openai import OpenAI, AzureOpenAI
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

# Optional Cloud SDKs
try: import boto3
except ImportError: boto3 = None
try:
    import vertexai
    from vertexai.generative_models import GenerativeModel
except ImportError: vertexai = None
try: from mistralai.client import Mistral
except ImportError:
    try: from mistralai import Mistral  # fallback for older versions
    except ImportError: Mistral = None


# Add modules to path for imports
sys.path.append(os.path.join(os.path.dirname(__file__), 'modules'))

# Import core modules
from engine import find_best_parallel
from strategies import STRATEGY_MAP, STRATEGY_CATEGORIES
from downloader import download_ticker_data
from market_intelligence import market_intel
from mcp_client import yf_mcp
from acp_agent import router as acp_router

# Load environment variables
load_dotenv()

# Setup logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)


def _count_tokens(text: str) -> int:
    """Approximate token count (~4 chars/token for English)."""
    if not text:
        return 0
    return max(1, len(text) // 4)


def _safe_float(v):
    """Convert to float or None, filtering out NaN/Inf."""
    if v is None:
        return None
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (ValueError, TypeError):
        return None


def _sanitize_nan(value):
    if isinstance(value, dict):
        return {k: _sanitize_nan(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_nan(v) for v in value]
    if isinstance(value, tuple):
        return [_sanitize_nan(v) for v in value]
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    try:
        import pandas as _pd
        if _pd.isna(value):
            return None
    except Exception:
        pass
    return value


def parse_llm_json_object(content: str) -> Dict:
    """Parse a JSON object from LLM output, tolerating code fences or preamble text."""
    if not content:
        raise json.JSONDecodeError("Empty LLM response", "", 0)

    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        json_match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not json_match:
            raise
        return json.loads(json_match.group(0))


def extract_strategy_output(content: str, fallback_ticker: str = "", fallback_category: str = "General") -> Dict:
    """Parse strategy generation output, falling back to markdown/code-fence extraction."""
    try:
        return parse_llm_json_object(content)
    except json.JSONDecodeError as parse_error:
        logger.warning(f"Strategy output was not valid JSON, extracting markdown/code fallback: {parse_error}")

    strategies = []
    code_blocks = re.findall(r"```(?:python|py)?\s*(.*?)```", content or "", re.DOTALL | re.IGNORECASE)
    if not code_blocks and content and "class " in content and "bt.Strategy" in content:
        code_blocks = [content]

    for index, raw_code in enumerate(code_blocks, start=1):
        code = raw_code.strip()
        if "class " not in code or "bt.Strategy" not in code:
            continue
        class_match = re.search(r"class\s+(\w+)\s*\(", code)
        class_name = class_match.group(1) if class_match else f"AIGeneratedStrategy{index}"
        readable_name = re.sub(r"(?<!^)(?=[A-Z])", " ", class_name).strip() or f"AI Generated Strategy {index}"
        strategies.append({
            "name": readable_name,
            "class_name": class_name,
            "code": code,
            "description": f"Extracted from non-JSON LLM output for {fallback_ticker or fallback_category or 'General'}.",
            "analysis": "The model returned markdown/code instead of strict JSON, so the backend extracted the Backtrader class automatically.",
            "ticker": fallback_ticker or "",
        })

    if strategies:
        return {"strategies": strategies, "raw_response": content, "parsed_from": "markdown_fallback"}

    raise json.JSONDecodeError("Could not extract valid strategy code from LLM response", content or "", 0)


def strip_code_fence(code: str) -> str:
    """Remove accidental markdown fences from generated strategy code."""
    cleaned = (code or "").strip()
    fence_match = re.match(r"^```(?:python|py)?\s*(.*?)\s*```$", cleaned, re.DOTALL | re.IGNORECASE)
    if fence_match:
        return fence_match.group(1).strip()
    return cleaned


def public_agent_preview(text: str, limit: int = 900) -> str:
    """Return a compact, user-visible preview for agent activity logs."""
    if not text:
        return ""
    cleaned = re.sub(r"\n{3,}", "\n\n", str(text).strip())
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    if len(cleaned) <= limit:
        return cleaned
    return f"...{cleaned[-limit:]}"


def summarize_runtime_error(error: str, limit: int = 420) -> str:
    """Compact a Python/Backtrader runtime error for user-facing agent logs."""
    if not error:
        return ""
    text = str(error).strip()
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    focused = []
    for line in lines:
        if (
            "AttributeError:" in line
            or "IndexError:" in line
            or "ValueError:" in line
            or "TypeError:" in line
            or line.startswith("File ")
            or line.startswith("elif ")
            or line.startswith("if ")
        ):
            focused.append(line)
    summary = " | ".join(focused[-4:] or lines[-4:])
    if len(summary) > limit:
        return f"...{summary[-limit:]}"
    return summary


def lint_backtrader_strategy_code(code: str) -> List[str]:
    """Catch common LLM-generated Backtrader mistakes before runtime."""
    issues = []
    excluded_self_compare_attrs = {"position", "data", "datas", "broker", "p", "params"}
    scalar_attrs = {
        "stop_price", "entry_price", "highest_price", "lowest_price", "trail_price",
        "take_profit", "target_price", "last_buy_price", "last_sell_price",
        "support_level", "resistance_level", "high_pivot", "low_pivot",
        "pivot_high", "pivot_low", "swing_high", "swing_low",
        "breakout_level", "breakdown_level", "range_high", "range_low",
    }
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return [f"Python syntax error: {exc.msg} at line {exc.lineno}"]

    def is_self_subscript(target):
        return (
            isinstance(target, ast.Subscript)
            and isinstance(target.value, ast.Attribute)
            and isinstance(target.value.value, ast.Name)
            and target.value.value.id == "self"
        )

    def is_bt_indicator_call(node):
        if not isinstance(node, ast.Call):
            return False
        func = node.func
        if isinstance(func, ast.Attribute):
            if isinstance(func.value, ast.Name) and func.value.id in {"btind"}:
                return True
            if isinstance(func.value, ast.Attribute) and isinstance(func.value.value, ast.Name):
                return func.value.value.id == "bt" and func.value.attr in {"ind", "indicators"}
        return False

    def is_self_indicator_compare(node):
        if not isinstance(node, ast.Compare):
            return False
        values = [node.left, *node.comparators]
        for value in values:
            if (
                isinstance(value, ast.Attribute)
                and isinstance(value.value, ast.Name)
                and value.value.id == "self"
                and value.attr not in excluded_self_compare_attrs
                and value.attr not in scalar_attrs
            ):
                return True
        return False

    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and node.attr == "baropen"
            and isinstance(node.value, ast.Attribute)
            and isinstance(node.value.value, ast.Name)
            and node.value.value.id == "self"
            and node.value.attr == "position"
        ):
            issues.append(
                f"Line {node.lineno}: Backtrader Position has no self.position.baropen attribute; "
                "store entry bar yourself, e.g. self.entry_bar = len(self) when a buy order is placed."
            )

        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Attribute)
            and isinstance(node.value.value, ast.Attribute)
            and isinstance(node.value.value.value, ast.Name)
            and node.value.value.value.id == "self"
            and node.value.value.attr == "data"
            and node.value.attr in {"open", "high", "low", "close", "volume"}
            and isinstance(node.slice, ast.Attribute)
            and isinstance(node.slice.value, ast.Name)
            and node.slice.value.id == "self"
        ):
            issues.append(
                f"Line {node.lineno}: do not index data lines with absolute state like self.{node.slice.attr}; "
                "Backtrader data indexes are relative. Store entry_price as a scalar instead."
            )

        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AugAssign):
            targets = [node.target]
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]

        for target in targets:
            if is_self_subscript(target):
                issues.append(
                    f"Line {node.lineno}: do not assign into Backtrader line buffers like self.x[0]; "
                    "store mutable stop/tracking values in scalar attributes such as self.stop_price."
                )
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Attribute)
            and isinstance(node.value.value, ast.Name)
            and node.value.value.id == "self"
            and node.value.attr in scalar_attrs
        ):
            issues.append(
                f"Line {node.lineno}: scalar attribute self.{node.value.attr} should not be indexed with [0]."
            )

        if isinstance(node, ast.FunctionDef) and node.name == "next":
            for child in ast.walk(node):
                if is_bt_indicator_call(child):
                    issues.append(
                        f"Line {child.lineno}: initialize indicators in __init__, not inside next()."
                    )
                if is_self_indicator_compare(child):
                    issues.append(
                        f"Line {child.lineno}: compare indicator current values with [0], "
                        "for example self.crossover[0] > 0."
                    )

    return issues


def repair_backtrader_indicator_comparisons(code: str) -> str:
    """Repair common LLM output: compare self.indicator[0], not self.indicator."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return code

    excluded = {"position", "data", "datas", "broker", "p", "params"}
    scalar_attrs = {
        "stop_price", "entry_price", "highest_price", "lowest_price", "trail_price",
        "take_profit", "target_price", "last_buy_price", "last_sell_price",
        "support_level", "resistance_level", "high_pivot", "low_pivot",
        "pivot_high", "pivot_low", "swing_high", "swing_low",
        "breakout_level", "breakdown_level", "range_high", "range_low",
    }
    excluded_compare_attrs = excluded | scalar_attrs

    class NextCompareRepair(ast.NodeTransformer):
        def __init__(self):
            self.in_next = False

        def visit_FunctionDef(self, node):
            was_in_next = self.in_next
            self.in_next = node.name == "next"
            self.generic_visit(node)
            self.in_next = was_in_next
            return node

        def visit_Compare(self, node):
            self.generic_visit(node)
            if not self.in_next:
                return node

            def fix(value):
                if (
                    isinstance(value, ast.Attribute)
                    and isinstance(value.value, ast.Name)
                    and value.value.id == "self"
                    and value.attr not in excluded_compare_attrs
                ):
                    return ast.copy_location(
                        ast.Subscript(
                            value=value,
                            slice=ast.Constant(value=0),
                            ctx=ast.Load(),
                        ),
                        value,
                    )
                return value

            node.left = fix(node.left)
            node.comparators = [fix(v) for v in node.comparators]
            return node

        def visit_Subscript(self, node):
            self.generic_visit(node)
            if (
                isinstance(node.value, ast.Attribute)
                and isinstance(node.value.value, ast.Name)
                and node.value.value.id == "self"
                and node.value.attr in scalar_attrs
            ):
                return ast.copy_location(node.value, node)
            return node

    repaired = NextCompareRepair().visit(tree)
    ast.fix_missing_locations(repaired)
    try:
        return ast.unparse(repaired)
    except Exception:
        return code


def validate_strategy_code_payload(code: str, class_name: str):
    cleaned_code = strip_code_fence(code)
    cleaned_code = repair_backtrader_indicator_comparisons(cleaned_code)
    lint_issues = lint_backtrader_strategy_code(cleaned_code)
    if lint_issues:
        return False, cleaned_code, "Backtrader validation failed.", "\n".join(lint_issues)

    temp_file = os.path.join(TEMP_DATA_DIR, f"val_{uuid.uuid4().hex}.py")
    try:
        with open(temp_file, "w") as f:
            f.write(cleaned_code)

        spec = importlib.util.spec_from_file_location(class_name, temp_file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        if not hasattr(module, class_name):
            return False, cleaned_code, f"Class '{class_name}' not found.", ""

        return True, cleaned_code, "Code compiled and class found successfully.", ""
    except Exception as e:
        import traceback
        return False, cleaned_code, str(e), traceback.format_exc()
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)


from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    yield
    await yf_mcp.shutdown()

app = FastAPI(title="TradingSpy", lifespan=lifespan)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# WebSocket Manager for real-time task updates
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}  # session_id -> [websockets]
    
    async def connect(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        if session_id not in self.active_connections:
            self.active_connections[session_id] = []
        self.active_connections[session_id].append(websocket)
    
    async def disconnect(self, session_id: str, websocket: WebSocket):
        if session_id in self.active_connections:
            self.active_connections[session_id].remove(websocket)
            if not self.active_connections[session_id]:
                del self.active_connections[session_id]
    
    async def broadcast(self, session_id: str, message: dict):
        if session_id in self.active_connections:
            for connection in self.active_connections[session_id]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    logger.error(f"Error sending WebSocket message: {e}")

manager = ConnectionManager()

# ── Agent confirmation registry ───────────────────────────────────────────────
# Maps confirm_id -> {"event": asyncio.Event, "answer": str | None}
_confirm_registry: Dict[str, dict] = {}

# Constants & Paths
BASE_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
STRATEGIES_DIR = os.path.join(BASE_DATA_DIR, "strategies")
RESULTS_DIR = os.path.join(BASE_DATA_DIR, "results")
MARKET_DATA_DIR = os.path.join(BASE_DATA_DIR, "market_data")
TEMP_DATA_DIR = os.path.join(BASE_DATA_DIR, "temp_datas")
OPTIMIZATION_DIR = os.path.join(BASE_DATA_DIR, "optimization_history")
CONFIG_FILE = os.path.join(BASE_DATA_DIR, "system_settings.json")

for d in [STRATEGIES_DIR, RESULTS_DIR, MARKET_DATA_DIR, TEMP_DATA_DIR, OPTIMIZATION_DIR]:
    os.makedirs(d, exist_ok=True)

# Static User for pure local monolith
LOCAL_USER_ID = "local_user"

# Thread-safe TinyDB storage
_tinydb_lock = threading.Lock()

class _ThreadSafeStorage:
    def __init__(self, filename, **kwargs):
        self._storage = JSONStorage(filename, **kwargs)

    def read(self):
        with _tinydb_lock:
            try:
                return self._storage.read()
            except json.JSONDecodeError:
                logger.warning("TinyDB JSON corrupted, returning empty")
                return {}

    def write(self, data):
        with _tinydb_lock:
            self._storage.write(data)

    def close(self):
        self._storage.close()

# TinyDB Setup (Pure Local Mode)
DB_FILE = os.path.join(BASE_DATA_DIR, "db.json")
tdb = TinyDB(DB_FILE, storage=_ThreadSafeStorage)
results_table = tdb.table("backtest_results")
strategies_table = tdb.table("strategies")
watchlist_table = tdb.table("watchlists")
sessions_table = tdb.table("optimization_sessions")
sync_config_table = tdb.table("sync_config")
agent_runs_table = tdb.table("agent_runs")

# Auto-sync scheduler
scheduler = AsyncIOScheduler()
sync_jobs = {}  # Track active sync jobs

# --- MODELS ---

class BacktestRequest(BaseModel):
    dataset_filename: str
    strategies: List[str]
    stake_range: Optional[List[int]] = None
    trail_range: Optional[List[float]] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    sequential: Optional[bool] = False
    initial_cash: Optional[float] = 100000.0
    commission: Optional[float] = 0.001
    max_workers: Optional[int] = 4

class AIStrategyRequest(BaseModel):
    prompt: str
    api_key: Optional[str] = None
    provider_config: Optional[Dict[str, Any]] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    max_tokens: Optional[int] = 8192
    agent_instructions: Optional[str] = None

    count: Optional[int] = 1
    ticker: Optional[str] = None
    dataset_filename: Optional[str] = None
    mode: Optional[str] = "pattern_fit"
    learn_lookback: Optional[int] = 100
    target_category: Optional[str] = None
    agent_run_id: Optional[str] = None
    generation_round: Optional[int] = None

class SaveStrategyRequest(BaseModel):
    name: str
    code: str
    class_name: str
    ticker: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = "General"

class ValidateStrategyRequest(BaseModel):
    code: str
    class_name: str

class AIEditRequest(BaseModel):
    name: str
    instruction: str
    code: str
    api_key: Optional[str] = None
    provider_config: Optional[Dict[str, Any]] = None
    provider: Optional[str] = None
    model: Optional[str] = None

class DownloadRequest(BaseModel):
    tickers: List[str]
    interval: Optional[str] = "1d"
    period: Optional[str] = "5y"
    suite: Optional[bool] = False
    extended_hours: Optional[bool] = False

class ImprovementRequest(BaseModel):
    strategy_name: str
    dataset_filename: str
    iterations: Optional[int] = 3
    user_prompt: Optional[str] = ""
    api_key: Optional[str] = None
    provider_config: Optional[Dict[str, Any]] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    auto_mode: Optional[bool] = False
    continuous_mode: Optional[bool] = False  # NEW: Restart after completion
    cooldown_minutes: Optional[int] = 360  # NEW: Wait 6 hours between runs
    start_date: Optional[str] = None  # NEW: Backtest start date
    end_date: Optional[str] = None  # NEW: Backtest end date

class AIChatRequest(BaseModel):
    message: str
    intent: Optional[str] = "general"
    api_key: Optional[str] = None
    provider_config: Optional[Dict[str, Any]] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    available_files: Optional[List[str]] = []
    available_strategies: Optional[List[str]] = []
    context: Optional[Dict] = {}
    history: Optional[List[Dict]] = []  # [{role: "user"|"assistant", content: "..."}]
    history_limit: Optional[int] = 20
    thinking_detail: Optional[str] = "normal"
    agent_instructions: Optional[str] = None
    max_tokens: Optional[int] = 8192

class AgentIntentRequest(BaseModel):
    message: str
    api_key: Optional[str] = None
    provider_config: Optional[Dict[str, Any]] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    available_files: Optional[List[str]] = []
    available_strategies: Optional[List[Any]] = []
    history: Optional[List[Dict]] = []
    context: Optional[Dict] = {}
    agent_instructions: Optional[str] = None
    max_tokens: Optional[int] = 1024

class AgentRunRequest(BaseModel):
    workflow: str = "strategy_create"
    prompt: Optional[str] = ""
    ticker: Optional[str] = None
    dataset_filename: Optional[str] = None
    period: Optional[str] = "5y"
    interval: Optional[str] = "1d"
    extended_hours: Optional[bool] = False
    candidate_count: Optional[int] = 3
    max_backtest_workers: Optional[int] = 4
    max_rounds: Optional[int] = 30
    stop_after_no_improvement: Optional[int] = 5
    benchmark_buy_hold: Optional[bool] = True
    benchmark_strategy: Optional[str] = None
    benchmark_mode: Optional[str] = "auto"
    require_fresh_data: Optional[bool] = True
    strategies: Optional[List[str]] = []
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    stake_range: Optional[List[int]] = None
    trail_range: Optional[List[float]] = None
    sequential: Optional[bool] = False
    initial_cash: Optional[float] = 100000.0
    commission: Optional[float] = 0.001
    available_files: Optional[List[str]] = []
    available_strategies: Optional[List[str]] = []
    history: Optional[List[Dict]] = []
    history_limit: Optional[int] = 20
    thinking_detail: Optional[str] = "normal"
    agent_instructions: Optional[str] = None
    max_tokens: Optional[int] = 8192
    api_key: Optional[str] = None
    provider_config: Optional[Dict[str, Any]] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    screen_universe: Optional[str] = None
    screen_requirements: Optional[str] = None
    screen_max_results: Optional[int] = 5
    screen_max_checked: Optional[int] = 30
    target_min_roi: Optional[float] = None

class TradingSignalRequest(BaseModel):
    tickers: List[str]
    period: Optional[str] = "3mo"
    interval: Optional[str] = "1d"

class ShareChatRequest(BaseModel):
    thread_id: str
    title: str
    messages: List[Dict]
    history: List[Dict]
    limit_lines: Optional[int] = None


def normalize_agent_run_request(request: AgentRunRequest) -> AgentRunRequest:
    settings = load_system_settings()
    default_provider = normalize_app_llm_provider(settings.get("default_provider") or os.getenv("DEFAULT_PROVIDER"))
    provider = normalize_provider_for_model(request.provider or default_provider, request.model)
    model = normalize_model(provider, request.model or settings.get("default_model") or os.getenv("DEFAULT_MODEL") or "gemini-2.5-flash")
    request.provider = provider
    request.model = model
    return request

class SystemSettings(BaseModel):
    openai_api_key: Optional[str] = ""
    openrouter_api_key: Optional[str] = ""
    groq_api_key: Optional[str] = ""
    google_ai_studio_api_key: Optional[str] = ""
    litellm_api_key: Optional[str] = ""
    litellm_base_url: Optional[str] = ""
    azure_openai_api_key: Optional[str] = ""
    azure_openai_endpoint: Optional[str] = ""
    azure_openai_api_version: Optional[str] = ""
    aws_access_key_id: Optional[str] = ""
    aws_secret_access_key: Optional[str] = ""
    aws_region: Optional[str] = ""
    gcp_api_key: Optional[str] = ""
    gcp_project: Optional[str] = ""
    gcp_location: Optional[str] = ""
    mistral_api_key: Optional[str] = ""
    default_provider: Optional[str] = "google_ai_studio"
    default_model: Optional[str] = "gemini-2.5-flash"
    enable_openai_compatible_output: Optional[bool] = True
    enable_acp_agent_output: Optional[bool] = False
    enable_a2a_remote_agent_output: Optional[bool] = False
    remote_agent_auth_token: Optional[str] = ""

class SyncConfig(BaseModel):
    enabled: bool = False
    interval_minutes: int = 60  # Default: sync every hour (for backward compatibility)
    tickers: List[str] = []
    data_interval: str = "1d"  # 1m, 5m, 1h, 1d, etc. (for backward compatibility)
    data_period: str = "5d"  # How much history to fetch (for backward compatibility)
    
    # NEW: Multi-granularity sync configuration
    sync_granularities: Optional[List[Dict]] = None  # [{"interval": "1m", "period": "1d", "sync_every_minutes": 5}, ...]
    use_multi_granularity: Optional[bool] = False  # Enable multi-granularity mode

# --- UTILS ---

def get_safe_user_id(user_id: str):
    return re.sub(r'[^a-zA-Z0-9]', '_', user_id)

def get_user_dirs(user_id: str):
    safe_id = get_safe_user_id(user_id)
    user_results_dir = os.path.join(RESULTS_DIR, safe_id)
    user_strategies_dir = os.path.join(STRATEGIES_DIR, safe_id)
    user_data_dir = os.path.join(MARKET_DATA_DIR, safe_id)
    for d in [user_results_dir, user_strategies_dir, user_data_dir]:
        os.makedirs(d, exist_ok=True)
    return user_results_dir, user_strategies_dir, user_data_dir

def resolve_safe_child_path(base_dir: str, filename: str, allowed_ext: tuple = (".txt", ".csv")) -> str:
    """Resolve a user-provided filename under base_dir without allowing traversal."""
    clean_name = os.path.basename(str(filename or ""))
    if not clean_name or clean_name != filename or not clean_name.endswith(allowed_ext):
        raise HTTPException(status_code=400, detail="Invalid filename")
    base_real = os.path.realpath(base_dir)
    target_real = os.path.realpath(os.path.join(base_real, clean_name))
    if os.path.commonpath([base_real, target_real]) != base_real:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return target_real

def validate_public_http_url(raw_url: str) -> str:
    """Allow only public http(s) URLs for local SSRF-sensitive fetch helpers."""
    parsed = urlparse(str(raw_url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid URL")
    if parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="URL credentials are not allowed")
    try:
        addr_infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="URL host could not be resolved")
    for info in addr_infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise HTTPException(status_code=400, detail="Private or local URLs are not allowed")
    return parsed.geturl()

# --- AI UTILS ---

def load_system_settings() -> Dict:
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                return json.load(f)
        except:
            return {}
    return {}

ASSISTANT_OUTPUTS = {
    "openai": {
        "field": "enable_openai_compatible_output",
        "label": "OpenAI-compatible endpoint",
        "default": True,
    },
    "acp": {
        "field": "enable_acp_agent_output",
        "label": "ACP Agent",
        "default": False,
    },
    "a2a": {
        "field": "enable_a2a_remote_agent_output",
        "label": "A2A Remote Agent",
        "default": False,
    },
}

def _assistant_output_enabled(kind: str, settings: Optional[Dict[str, Any]] = None) -> bool:
    config = ASSISTANT_OUTPUTS[kind]
    data = settings or load_system_settings()
    return bool(data.get(config["field"], config["default"]))

def _assistant_output_disabled_response(kind: str) -> JSONResponse:
    label = ASSISTANT_OUTPUTS[kind]["label"]
    return JSONResponse(
        status_code=403,
        content={
            "error": "assistant_output_disabled",
            "message": f"{label} output is disabled in Settings.",
        },
    )

def _assistant_output_auth_response() -> JSONResponse:
    return JSONResponse(
        status_code=401,
        content={
            "error": "assistant_output_unauthorized",
            "message": "Remote agent output requires a valid bearer token.",
        },
    )

def _remote_agent_token(settings: Optional[Dict[str, Any]] = None) -> str:
    data = settings or load_system_settings()
    return (data.get("remote_agent_auth_token") or os.getenv("REMOTE_AGENT_AUTH_TOKEN") or "").strip()


class AssistantOutputGateMiddleware:
    """Gate remote assistant surfaces without wrapping every response stream."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive=receive)
        path = request.url.path.rstrip("/") or "/"
        settings = load_system_settings()

        if path.startswith("/v1") and not _assistant_output_enabled("openai", settings):
            await _assistant_output_disabled_response("openai")(scope, receive, send)
            return

        remote_kind = None
        if path.startswith("/acp"):
            remote_kind = "acp"
        elif path.startswith("/a2a") or path == "/.well-known/agent-card.json":
            remote_kind = "a2a"

        if remote_kind:
            if not _assistant_output_enabled(remote_kind, settings):
                await _assistant_output_disabled_response(remote_kind)(scope, receive, send)
                return
            token = _remote_agent_token(settings)
            if token:
                auth = request.headers.get("authorization", "")
                supplied = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
                if supplied != token:
                    await _assistant_output_auth_response()(scope, receive, send)
                    return

        await self.app(scope, receive, send)


app.add_middleware(AssistantOutputGateMiddleware)


def _fmt_number(value: Any, digits: int = 2) -> str:
    try:
        return f"{float(value):.{digits}f}"
    except Exception:
        return "n/a"


def _fmt_percent(value: Any) -> str:
    try:
        return f"{float(value) * 100:.1f}%"
    except Exception:
        return "n/a"


def _fmt_money(value: Any) -> str:
    try:
        amount = float(value)
    except Exception:
        return "n/a"
    if abs(amount) >= 1_000_000_000:
        return f"${amount / 1_000_000_000:.2f}B"
    if abs(amount) >= 1_000_000:
        return f"${amount / 1_000_000:.2f}M"
    if abs(amount) >= 1_000:
        return f"${amount / 1_000:.1f}K"
    return f"${amount:.2f}"


def _render_insider_activity_answer(result: Dict[str, Any]) -> str:
    universe = result.get("universe") or "selected universe"
    checked = result.get("checked")
    matched = result.get("matched")
    days_back = result.get("days_back")
    as_of = result.get("as_of")
    rows = result.get("rows") or []
    notable = result.get("notable_trades") or []
    header = (
        f"I scanned `{universe}` for recent insider activity"
        f"{f' over the last {days_back} day(s)' if days_back else ''}."
    )
    scope = (
        f"Checked {checked if checked is not None else 'n/a'} symbol(s); "
        f"{matched if matched is not None else len(rows)} had matching insider activity."
    )
    freshness = f" Data as of {str(as_of).replace('T', ' ')[:19]}." if as_of else ""
    lines = [header, scope + freshness]
    note = result.get("interpretation_note")
    if note:
        lines.append(note)
    data_sources = result.get("data_sources") or []
    if data_sources:
        lines.append(f"Source: {', '.join(data_sources)}. I only report transactions returned by this feed; names, dates, prices, and amounts are not inferred.")

    if not rows and not notable:
        lines.append("")
        lines.append("No matching insider transactions were returned for that scan. That may mean no recent filings matched the lookback, or the upstream insider feed was incomplete for those tickers.")
        return "\n".join(lines).strip()

    if rows:
        lines.append("")
        lines.append("Top symbols:")
        for row in rows[:8]:
            symbol = row.get("symbol") or "?"
            bits = []
            if row.get("open_market_buy_count"):
                bits.append(f"{row.get('open_market_buy_count')} open-market buy(s), {_fmt_money(row.get('open_market_buy_value'))}")
            if row.get("open_market_sell_count"):
                bits.append(f"{row.get('open_market_sell_count')} open-market sell(s), {_fmt_money(row.get('open_market_sell_value'))}")
            if row.get("grant_or_award_count"):
                bits.append(f"{row.get('grant_or_award_count')} grant/award(s)")
            largest_buy = row.get("largest_buy") or {}
            largest_sell = row.get("largest_sell") or {}
            detail = "; ".join(bits) if bits else "activity returned, but no classified open-market buy/sell"
            if largest_buy:
                detail += (
                    f". Largest buy: {largest_buy.get('date') or 'date n/a'} "
                    f"{largest_buy.get('insider') or 'insider n/a'} {_fmt_money(largest_buy.get('value'))}"
                )
            if largest_sell:
                detail += (
                    f". Largest sell: {largest_sell.get('date') or 'date n/a'} "
                    f"{largest_sell.get('insider') or 'insider n/a'} {_fmt_money(largest_sell.get('value'))}"
                )
            lines.append(f"- {symbol}: {detail}.")

    if notable:
        lines.append("")
        lines.append("Largest recent transactions:")
        for trade in notable[:6]:
            kind = str(trade.get("classified_as") or "transaction").replace("_", " ")
            price = trade.get("price")
            price_text = f"${float(price):.2f}" if isinstance(price, (int, float)) and math.isfinite(float(price)) else "price unavailable"
            lines.append(
                f"- {trade.get('date') or 'date n/a'} {trade.get('ticker') or '?'}: "
                f"{kind}, {trade.get('insider') or 'insider n/a'}, "
                f"{trade.get('shares') or 'n/a'} shares at {price_text}; value {_fmt_money(trade.get('value'))}."
            )

    lines.append("")
    lines.append("Use this as an insider-activity screen, not a standalone investment signal; sells can be routine, and grants/awards are compensation rather than open-market buying.")
    return "\n".join(lines)


def _classify_insider_trade_for_answer(trade: Dict[str, Any]) -> str:
    tx_type = str(trade.get("transaction_type") or "").lower()
    tx_text = " ".join(str(trade.get(key) or "") for key in ("last_tx", "text", "ownership_change")).lower()
    try:
        price = float(trade.get("price") or 0)
    except Exception:
        price = 0
    if price == 0 or "award" in tx_text or "grant" in tx_text:
        return "grant/award"
    if "sell" in tx_type or "sale" in tx_text or "disposed" in tx_text:
        return "open-market sell"
    if "buy" in tx_type or "purchase" in tx_text or "acq" in tx_text:
        return "open-market buy"
    return "other"


def _render_insider_trades_answer(result: Dict[str, Any]) -> str:
    trades = result.get("trades") or []
    total = result.get("total")
    tickers = sorted({str(t.get("ticker") or "").upper() for t in trades if t.get("ticker")})
    ticker_text = f" for {', '.join(tickers)}" if tickers else ""
    source_note = "Source: TradingSpy insider feed from yfinance insider transaction tables; not independently SEC-verified in this response."
    lines = [
        f"I found {len(trades)} returned insider transaction(s){f' out of {total} total' if total is not None else ''}{ticker_text}.",
        source_note,
        "I am only reporting records returned by the data feed below; no names, dates, prices, or amounts are inferred.",
    ]
    if result.get("error"):
        lines.append(f"Feed error: {result.get('error')}")
    if not trades:
        lines.append("")
        lines.append("No insider transactions were returned for that request. I will not fill gaps from memory.")
        return "\n".join(lines).strip()

    lines.append("")
    lines.append("Returned transactions:")
    for trade in trades[:20]:
        kind = _classify_insider_trade_for_answer(trade)
        price = trade.get("price")
        value = trade.get("value")
        portfolio_pct = trade.get("portfolio_pct")
        price_text = f"${float(price):.2f}" if isinstance(price, (int, float)) and math.isfinite(float(price)) else "price unavailable"
        value_text = _fmt_money(value) if value not in (None, "") else "value unavailable"
        pct_text = f"; {portfolio_pct}% of reported holdings" if portfolio_pct not in (None, "") else ""
        lines.append(
            f"- {trade.get('date') or 'date unavailable'} {trade.get('ticker') or '?'}: "
            f"{kind}, {trade.get('insider') or 'insider unavailable'}, "
            f"{trade.get('shares') or 'shares unavailable'} shares at {price_text}, {value_text}{pct_text}."
        )
    lines.append("")
    lines.append("Awards/grants are compensation events and are not treated as insider buy signals.")
    return "\n".join(lines)


def _render_screen_undervalued_answer(result: Dict[str, Any]) -> str:
    candidates = result.get("candidates") or []
    thresholds = result.get("thresholds") or {}
    universe = result.get("universe") or "selected universe"
    checked = result.get("checked")
    matched = result.get("matched")
    as_of = result.get("as_of")

    header = (
        f"I screened `{universe}` for potentially undervalued fundamentals and found "
        f"{matched if matched is not None else len(candidates)} candidate(s)"
        f"{f' out of {checked} checked symbol(s)' if checked is not None else ''}."
    )
    rule_parts = [
        f"forward P/E <= {thresholds.get('max_forward_pe', 'n/a')}",
        f"PEG <= {thresholds.get('max_peg', 'n/a')}",
        f"P/S <= {thresholds.get('max_price_to_sales', 'n/a')}",
        f"revenue growth >= {_fmt_percent(thresholds.get('min_revenue_growth'))}",
    ]
    if thresholds.get("min_market_cap") is not None:
        rule_parts.append(f"market cap >= {_fmt_money(thresholds.get('min_market_cap'))}")
    if thresholds.get("max_market_cap") is not None:
        rule_parts.append(f"market cap <= {_fmt_money(thresholds.get('max_market_cap'))}")
    if thresholds.get("include_industry_terms"):
        rule_parts.append(f"industry/sector matches {', '.join(thresholds.get('include_industry_terms') or [])}")
    rules = f"Rules used: {'; '.join(rule_parts)}."
    freshness = f" Data as of {str(as_of).replace('T', ' ')[:19]}." if as_of else ""

    if not candidates:
        rejected = result.get("rejected_sample") or []
        lines = [header, rules + freshness, "", "No name passed the screen. Closest rejected examples:"]
        for item in rejected[:5]:
            caution = "; ".join(item.get("cautions") or []) if isinstance(item.get("cautions"), list) else item.get("reason", "")
            lines.append(f"- {item.get('symbol', '?')}: score {item.get('score', 'n/a')}. {caution}")
        return "\n".join(lines).strip()

    lines = [header, rules + freshness, ""]
    for idx, candidate in enumerate(candidates[:5], start=1):
        quote = candidate.get("quote") or {}
        symbol = candidate.get("symbol") or candidate.get("ticker") or "?"
        name = candidate.get("name")
        price = quote.get("price") if quote.get("price") is not None else candidate.get("price")
        reasons = "; ".join((candidate.get("reasons") or [])[:4]) or "matched the screen"
        cautions = "; ".join((candidate.get("cautions") or [])[:2])
        latest_bar = quote.get("latest_bar")
        news = " | ".join(
            item.get("title", "")
            for item in (candidate.get("recent_news") or [])[:2]
            if isinstance(item, dict) and item.get("title")
        )
        text = (
            f"{idx}. {symbol}{f' ({name})' if name and name != symbol else ''}: "
            f"${_fmt_number(price)}; forward P/E {_fmt_number(candidate.get('forward_pe'))}, "
            f"PEG {_fmt_number(candidate.get('peg_ratio'))}, P/S {_fmt_number(candidate.get('price_to_sales'))}, "
            f"revenue growth {_fmt_percent(candidate.get('revenue_growth'))}, "
            f"profit margin {_fmt_percent(candidate.get('profit_margin'))}, "
            f"relative volume {_fmt_number(quote.get('relative_volume_30d'))}x. "
            f"Why it passed: {reasons}."
        )
        if latest_bar:
            text += f" Latest bar: {str(latest_bar)[:10]}"
            if quote.get("latest_bar_age_days") is not None:
                text += f" ({quote.get('latest_bar_age_days')} day(s) old)."
            else:
                text += "."
        if cautions:
            text += f" Watch: {cautions}."
        if news:
            text += f" News: {news}."
        lines.append(text)
    lines.append("")
    lines.append("This is a screen, not a buy recommendation. I would treat the top names as candidates for deeper thesis work, not automatic buys.")
    return "\n".join(lines)

# ACP (Agent Communication Protocol) router
app.include_router(acp_router, prefix="/acp")

def normalize_provider(provider: Optional[str]) -> str:
    """Normalize provider ids from UI/localStorage/env into backend canonical ids."""
    p = (provider or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "googleaistudio": "google_ai_studio",
        "google_ai": "google_ai_studio",
        "gemini": "google_ai_studio",
        "google_gemini": "google_ai_studio",
        "lite_llm": "litellm",
        "lite": "litellm",
        "vertex": "gcp",
        "vertex_ai": "gcp",
        "google_vertex_ai": "gcp",
    }
    return aliases.get(p, p or "google_ai_studio")

def normalize_model(provider: str, model: Optional[str]) -> str:
    """Normalize common model aliases to provider model ids."""
    m = (model or "").strip()
    if provider == "google_ai_studio":
        aliases = {
            "gemini-flash-latest": "gemini-2.5-flash",
            "gemini_flash_latest": "gemini-2.5-flash",
            "gemini-latest": "gemini-2.5-flash",
            "gemini_flash": "gemini-2.5-flash",
        }
        return aliases.get(m.lower(), m or "gemini-2.5-flash")
    if provider == "mistral":
        return m or "mistral-large-latest"
    if provider == "groq":
        return m or "llama-3.1-8b-instant"
    if provider == "aws":
        return m or "anthropic.claude-3-haiku-20240307-v1:0"
    if provider == "gcp":
        return m or "gemini-1.5-pro"
    if provider == "openrouter":
        return m or "openai/gpt-4o-mini"
    if provider == "litellm":
        return m or "gpt-4o-mini"
    return m or "gemini-2.5-flash"

def normalize_provider_for_model(provider: Optional[str], model: Optional[str]) -> str:
    """Correct common UI/provider drift, such as Gemini models submitted as OpenAI."""
    normalized = normalize_provider(provider)
    model_l = (model or "").strip().lower()
    if normalized == "openai" and ("gemini" in model_l or model_l.startswith("models/gemini")):
        return "google_ai_studio"
    return normalized

APP_LLM_PROVIDERS = {"google_ai_studio", "mistral", "openrouter", "litellm"}

def normalize_app_llm_provider(provider: Optional[str]) -> str:
    """Provider choices exposed in the product UI after validation."""
    normalized = normalize_provider(provider)
    return normalized if normalized in APP_LLM_PROVIDERS else "google_ai_studio"

def _provider_config_value(provider_config: Optional[Dict[str, Any]], settings: Dict, key: str, env_key: str = None, default: Any = None):
    provider_config = provider_config or {}
    value = provider_config.get(key)
    if value not in (None, ""):
        return value
    value = settings.get(key)
    if value not in (None, ""):
        return value
    if env_key:
        value = os.getenv(env_key)
        if value not in (None, ""):
            return value
    return default

def resolve_provider_credentials(provider: str, api_key: str = None, provider_config: Optional[Dict[str, Any]] = None, settings: Dict = None) -> Dict[str, Any]:
    settings = settings or load_system_settings()
    provider = normalize_provider(provider)
    cfg = provider_config or {}

    if provider == "openai":
        return {"api_key": api_key or _provider_config_value(cfg, settings, "openai_api_key", "OPENAI_API_KEY")}
    if provider == "openrouter":
        return {"api_key": api_key or _provider_config_value(cfg, settings, "openrouter_api_key", "OPENROUTER_API_KEY"), "base_url": "https://openrouter.ai/api/v1"}
    if provider == "groq":
        return {"api_key": api_key or _provider_config_value(cfg, settings, "groq_api_key", "GROQ_API_KEY"), "base_url": "https://api.groq.com/openai/v1"}
    if provider == "google_ai_studio":
        return {
            "api_key": api_key or _provider_config_value(cfg, settings, "google_ai_studio_api_key", "GOOGLE_AI_STUDIO_API_KEY") or os.getenv("GEMINI_API_KEY"),
            "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        }
    if provider == "litellm":
        return {
            "api_key": api_key or _provider_config_value(cfg, settings, "litellm_api_key", "LITELLM_API_KEY") or "not-needed",
            "base_url": _provider_config_value(cfg, settings, "litellm_base_url", "LITELLM_BASE_URL", "http://localhost:4000/v1"),
        }
    if provider == "mistral":
        return {"api_key": api_key or _provider_config_value(cfg, settings, "mistral_api_key", "MISTRAL_API_KEY")}
    if provider == "azure":
        return {
            "api_key": api_key or _provider_config_value(cfg, settings, "azure_openai_api_key", "AZURE_OPENAI_API_KEY"),
            "azure_endpoint": _provider_config_value(cfg, settings, "azure_openai_endpoint", "AZURE_OPENAI_ENDPOINT"),
            "api_version": _provider_config_value(cfg, settings, "azure_openai_api_version", "AZURE_OPENAI_API_VERSION", "2024-02-15-preview"),
        }
    if provider == "aws":
        return {
            "aws_access_key_id": _provider_config_value(cfg, settings, "aws_access_key_id", "AWS_ACCESS_KEY_ID") or api_key,
            "aws_secret_access_key": _provider_config_value(cfg, settings, "aws_secret_access_key", "AWS_SECRET_ACCESS_KEY"),
            "aws_region": _provider_config_value(cfg, settings, "aws_region", "AWS_REGION", "us-east-1"),
        }
    if provider == "gcp":
        return {
            "gcp_api_key": api_key or _provider_config_value(cfg, settings, "gcp_api_key", "GCP_API_KEY"),
            "gcp_project": _provider_config_value(cfg, settings, "gcp_project", "GCP_PROJECT"),
            "gcp_location": _provider_config_value(cfg, settings, "gcp_location", "GCP_LOCATION", "us-central1"),
        }
    return {"api_key": api_key}

def build_langchain_chat_model(provider: str, model: str, api_key: str = None, provider_config: Optional[Dict[str, Any]] = None, temperature: float = 0):
    settings = load_system_settings()
    default_provider = normalize_app_llm_provider(settings.get("default_provider") or os.getenv("DEFAULT_PROVIDER"))
    provider = normalize_provider_for_model(provider or default_provider, model)
    model = normalize_model(provider, model or settings.get("default_model") or os.getenv("DEFAULT_MODEL", "gemini-2.5-flash"))
    creds = resolve_provider_credentials(provider, api_key, provider_config, settings)

    if provider in {"openai", "openrouter", "groq", "google_ai_studio", "litellm"}:
        from langchain_openai import ChatOpenAI
        key = creds.get("api_key")
        if not key:
            raise ValueError(f"No API key configured for {provider}")
        kwargs = {"model": model, "api_key": key, "temperature": temperature}
        if creds.get("base_url"):
            kwargs["base_url"] = creds["base_url"]
        return ChatOpenAI(**kwargs), key

    if provider == "mistral":
        from langchain_mistralai.chat_models import ChatMistralAI
        key = creds.get("api_key")
        if not key:
            raise ValueError("No API key configured for mistral")
        return ChatMistralAI(model=model, api_key=key, temperature=temperature), key

    if provider == "azure":
        from langchain_openai import AzureChatOpenAI
        key = creds.get("api_key")
        if not key or not creds.get("azure_endpoint"):
            raise ValueError("Azure requires azure_openai_api_key and azure_openai_endpoint")
        return AzureChatOpenAI(
            azure_deployment=model,
            api_key=key,
            azure_endpoint=creds["azure_endpoint"],
            api_version=creds.get("api_version") or "2024-02-15-preview",
            temperature=temperature,
        ), key

    if provider == "aws":
        if not creds.get("aws_access_key_id") or not creds.get("aws_secret_access_key"):
            raise ValueError("AWS Bedrock requires aws_access_key_id and aws_secret_access_key")
        try:
            from langchain_aws import ChatBedrock
        except ImportError as exc:
            raise ValueError("AWS Bedrock requires the langchain-aws package. Rebuild after installing backend requirements.") from exc
        if not boto3:
            raise ValueError("AWS Bedrock requires boto3. Rebuild after installing backend requirements.")
        session = boto3.Session(
            aws_access_key_id=creds["aws_access_key_id"],
            aws_secret_access_key=creds["aws_secret_access_key"],
            region_name=creds.get("aws_region") or "us-east-1",
        )
        return ChatBedrock(
            model_id=model,
            client=session.client("bedrock-runtime"),
            model_kwargs={"temperature": temperature},
        ), creds["aws_access_key_id"]

    if provider == "gcp":
        try:
            from langchain_google_vertexai import ChatVertexAI
        except ImportError as exc:
            raise ValueError("GCP Vertex AI requires the langchain-google-vertexai package. Rebuild after installing backend requirements.") from exc
        if not creds.get("gcp_project"):
            raise ValueError("GCP Vertex AI requires gcp_project plus ADC/service-account auth. Use Google AI Studio for API-key Gemini.")
        return ChatVertexAI(
            model_name=model,
            project=creds.get("gcp_project"),
            location=creds.get("gcp_location") or "us-central1",
            temperature=temperature,
        ), creds.get("gcp_project")

    raise ValueError(f"Provider {provider} not supported")

async def call_llm(provider: str, model: str, system_prompt: str, user_prompt: str, api_key: str = None, provider_config: Optional[Dict[str, Any]] = None, json_mode: bool = True, history: list = None, max_tokens: int = 8192, on_token: callable = None):
    """Unified entry point for all LLM providers. `on_token` callback receives each token chunk for streaming."""
    settings = load_system_settings()
    
    # Use UI-defined provider/model if not specified in request
    default_provider = normalize_app_llm_provider(settings.get("default_provider") or os.getenv("DEFAULT_PROVIDER"))
    provider = normalize_provider_for_model(provider or default_provider, model)
    model = normalize_model(provider, model or settings.get("default_model") or os.getenv("DEFAULT_MODEL", "gemini-2.5-flash"))
    creds = resolve_provider_credentials(provider, api_key, provider_config, settings)
    
    logger.info(f"LLM Call: Provider={provider}, Model={model}")

    # Build messages list with optional history
    messages = [{"role": "system", "content": system_prompt}]
    if history:
        for h in history:
            if h.get("role") in ("user", "assistant") and h.get("content"):
                messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": user_prompt})

    def _extract_gemini_text(result: Dict) -> str:
        candidates = result.get("candidates") or []
        if not candidates:
            return ""
        parts = candidates[0].get("content", {}).get("parts", [])
        return "".join(part.get("text", "") for part in parts)
    
    # 1. Azure OpenAI
    if provider == "azure":
        client = AzureOpenAI(
            api_key=creds.get("api_key"),
            api_version=creds.get("api_version") or "2024-02-15-preview",
            azure_endpoint=creds.get("azure_endpoint")
        )
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_object"} if json_mode else None,
            max_tokens=max_tokens
        )
        return response.choices[0].message.content

    # 2. AWS Bedrock
    elif provider == "aws" and boto3:
        session = boto3.Session(
            aws_access_key_id=creds.get("aws_access_key_id"),
            aws_secret_access_key=creds.get("aws_secret_access_key"),
            region_name=creds.get("aws_region") or "us-east-1"
        )
        bedrock = session.client("bedrock-runtime")
        # Bedrock uses separate system + messages format
        user_messages = [m for m in messages if m["role"] != "system"]
        payload = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": max_tokens,
            "system": system_prompt,
            "messages": user_messages
        }
        res = bedrock.invoke_model(modelId=model, body=json.dumps(payload))
        res_body = json.loads(res.get('body').read())
        return res_body.get('content')[0].get('text')
    elif provider == "aws":
        raise Exception("AWS Bedrock requires boto3. Rebuild after installing backend requirements.")

    # 3. GCP Vertex AI
    elif provider == "gcp":
        gcp_project = creds.get("gcp_project")
        gcp_location = creds.get("gcp_location") or "us-central1"
        if vertexai:
            vertexai.init(project=gcp_project, location=gcp_location)
            gemini = GenerativeModel(model_name=model)
            history_text = ""
            for m in messages[1:-1]:
                role = "User" if m["role"] == "user" else "Assistant"
                history_text += f"{role}: {m['content']}\n"
            full_prompt = f"{system_prompt}\n\n{history_text}User Request: {user_prompt}"
            response = gemini.generate_content(full_prompt)
            return response.text
        else:
            raise Exception("GCP Vertex AI requires google-cloud-aiplatform plus ADC/service-account auth. Use Google AI Studio for API-key Gemini.")

    # 4. Google AI Studio / Gemini API
    elif provider == "google_ai_studio":
        gemini_key = creds.get("api_key")
        if not gemini_key:
            raise Exception("API Key missing for Google AI Studio")

        model_name = model if model.startswith("models/") else f"models/{model}"
        url = f"https://generativelanguage.googleapis.com/v1beta/{model_name}:generateContent"
        headers = {
            "x-goog-api-key": gemini_key,
            "Content-Type": "application/json",
        }
        history_parts = []
        for m in messages[1:-1]:
            role = "User" if m["role"] == "user" else "Assistant"
            history_parts.append(f"{role}: {m['content']}")
        full_prompt = f"{system_prompt}\n\n" + "\n".join(history_parts) + f"\n\nUser Request: {user_prompt}"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": full_prompt}]}],
            "generationConfig": {
                "temperature": 0.7,
                "maxOutputTokens": max_tokens,
            },
        }
        if json_mode:
            payload["generationConfig"]["responseMimeType"] = "application/json"

        response = requests.post(url, json=payload, headers=headers, timeout=180)
        if response.status_code != 200:
            raise Exception(f"Google AI Studio API error: {response.text}")
        content = _extract_gemini_text(response.json())
        if on_token and content:
            on_token(content)
        return content

    # 5. Mistral
    elif provider == "mistral" and Mistral:
        client = Mistral(api_key=creds.get("api_key"))
        mistral_messages = list(messages)
        
        # For JSON mode, use a much simpler and more direct approach
        if json_mode:
            # Simplify the system prompt - be direct but not threatening
            mistral_messages[0] = {
                "role": "system", 
                "content": system_prompt + "\n\nIMPORTANT: Respond with valid JSON only. Format:\n{\"response\": \"your message\", \"reasoning\": \"brief explanation\", \"actions\": [...], \"done\": false}"
            }
            
            # Use response_format with proper error handling
            try:
                res = await asyncio.to_thread(
                    client.chat.complete,
                    model=model, 
                    messages=mistral_messages, 
                    max_tokens=max_tokens,
                    response_format={"type": "json_object"}
                )
                content = res.choices[0].message.content
            except Exception as e:
                # If response_format fails, try without it but with stronger prompt
                logger.warning(f"Mistral response_format failed, trying without: {e}")
                mistral_messages[0]["content"] = system_prompt + "\n\nYou MUST respond with ONLY valid JSON in this exact format:\n{\"response\": \"your message here\", \"reasoning\": \"brief explanation\", \"actions\": [], \"done\": false}\n\nDo not include any text before or after the JSON object."
                res = await asyncio.to_thread(client.chat.complete, model=model, messages=mistral_messages, max_tokens=max_tokens)
                content = res.choices[0].message.content
        else:
            res = await asyncio.to_thread(client.chat.complete, model=model, messages=mistral_messages, max_tokens=max_tokens)
            content = res.choices[0].message.content
            if on_token:
                on_token(content)
            
        # Clean up common formatting issues
        if json_mode:
            content = content.strip()
            
            # Remove markdown code fences
            if content.startswith("```"):
                content = re.sub(r"^```(?:json)?\s*", "", content)
                content = re.sub(r"\s*```$", "", content)
                content = content.strip()
            
            # Try to extract JSON if there's text before/after
            if not content.startswith("{"):
                # Look for JSON object in the response
                json_match = re.search(r'\{.*\}', content, re.DOTALL)
                if json_match:
                    content = json_match.group(0)
                    logger.warning(f"Extracted JSON from Mistral response (had extra text)")
            
            # Validate JSON
            try:
                json.loads(content)
            except json.JSONDecodeError as e:
                logger.error(f"Mistral returned invalid JSON: {content[:300]}")
                # Return a fallback JSON response instead of crashing
                fallback = {
                    "response": content[:500] if content else "I encountered an error generating a response.",
                    "reasoning": "Mistral returned non-JSON response, using fallback",
                    "actions": [],
                    "done": True
                }
                logger.warning(f"Using fallback JSON response for Mistral")
                return json.dumps(fallback)
        
        return content
    elif provider == "mistral":
        raise Exception("Mistral requires the mistralai package. Rebuild after installing backend requirements.")

    # 6. OpenAI Compatible (OpenAI, OpenRouter, Groq, LiteLLM)
    else:
        effective_key = api_key
        base_url = creds.get("base_url")
        effective_key = effective_key or creds.get("api_key")

        if not effective_key:
            raise Exception(f"API Key missing for provider {provider}")

        client = OpenAI(api_key=effective_key, base_url=base_url, timeout=180)
        if on_token and not json_mode:
            # Streaming mode
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                stream=True,
                max_tokens=max_tokens
            )
            full_content = ""
            for chunk in response:
                if chunk.choices and len(chunk.choices) > 0:
                    delta = chunk.choices[0].delta
                    if delta and delta.content:
                        full_content += delta.content
                        on_token(delta.content)
            return full_content
        else:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                response_format={"type": "json_object"} if json_mode else None,
                max_tokens=max_tokens,
                timeout=180
            )
            return response.choices[0].message.content


def get_price_action_summary(dataset_filename: str, bar_limit: int = 100) -> str:
    """Read recent bars from CSV and generate a text summary for the AI."""
    try:
        user_id = LOCAL_USER_ID
        _, _, user_data_dir = get_user_dirs(user_id)
        file_path = resolve_safe_child_path(user_data_dir, dataset_filename)
        
        if not os.path.exists(file_path):
            file_path = resolve_safe_child_path(MARKET_DATA_DIR, dataset_filename)
            if not os.path.exists(file_path): return ""
            
        df = pd.read_csv(file_path)
        for col in ["Open", "High", "Low", "Close", "Volume"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df.dropna(subset=["Open", "High", "Low", "Close"]).copy()
        if len(df) < 20: return "Not enough data for deep analysis."
        
        # Calculate Technical Indicators
        df['SMA20'] = df['Close'].rolling(window=20).mean()
        df['SMA50'] = df['Close'].rolling(window=50).mean()
        
        # RSI 14
        delta = df['Close'].diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=14).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
        rs = gain / loss
        df['RSI'] = 100 - (100 / (1 + rs))
        
        recent = df.tail(bar_limit).copy()
        last = recent.iloc[-1]
        prior = recent.iloc[:-1] if len(recent) > 1 else recent
        
        # Calculate some basics
        volatility = recent['Close'].std() / recent['Close'].mean() * 100
        trend = (recent['Close'].iloc[-1] - recent['Close'].iloc[0]) / recent['Close'].iloc[0] * 100
        avg_rsi = recent['RSI'].mean()
        current_rsi = recent['RSI'].iloc[-1]
        recent_high_20 = prior.tail(20)['High'].max() if len(prior) >= 20 else prior['High'].max()
        recent_low_20 = prior.tail(20)['Low'].min() if len(prior) >= 20 else prior['Low'].min()
        recent_high_50 = prior.tail(50)['High'].max() if len(prior) >= 50 else prior['High'].max()
        recent_low_50 = prior.tail(50)['Low'].min() if len(prior) >= 50 else prior['Low'].min()
        avg_volume_20 = prior.tail(20)['Volume'].mean() if 'Volume' in prior else None
        current_volume = last.get('Volume')
        volume_ratio = (current_volume / avg_volume_20) if avg_volume_20 and avg_volume_20 > 0 else None
        one_bar_change = ((last['Close'] - last['Open']) / last['Open'] * 100) if last['Open'] else 0
        five_bar_change = ((recent['Close'].iloc[-1] - recent['Close'].iloc[-6]) / recent['Close'].iloc[-6] * 100) if len(recent) >= 6 and recent['Close'].iloc[-6] else 0
        twenty_bar_change = ((recent['Close'].iloc[-1] - recent['Close'].iloc[-21]) / recent['Close'].iloc[-21] * 100) if len(recent) >= 21 and recent['Close'].iloc[-21] else trend
        atr = (recent['High'] - recent['Low']).tail(14).mean()
        atr_pct = (atr / last['Close'] * 100) if last['Close'] else None
        breakout_20 = last['Close'] > recent_high_20 if pd.notna(recent_high_20) else False
        breakdown_20 = last['Close'] < recent_low_20 if pd.notna(recent_low_20) else False
        near_high_20 = ((recent_high_20 - last['Close']) / last['Close'] * 100) if pd.notna(recent_high_20) and last['Close'] else None
        near_low_20 = ((last['Close'] - recent_low_20) / last['Close'] * 100) if pd.notna(recent_low_20) and last['Close'] else None
        rsi_min_30 = recent.tail(30)['RSI'].min()
        rsi_max_30 = recent.tail(30)['RSI'].max()
        viable_signals = []
        if breakout_20:
            viable_signals.append("20-bar close breakout is already active")
        elif near_high_20 is not None and near_high_20 <= 2:
            viable_signals.append("price is within 2% of 20-bar high; breakout trigger can be realistic")
        if breakdown_20:
            viable_signals.append("20-bar breakdown is active")
        if current_rsi <= 35 or rsi_min_30 <= 35:
            viable_signals.append("RSI oversold/reversion trigger has appeared recently")
        if current_rsi >= 65 or rsi_max_30 >= 65:
            viable_signals.append("RSI momentum/overbought trigger has appeared recently")
        if volume_ratio is not None and volume_ratio >= 1.2:
            viable_signals.append("current volume is above the 20-bar average")
        if not viable_signals:
            viable_signals.append("strict breakout/oversold thresholds may not trigger; use adaptive thresholds or fallback entries")

        def fmt_num(value, digits=2):
            try:
                if value is None or pd.isna(value):
                    return "unavailable"
                return f"{float(value):.{digits}f}"
            except Exception:
                return "unavailable"
        
        # Determine MA position
        above_sma20 = recent['Close'].iloc[-1] > recent['SMA20'].iloc[-1] if pd.notna(recent['SMA20'].iloc[-1]) else None
        above_sma50 = recent['Close'].iloc[-1] > recent['SMA50'].iloc[-1] if pd.notna(recent['SMA50'].iloc[-1]) else None
        ma_status = f"Close {'above' if above_sma20 else 'below'} SMA20; {'above' if above_sma50 else 'below'} SMA50"
        
        # Pick last 30 bars for high-density pattern recognition
        bars_30 = recent.tail(30)[['Date', 'Open', 'High', 'Low', 'Close', 'Volume', 'RSI']].to_string(index=False)
        
        return f"""
Deep Price Action Intel (Last {len(recent)} Bars):
- Market Regime: {'Bullish Trend' if trend > 2 else 'Bearish Trend' if trend < -2 else 'Sideways/Chop'}
- Volatility: {volatility:.2f}%
- Moving Average Status: {ma_status}
- RSI Context: Average {avg_rsi:.1f}, Current {current_rsi:.1f}
- Last Close: {last['Close']:.2f}; 1-bar change {one_bar_change:.2f}%; 5-bar change {five_bar_change:.2f}%; 20-bar change {twenty_bar_change:.2f}%
- 20-bar range before last bar: {recent_low_20:.2f} to {recent_high_20:.2f}; 50-bar range: {recent_low_50:.2f} to {recent_high_50:.2f}
- Breakout context: 20-bar breakout active={breakout_20}; breakdown active={breakdown_20}; distance to 20-bar high={fmt_num(near_high_20)}%; distance above 20-bar low={fmt_num(near_low_20)}%
- ATR(14) approx: {fmt_num(atr)} ({fmt_num(atr_pct)}% of price)
- Volume context: latest={int(current_volume) if pd.notna(current_volume) else 'unavailable'}; 20-bar avg={int(avg_volume_20) if avg_volume_20 and pd.notna(avg_volume_20) else 'unavailable'}; ratio={fmt_num(volume_ratio)}x
- Recently viable triggers: {'; '.join(viable_signals)}
- Strategy generation guardrail: entry rules must be realistic for this candle profile. Avoid ultra-strict combinations that require breakout + high volume + RSI extremes at the same time unless the recent bars show that combination. Include at least one adaptive entry path that can trade in the observed regime.

High-Density Recent Bar Sequence (Last 30 Bars):
{bars_30}
"""
    except Exception as e:
        logger.error(f"Error summarizing price action: {e}")
        return ""

# --- IN-MEMORY STORAGE ---
results_store = {}
task_statuses = {}
results_store_lock = threading.Lock()


def init_task_state(task_id: str, initial_state: Dict):
    with results_store_lock:
        results_store[task_id] = {
            **initial_state,
            "events": [],
            "event_seq": 0,
        }


def emit_task_event(task_id: str, event_type: str, **payload):
    with results_store_lock:
        task = results_store.get(task_id)
        if not task:
            return
        seq = task.get("event_seq", 0) + 1
        task["event_seq"] = seq
        task.setdefault("events", []).append({
            "seq": seq,
            "type": event_type,
            **payload,
        })
        if len(task["events"]) > 500:
            task["events"] = task["events"][-500:]


def update_task_state(task_id: str, **fields):
    with results_store_lock:
        task = results_store.get(task_id)
        if not task:
            return
        task.update(fields)
improvement_sessions = {}
agent_runs = {}
download_lock = threading.Lock()


def _resolve_market_data_path(user_id: str, filename: str) -> str:
    _, _, user_data_dir = get_user_dirs(user_id)
    local_path = resolve_safe_child_path(user_data_dir, filename)
    if os.path.exists(local_path):
        return local_path
    fallback = resolve_safe_child_path(MARKET_DATA_DIR, filename)
    if os.path.exists(fallback):
        return fallback
    return local_path


def get_dataset_meta_from_path(file_path: str) -> Dict[str, Any]:
    try:
        if not os.path.exists(file_path):
            return {"start": None, "end": None, "rows": 0, "exists": False}
        df = pd.read_csv(file_path)
        if df.empty or "Date" not in df.columns:
            return {"start": None, "end": None, "rows": 0, "exists": True}
        df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
        df = df.dropna(subset=["Date"]).sort_values("Date")
        if df.empty:
            return {"start": None, "end": None, "rows": 0, "exists": True}
        return {
            "start": df["Date"].iloc[0].strftime("%Y-%m-%d"),
            "end": df["Date"].iloc[-1].strftime("%Y-%m-%d"),
            "rows": int(len(df)),
            "exists": True,
        }
    except Exception as e:
        logger.warning(f"Failed to inspect dataset metadata for {file_path}: {e}")
        return {"start": None, "end": None, "rows": 0, "exists": os.path.exists(file_path), "error": str(e)}


def _latest_expected_daily_bar_date(target_end: str = None) -> str:
    target_date = pd.to_datetime(target_end or datetime.now().strftime("%Y-%m-%d")).date()
    today = datetime.now().date()
    effective = today - timedelta(days=1) if target_date >= today else target_date
    start = effective - timedelta(days=14)
    holidays = set(pd.to_datetime(USFederalHolidayCalendar().holidays(start=start, end=effective)).date)
    while effective.weekday() >= 5 or effective in holidays:
        effective -= timedelta(days=1)
    return effective.strftime("%Y-%m-%d")


def get_dataset_status(user_id: str, filename: str, requested_end: str = None) -> Dict[str, Any]:
    path = _resolve_market_data_path(user_id, filename)
    meta = get_dataset_meta_from_path(path)
    today = datetime.now().strftime("%Y-%m-%d")
    target_end = requested_end or today
    effective_end = _latest_expected_daily_bar_date(target_end)
    stale = True
    if meta.get("end"):
        try:
            stale = pd.to_datetime(meta["end"]).date() < pd.to_datetime(effective_end).date()
        except Exception:
            stale = True
    return {
        "filename": filename,
        "path": path,
        "requested_end": target_end,
        "effective_end": effective_end,
        "fresh": bool(meta.get("exists") and not stale),
        "stale": bool(stale),
        **meta,
    }


def calculate_buy_hold_benchmark(file_path: str, start_date: str = None, end_date: str = None, initial_cash: float = 100000.0) -> Dict[str, Any]:
    try:
        df = pd.read_csv(file_path)
        if df.empty or "Date" not in df.columns or "Close" not in df.columns:
            return {"available": False, "reason": "Dataset missing Date/Close columns"}
        df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
        df["Close"] = pd.to_numeric(df["Close"], errors="coerce")
        df = df.dropna(subset=["Date", "Close"]).sort_values("Date")
        if start_date:
            df = df[df["Date"] >= pd.to_datetime(start_date)]
        if end_date:
            df = df[df["Date"] <= pd.to_datetime(end_date)]
        if len(df) < 2:
            return {"available": False, "reason": "Not enough bars for benchmark"}
        start_price = float(df["Close"].iloc[0])
        end_price = float(df["Close"].iloc[-1])
        if start_price <= 0:
            return {"available": False, "reason": "Invalid start price"}
        roi = ((end_price - start_price) / start_price) * 100
        return {
            "available": True,
            "roi": roi,
            "start": df["Date"].iloc[0].strftime("%Y-%m-%d"),
            "end": df["Date"].iloc[-1].strftime("%Y-%m-%d"),
            "start_price": start_price,
            "end_price": end_price,
            "final_value": initial_cash * (1 + roi / 100),
            "rows": int(len(df)),
        }
    except Exception as e:
        return {"available": False, "reason": str(e)}

# --- REUSABLE BOILERPLATE ---
STRATEGY_BOILERPLATE = """import backtrader as bt
import backtrader.indicators as btind

class BaseStrategy(bt.Strategy):
    params = (
        ('printlog', False),
        ('trailpercent', 0.0), 
    )

    def log(self, txt, dt=None):
        if self.params.printlog:
            dt = dt or self.datas[0].datetime.date(0)
            print('%s, %s' % (dt.isoformat(), txt))

    def __init__(self):
        self.order = None
        self.stop_price = None

    def notify_order(self, order):
        if order.status in [order.Completed]:
            if order.isbuy():
                if self.p.trailpercent > 0:
                    self.stop_price = order.executed.price * (1.0 - self.p.trailpercent)
            self.bar_executed = len(self)
        self.order = None

    def next(self):
        if self.position and self.p.trailpercent > 0:
            new_stop = self.data.close[0] * (1.0 - self.p.trailpercent)
            if self.stop_price is None or new_stop > self.stop_price:
                self.stop_price = new_stop
            
            if self.data.close[0] < self.stop_price:
                self.close()
                self.stop_price = None
"""

# --- CORE BACKTESTING TASK ---

async def run_backtests_task(task_id: str, dataset_filename: str, strategies: List[str], stake_range: List[int], trail_range: List[float], start_date: str, end_date: str, sequential: bool, user_id: str, initial_cash: float = 100000.0, commission: float = 0.001, max_workers: int = 4, progress_callback=None):
    try:
        results_store[task_id].update({"status": "running", "progress": 0, "current": "Loading data..."})
        _, _, user_data_dir = get_user_dirs(user_id)
        local_path = resolve_safe_child_path(user_data_dir, dataset_filename)
        
        if not os.path.exists(local_path):
            # Try global fallback
            local_path = resolve_safe_child_path(MARKET_DATA_DIR, dataset_filename)
            if not os.path.exists(local_path):
                results_store[task_id].update({"status": "failed", "error": f"Data file {dataset_filename} not found"})
                return

        dataset_status = get_dataset_status(user_id, dataset_filename, end_date)
        buy_hold = calculate_buy_hold_benchmark(local_path, start_date, end_date, initial_cash)

        results_store[task_id].update({"status": "running", "progress": 10, "current": "Preparing strategies..."})

        strategy_inputs = []
        for strat_key in strategies:
            if strat_key in STRATEGY_MAP:
                strategy_inputs.append((strat_key, strat_key))
            else:
                strat_doc = strategies_table.get((Query().name == strat_key) & (Query().user_id == user_id))
                if strat_doc:
                    temp_strat_file = os.path.join(TEMP_DATA_DIR, f"run_strat_{uuid.uuid4().hex}_{strat_key.replace(' ', '_')}.py")
                    with open(temp_strat_file, "w") as f:
                        f.write(strat_doc["code"])
                    strategy_inputs.append((strat_key, {"file": temp_strat_file, "class": strat_doc["class_name"]}))
        
        if not strategy_inputs:
            results_store[task_id].update({"status": "failed", "error": "No valid strategies found"})
            return

        from concurrent.futures import ThreadPoolExecutor, as_completed
        progress_lock = threading.Lock()
        final_results = []
        completed_count = 0
        stake_options = stake_range if stake_range else [30, 70, 95]
        trail_options = trail_range if trail_range else [0.0, 0.10]
        combo_count = len(stake_options) * len(trail_options)
        
        def run_single(name, inp):
            nonlocal completed_count
            try:
                if progress_callback:
                    progress_callback({
                        "type": "strategy_start",
                        "strategy": name,
                        "combinations": combo_count,
                        "completed": completed_count,
                        "total": len(strategy_inputs),
                    })
                val, config, markers, stats = find_best_parallel(inp, local_path, stake_range, trail_range, start_date, end_date, initial_cash, commission)
                roi = ((val - initial_cash) / initial_cash) * 100
                runtime_error = (stats or {}).get("__runtime_error")
                trade_count = _agent_strategy_trade_count({"statistics": stats})
                is_active = trade_count > 0 and not runtime_error
                res = {
                    "strategy": name,
                    "roi": roi,
                    "best_config": config,
                    "markers": markers,
                    "statistics": stats,
                    "benchmark": {"buy_hold": buy_hold},
                    "trade_count": trade_count,
                    "inactive": not is_active,
                    "valid_candidate": is_active,
                }
                if runtime_error:
                    res["error"] = runtime_error
                    res["runtime_error"] = runtime_error
                    res["runtime_traceback"] = (stats or {}).get("__runtime_traceback")
                    res["rejection_reason"] = f"Backtest runtime error: {runtime_error}"
                elif not is_active:
                    res["rejection_reason"] = "No trades were taken; generation did not produce an active strategy for this dataset."
                if buy_hold.get("available"):
                    res["benchmark_delta"] = roi - buy_hold["roi"]
                
                with progress_lock:
                    completed_count += 1
                    prog = 20 + int((completed_count / len(strategy_inputs)) * 70)
                    partials = results_store[task_id].get("partial_results", [])
                    partials.append(res)
                    partials.sort(key=_agent_result_sort_key, reverse=True)
                    results_store[task_id].update({"progress": prog, "current": f"Completed {completed_count}/{len(strategy_inputs)}", "partial_results": partials})
                    if progress_callback:
                        progress_callback({
                            "type": "strategy_complete",
                            "strategy": name,
                            "combinations": combo_count,
                            "completed": completed_count,
                            "total": len(strategy_inputs),
                            "roi": roi,
                            "trade_count": trade_count,
                            "error": runtime_error,
                            "rejection_reason": res.get("rejection_reason"),
                        })
                return res
            except Exception as e:
                err_res = {
                    "strategy": name,
                    "roi": -100,
                    "error": str(e),
                    "trade_count": 0,
                    "inactive": True,
                    "valid_candidate": False,
                    "rejection_reason": f"Backtest error: {e}",
                }
                with progress_lock:
                    completed_count += 1
                    if progress_callback:
                        progress_callback({
                            "type": "strategy_complete",
                            "strategy": name,
                            "combinations": combo_count,
                            "completed": completed_count,
                            "total": len(strategy_inputs),
                            "roi": -100,
                            "trade_count": 0,
                            "error": str(e),
                            "rejection_reason": err_res.get("rejection_reason"),
                        })
                return err_res

        worker_cap = max(1, min(int(max_workers or 4), 8))
        num_workers = 1 if sequential else min(len(strategy_inputs), worker_cap)
        with ThreadPoolExecutor(max_workers=num_workers) as executor:
            futures = [executor.submit(run_single, n, i) for n, i in strategy_inputs]
            for f in as_completed(futures):
                final_results.append(f.result())

        sorted_results = sorted(final_results, key=_agent_result_sort_key, reverse=True)
        active_results = [r for r in sorted_results if r.get("valid_candidate") and not r.get("error")]
        inactive_results = [r for r in sorted_results if not (r.get("valid_candidate") and not r.get("error"))]
        
        # Calculate summary for frontend
        summary = {
            "total_strategies": len(sorted_results),
            "active_strategies": len(active_results),
            "inactive_strategies": len(inactive_results),
            "best_strategy": active_results[0].get('strategy', 'N/A') if active_results else 'No active strategy',
            "best_roi": active_results[0].get('roi') if active_results else None,
            "avg_roi": sum(r.get('roi', 0) for r in active_results) / len(active_results) if active_results else None,
            "buy_hold_roi": buy_hold.get("roi") if buy_hold.get("available") else None,
            "dataset_status": dataset_status,
        }
        
        results_store[task_id].update({
            "status": "completed", "progress": 100, "results": sorted_results, "summary": summary, "benchmark": {"buy_hold": buy_hold}, "dataset_status": dataset_status
        })
        
        # Save to DB
        results_table.insert({
            "id": task_id, "user_id": user_id, "timestamp": datetime.now().isoformat(),
            "dataset": dataset_filename, "strategies": strategies, "results": sorted_results,
            "summary": summary, "benchmark": {"buy_hold": buy_hold}, "dataset_status": dataset_status
        })

    except Exception as e:
        logger.error(f"Backtest task error: {e}")
        results_store[task_id].update({"status": "failed", "error": str(e)})

# --- ROUTES ---

@app.get("/health")
async def health():
    return {"status": "ok", "monolith": True}


@app.get("/api/debug/agent")
async def debug_agent():
    settings = load_system_settings()
    provider = normalize_app_llm_provider(settings.get("default_provider") or os.getenv("DEFAULT_PROVIDER"))
    model = normalize_model(provider, settings.get("default_model") or os.getenv("DEFAULT_MODEL") or "gemini-2.5-flash")
    recent_runs = sorted(
        [_safe_agent_run(run) for run in agent_runs.values()],
        key=lambda r: r.get("created_at", ""),
        reverse=True,
    )[:10]
    return {
        "status": "ok",
        "log_level": LOG_LEVEL,
        "provider": provider,
        "model": model,
        "keys_present": {
            "openai": bool(os.getenv("OPENAI_API_KEY") or settings.get("openai_api_key")),
            "openrouter": bool(os.getenv("OPENROUTER_API_KEY") or settings.get("openrouter_api_key")),
            "groq": bool(os.getenv("GROQ_API_KEY") or settings.get("groq_api_key")),
            "mistral": bool(os.getenv("MISTRAL_API_KEY") or settings.get("mistral_api_key")),
            "google_ai_studio": bool(os.getenv("GOOGLE_AI_STUDIO_API_KEY") or os.getenv("GEMINI_API_KEY") or settings.get("google_ai_studio_api_key")),
            "litellm": bool(os.getenv("LITELLM_API_KEY") or settings.get("litellm_api_key")),
        },
        "searxng_url": os.getenv("SEARXNG_URL", "http://localhost:8080"),
        "data_paths": {
            "base": BASE_DATA_DIR,
            "market_data": MARKET_DATA_DIR,
            "temp": TEMP_DATA_DIR,
        },
        "active_agent_runs": len(agent_runs),
        "recent_runs": recent_runs,
    }


@app.get("/api/debug/tasks")
async def debug_tasks():
    recent_tasks = []
    for task_id, task in list(results_store.items())[-25:]:
        recent_tasks.append({
            "task_id": task_id,
            "status": task.get("status"),
            "progress": task.get("progress"),
            "current": task.get("current"),
            "error": task.get("error"),
            "has_results": bool(task.get("results") or task.get("partial_results")),
        })
    return {
        "status": "ok",
        "results_store_count": len(results_store),
        "recent_tasks": recent_tasks,
        "optimizer_sessions": len(improvement_sessions),
        "agent_runs": len(agent_runs),
    }

# --- WebSocket for Real-time Task Updates ---

@app.websocket("/ws/optimizer/{session_id}")
async def websocket_optimizer(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for real-time optimization progress updates"""
    await manager.connect(session_id, websocket)
    try:
        while True:
            # Keep connection alive and listen for stop commands
            data = await websocket.receive_text()
            if data == "stop":
                if session_id in improvement_sessions:
                    improvement_sessions[session_id]["stop_requested"] = True
    except WebSocketDisconnect:
        await manager.disconnect(session_id, websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        await manager.disconnect(session_id, websocket)

# --- Market Data Routes ---

@app.post("/api/market-data/download")
async def download_data(request: DownloadRequest, background_tasks: BackgroundTasks):
    user_id = LOCAL_USER_ID
    _, _, user_dir = get_user_dirs(user_id)
    task_id = str(uuid.uuid4())
    
    # Use results_store instead of task_statuses so check_task_status can find it
    results_store[task_id] = {"status": "running", "progress": 0, "current": "Starting download..."}
    
    SUITE_COMBOS = [
        ("1m",  "5d"),
        ("5m",  "60d"),
        ("1h",  "2y"),
        ("1d",  "max"),
    ]

    # Auto-add tickers to watchlist
    try:
        watchlist_doc = watchlist_table.get(Query().user_id == user_id)
        current_tickers = watchlist_doc.get("tickers", []) if watchlist_doc else []
        
        new_tickers = []
        for ticker in request.tickers:
            ticker_upper = ticker.upper()
            if ticker_upper not in current_tickers:
                current_tickers.append(ticker_upper)
                new_tickers.append(ticker_upper)
        
        if new_tickers:
            watchlist_table.upsert({"user_id": user_id, "tickers": current_tickers}, Query().user_id == user_id)
            logger.info(f"Auto-added to watchlist: {', '.join(new_tickers)}")
    except Exception as e:
        logger.warning(f"Failed to auto-add to watchlist: {e}")

    def sync_task():
        try:
            if request.suite:
                combos = SUITE_COMBOS
            else:
                combos = [(request.interval, request.period)]

            total_downloads = len(request.tickers) * len(combos)
            completed = 0
            downloaded_files = []
            
            for ticker in request.tickers:
                for interval, period in combos:
                    try:
                        results_store[task_id].update({
                            "progress": int((completed / total_downloads) * 100),
                            "current": f"Downloading {ticker} {interval}/{period}..."
                        })
                        download_ticker_data(
                            ticker,
                            interval=interval,
                            period=period,
                            output_dir=user_dir,
                            extended_hours=bool(request.extended_hours),
                        )
                        # Track the actual filename created (format: ticker-interval-period.txt)
                        suffix = "-extended" if request.extended_hours else ""
                        filename = f"{ticker.lower()}-{interval}-{period}{suffix}.txt"
                        downloaded_files.append(filename)
                        logger.info(f"Downloaded {ticker} {interval}/{period} → {filename}")
                        completed += 1
                    except Exception as inner_e:
                        logger.warning(f"Suite download skipped {ticker} {interval}/{period}: {inner_e}")
                        completed += 1
            
            results_store[task_id].update({
                "status": "completed",
                "progress": 100,
                "current": "Download complete",
                "results": {
                    "tickers": request.tickers,
                    "files_downloaded": completed,
                    "filenames": downloaded_files  # ← ADDED: Agent can use these exact filenames
                }
            })
        except Exception as e:
            results_store[task_id].update({
                "status": "failed",
                "error": str(e)
            })

    background_tasks.add_task(sync_task)
    return {"task_id": task_id, "message": "Suite download started" if request.suite else "Download started"}

@app.get("/api/market-data/files")
async def list_files():
    user_id = LOCAL_USER_ID
    _, _, user_dir = get_user_dirs(user_id)
    # yfinance downloader saves as .txt by default
    files = [f for f in os.listdir(user_dir) if f.endswith('.txt') or f.endswith('.csv')]
    return {"files": sorted(files)}

@app.get("/api/market-data/check/{ticker}")
async def check_data(ticker: str):
    user_id = LOCAL_USER_ID
    _, _, user_dir = get_user_dirs(user_id)
    ticker = ticker.upper()
    files = [f for f in os.listdir(user_dir) if f.upper().startswith(ticker + '-') and (f.endswith('.txt') or f.endswith('.csv'))]
    return {"available": len(files) > 0, "files": sorted(files)}

@app.post("/api/market-data/sync-files-to-watchlist")
async def sync_files_to_watchlist():
    """Sync all downloaded tickers to watchlist"""
    user_id = LOCAL_USER_ID
    _, _, user_dir = get_user_dirs(user_id)
    
    try:
        # Get all downloaded files
        files = [f for f in os.listdir(user_dir) if f.endswith('.txt') or f.endswith('.csv')]
        
        # Extract unique tickers from filenames (format: TICKER-interval-period.txt)
        tickers = set()
        for file in files:
            # Extract ticker from filename (e.g., "aapl-1d-5y.txt" -> "AAPL")
            ticker = file.split('-')[0].upper()
            if ticker:
                tickers.add(ticker)
        
        if not tickers:
            return {"message": "No tickers found in downloaded files", "added": []}
        
        # Get current watchlist
        watchlist_doc = watchlist_table.get(Query().user_id == user_id)
        current_tickers = watchlist_doc.get("tickers", []) if watchlist_doc else []
        
        # Add new tickers
        new_tickers = []
        for ticker in tickers:
            if ticker not in current_tickers:
                current_tickers.append(ticker)
                new_tickers.append(ticker)
        
        # Update watchlist
        if new_tickers:
            watchlist_table.upsert({"user_id": user_id, "tickers": sorted(current_tickers)}, Query().user_id == user_id)
            logger.info(f"Synced {len(new_tickers)} tickers to watchlist: {', '.join(new_tickers)}")
            return {"message": f"Added {len(new_tickers)} tickers to watchlist", "added": new_tickers}
        else:
            return {"message": "All tickers already in watchlist", "added": []}
            
    except Exception as e:
        logger.error(f"Error syncing files to watchlist: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/market-data/data/{filename}")
async def delete_file(filename: str):
    user_id = LOCAL_USER_ID
    _, _, user_dir = get_user_dirs(user_id)
    file_path = resolve_safe_child_path(user_dir, filename)
    if os.path.exists(file_path):
        os.remove(file_path)
        return {"message": "Deleted"}
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/api/market-data/data/{filename}")
async def get_market_file(filename: str):
    user_id = LOCAL_USER_ID
    _, _, user_dir = get_user_dirs(user_id)
    file_path = resolve_safe_child_path(user_dir, filename)
    if os.path.exists(file_path):
        from fastapi.responses import FileResponse
        # Explicitly set media type for text files
        media_type = "text/csv" if filename.endswith('.csv') else "text/plain"
        return FileResponse(file_path, media_type=media_type, filename=filename)
    raise HTTPException(status_code=404, detail=f"File not found at {file_path}")

@app.get("/api/market-data/data/{filename}/meta")
async def get_market_meta(filename: str):
    user_id = LOCAL_USER_ID
    _, _, user_dir = get_user_dirs(user_id)
    file_path = resolve_safe_child_path(user_dir, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")
    
    try:
        df = pd.read_csv(file_path)
        if df.empty or 'Date' not in df.columns:
            return {"start": None, "end": None, "rows": 0}
        
        # Sort by date if possible
        df['Date'] = pd.to_datetime(df['Date'])
        df = df.sort_values('Date')
        
        return {
            "start": df['Date'].iloc[0].strftime('%Y-%m-%d'),
            "end": df['Date'].iloc[-1].strftime('%Y-%m-%d'),
            "rows": len(df)
        }
    except Exception as e:
        logger.error(f"Error reading meta: {e}")
        return {"start": None, "end": None, "rows": 0}

@app.get("/api/market-data/task/{task_id}")
async def get_market_task_status(task_id: str):
    if task_id in results_store:
        return results_store[task_id]
    if task_id in task_statuses:
        status = task_statuses[task_id]
        if status == "completed":
            return {"status": "completed"}
        elif status.startswith("failed"):
            return {"status": "failed", "error": status}
        else:
            return {"status": "pending", "progress": 50, "current": "Downloading data..."}
    raise HTTPException(status_code=404, detail="Task not found")

@app.get("/api/market-data/watch")
async def get_watchlist():
    items = watchlist_table.search(Query().user_id == LOCAL_USER_ID)
    if not items: return {"watched_tickers": [], "categories": []}
    return {
        "watched_tickers": items[0].get("tickers", []),
        "categories": items[0].get("categories", [])
    }

@app.post("/api/market-data/watch")
async def update_watchlist(new_tickers: List[str]):
    items = watchlist_table.search(Query().user_id == LOCAL_USER_ID)
    current_tickers = items[0].get("tickers", []) if items else []
    current_categories = items[0].get("categories", []) if items else []
    
    added = []
    for t in new_tickers:
        if t not in current_tickers:
            current_tickers.append(t)
            added.append(t)
    
    watchlist_table.upsert({"user_id": LOCAL_USER_ID, "tickers": current_tickers, "categories": current_categories}, Query().user_id == LOCAL_USER_ID)
    return {"added": added, "failed": [], "watched_tickers": current_tickers}

class CategoriesRequest(BaseModel):
    categories: list = []

@app.post("/api/market-data/watch/categories")
async def save_categories(req: CategoriesRequest):
    items = watchlist_table.search(Query().user_id == LOCAL_USER_ID)
    if items:
        watchlist_table.update({"categories": req.categories}, Query().user_id == LOCAL_USER_ID)
    else:
        watchlist_table.upsert({"user_id": LOCAL_USER_ID, "tickers": [], "categories": req.categories}, Query().user_id == LOCAL_USER_ID)
    return {"status": "ok", "categories": req.categories}

@app.delete("/api/market-data/watch/{ticker}")
async def remove_from_watchlist(ticker: str):
    items = watchlist_table.search(Query().user_id == LOCAL_USER_ID)
    if items:
        tickers = items[0].get("tickers", [])
        if ticker in tickers:
            tickers.remove(ticker)
            watchlist_table.update({"tickers": tickers}, Query().user_id == LOCAL_USER_ID)
    return {"message": f"Removed {ticker}"}

@app.post("/api/market-data/sync-now")
async def sync_watchlist(background_tasks: BackgroundTasks):
    items = watchlist_table.search(Query().user_id == LOCAL_USER_ID)
    if not items or not items[0].get("tickers"):
        return {"message": "Watchlist is empty"}
    
    tickers = items[0].get("tickers")
    task_id = str(uuid.uuid4())
    task_statuses[task_id] = "pending"
    
    _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
    
    def sync_task():
        try:
            for ticker in tickers:
                download_ticker_data(ticker, interval="1d", period="5y", output_dir=user_dir)
            task_statuses[task_id] = "completed"
        except Exception as e:
            task_statuses[task_id] = f"failed: {str(e)}"

    background_tasks.add_task(sync_task)
    return {"task_id": task_id, "message": "Sync started"}

# --- Backtesting Routes ---

@app.post("/api/backtest/backtest")
async def start_backtest(request: BacktestRequest, background_tasks: BackgroundTasks):
    task_id = str(uuid.uuid4())
    user_id = LOCAL_USER_ID
    results_store[task_id] = {"status": "running", "user_id": user_id, "partial_results": []}
    background_tasks.add_task(run_backtests_task, task_id, request.dataset_filename, request.strategies, request.stake_range, request.trail_range, request.start_date, request.end_date, request.sequential, user_id, request.initial_cash, request.commission, request.max_workers)
    return {"task_id": task_id}

@app.get("/api/backtest/results/{task_id}")
async def get_results(task_id: str):
    if task_id in results_store:
        return results_store[task_id]
    doc = results_table.get(Query().id == task_id)
    if doc:
        return {"status": "completed", "results": doc["results"]}
    raise HTTPException(status_code=404, detail="Task not found")


def _repair_agent_terminal_status(run: dict) -> dict:
    if (
        run
        and run.get("status") == "stopped"
        and run.get("accepted_version")
        and (run.get("outcome") or {}).get("status") == "accepted"
    ):
        repaired = dict(run)
        repaired["status"] = "completed"
        repaired["progress"] = 100
        repaired["current_step"] = (repaired.get("outcome") or {}).get("title") or "Strategy found"
        return repaired
    return run

def _safe_agent_run(run: dict) -> dict:
    run = _repair_agent_terminal_status(run)
    safe = {k: v for k, v in run.items() if k not in {"stop_requested"}}
    config = dict(safe.get("config") or {})
    if config:
        for key in (
            "api_key",
            "provider_config",
            "history",
            "available_files",
            "available_strategies",
        ):
            config.pop(key, None)
        if config.get("agent_instructions"):
            config["agent_instructions"] = str(config["agent_instructions"])[:500]
        safe["config"] = config
    return safe


def _agent_run_monitor_summary(run: dict) -> dict:
    safe = _safe_agent_run(run)
    events = safe.get("events") or []
    plan_steps = safe.get("plan_steps") or []
    latest_event = events[-1] if events else None
    return {
        "run_id": safe.get("run_id"),
        "workflow": safe.get("workflow"),
        "status": safe.get("status"),
        "progress": safe.get("progress") or 0,
        "current_step": safe.get("current_step") or "",
        "ticker": safe.get("ticker"),
        "dataset_filename": safe.get("dataset_filename"),
        "created_at": safe.get("created_at"),
        "updated_at": safe.get("updated_at"),
        "started_at": safe.get("started_at"),
        "completed_at": safe.get("completed_at"),
        "elapsed_seconds": safe.get("elapsed_seconds"),
        "error": safe.get("error"),
        "outcome": safe.get("outcome"),
        "latest_event": {
            "type": latest_event.get("type"),
            "message": latest_event.get("message"),
            "ts": latest_event.get("ts"),
        } if isinstance(latest_event, dict) else None,
        "plan_steps": [
            {
                "id": step.get("id"),
                "label": step.get("label"),
                "status": step.get("status"),
                "observation": step.get("observation"),
            }
            for step in plan_steps[:12]
            if isinstance(step, dict)
        ],
    }


AGENT_TERMINAL_STATUSES = {"completed", "failed", "stopped", "stale"}


def _utc_iso_now() -> str:
    return datetime.utcnow().isoformat(timespec="milliseconds") + "Z"


def _append_agent_event(run_id: str, event_type: str, message: str, **payload):
    run = agent_runs.get(run_id)
    if not run:
        return
    event = {
        "ts": _utc_iso_now(),
        "type": event_type,
        "message": message,
        **payload,
    }
    run.setdefault("events", []).append(event)
    if len(run["events"]) > 500:
        run["events"] = run["events"][-500:]
    logger.info("agent_run_event run_id=%s type=%s message=%s", run_id, event_type, message)


def _update_agent_run(run_id: str, **fields):
    run = agent_runs.get(run_id)
    if not run:
        return
    if run.get("stop_requested") and run.get("status") == "stopped" and fields.get("status") != "stopped":
        return
    now_iso = datetime.now().isoformat()
    fields.setdefault("updated_at", now_iso)
    if fields.get("status") == "running" and not run.get("started_at"):
        fields["started_at"] = now_iso
    if fields.get("status") in AGENT_TERMINAL_STATUSES and not run.get("completed_at"):
        fields["completed_at"] = now_iso
    started_at = fields.get("started_at") or run.get("started_at") or run.get("created_at")
    if started_at:
        try:
            fields["elapsed_seconds"] = int((datetime.now() - datetime.fromisoformat(started_at)).total_seconds())
        except Exception:
            pass
    run.update(fields)
    agent_runs_table.upsert(_safe_agent_run(run), Query().run_id == run_id)


async def _flush_agent_updates():
    """Yield control to event loop so the polling endpoint sees the latest agent run updates."""
    await asyncio.sleep(0)


def _agent_stop_requested(run_id: str) -> bool:
    return bool(agent_runs.get(run_id, {}).get("stop_requested"))


def _mark_persisted_agent_run_stale(run: dict) -> dict:
    if not run or run.get("status") in AGENT_TERMINAL_STATUSES:
        return run
    repaired = dict(run)
    now_iso = datetime.now().isoformat()
    repaired.update({
        "status": "stale",
        "current_step": "Agent worker is no longer active",
        "error": "This run was marked stale because the backend no longer has an active worker for it. The server may have restarted, or the process that owned the run exited.",
        "updated_at": now_iso,
        "completed_at": repaired.get("completed_at") or now_iso,
    })
    started_at = repaired.get("started_at") or repaired.get("created_at")
    if started_at:
        try:
            repaired["elapsed_seconds"] = int((datetime.now() - datetime.fromisoformat(started_at)).total_seconds())
        except Exception:
            pass
    repaired.setdefault("events", []).append({
        "ts": _utc_iso_now(),
        "type": "stale",
        "message": "Marked stale because no active backend worker owns this run.",
    })
    if len(repaired["events"]) > 500:
        repaired["events"] = repaired["events"][-500:]
    agent_runs_table.upsert(_safe_agent_run(repaired), Query().run_id == repaired.get("run_id"))
    return repaired

async def _run_agent_step_with_timeout(func, timeout_seconds: float, *args, **kwargs):
    return await asyncio.wait_for(asyncio.to_thread(func, *args, **kwargs), timeout=timeout_seconds)


def _ticker_from_dataset(filename: str) -> str:
    return (filename or "").split("-")[0].split("_")[0].upper()


def _extract_ticker_from_text(text: str) -> str:
    ignored = {
        "A", "I", "AI", "API", "CEO", "CFO", "USA", "US", "USD", "ETF", "ETFS",
        "ROI", "SMA", "EMA", "RSI", "ATR", "MACD", "THE", "AND", "FOR", "WITH",
        "THIS", "THAT", "DATA", "NEWS", "MARKET", "STOCK", "STOCKS",
    }
    common_lowercase_symbols = {
        "spy", "qqq", "tqqq", "sqqq", "iwm", "dia", "vti", "voo",
        "soxl", "soxs", "uvxy", "svxy",
        "nvda", "tsla", "aapl", "msft", "amzn", "meta", "googl", "goog",
        "nflx", "amd", "mu", "avgo", "crwd",
    }
    company_aliases = {
        "crowdstrike": "CRWD",
        "crowd strike": "CRWD",
        "nvidia": "NVDA",
        "tesla": "TSLA",
        "apple": "AAPL",
        "microsoft": "MSFT",
        "amazon": "AMZN",
        "google": "GOOGL",
        "alphabet": "GOOGL",
        "netflix": "NFLX",
        "broadcom": "AVGO",
    }
    text = text or ""
    normalized = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
    for alias, symbol in company_aliases.items():
        if re.search(rf"(^|\s){re.escape(alias)}(\s|$)", normalized):
            return symbol
    for token in re.findall(r"\$([A-Za-z][A-Za-z0-9.-]{0,9})", text):
        symbol = token.upper()
        if symbol not in ignored:
            return symbol
    for token in re.findall(r"\b[A-Z]{1,5}(?:-USD)?\b", text):
        symbol = token.upper()
        if symbol not in ignored:
            return symbol
    for token in re.findall(r"\b[a-z]{2,5}(?:-usd)?\b", text):
        if token.lower() in common_lowercase_symbols:
            return token.upper()
    return ""


def _find_best_dataset_for_ticker(user_id: str, ticker: str, interval: str = "1d", extended_hours: bool = False) -> Optional[str]:
    _, _, user_dir = get_user_dirs(user_id)
    ticker = (ticker or "").upper()
    candidates = [
        f for f in os.listdir(user_dir)
        if f.upper().startswith(ticker + "-") and f.endswith((".txt", ".csv"))
    ]
    if interval:
        preferred = [f for f in candidates if f"-{interval}-" in f.lower()]
        if preferred:
            candidates = preferred
    if extended_hours:
        preferred = [f for f in candidates if "-extended" in f.lower() or "_extended" in f.lower()]
        if preferred:
            candidates = preferred
    else:
        regular = [f for f in candidates if "-extended" not in f.lower() and "_extended" not in f.lower()]
        if regular:
            candidates = regular
    if not candidates:
        return None
    candidates.sort(key=lambda f: (get_dataset_meta_from_path(os.path.join(user_dir, f)).get("end") or "", f), reverse=True)
    return candidates[0]


def _agent_instruction_block(instructions: Optional[str], *, max_chars: int = 1600) -> str:
    cleaned = " ".join(str(instructions or "").split())
    if not cleaned:
        return ""
    return cleaned[:max_chars]


def _agent_backtest_settings(request: AgentRunRequest) -> Dict[str, Any]:
    stake_options = [
        max(1, min(int(value), 100))
        for value in (request.stake_range or [])
        if value is not None
    ]
    trail_options = [
        max(0.0, min(float(value), 1.0))
        for value in (request.trail_range or [])
        if value is not None
    ]
    initial_cash = max(1.0, float(request.initial_cash or 100000.0))
    commission = max(0.0, min(float(request.commission or 0.001), 1.0))
    return {
        "stake_range": stake_options or [30, 70, 95],
        "trail_range": trail_options or [0.0, 0.10],
        "start_date": request.start_date,
        "end_date": request.end_date,
        "sequential": bool(request.sequential),
        "initial_cash": initial_cash,
        "commission": commission,
    }


def _agent_approach_for_request(request: AgentRunRequest, ticker: str, dataset_filename: str) -> Dict[str, Any]:
    detail = (request.thinking_detail or "normal").lower()
    target = ticker or dataset_filename or "the requested market"
    worker_cap = max(1, min(int(request.max_backtest_workers or 4), 8))
    backtest_settings = _agent_backtest_settings(request)
    if request.workflow == "fundamental_screener":
        steps = [
            "Infer the stock universe and valuation/growth requirements from the prompt",
            "Load broad market and industry context for the current backdrop",
            "Screen candidates with yfinance fundamentals, recent price/volume, news, options, and insider summaries",
            "Reject stale or incomplete matches where the data cannot support the claim",
            "Rank candidates and store the screen summary so the next chat can discuss it",
        ]
        if detail == "brief":
            steps = steps[:3]
        elif detail == "detailed":
            steps.extend([
                f"Check up to {request.screen_max_checked or 30} symbols",
                f"Return up to {request.screen_max_results or 5} candidates",
                f"Reuse up to {request.history_limit or 0} history messages" if request.history else "Do not rely on prior chat history",
            ])
        custom_instructions = _agent_instruction_block(getattr(request, "agent_instructions", None), max_chars=220)
        if custom_instructions:
            steps.append(f"Apply user agent instructions: {custom_instructions}")
        return {
            "detail": detail,
            "summary": "Plan first, then run a fundamental undervaluation screen.",
            "steps": steps,
            "settings": {
                "history_limit": request.history_limit,
                "max_tokens": request.max_tokens,
                "thinking_detail": request.thinking_detail,
                "screen_universe": request.screen_universe,
                "screen_max_results": request.screen_max_results,
                "screen_max_checked": request.screen_max_checked,
            },
        }
    steps = [
        f"Understand the request and target: {target}",
        "Load market overview and industry heatmap before strategy decisions",
        "Check whether the selected dataset exists and is stale",
        "Read recent candles, RSI, moving averages, range, volume, and viable triggers from the dataset",
    ]
    if request.require_fresh_data:
        steps.append("Download fresh data when the dataset is missing or stale")
    if request.workflow in {"strategy_create", "strategy_race"}:
        steps.extend([
            "Generate multiple practical Backtrader candidates",
            "Backtest candidates concurrently",
            "Compare results with the selected benchmark and pick the strongest version",
        ])
    if request.workflow == "market_review":
        steps.append("Stop after market context and freshness status are ready")

    if detail == "brief":
        steps = steps[:3]
    elif detail == "detailed":
        steps.extend([
            f"Reuse up to {request.history_limit or 0} history messages" if request.history else "Do not rely on prior chat history",
            f"Cap LLM output at {request.max_tokens or 8192} tokens",
            f"Use up to {worker_cap} backtest worker(s)",
            f"Backtest stake range {backtest_settings['stake_range']} and trailing stops {backtest_settings['trail_range']}",
            f"Use initial capital ${backtest_settings['initial_cash']:,.0f} and commission {backtest_settings['commission']}",
        ])
    custom_instructions = _agent_instruction_block(getattr(request, "agent_instructions", None), max_chars=220)
    if custom_instructions:
        steps.append(f"Apply user agent instructions: {custom_instructions}")

    return {
        "detail": detail,
        "summary": f"Plan first, then run {request.workflow.replace('_', ' ')} for {target}.",
        "steps": steps,
        "settings": {
            "history_limit": request.history_limit,
            "max_tokens": request.max_tokens,
            "thinking_detail": request.thinking_detail,
            "max_backtest_workers": worker_cap,
            "backtest_settings": backtest_settings,
        },
    }


def _agent_plan_for_request(request: AgentRunRequest) -> List[Dict[str, Any]]:
    if request.workflow == "fundamental_screener":
        return [
            {"id": "screen_parse", "label": "Parse screen requirements", "status": "pending"},
            {"id": "market_context", "label": "Read market context", "status": "pending"},
            {"id": "screen_candidates", "label": "Screen fundamental candidates", "status": "pending"},
            {"id": "enrich_candidates", "label": "Enrich candidates", "status": "pending"},
            {"id": "rank_report", "label": "Rank and report", "status": "pending"},
        ]

    steps = [
        {"id": "resolve_target", "label": "Resolve target", "status": "pending"},
        {"id": "market_context", "label": "Read market context", "status": "pending"},
        {"id": "dataset_freshness", "label": "Check dataset freshness", "status": "pending"},
    ]
    if request.require_fresh_data:
        steps.append({"id": "data_sync", "label": "Sync data if needed", "status": "pending"})
    if request.workflow == "market_review":
        steps.append({"id": "market_review", "label": "Summarize market review", "status": "pending"})
    else:
        steps.extend([
            {"id": "candle_profile", "label": "Read candle profile", "status": "pending"},
            {"id": "strategy_generation", "label": "Generate strategy candidates", "status": "pending"},
            {"id": "backtest", "label": "Run backtests", "status": "pending"},
            {"id": "evaluate", "label": "Compare and select", "status": "pending"},
        ])
    return steps


def _infer_agent_window_from_prompt(prompt: str) -> Dict[str, Optional[str]]:
    text = (prompt or "").lower()
    end = datetime.now()
    extended_hours = bool(re.search(r"\b(extended[-\s]?hours?|premarket|pre[-\s]?market|postmarket|post[-\s]?market|after[-\s]?hours?)\b", text))
    minute_match = re.search(r"\b(1|2|5|15|30|60|90)\s*(?:m|min|mins|minute|minutes)\b", text)

    def fmt(dt: datetime) -> str:
        return dt.strftime("%Y-%m-%d")

    if minute_match:
        interval = f"{minute_match.group(1)}m"
        return {
            "period": "5d" if interval == "1m" else "60d",
            "interval": interval,
            "extended_hours": extended_hours,
            "start_date": None,
            "end_date": None,
        }
    if any(term in text for term in ["this year", "year to date", "ytd", "current year", str(end.year)]):
        return {"period": "ytd", "interval": None, "extended_hours": extended_hours, "start_date": f"{end.year}-01-01", "end_date": fmt(end)}
    if any(term in text for term in ["half year", "half-year", "6 month", "six month"]):
        return {"period": "6mo", "interval": None, "extended_hours": extended_hours, "start_date": fmt(end - timedelta(days=183)), "end_date": fmt(end)}
    if any(term in text for term in ["recent quarter", "3 month", "three month"]):
        return {"period": "3mo", "interval": None, "extended_hours": extended_hours, "start_date": fmt(end - timedelta(days=92)), "end_date": fmt(end)}
    if any(term in text for term in ["last year", "1 year", "one year"]):
        return {"period": "1y", "interval": None, "extended_hours": extended_hours, "start_date": fmt(end - timedelta(days=365)), "end_date": fmt(end)}
    if re.search(r"\b(1h|hourly|hour)\b", text):
        return {"period": "6mo", "interval": "1h", "extended_hours": extended_hours, "start_date": None, "end_date": None}
    return {"period": None, "interval": None, "extended_hours": extended_hours, "start_date": None, "end_date": None}


def _infer_agent_candidate_count_from_prompt(prompt: str) -> Optional[int]:
    text = (prompt or "").lower()
    match = re.search(r"\b(?:generate|create|make|build|backtest|run)\s+(\d{1,2})\s+(?:strategy|strategies|candidates?)\b", text)
    if not match:
        match = re.search(r"\b(\d{1,2})\s+(?:strategy|strategies|candidates?)\b", text)
    if not match:
        return None
    try:
        return max(1, min(int(match.group(1)), 10))
    except Exception:
        return None


def _extract_roi_target(prompt: str) -> Optional[float]:
    text = (prompt or "").lower()
    patterns = [
        r"(?:higher|greater|more|better|above|beat|exceed|target|>)\s*(?:than\s*)?(?:a\s*)?(\d{2,3})(?:\s*%|\s*percent)",
        r"(\d{2,3})\s*%\s*(?:roi|return|target|goal)",
        r"(?:roi|return|target|goal)\s*(?:of\s*)?(?:>=?\s*)?(\d{2,3})(?:\s*%|\s*percent)",
        r"(?:find|get|need|want|look for)\s*(?:a\s*)?(?:strategy\s*)?(?:with\s*)?(?:>=\s*)?(\d{2,3})\s*%",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            try:
                val = float(match.group(1))
                if 0 < val <= 1000:
                    return val
            except Exception:
                pass
    return None


def _infer_screen_universe_from_prompt(prompt: str) -> str:
    text = (prompt or "").lower()
    explicit_symbols = re.findall(r"(?:\$|\btickers?\s+|symbols?\s+)([A-Z]{1,5}(?:\.[A-Z]{1,3})?)(?=\b)", prompt or "")
    comma_symbol_matches = re.findall(r"\b[A-Z]{1,5}(?:\.[A-Z]{1,3})?\b", prompt or "") if re.search(r"\b(?:tickers?|symbols?)\b", text) else []
    ignored_words = {"AI", "PEG", "PE", "PS", "P", "S", "ETF", "ETFS", "YTD", "EPS", "CEO", "CFO", "USA", "US"}
    comma_symbols = [symbol for symbol in [*explicit_symbols, *comma_symbol_matches] if symbol not in ignored_words]
    if len(comma_symbols) >= 2:
        return ",".join(dict.fromkeys(comma_symbols[:50]))
    if "biotech" in text or re.search(r"\bXBI\b", prompt or "", flags=re.IGNORECASE):
        return "biotech"
    if any(term in text for term in ["software", "saas", "cloud", "cyber", "ai stock", "ai stocks", "artificial intelligence"]):
        return "software-ai"
    if any(term in text for term in ["semiconductor", "semis", "chip", "chips"]):
        return "semis"
    if any(term in text for term in ["bank", "banks", "financial", "fintech"]):
        return "financials"
    if any(term in text for term in ["healthcare", "health care", "biotech", "medical", "pharma"]):
        return "healthcare"
    if any(term in text for term in ["energy", "oil", "gas", "e&p", "exploration"]):
        return "energy"
    if any(term in text for term in ["consumer", "retail", "discretionary", "staples"]):
        return "consumer"
    if any(term in text for term in ["industrial", "industrials", "machinery", "aerospace"]):
        return "industrials"
    if any(term in text for term in ["mega cap", "large cap", "big tech", "highest market cap"]):
        return "high-market-cap"
    return "default"


def _screen_candidate_label(candidate: Dict[str, Any]) -> str:
    symbol = candidate.get("symbol") or candidate.get("ticker") or "candidate"
    name = candidate.get("name") or candidate.get("company_name") or ""
    return f"{symbol} ({name})" if name and name != symbol else str(symbol)


def _format_screen_candidate_reason(candidate: Dict[str, Any]) -> str:
    reasons = [str(reason) for reason in (candidate.get("reasons") or []) if reason][:4]
    cautions = [str(caution) for caution in (candidate.get("cautions") or []) if caution][:2]
    quote = candidate.get("quote") or {}
    if quote.get("relative_volume_30d") is not None:
        try:
            reasons.append(f"relative volume {float(quote.get('relative_volume_30d')):.2f}x")
        except Exception:
            pass
    if quote.get("latest_bar_age_days") is not None:
        reasons.append(f"latest bar age {quote.get('latest_bar_age_days')} day(s)")
    summary = "; ".join(reasons) if reasons else "Matched the default fundamental screen."
    if cautions:
        summary = f"{summary}. Watch: {'; '.join(cautions)}"
    return summary


def _compact_screen_candidate_for_summary(candidate: Dict[str, Any]) -> Dict[str, Any]:
    quote = candidate.get("quote") or {}
    insiders = candidate.get("insider_trades") or {}
    options = candidate.get("options_overview") or {}
    return {
        "symbol": candidate.get("symbol") or candidate.get("ticker"),
        "name": candidate.get("name"),
        "sector": candidate.get("sector"),
        "industry": candidate.get("industry"),
        "score": candidate.get("score"),
        "price": quote.get("price") if quote.get("price") is not None else candidate.get("price"),
        "forward_pe": candidate.get("forward_pe"),
        "peg_ratio": candidate.get("peg_ratio"),
        "price_to_sales": candidate.get("price_to_sales"),
        "revenue_growth": candidate.get("revenue_growth"),
        "profit_margin": candidate.get("profit_margin"),
        "analyst_upside": candidate.get("analyst_upside"),
        "relative_volume_30d": quote.get("relative_volume_30d"),
        "return_5d": quote.get("return_5d"),
        "return_1mo": quote.get("return_1mo"),
        "latest_bar": quote.get("latest_bar"),
        "latest_bar_age_days": quote.get("latest_bar_age_days"),
        "reasons": (candidate.get("reasons") or [])[:5],
        "cautions": (candidate.get("cautions") or [])[:4],
        "news": [
            {
                "title": item.get("title"),
                "publisher": item.get("publisher"),
                "published": item.get("published"),
            }
            for item in (candidate.get("recent_news") or [])[:2]
            if isinstance(item, dict)
        ],
        "insider_summary": {
            "open_market_buy_count": insiders.get("open_market_buy_count"),
            "open_market_sell_count": insiders.get("open_market_sell_count"),
            "grant_or_award_count": insiders.get("grant_or_award_count"),
            "note": insiders.get("interpretation_note"),
        } if insiders else None,
        "options_summary": {
            "available": options.get("available"),
            "nearest_expiration": options.get("nearest_expiration"),
            "put_call_volume_ratio": options.get("nearest_put_call_volume_ratio"),
        } if options else None,
    }


async def _generate_agent_visible_summary(request: AgentRunRequest, summary_payload: Dict[str, Any], fallback: str) -> str:
    system_prompt = """You are the TradingSpy assistant writing a concise post-run summary to the user.
Use the same conversational style as the normal chat assistant. Do not expose chain-of-thought.
Explain what the agent did, what data it used, why the top results passed, and what caveats matter.
Do not invent facts beyond the payload. If data is stale/incomplete, say so plainly.
This is not financial advice."""
    user_prompt = json.dumps(summary_payload, default=str)[:12000]
    try:
        text = await call_llm(
            provider=request.provider,
            model=request.model,
            system_prompt=system_prompt,
            user_prompt=f"Write the final user-facing chat summary for this completed agent run:\n{user_prompt}",
            api_key=request.api_key,
            provider_config=request.provider_config,
            json_mode=False,
            history=None,
            max_tokens=min(max(int(request.max_tokens or 8192), 800), 1800),
        )
        cleaned = str(text or "").strip()
        return cleaned or fallback
    except Exception as exc:
        logger.warning("Agent visible summary LLM failed: %s", exc)
        return fallback


async def _run_fundamental_screener_agent(run_id: str, request: AgentRunRequest):
    from modules.tool_calling_agent import screen_undervalued_stocks

    prompt = request.prompt or request.screen_requirements or "Find fundamentally undervalued stocks with positive growth and profitability."
    universe = request.screen_universe or _infer_screen_universe_from_prompt(prompt)
    if universe == "default" and request.history:
        history_limit = max(0, min(80, int(request.history_limit or 20)))
        context_text = "\n".join(
            str(item.get("content") or "")
            for item in request.history[-history_limit:]
            if isinstance(item, dict) and item.get("content")
        )
        contextual_universe = _infer_screen_universe_from_prompt(context_text)
        if contextual_universe != "default":
            universe = contextual_universe
    requirements = request.screen_requirements or prompt
    max_results = max(1, min(int(request.screen_max_results or 5), 10))
    max_checked = max(max_results, min(int(request.screen_max_checked or 30), 80))

    _set_agent_plan_step(run_id, "screen_parse", "running", "Inferring universe and fundamental constraints")
    _update_agent_run(run_id, status="running", progress=8, current_step="Parsing fundamental screen request")
    _append_agent_event(
        run_id,
        "screen_parse",
        f"Screening universe {universe} for: {requirements[:220]}",
        universe=universe,
        requirements=requirements,
        max_results=max_results,
        max_checked=max_checked,
    )
    _set_agent_plan_step(run_id, "screen_parse", "completed", f"Universe: {universe}; checking up to {max_checked} symbol(s)")

    approach = _agent_approach_for_request(request, "", "")
    _update_agent_run(run_id, approach=approach)
    _append_agent_event(run_id, "approach", approach["summary"], steps=approach["steps"], settings=approach["settings"])

    if _agent_stop_requested(run_id):
        _set_agent_plan_step(run_id, "screen_parse", "stopped", "Stop requested")
        _update_agent_run(run_id, status="stopped", current_step="Stopped")
        return

    market_context = {}
    try:
        _set_agent_plan_step(run_id, "market_context", "running", "Loading market overview and industry heatmap")
        _update_agent_run(run_id, progress=18, current_step="Reading market overview and industry heatmap")
        overview = _sanitize_nan(await _run_agent_step_with_timeout(market_intel.get_market_movers, 8, "1d", None))
        heatmap = _sanitize_nan(await asyncio.wait_for(industry_heatmap(tickers=None, period="1d"), timeout=10))
        market_context = {"overview": overview, "industry_heatmap": heatmap}
        _update_agent_run(run_id, market_context=market_context)
        _set_agent_plan_step(run_id, "market_context", "completed", "Market overview and industry heatmap loaded")
        _append_agent_event(run_id, "market_context", "Loaded market overview and industry heatmap for screener context")
    except asyncio.TimeoutError:
        _set_agent_plan_step(run_id, "market_context", "skipped", "Market context timed out; continuing with screener data")
        _append_agent_event(run_id, "warning", "Market context timed out; continuing with screener data")
    except Exception as e:
        _set_agent_plan_step(run_id, "market_context", "skipped", f"Market context unavailable: {e}")
        _append_agent_event(run_id, "warning", f"Market context unavailable: {e}")

    if _agent_stop_requested(run_id):
        _set_agent_plan_step(run_id, "market_context", "stopped", "Stop requested")
        _update_agent_run(run_id, status="stopped", current_step="Stopped")
        return

    _set_agent_plan_step(run_id, "screen_candidates", "running", f"Screening up to {max_checked} symbol(s)")
    _update_agent_run(run_id, progress=35, current_step=f"Screening {universe} fundamentals")
    _append_agent_event(run_id, "screen_progress", f"Calling fundamental screener for {universe}", universe=universe, max_checked=max_checked)
    screen_result = _sanitize_nan(await asyncio.to_thread(screen_undervalued_stocks.invoke, {
        "universe": universe,
        "requirements": requirements,
        "max_results": max_results,
        "max_checked": max_checked,
        "include_insiders": True,
        "include_news": True,
        "include_options": True,
        "include_market_context": True,
    }))

    candidates = screen_result.get("candidates") or []
    raw_checked = screen_result.get("checked_count", screen_result.get("checked"))
    if isinstance(raw_checked, (list, tuple, set)):
        checked = len(raw_checked)
    elif raw_checked is not None:
        checked = int(raw_checked)
    else:
        checked = max_checked
    matched = screen_result.get("matched_count", screen_result.get("matched"))
    matched = int(matched) if matched is not None else len(candidates)
    _set_agent_plan_step(run_id, "screen_candidates", "completed", f"Checked {checked} symbol(s); matched {matched}")
    _append_agent_event(run_id, "screen_complete", f"Fundamental screen matched {len(candidates)} candidate(s)", checked=checked, matched=matched, universe=universe)

    _set_agent_plan_step(run_id, "enrich_candidates", "running", "Reviewing news, options, insider, and volume context")
    _update_agent_run(run_id, progress=78, current_step=f"Enriching {len(candidates)} candidate(s)")
    for index, candidate in enumerate(candidates[:max_results], start=1):
        quote = candidate.get("quote") or {}
        metrics = candidate.get("metrics") or candidate.get("fundamentals") or {}
        rel_volume = quote.get("relative_volume_30d")
        latest_bar = quote.get("latest_bar") or {}
        _append_agent_event(
            run_id,
            "screen_candidate",
            f"Candidate {index}: {_screen_candidate_label(candidate)}",
            symbol=candidate.get("symbol") or candidate.get("ticker"),
            score=candidate.get("score"),
            price=quote.get("price"),
            forward_pe=metrics.get("forward_pe") or candidate.get("forward_pe"),
            peg_ratio=metrics.get("peg_ratio") or candidate.get("peg_ratio"),
            price_to_sales=metrics.get("price_to_sales") or candidate.get("price_to_sales"),
            revenue_growth=metrics.get("revenue_growth") or candidate.get("revenue_growth"),
            relative_volume_30d=rel_volume,
            latest_bar=latest_bar,
        )
    _set_agent_plan_step(run_id, "enrich_candidates", "completed", f"Enriched {len(candidates)} candidate(s)")

    if candidates:
        top = candidates[0]
        top_reason = _format_screen_candidate_reason(top)
        fallback_summary = (
            f"Fundamental screen completed. It checked {checked} symbol(s) in {universe} and found {len(candidates)} candidate(s). "
            f"Top match: {_screen_candidate_label(top)} because {top_reason}."
        )
        summary_payload = {
            "workflow": "fundamental_screener",
            "user_prompt": request.prompt,
            "universe": universe,
            "requirements": requirements,
            "checked": checked,
            "matched": matched,
            "thresholds": screen_result.get("thresholds"),
            "as_of": screen_result.get("as_of"),
            "data_sources": screen_result.get("data_sources"),
            "candidates": [_compact_screen_candidate_for_summary(candidate) for candidate in candidates[:5]],
            "rejected_sample": (screen_result.get("rejected_sample") or [])[:5],
        }
        assistant_summary = await _generate_agent_visible_summary(request, summary_payload, fallback_summary)
        outcome = {
            "status": "accepted",
            "title": "Screen completed",
            "message": f"Found {len(candidates)} candidate(s). Top match: {_screen_candidate_label(top)}. Why: {top_reason}",
            "accepted": top,
            "best_attempt": top,
            "summary": top_reason,
            "assistant_summary": assistant_summary,
        }
        current_step = "Fundamental screen found candidates"
    else:
        fallback_summary = f"Fundamental screen completed, but no stocks matched after checking {checked} symbol(s) in {universe}."
        assistant_summary = await _generate_agent_visible_summary(request, {
            "workflow": "fundamental_screener",
            "user_prompt": request.prompt,
            "universe": universe,
            "requirements": requirements,
            "checked": checked,
            "matched": matched,
            "thresholds": screen_result.get("thresholds"),
            "rejected_sample": (screen_result.get("rejected_sample") or [])[:8],
            "as_of": screen_result.get("as_of"),
        }, fallback_summary)
        outcome = {
            "status": "rejected",
            "title": "No candidates matched",
            "message": f"No stocks matched after checking {checked} symbol(s) in {universe}. Try a wider universe or relaxed thresholds.",
            "accepted": None,
            "best_attempt": None,
            "assistant_summary": assistant_summary,
        }
        current_step = "No candidates matched"
    _set_agent_plan_step(run_id, "rank_report", "completed", outcome["message"], outcome=outcome)
    _update_agent_run(
        run_id,
        status="completed",
        progress=100,
        current_step=current_step,
        screen_result=screen_result,
        candidates=candidates,
        outcome=outcome,
        assistant_summary=assistant_summary,
        ticker=None,
        dataset_filename=None,
    )
    _append_agent_event(run_id, "complete", outcome["message"], outcome=outcome)


def _agent_prompt_requests_until_benchmark(prompt: str) -> bool:
    text = (prompt or "").lower()
    return bool(
        ("until" in text and any(term in text for term in ["beat", "beats", "outperform", "outperforms"]) and "buy" in text and "hold" in text)
        or ("until" in text and any(term in text for term in ["beat", "beats", "outperform", "outperforms"]))
        or ("unless" in text and "stop" in text)
        or ("keep generating" in text and ("buy and hold" in text or "buy & hold" in text))
    )

def _agent_prompt_requests_strategy_improvement(prompt: str) -> bool:
    text = (prompt or "").lower()
    return any(term in text for term in ["improve", "optimize", "optimise", "evolve", "enhance", "refine", "beat my", "beat the strategy"])

def _agent_available_strategy_names(request: AgentRunRequest) -> List[str]:
    names = []
    for item in request.available_strategies or []:
        if isinstance(item, str):
            name = item
        elif isinstance(item, dict):
            name = item.get("name") or item.get("strategy")
        else:
            name = ""
        if name:
            names.append(str(name))
    return names

def _agent_matchable_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()

def _agent_infer_benchmark_strategy(request: AgentRunRequest) -> Optional[str]:
    if request.benchmark_mode and str(request.benchmark_mode).lower() == "buy_hold":
        return None
    explicit = (request.benchmark_strategy or "").strip()
    if explicit:
        return explicit
    if not _agent_prompt_requests_strategy_improvement(request.prompt or ""):
        return None
    prompt_text = f" {_agent_matchable_text(request.prompt or '')} "
    for name in sorted(_agent_available_strategy_names(request), key=len, reverse=True):
        lowered = _agent_matchable_text(name)
        if lowered and f" {lowered} " in prompt_text:
            return name
    if request.strategies and len(request.strategies) == 1:
        return request.strategies[0]
    return None

def _agent_comparison_from_strategy(result: dict) -> Optional[Dict[str, Any]]:
    if not result or result.get("error"):
        return None
    roi = _agent_result_roi(result)
    if roi is None:
        return None
    return {
        "type": "strategy",
        "label": result.get("strategy") or "baseline strategy",
        "strategy": result.get("strategy"),
        "roi": roi,
        "available": True,
        "trade_count": _agent_strategy_trade_count(result),
        "statistics": result.get("statistics") or {},
    }

def _agent_comparison_from_buy_hold(buy_hold: dict) -> Optional[Dict[str, Any]]:
    if not buy_hold or not buy_hold.get("available"):
        return None
    try:
        roi = float(buy_hold.get("roi"))
    except Exception:
        return None
    return {
        "type": "buy_hold",
        "label": "buy and hold",
        "roi": roi,
        "available": True,
        "start": buy_hold.get("start"),
        "end": buy_hold.get("end"),
    }

def _agent_select_comparison_benchmark(benchmark: dict, baseline_result: dict = None) -> Optional[Dict[str, Any]]:
    strategy_benchmark = _agent_comparison_from_strategy(baseline_result)
    if strategy_benchmark:
        return strategy_benchmark
    return _agent_comparison_from_buy_hold((benchmark or {}).get("buy_hold") or {})

def _agent_apply_comparison_delta(result: dict, comparison: dict):
    if not result or not comparison or not comparison.get("available"):
        return
    roi = _agent_result_roi(result)
    try:
        benchmark_roi = float(comparison.get("roi"))
    except Exception:
        return
    if roi is None:
        return
    result["benchmark_delta"] = roi - benchmark_roi
    result["benchmark_label"] = comparison.get("label")
    result["benchmark_type"] = comparison.get("type")


def _set_agent_plan_step(run_id: str, step_id: str, status: str, observation: Optional[str] = None, **payload):
    run = agent_runs.get(run_id)
    if not run:
        return
    now_iso = datetime.now().isoformat()
    plan_steps = list(run.get("plan_steps") or [])
    found = False
    for step in plan_steps:
        if step.get("id") != step_id:
            continue
        found = True
        step["status"] = status
        if status == "running" and not step.get("started_at"):
            step["started_at"] = now_iso
        if status in {"completed", "failed", "skipped", "stopped"}:
            step["completed_at"] = now_iso
        if observation is not None:
            step["observation"] = observation
        if payload:
            step.setdefault("data", {}).update(payload)
        break
    if not found:
        plan_steps.append({
            "id": step_id,
            "label": step_id.replace("_", " ").title(),
            "status": status,
            "observation": observation,
            "started_at": now_iso if status == "running" else None,
            "completed_at": now_iso if status in {"completed", "failed", "skipped", "stopped"} else None,
            "data": payload or {},
        })
    _update_agent_run(run_id, plan_steps=plan_steps)
    _append_agent_event(run_id, f"step_{status}", observation or step_id, step_id=step_id, **payload)


def _sanitize_assistant_response(text: str) -> str:
    if not text:
        return text
    replacements = {
        "get_market_overview tool": "market overview data",
        "get_market_overview": "market overview data",
        "get_industry_heatmap tool": "industry heatmap data",
        "get_industry_heatmap": "industry heatmap data",
        "web_search tool": "news search",
        "web_search": "news search",
        "get_news tool": "news data",
        "get_news": "news data",
        "get_insider_trades tool": "insider trading data",
        "get_insider_trades": "insider trading data",
        "screen_industry_insider_activity tool": "insider industry scan",
        "screen_industry_insider_activity": "insider industry scan",
        "get_fundamentals tool": "fundamental valuation data",
        "get_fundamentals": "fundamental valuation data",
        "read_market_data tool": "local market data",
        "read_market_data": "local market data",
        "read_candles tool": "candle data",
        "read_candles": "candle data",
        "get_chart_data tool": "chart data",
        "get_chart_data": "chart data",
    }
    cleaned = text
    for raw, replacement in replacements.items():
        cleaned = cleaned.replace(raw, replacement)
    cleaned = re.sub(r"\bNaN values?\b", "unavailable values", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bNaN\b", "unavailable", cleaned)
    return cleaned


def _public_tool_label(tool_name: str) -> str:
    labels = {
        "get_market_overview": "market overview",
        "get_industry_heatmap": "industry heatmap",
        "web_search": "news search",
        "get_news": "news",
        "get_insider_trades": "insider trading",
        "screen_industry_insider_activity": "insider industry scan",
        "get_fundamentals": "fundamentals",
        "read_market_data": "local market data",
        "read_candles": "candle data",
        "get_chart_data": "chart data",
        "get_price_chart": "price chart",
        "generate_strategy": "strategy generation",
        "run_backtest": "backtest",
        "download_market_data": "data download",
        "check_task_status": "task status",
    }
    return labels.get(tool_name or "", (tool_name or "data source").replace("_", " "))


_TOOL_NAME_ALIASES = {
    "get_techniques": "get_technicals",
    "get_technical": "get_technicals",
    "get_technical_analysis": "get_technicals",
}


def _normalize_agent_tool_name(tool_name: str) -> str:
    """Repair a small set of common model-generated tool-name variants."""
    clean = str(tool_name or "").strip().lower().replace(" ", "_").replace("-", "_")
    return _TOOL_NAME_ALIASES.get(clean, clean)


def _tool_result_error(result) -> Optional[str]:
    """Treat a tool's structured failure payload as a failure, not a green success."""
    if not isinstance(result, dict):
        return None
    error = result.get("error")
    if error:
        return str(error)
    if str(result.get("status") or "").lower() == "failed":
        return str(result.get("message") or result.get("detail") or "Tool reported failure")
    return None

def _agent_strategy_trade_count(result: dict) -> int:
    stats = result.get("statistics") or {}
    try:
        return int(stats.get("total_trades") or 0)
    except Exception:
        return 0

def _agent_result_roi(result: dict) -> Optional[float]:
    try:
        return float((result or {}).get("roi"))
    except Exception:
        return None

def _agent_result_sort_key(result: dict):
    active_rank = 1 if result and result.get("valid_candidate", _agent_strategy_trade_count(result) > 0) and not result.get("error") else 0
    roi = _agent_result_roi(result)
    return (active_rank, roi if roi is not None else -100.0)

def _agent_better_attempt(candidate: dict, current: dict = None) -> bool:
    if not candidate or candidate.get("error"):
        return False
    if not current:
        return True
    candidate_trades = _agent_strategy_trade_count(candidate)
    current_trades = _agent_strategy_trade_count(current)
    if candidate_trades > 0 and current_trades <= 0:
        return True
    if candidate_trades <= 0 and current_trades > 0:
        return False
    candidate_roi = _agent_result_roi(candidate)
    current_roi = _agent_result_roi(current)
    if candidate_roi is None:
        return False
    if current_roi is None:
        return True
    return candidate_roi > current_roi

def _agent_strategy_verdict(result: dict, comparison_benchmark: dict = None, target_min_roi: float = None) -> Dict[str, Any]:
    roi = result.get("roi")
    delta = result.get("benchmark_delta")
    trades = _agent_strategy_trade_count(result)
    comparison_benchmark = comparison_benchmark or {}
    benchmark_label = comparison_benchmark.get("label") or "the configured benchmark"
    try:
        roi_num = float(roi)
    except Exception:
        roi_num = None
    try:
        delta_num = float(delta)
    except Exception:
        delta_num = None

    if result.get("error"):
        return {"accepted": False, "reason": f"Backtest error: {result.get('error')}", "trade_count": trades}
    if trades <= 0:
        return {"accepted": False, "reason": "No trades were taken, so the strategy is inactive.", "trade_count": trades}
    if roi_num is None:
        return {"accepted": False, "reason": "ROI was unavailable.", "trade_count": trades}
    if roi_num <= 0:
        return {"accepted": False, "reason": f"Strategy ROI was not positive ({roi_num:.2f}%).", "trade_count": trades}
    if comparison_benchmark.get("available") and delta_num is not None and delta_num <= 0:
        return {"accepted": False, "reason": f"It underperformed {benchmark_label} by {abs(delta_num):.2f} percentage points.", "trade_count": trades}
    if target_min_roi is not None and roi_num is not None and roi_num < target_min_roi:
        return {"accepted": False, "reason": f"ROI {roi_num:.2f}% is below the minimum target of {target_min_roi:.0f}%.", "trade_count": trades}
    return {"accepted": True, "reason": f"Positive ROI and beat {benchmark_label}.", "trade_count": trades}


async def _agent_llm_extract_run_params(request: AgentRunRequest) -> Dict[str, Any]:
    """Use LLM to extract target_min_roi and benchmark_strategy from the user prompt.
    Falls back to regex/string matching if the LLM call fails."""
    if not request.prompt:
        return {}
    if request.target_min_roi is not None:
        return {"target_min_roi": request.target_min_roi, "benchmark_strategy": await _agent_llm_extract_benchmark(request)}
    available = _agent_available_strategy_names(request)
    strategies_hint = f"\nAvailable strategies to use as benchmark: {', '.join(available) if available else 'none (only buy-and-hold is available for comparison)'}"
    system_prompt = (
        "You extract structured parameters from a trading strategy request. "
        "Respond ONLY with valid JSON containing two optional fields:\n"
        '- "target_min_roi": number or null — a minimum ROI threshold the user wants (e.g. 70 for 70%). Return null if no threshold is mentioned.\n'
        '- "benchmark_strategy": string or null — the exact name of a strategy to compare against (from the provided list), or null if the user wants buy-and-hold or doesn\'t mention a specific strategy.\n'
        "Examples:\n"
        '- "find a strategy with ROI higher than 70%" → {"target_min_roi": 70, "benchmark_strategy": null}\n'
        '- "beat the SMA crossover strategy with at least 80% ROI" → {"target_min_roi": 80, "benchmark_strategy": "SMA Crossover"}\n'
        '- "find a good strategy for AAPL" → {"target_min_roi": null, "benchmark_strategy": null}\n'
        f"{strategies_hint}"
    )
    try:
        raw = await call_llm(
            provider=request.provider,
            model=request.model,
            system_prompt=system_prompt,
            user_prompt=f"Extract parameters from this user request:\n\n{request.prompt}",
            api_key=request.api_key,
            provider_config=request.provider_config,
            json_mode=True,
            max_tokens=256,
        )
        if not raw:
            return _agent_fallback_extract(request)
        parsed = json.loads(raw)
        result: Dict[str, Any] = {}
        roi = parsed.get("target_min_roi")
        if roi is not None:
            try:
                val = float(roi)
                if 0 < val <= 1000:
                    result["target_min_roi"] = val
            except (TypeError, ValueError):
                pass
        strategy = parsed.get("benchmark_strategy")
        if strategy and isinstance(strategy, str) and strategy.strip():
            normalized = strategy.strip()
            exact_match = next((s for s in available if s.lower() == normalized.lower()), None)
            if exact_match:
                result["benchmark_strategy"] = exact_match
            else:
                result["benchmark_strategy"] = normalized
        return result
    except Exception as e:
        logger.warning(f"LLM extraction failed, falling back to regex: {e}")
        return _agent_fallback_extract(request)


async def _agent_llm_extract_benchmark(request: AgentRunRequest) -> Optional[str]:
    if request.benchmark_mode and str(request.benchmark_mode).lower() == "buy_hold":
        return None
    if request.benchmark_strategy:
        return request.benchmark_strategy.strip()
    if not request.prompt:
        return None
    available = _agent_available_strategy_names(request)
    strategies_hint = f"Available strategies: {', '.join(available) if available else 'none'}"
    system_prompt = (
        "Extract the benchmark strategy name from a user request. "
        "If the user mentions a specific strategy to beat (from the list), return its exact name. "
        "If the user only mentions buy-and-hold or no specific strategy, return null. "
        f"{strategies_hint}\n\n"
        "Respond ONLY with valid JSON: {\"benchmark_strategy\": string | null}"
    )
    try:
        raw = await call_llm(
            provider=request.provider,
            model=request.model,
            system_prompt=system_prompt,
            user_prompt=f"User request: {request.prompt}",
            api_key=request.api_key,
            provider_config=request.provider_config,
            json_mode=True,
            max_tokens=128,
        )
        if not raw:
            return _agent_infer_benchmark_strategy(request)
        parsed = json.loads(raw)
        strategy = parsed.get("benchmark_strategy")
        if strategy and isinstance(strategy, str) and strategy.strip():
            normalized = strategy.strip()
            exact_match = next((s for s in available if s.lower() == normalized.lower()), None)
            return exact_match or normalized
        return None
    except Exception:
        return _agent_infer_benchmark_strategy(request)


def _agent_fallback_extract(request: AgentRunRequest) -> Dict[str, Any]:
    return {
        "target_min_roi": _extract_roi_target(request.prompt or ""),
        "benchmark_strategy": _agent_infer_benchmark_strategy(request),
    }


async def agent_run_task(run_id: str, request: AgentRunRequest):
    user_id = LOCAL_USER_ID
    try:
        if request.workflow == "fundamental_screener":
            _update_agent_run(run_id, status="running", progress=3, current_step="Preparing fundamental screener", plan_steps=_agent_plan_for_request(request))
            _append_agent_event(run_id, "start", "Started fundamental screener")
            await _run_fundamental_screener_agent(run_id, request)
            return

        llm_params = await _agent_llm_extract_run_params(request)
        if "target_min_roi" in llm_params and request.target_min_roi is None:
            request.target_min_roi = llm_params["target_min_roi"]
        llm_benchmark_strategy = llm_params.get("benchmark_strategy")

        inferred_window = _infer_agent_window_from_prompt(request.prompt or "")
        if inferred_window.get("period") and (not request.period or request.period == "5y"):
            request.period = inferred_window["period"]
        if inferred_window.get("interval") and (not request.interval or request.interval == "1d"):
            request.interval = inferred_window["interval"]
        if inferred_window.get("extended_hours"):
            request.extended_hours = True
        if inferred_window.get("start_date") and not request.start_date:
            request.start_date = inferred_window["start_date"]
        if inferred_window.get("end_date") and not request.end_date:
            request.end_date = inferred_window["end_date"]
        until_benchmark = _agent_prompt_requests_until_benchmark(request.prompt or "")
        if until_benchmark and request.workflow in {"strategy_create", "strategy_race"} and not request.strategies:
            request.max_rounds = max(int(request.max_rounds or 0), 100)
            request.stop_after_no_improvement = max(int(request.stop_after_no_improvement or 0), 100)
            request.candidate_count = max(int(request.candidate_count or 0), 5)

        _update_agent_run(run_id, status="running", progress=5, current_step="Preparing agent run", plan_steps=_agent_plan_for_request(request))
        await _flush_agent_updates()
        _append_agent_event(run_id, "start", f"Started {request.workflow}")
        if until_benchmark and request.workflow in {"strategy_create", "strategy_race"} and not request.strategies:
            _append_agent_event(
                run_id,
                "benchmark_loop",
                "Detected an explicit request to keep generating until a candidate beats buy and hold; expanded search budget until user stop or benchmark success.",
                max_rounds=request.max_rounds,
                stop_after_no_improvement=request.stop_after_no_improvement,
                candidate_count=request.candidate_count,
            )

        _set_agent_plan_step(run_id, "resolve_target", "running", "Resolving ticker and dataset")
        ticker = (request.ticker or _ticker_from_dataset(request.dataset_filename or "") or _extract_ticker_from_text(request.prompt or "")).upper()
        dataset_filename = request.dataset_filename
        if not dataset_filename and ticker:
            dataset_filename = _find_best_dataset_for_ticker(user_id, ticker, request.interval or "1d", bool(request.extended_hours))

        if not ticker and dataset_filename:
            ticker = _ticker_from_dataset(dataset_filename)

        if not ticker and request.workflow != "market_review":
            _update_agent_run(run_id, ticker=ticker, dataset_filename=dataset_filename)
            _set_agent_plan_step(run_id, "resolve_target", "stopped", "I need a ticker symbol before I can download data or run a backtest")
            _update_agent_run(
                run_id,
                status="stopped",
                progress=8,
                current_step="Need ticker symbol",
                error="Please include a ticker symbol, for example QQQ, SPY, NVDA, or AAPL.",
            )
            _append_agent_event(run_id, "needs_input", "Please include a ticker symbol, for example QQQ, SPY, NVDA, or AAPL.")
            return

        _update_agent_run(run_id, ticker=ticker, dataset_filename=dataset_filename)
        _set_agent_plan_step(run_id, "resolve_target", "completed", f"Target resolved: {ticker or dataset_filename or 'market review'}", ticker=ticker, dataset_filename=dataset_filename)
        approach = _agent_approach_for_request(request, ticker, dataset_filename)
        _update_agent_run(run_id, approach=approach)
        _append_agent_event(run_id, "approach", approach["summary"], steps=approach["steps"], settings=approach["settings"])

        market_context = {}
        try:
            _set_agent_plan_step(run_id, "market_context", "running", "Loading market overview and industry heatmap")
            _update_agent_run(run_id, progress=12, current_step="Reading market overview and industry heatmap")
            await _flush_agent_updates()
            if _agent_stop_requested(run_id):
                _set_agent_plan_step(run_id, "market_context", "stopped", "Stop requested")
                _update_agent_run(run_id, status="stopped", current_step="Stopped")
                return
            overview = _sanitize_nan(await _run_agent_step_with_timeout(market_intel.get_market_movers, 8, request.period or "1d", None))
            if _agent_stop_requested(run_id):
                _set_agent_plan_step(run_id, "market_context", "stopped", "Stop requested")
                _update_agent_run(run_id, status="stopped", current_step="Stopped")
                return
            heatmap = _sanitize_nan(await asyncio.wait_for(industry_heatmap(tickers=None, period=request.period or "1d"), timeout=10))
            market_context = {"overview": overview, "industry_heatmap": heatmap}
            _update_agent_run(run_id, market_context=market_context)
            _set_agent_plan_step(run_id, "market_context", "completed", "Market overview and industry heatmap loaded")
            _append_agent_event(run_id, "market_context", "Loaded market overview and industry heatmap")
        except asyncio.TimeoutError:
            _set_agent_plan_step(run_id, "market_context", "skipped", "Market context timed out; continuing with local dataset and candle profile")
            _append_agent_event(run_id, "warning", "Market context timed out; continuing without overview/heatmap")
        except Exception as e:
            _set_agent_plan_step(run_id, "market_context", "failed", f"Market context unavailable: {e}")
            _append_agent_event(run_id, "warning", f"Market context unavailable: {e}")

        if _agent_stop_requested(run_id):
            _set_agent_plan_step(run_id, "market_context", "stopped", "Stop requested")
            _update_agent_run(run_id, status="stopped", current_step="Stopped")
            return

        dataset_status = None
        _set_agent_plan_step(run_id, "dataset_freshness", "running", "Checking dataset freshness")
        if dataset_filename:
            dataset_status = get_dataset_status(user_id, dataset_filename, request.end_date)
            _update_agent_run(run_id, dataset_status=dataset_status, progress=20, current_step="Checked dataset freshness")
            await _flush_agent_updates()
            _append_agent_event(
                run_id,
                "dataset_status",
                "Dataset freshness checked",
                dataset_status=dataset_status,
            )
            freshness_msg = "Dataset is fresh" if dataset_status.get("fresh") else "Dataset is missing or stale"
            _set_agent_plan_step(run_id, "dataset_freshness", "completed", freshness_msg, dataset_status=dataset_status)
        else:
            _set_agent_plan_step(run_id, "dataset_freshness", "skipped", "No dataset selected yet")

        if _agent_stop_requested(run_id):
            _set_agent_plan_step(run_id, "dataset_freshness", "stopped", "Stop requested")
            _update_agent_run(run_id, status="stopped", current_step="Stopped")
            return

        needs_download = bool(request.require_fresh_data and ticker and (not dataset_filename or not dataset_status or dataset_status.get("stale") or not dataset_status.get("exists")))
        if needs_download:
            _set_agent_plan_step(run_id, "data_sync", "running", f"Downloading fresh data for {ticker}")
            _update_agent_run(run_id, progress=25, current_step=f"Downloading fresh data for {ticker}")
            await _flush_agent_updates()
            extended_note = " with extended hours" if request.extended_hours else ""
            _append_agent_event(run_id, "download", f"Downloading {ticker} {request.interval}/{request.period}{extended_note}")
            loop = asyncio.get_event_loop()
            await _flush_agent_updates()
            _, _, user_dir = get_user_dirs(user_id)
            downloaded_path = await loop.run_in_executor(
                None,
                lambda: download_ticker_data(
                    ticker,
                    interval=request.interval or "1d",
                    period=request.period or "5y",
                    output_dir=user_dir,
                    extended_hours=bool(request.extended_hours),
                )
            )
            if not downloaded_path:
                raise RuntimeError(f"Download failed for {ticker}")
            dataset_filename = os.path.basename(downloaded_path)
            dataset_status = get_dataset_status(user_id, dataset_filename, request.end_date)
            _update_agent_run(run_id, dataset_filename=dataset_filename, dataset_status=dataset_status)
            _set_agent_plan_step(run_id, "data_sync", "completed", f"Using dataset {dataset_filename}", dataset_status=dataset_status)
            _append_agent_event(run_id, "download_complete", f"Using dataset {dataset_filename}", dataset_status=dataset_status)
        elif request.require_fresh_data:
            _set_agent_plan_step(run_id, "data_sync", "skipped", "Existing dataset is usable")

        if _agent_stop_requested(run_id):
            _set_agent_plan_step(run_id, "data_sync", "stopped", "Stop requested")
            _update_agent_run(run_id, status="stopped", current_step="Stopped")
            return

        if request.workflow == "market_review":
            _set_agent_plan_step(run_id, "market_review", "completed", "Market review complete")
            _update_agent_run(run_id, status="completed", progress=100, current_step="Market review complete")
            _append_agent_event(run_id, "complete", "Market review complete")
            return

        if not dataset_filename:
            raise RuntimeError("No dataset available. Provide a ticker or dataset filename.")

        price_action_summary = ""
        _set_agent_plan_step(run_id, "candle_profile", "running", f"Reading recent candles from {dataset_filename}")
        _update_agent_run(run_id, progress=30, current_step="Reading candle profile")
        await _flush_agent_updates()
        try:
            price_action_summary = await asyncio.get_event_loop().run_in_executor(None, lambda: get_price_action_summary(dataset_filename, bar_limit=120))
            if price_action_summary:
                _update_agent_run(run_id, price_action_summary=price_action_summary)
                _set_agent_plan_step(run_id, "candle_profile", "completed", "Candle profile loaded: recent bars, RSI, moving averages, range, volume, and viable triggers")
                _append_agent_event(run_id, "candle_profile", "Loaded candle profile for strategy generation")
            else:
                _set_agent_plan_step(run_id, "candle_profile", "failed", "Candle profile unavailable for this dataset")
                _append_agent_event(run_id, "warning", "Candle profile unavailable for this dataset")
        except Exception as e:
            _set_agent_plan_step(run_id, "candle_profile", "failed", f"Candle profile unavailable: {e}")
            _append_agent_event(run_id, "warning", f"Candle profile unavailable: {e}")

        backtest_settings = _agent_backtest_settings(request)
        baseline_strategy_name = llm_benchmark_strategy or _agent_infer_benchmark_strategy(request)
        baseline_result = None
        comparison_benchmark = None
        if baseline_strategy_name and request.workflow in {"strategy_create", "strategy_race"}:
            _set_agent_plan_step(run_id, "baseline_benchmark", "running", f"Backtesting baseline strategy {baseline_strategy_name}")
            _update_agent_run(run_id, progress=34, current_step=f"Benchmarking baseline strategy {baseline_strategy_name}", benchmark_strategy=baseline_strategy_name)
            await _flush_agent_updates()
            baseline_task_id = str(uuid.uuid4())
            results_store[baseline_task_id] = {"status": "running", "user_id": user_id, "partial_results": []}
            await run_backtests_task(
                baseline_task_id,
                dataset_filename,
                [baseline_strategy_name],
                None,
                None,
                request.start_date,
                request.end_date,
                True,
                user_id,
                backtest_settings["initial_cash"],
                backtest_settings["commission"],
                1,
            )
            baseline_backtest = results_store.get(baseline_task_id, {})
            if baseline_backtest.get("status") == "completed":
                baseline_results = baseline_backtest.get("results") or []
                baseline_result = next((r for r in baseline_results if r.get("strategy") == baseline_strategy_name), baseline_results[0] if baseline_results else None)
                comparison_benchmark = _agent_comparison_from_strategy(baseline_result)
                if comparison_benchmark:
                    _update_agent_run(run_id, baseline_result=baseline_result, comparison_benchmark=comparison_benchmark)
                    _set_agent_plan_step(
                        run_id,
                        "baseline_benchmark",
                        "completed",
                        f"Baseline loaded: {baseline_strategy_name} ROI {comparison_benchmark.get('roi'):.2f}%",
                        baseline_result=baseline_result,
                        comparison_benchmark=comparison_benchmark,
                    )
                    _append_agent_event(run_id, "baseline_benchmark", f"Using {baseline_strategy_name} as comparison benchmark", comparison_benchmark=comparison_benchmark)
                else:
                    _set_agent_plan_step(run_id, "baseline_benchmark", "failed", f"Baseline {baseline_strategy_name} did not produce a usable ROI")
                    _append_agent_event(run_id, "warning", f"Could not use {baseline_strategy_name} as comparison benchmark")
            else:
                _set_agent_plan_step(run_id, "baseline_benchmark", "failed", baseline_backtest.get("error") or "Baseline backtest failed")
                _append_agent_event(run_id, "warning", f"Baseline backtest failed for {baseline_strategy_name}", error=baseline_backtest.get("error"))

        strategies = list(request.strategies or [])
        strategy_round_cap = max(1, min(int(request.max_rounds or 30), 100))
        stop_after_cap = 100 if until_benchmark else 20
        stop_after_no_improve = max(1, min(int(request.stop_after_no_improvement or 5), stop_after_cap))
        backtest_result = {}
        backtest_task_id = None
        benchmark = None
        best_attempt = None
        accepted = None
        outcome = None
        candidates = []

        async def run_agent_backtest_with_progress(
            *,
            task_id: str,
            strategy_names: List[str],
            sequential: bool,
            max_workers: int,
            progress: int,
            label: str,
        ):
            active_stake_range = backtest_settings["stake_range"]
            active_trail_range = backtest_settings["trail_range"]

            def on_backtest_progress(event):
                event_type = event.get("type")
                strategy_name = event.get("strategy") or "strategy"
                combinations = event.get("combinations") or 0
                completed = event.get("completed") or 0
                total = event.get("total") or len(strategy_names)
                if event_type == "strategy_start":
                    message = f"{label}: running {combinations} optimization combinations for {strategy_name}"
                    _append_agent_event(
                        run_id,
                        "backtest_progress",
                        message,
                        detail=f"Candidate {completed + 1}/{total}. Testing stake/trailing-stop combinations.",
                        round=round_number if 'round_number' in locals() else None,
                        strategy=strategy_name,
                        combinations=combinations,
                        completed=completed,
                        total=total,
                    )
                    _update_agent_run(run_id, current_step=message, progress=progress)
                elif event_type == "strategy_complete":
                    if event.get("error"):
                        message = f"{label}: rejected {strategy_name} after backtest error"
                        detail = summarize_runtime_error(event.get("error") or event.get("rejection_reason"))
                    elif event.get("trade_count", 0) <= 0:
                        message = f"{label}: rejected {strategy_name} after zero trades"
                        detail = event.get("rejection_reason") or "No trades were taken on this dataset."
                    else:
                        message = f"{label}: completed {strategy_name} ROI {float(event.get('roi') or 0):.2f}%"
                        detail = f"Completed {completed}/{total}. Trades: {event.get('trade_count', 0)}."
                    _append_agent_event(
                        run_id,
                        "backtest_result",
                        message,
                        detail=detail,
                        round=round_number if 'round_number' in locals() else None,
                        strategy=strategy_name,
                        combinations=combinations,
                        completed=completed,
                        total=total,
                    )
                    _update_agent_run(run_id, current_step=message, progress=progress)

            backtest_task = asyncio.create_task(run_backtests_task(
                task_id,
                dataset_filename,
                strategy_names,
                active_stake_range,
                active_trail_range,
                request.start_date,
                request.end_date,
                sequential,
                user_id,
                backtest_settings["initial_cash"],
                backtest_settings["commission"],
                max_workers,
                on_backtest_progress,
            ))
            started_at = time.monotonic()
            last_partial_count = -1
            last_current = ""
            heartbeat = 0
            while not backtest_task.done():
                await asyncio.sleep(5)
                if backtest_task.done():
                    break
                heartbeat += 1
                task_state = results_store.get(task_id, {})
                partials = task_state.get("partial_results") or []
                current = task_state.get("current") or label
                elapsed = int(time.monotonic() - started_at)
                if len(partials) != last_partial_count or current != last_current or heartbeat % 3 == 0:
                    last_partial_count = len(partials)
                    last_current = current
                    detail = None
                    if partials:
                        best_partial = sorted(partials, key=_agent_result_sort_key, reverse=True)[0]
                        detail = (
                            f"Partial best: {best_partial.get('strategy')} ROI "
                            f"{float(best_partial.get('roi') or 0):.2f}%"
                        )
                        if best_partial.get("error") or best_partial.get("rejection_reason"):
                            detail += f". Note: {summarize_runtime_error(best_partial.get('runtime_traceback') or best_partial.get('error') or best_partial.get('rejection_reason'))}"
                    _append_agent_event(
                        run_id,
                        "backtest_progress",
                        f"{label}: {current} ({elapsed}s)",
                        detail=detail or f"Completed {len(partials)}/{len(strategy_names)} candidate result(s).",
                        round=round_number if 'round_number' in locals() else None,
                        elapsed_seconds=elapsed,
                        completed=len(partials),
                        total=len(strategy_names),
                    )
                    _update_agent_run(run_id, current_step=f"{label}: {current} ({elapsed}s)", progress=progress)
            await backtest_task
            completed_state = results_store.get(task_id, {})
            for result in (completed_state.get("results") or [])[:8]:
                if result.get("error") or result.get("runtime_error"):
                    _append_agent_event(
                        run_id,
                        "backtest_result",
                        f"Rejected {result.get('strategy')} after runtime error",
                        error=summarize_runtime_error(result.get("runtime_traceback") or result.get("runtime_error") or result.get("error")),
                        round=round_number if 'round_number' in locals() else None,
                        strategy=result.get("strategy"),
                    )
                elif result.get("inactive"):
                    _append_agent_event(
                        run_id,
                        "backtest_result",
                        f"Rejected {result.get('strategy')}: zero trades",
                        detail=result.get("rejection_reason"),
                        round=round_number if 'round_number' in locals() else None,
                        strategy=result.get("strategy"),
                    )
                else:
                    _append_agent_event(
                        run_id,
                        "backtest_result",
                        f"Backtested {result.get('strategy')}: ROI {float(result.get('roi') or 0):.2f}%",
                        detail=f"Trades: {result.get('trade_count', 0)}. Delta: {float(result.get('benchmark_delta') or 0):.2f} percentage points." if result.get("benchmark_delta") is not None else f"Trades: {result.get('trade_count', 0)}.",
                        round=round_number if 'round_number' in locals() else None,
                        strategy=result.get("strategy"),
                    )
            return completed_state

        if request.workflow in {"strategy_create", "strategy_race"} and not strategies:
            prompt = request.prompt or f"Create practical strategies for {ticker or dataset_filename}. Use current market and industry context and avoid overfitting."
            if comparison_benchmark and comparison_benchmark.get("type") == "strategy":
                prompt = f"""{prompt}

BASELINE STRATEGY TO IMPROVE:
- Strategy: {comparison_benchmark.get('label')}
- Baseline ROI on this same dataset/window: {float(comparison_benchmark.get('roi') or 0):.2f}%
- Baseline trade count: {comparison_benchmark.get('trade_count')}
- New candidates must beat this baseline strategy. Do not optimize only against buy and hold unless the user explicitly asked for that."""
            if request.target_min_roi is not None:
                prompt = f"""{prompt}

ROI TARGET: The user specified a minimum ROI target of {request.target_min_roi:.0f}%. Only accept strategies that achieve at least {request.target_min_roi:.0f}% ROI on this dataset. Aim for strategies that comfortably exceed this threshold, not just barely meet it."""
            if price_action_summary:
                prompt = f"""{prompt}

MANDATORY CANDLE AWARENESS:
Use this actual local dataset profile before deciding entries/exits. Your strategy must be designed so at least one entry path is plausible in this observed candle regime, not a rigid rule stack that never fires.

{price_action_summary}

Generation requirements based on the candle profile:
- Explicitly adapt thresholds to the observed range, RSI behavior, ATR, and volume context.
- Avoid combining too many rare conditions. Breakout + volume + RSI + trend filters together often produce zero trades.
- Include a fallback entry for the observed regime, such as pullback-in-uptrend, range reversion, volatility breakout, or moving-average reclaim, depending on the profile.
- Prefer parameterized thresholds with reasonable defaults.
- The generated Backtrader code must be capable of taking trades on this dataset when the candle profile supports the setup."""
            prompt = f"""{prompt}

BACKTEST PARAMETERS THAT WILL BE USED FOR EVALUATION:
- Stake optimization range (% of equity): {backtest_settings["stake_range"]}
- Trailing stop matrix: {backtest_settings["trail_range"]}
- Date window: {backtest_settings["start_date"] or "dataset start"} to {backtest_settings["end_date"] or "dataset end"}
- Initial capital: ${backtest_settings["initial_cash"]:,.2f}
- Commission: {backtest_settings["commission"]}
- Execution mode: {"sequential low-resource" if backtest_settings["sequential"] else "parallel"}"""
            custom_agent_instructions = _agent_instruction_block(getattr(request, "agent_instructions", None))
            if custom_agent_instructions:
                prompt = f"""{prompt}

USER AGENT INSTRUCTIONS:
{custom_agent_instructions}

Treat these as operator preferences for this run. Apply them when they do not conflict with platform validation, benchmark comparison, or safety requirements."""
            history_limit = max(0, min(80, int(request.history_limit or 0)))
            history_items = (request.history or [])[-history_limit:] if history_limit else []
            if history_items:
                compact_history = "\n".join(
                    f"{str(item.get('role', 'user'))}: {str(item.get('content', ''))[:700]}"
                    for item in history_items
                    if isinstance(item, dict) and item.get("content")
                )
                if compact_history:
                    prompt = f"{prompt}\n\nRelevant prior chat context:\n{compact_history}"
            strategies = []
            gen_result = {}
            generation_error = ""
            inferred_candidate_count = _infer_agent_candidate_count_from_prompt(request.prompt or "")
            base_count = max(1, min(int(request.candidate_count or inferred_candidate_count or 3), 8))
            no_improve_streak = 0
            best_attempt = None
            best_roi = None
            accepted = None
            outcome = None
            benchmark = None
            candidates = []
            round_number = 0

            while round_number < strategy_round_cap and not accepted:
                round_number += 1
                generation_task_id = str(uuid.uuid4())
                init_task_state(generation_task_id, {
                    "status": "running",
                    "progress": 10,
                    "current": f"Agent generating candidate strategies (round {round_number})...",
                    "user_id": user_id,
                    "stream_preview": "",
                })

                _set_agent_plan_step(
                    run_id,
                    "strategy_generation",
                    "running",
                    f"Generating candidate strategy code (round {round_number}/{strategy_round_cap})",
                )
                _update_agent_run(
                    run_id,
                    progress=min(55, 35 + round_number),
                    current_step=f"Generating candidate strategies (round {round_number})",
                )
                await _flush_agent_updates()

                attempt_prompt = prompt
                if generation_error:
                    attempt_prompt = f"""{prompt}

The previous generation attempt failed validation or did not beat the benchmark: {generation_error}

Repair requirements:
- Return valid JSON with a strategies array.
- Each strategy must include raw Python code only.
- Each class must inherit bt.Strategy and compile without syntax errors.
- Define all indicators in __init__, not next.
- Do not assign to Backtrader line buffers.
- Use scalar attributes for stop prices/trailing stops.
- Include clear buy/sell or close logic.
- Avoid size hardcodes in self.buy/self.sell.
- Generate simpler, robust strategies that are likely to pass validation."""

                await ai_generation_task(generation_task_id, AIStrategyRequest(
                    prompt=attempt_prompt,
                    api_key=request.api_key,
                    provider_config=request.provider_config,
                    provider=request.provider,
                    model=request.model,
                    max_tokens=max(4096, min(int(request.max_tokens or 8192), 20000)),
                    agent_instructions=request.agent_instructions,
                    count=base_count,
                    ticker=ticker,
                    dataset_filename=dataset_filename,
                    mode="pattern_fit",
                    target_category=ticker or "Agent",
                    agent_run_id=run_id,
                    generation_round=round_number,
                ))
                gen_result = results_store.get(generation_task_id, {})
                if not (gen_result.get("status") == "completed" and gen_result.get("saved_names")):
                    generation_error = gen_result.get("error") or "No valid strategy code was saved from the model output"
                    _update_agent_run(
                        run_id,
                        current_step=f"Round {round_number} generation failed validation",
                        last_generation_error=generation_error,
                        last_generation_round=round_number,
                    )
                    _append_agent_event(run_id, "generation_retry", f"Round {round_number} generation failed", error=generation_error)
                    no_improve_streak += 1
                    if no_improve_streak >= stop_after_no_improve:
                        break
                    continue

                strategies = gen_result.get("saved_names") or []
                _set_agent_plan_step(run_id, "strategy_generation", "completed", f"Generated {len(strategies)} strategy candidate(s) in round {round_number}", strategies=strategies)
                _append_agent_event(run_id, "generation_complete", f"Generated {len(strategies)} candidate strategies in round {round_number}", strategies=strategies)

                _set_agent_plan_step(run_id, "backtest", "running", f"Backtesting {len(strategies)} strategy candidate(s) from round {round_number}")
                stake_options = backtest_settings["stake_range"]
                trail_options = backtest_settings["trail_range"]
                combo_count = len(stake_options) * len(trail_options)
                _update_agent_run(run_id, progress=60, current_step=f"Backtesting {len(strategies)} strategy candidate(s) across {combo_count} parameter combinations")
                await _flush_agent_updates()
                _append_agent_event(
                    run_id,
                    "backtest_optimization",
                    f"Optimizing {len(strategies)} candidate strategy(s) across {combo_count} parameter combinations",
                    strategies=strategies,
                    combinations=combo_count,
                    stake_range=stake_options,
                    trail_range=trail_options,
                )
                backtest_task_id = str(uuid.uuid4())
                results_store[backtest_task_id] = {"status": "running", "user_id": user_id, "partial_results": []}
                await run_agent_backtest_with_progress(
                    task_id=backtest_task_id,
                    strategy_names=strategies,
                    sequential=backtest_settings["sequential"],
                    max_workers=max(1, min(int(request.max_backtest_workers or 4), 8)),
                    progress=60,
                    label=f"Round {round_number} backtesting",
                )
                backtest_result = results_store.get(backtest_task_id, {})
                if backtest_result.get("status") != "completed":
                    generation_error = backtest_result.get("error") or "Backtest failed"
                    _update_agent_run(
                        run_id,
                        current_step=f"Round {round_number} backtest failed",
                        last_generation_error=generation_error,
                        last_generation_round=round_number,
                    )
                    _set_agent_plan_step(run_id, "backtest", "failed", generation_error)
                    _append_agent_event(run_id, "generation_retry", f"Round {round_number} backtest failed", error=generation_error)
                    no_improve_streak += 1
                    if no_improve_streak >= stop_after_no_improve:
                        break
                    continue

                _set_agent_plan_step(run_id, "backtest", "completed", f"Backtested {len(strategies)} strategy candidate(s)", backtest_task_id=backtest_task_id)
                benchmark = backtest_result.get("benchmark")
                results = backtest_result.get("results") or []
                buy_hold = (benchmark or {}).get("buy_hold") or {}
                comparison_benchmark = comparison_benchmark or _agent_select_comparison_benchmark(benchmark, baseline_result)
                if benchmark is not None and comparison_benchmark:
                    benchmark["comparison"] = comparison_benchmark
                for r in results:
                    _agent_apply_comparison_delta(r, comparison_benchmark)
                active_results = [r for r in results if _agent_strategy_trade_count(r) > 0 and not r.get("error")]
                verdicts = {}
                round_accepted = None
                for r in results:
                    verdict = _agent_strategy_verdict(r, comparison_benchmark, request.target_min_roi)
                    verdicts[r.get("strategy")] = verdict
                    if _agent_better_attempt(r, best_attempt):
                        best_attempt = r
                    if verdict.get("accepted") and round_accepted is None:
                        round_accepted = r
                round_best = results[0] if results else None
                if round_best:
                    round_best_roi = round_best.get("roi")
                    try:
                        round_best_roi_num = float(round_best_roi)
                    except Exception:
                        round_best_roi_num = None
                    if best_roi is None or (round_best_roi_num is not None and round_best_roi_num > best_roi):
                        best_roi = round_best_roi_num
                if round_accepted:
                    accepted = round_accepted
                    candidates = [{
                        "strategy": r.get("strategy"),
                        "roi": r.get("roi"),
                        "benchmark_delta": r.get("benchmark_delta"),
                        "inactive": bool(r.get("inactive") or _agent_strategy_trade_count(r) <= 0),
                        "valid_candidate": bool(r.get("valid_candidate", _agent_strategy_trade_count(r) > 0)),
                        "accepted": bool(r.get("strategy") == round_accepted.get("strategy")),
                        "rejected": not bool(r.get("strategy") == round_accepted.get("strategy")),
                        "rejection_reason": None if r.get("strategy") == round_accepted.get("strategy") else verdicts.get(r.get("strategy"), {}).get("reason"),
                        "trade_count": verdicts.get(r.get("strategy"), {}).get("trade_count"),
                        "statistics": r.get("statistics", {}),
                    } for r in results]
                    outcome = {
                        "status": "accepted",
                        "title": "Strategy found",
                        "message": f"Accepted {round_accepted.get('strategy')} with ROI {round_accepted.get('roi')}",
                        "best_attempt": round_best,
                        "accepted": round_accepted,
                    }
                    break

                no_improve_streak += 1
                round_best_verdict = _agent_strategy_verdict(round_best, comparison_benchmark, request.target_min_roi) if round_best else {}
                if results and not active_results:
                    generation_error = (
                        f"Round {round_number} produced only inactive strategies: every candidate took zero trades. "
                        "Loosen entry filters, remove rare condition stacks, and include at least one realistic entry path "
                        "that should fire on this dataset."
                    )
                else:
                    generation_error = (
                        f"Round {round_number} best attempt did not beat {comparison_benchmark.get('label') if comparison_benchmark else 'the benchmark'}"
                        if not round_best
                        else (
                        f"{round_best.get('strategy')} ROI {float(round_best.get('roi') or 0):.2f}% did not beat {comparison_benchmark.get('label') if comparison_benchmark else 'the benchmark'}. "
                        f"Rejection: {round_best_verdict.get('reason', 'underperformed benchmark')}. "
                        f"Best active attempt so far: {best_attempt.get('strategy') if best_attempt else 'none'} "
                        f"ROI {float((best_attempt or {}).get('roi') or 0):.2f}%."
                        )
                    )
                _append_agent_event(run_id, "generation_retry", f"Round {round_number} did not beat benchmark", error=generation_error)
                _update_agent_run(
                    run_id,
                    last_generation_error=generation_error,
                    last_generation_round=round_number,
                )
                candidates = [{
                    "strategy": r.get("strategy"),
                    "roi": r.get("roi"),
                    "benchmark_delta": r.get("benchmark_delta"),
                    "inactive": bool(r.get("inactive") or _agent_strategy_trade_count(r) <= 0),
                    "valid_candidate": bool(r.get("valid_candidate", _agent_strategy_trade_count(r) > 0)),
                    "accepted": False,
                    "rejected": True,
                    "rejection_reason": verdicts.get(r.get("strategy"), {}).get("reason"),
                    "trade_count": verdicts.get(r.get("strategy"), {}).get("trade_count"),
                    "statistics": r.get("statistics", {}),
                } for r in results]
                if no_improve_streak >= stop_after_no_improve:
                    break

            if not strategies and not accepted:
                _set_agent_plan_step(run_id, "strategy_generation", "failed", generation_error or "Strategy generation failed validation twice")
                raise RuntimeError(generation_error or "Strategy generation failed validation twice. Try a more specific prompt or a stronger model.")
            if accepted:
                _set_agent_plan_step(run_id, "strategy_generation", "completed", f"Generated and accepted strategy after {round_number} round(s)", strategies=[accepted.get("strategy")])
            elif candidates:
                _set_agent_plan_step(run_id, "strategy_generation", "completed", f"Generated {len(candidates)} candidate(s) across {round_number} round(s)", strategies=[c["strategy"] for c in candidates if c.get("strategy")])
        else:
            _set_agent_plan_step(run_id, "strategy_generation", "skipped", f"Using {len(strategies)} supplied strategy candidate(s)", strategies=strategies)

        if _agent_stop_requested(run_id):
            _set_agent_plan_step(run_id, "strategy_generation", "stopped", "Stop requested")
            _update_agent_run(run_id, status="stopped", current_step="Stopped")
            return

        if not strategies and not accepted:
            _set_agent_plan_step(run_id, "strategy_generation", "failed", "No strategy candidates are available for backtest")
            raise RuntimeError("No strategy candidates are available. Ask me to generate a strategy first, or select an existing strategy to backtest.")
        if strategies and not candidates and not accepted:
            _set_agent_plan_step(run_id, "backtest", "running", f"Backtesting {len(strategies)} supplied strategy candidate(s)")
            stake_options = backtest_settings["stake_range"]
            trail_options = backtest_settings["trail_range"]
            combo_count = len(stake_options) * len(trail_options)
            _update_agent_run(run_id, progress=60, current_step=f"Backtesting {len(strategies)} supplied strategy candidate(s) across {combo_count} parameter combinations")
            await _flush_agent_updates()
            _append_agent_event(
                run_id,
                "backtest_optimization",
                f"Optimizing {len(strategies)} supplied strategy candidate(s) across {combo_count} parameter combinations",
                strategies=strategies,
                combinations=combo_count,
                stake_range=stake_options,
                trail_range=trail_options,
            )
            backtest_task_id = str(uuid.uuid4())
            results_store[backtest_task_id] = {"status": "running", "user_id": user_id, "partial_results": []}
            await run_agent_backtest_with_progress(
                task_id=backtest_task_id,
                strategy_names=strategies,
                sequential=backtest_settings["sequential"],
                max_workers=max(1, min(int(request.max_backtest_workers or 4), 8)),
                progress=60,
                label="Backtesting supplied strategies",
            )
            backtest_result = results_store.get(backtest_task_id, {})
            if backtest_result.get("status") != "completed":
                _set_agent_plan_step(run_id, "backtest", "failed", backtest_result.get("error") or "Backtest failed")
                raise RuntimeError(backtest_result.get("error") or "Backtest failed")
            _set_agent_plan_step(run_id, "backtest", "completed", f"Backtested {len(strategies)} supplied strategy candidate(s)", backtest_task_id=backtest_task_id)
            benchmark = backtest_result.get("benchmark")
            results = backtest_result.get("results") or []
            buy_hold = (benchmark or {}).get("buy_hold") or {}
            comparison_benchmark = comparison_benchmark or _agent_select_comparison_benchmark(benchmark, baseline_result)
            if benchmark is not None and comparison_benchmark:
                benchmark["comparison"] = comparison_benchmark
            for r in results:
                _agent_apply_comparison_delta(r, comparison_benchmark)
            verdicts = {}
            round_accepted = None
            for r in results:
                verdict = _agent_strategy_verdict(r, comparison_benchmark, request.target_min_roi)
                verdicts[r.get("strategy")] = verdict
                if _agent_better_attempt(r, best_attempt):
                    best_attempt = r
                if verdict.get("accepted") and round_accepted is None:
                    round_accepted = r
            candidates = [{
                "strategy": r.get("strategy"),
                "roi": r.get("roi"),
                "benchmark_delta": r.get("benchmark_delta"),
                "inactive": bool(r.get("inactive") or _agent_strategy_trade_count(r) <= 0),
                "valid_candidate": bool(r.get("valid_candidate", _agent_strategy_trade_count(r) > 0)),
                "accepted": bool(round_accepted and r.get("strategy") == round_accepted.get("strategy")),
                "rejected": not bool(verdicts.get(r.get("strategy"), {}).get("accepted")),
                "rejection_reason": verdicts.get(r.get("strategy"), {}).get("reason"),
                "trade_count": verdicts.get(r.get("strategy"), {}).get("trade_count"),
                "statistics": r.get("statistics", {}),
            } for r in results]
            if round_accepted:
                accepted = round_accepted
                outcome = {
                    "status": "accepted",
                    "title": "Strategy found",
                    "message": f"Accepted {round_accepted.get('strategy')} with ROI {round_accepted.get('roi')}",
                    "best_attempt": best_attempt,
                    "accepted": round_accepted,
                }
            else:
                outcome = {
                    "status": "rejected",
                    "title": "No worthwhile strategy found",
                    "message": "No deployable strategy found",
                    "best_attempt": best_attempt,
                    "accepted": None,
                }
        if not candidates and accepted:
            candidates = [{
                "strategy": accepted.get("strategy"),
                "roi": accepted.get("roi"),
                "benchmark_delta": accepted.get("benchmark_delta"),
                "inactive": False,
                "valid_candidate": True,
                "accepted": True,
                "rejected": False,
                "rejection_reason": None,
                "trade_count": _agent_strategy_trade_count(accepted),
                "statistics": accepted.get("statistics", {}),
            }]
        if accepted:
            accepted_msg = f"Accepted {accepted.get('strategy')} with ROI {accepted.get('roi')}"
            outcome = outcome or {
                "status": "accepted",
                "title": "Strategy found",
                "message": accepted_msg,
                "best_attempt": best_attempt,
                "accepted": accepted,
            }
        else:
            attempted_msg = "No deployable strategy found"
            if best_attempt:
                best_verdict = _agent_strategy_verdict(best_attempt, comparison_benchmark, request.target_min_roi)
                if _agent_strategy_trade_count(best_attempt) > 0:
                    attempted_msg = (
                        f"No deployable strategy found. Best active attempt was {best_attempt.get('strategy')} "
                        f"with ROI {float(best_attempt.get('roi') or 0):.2f}%, but it was rejected: {best_verdict.get('reason')}"
                    )
                else:
                    attempted_msg = (
                        "No deployable strategy found. No active strategy was generated; "
                        f"the best recorded candidate ({best_attempt.get('strategy')}) took zero trades and is invalid."
                    )
            outcome = outcome or {
                "status": "rejected",
                "title": "No worthwhile strategy found",
                "message": attempted_msg,
                "best_attempt": best_attempt,
                "accepted": None,
            }
            accepted_msg = attempted_msg
        _set_agent_plan_step(run_id, "evaluate", "completed", accepted_msg, accepted=accepted, outcome=outcome)

        _update_agent_run(
            run_id,
            status="completed",
            progress=100,
            current_step=outcome["title"],
            candidates=candidates,
            accepted_version=accepted,
            best_attempt=best_attempt,
            outcome=outcome,
            benchmark=backtest_result.get("benchmark") or ({"comparison": comparison_benchmark} if comparison_benchmark else None),
            backtest_task_id=backtest_task_id,
            summary=backtest_result.get("summary"),
        )
        _append_agent_event(run_id, "complete", outcome["message"], accepted=accepted, outcome=outcome)
    except Exception as e:
        logger.error(f"Agent run {run_id} failed: {e}", exc_info=True)
        _update_agent_run(run_id, status="failed", error=str(e), current_step=f"Failed: {e}")
        _append_agent_event(run_id, "error", str(e))


def _fallback_agent_intent(message: str) -> Dict[str, Any]:
    text = (message or "").lower()
    explain_terms = ("explain", "what does", "how does", "review", "walk me through", "strategy code")
    generate_terms = ("generate", "create", "build", "find a strategy", "make a strategy")
    improve_terms = ("improve", "optimize", "beat", "better than")
    backtest_terms = ("backtest", "test", "simulate")
    data_terms = ("download data", "fresh data", "sync data", "dataset freshness")
    screen_terms = ("undervalued", "undervalue", "under value", "fundamental screen", "screen stocks", "screen stock", "stock screen", "find stocks", "find stock", "cheap stocks", "cheap stock", "value stocks", "value stock")
    insider_terms = ("insider buy", "insider buys", "insider buying", "insider sell", "insider sells", "insider selling", "insider trade", "insider trades", "insider trading", "insider activity", "insider transactions")

    if any(term in text for term in explain_terms):
        return {"intent": "strategy_explain", "workflow": None, "should_start_agent": False, "confidence": 0.6}
    if any(term in text for term in insider_terms):
        return {"intent": "market_analysis", "workflow": None, "should_start_agent": False, "confidence": 0.72}
    if any(term in text for term in screen_terms) and any(term in text for term in ["stock", "stocks", "company", "companies", "fundamental", "fundamentals", "peg", "price/sales", "p/s", "margin"]):
        return {"intent": "fundamental_screen", "workflow": "fundamental_screener", "should_start_agent": True, "confidence": 0.62}
    if any(term in text for term in data_terms):
        return {"intent": "data_task", "workflow": "market_review", "should_start_agent": True, "confidence": 0.55}
    if any(term in text for term in improve_terms):
        return {"intent": "strategy_improve", "workflow": "strategy_race", "should_start_agent": True, "confidence": 0.55}
    if any(term in text for term in backtest_terms):
        return {"intent": "backtest", "workflow": "strategy_race", "should_start_agent": True, "confidence": 0.55}
    if any(term in text for term in generate_terms):
        return {"intent": "strategy_generate", "workflow": "strategy_create", "should_start_agent": True, "confidence": 0.55}
    return {"intent": "chat", "workflow": None, "should_start_agent": False, "confidence": 0.5}


@app.post("/api/agent/intent")
async def classify_agent_intent(request: AgentIntentRequest):
    message_lc = (request.message or "").lower()
    insider_terms = ("insider buy", "insider buys", "insider buying", "insider sell", "insider sells", "insider selling", "insider trade", "insider trades", "insider trading", "insider activity", "insider transactions")
    strategy_names = []
    for item in request.available_strategies or []:
        if isinstance(item, dict):
            name = item.get("name") or item.get("strategy") or item.get("class_name")
        else:
            name = str(item)
        if name:
            strategy_names.append(str(name))

    recent_history = [
        {"role": h.get("role"), "content": str(h.get("content", ""))[:500]}
        for h in (request.history or [])[-8:]
        if isinstance(h, dict) and h.get("content")
    ]
    system_prompt = """Classify the user's intent for a trading assistant. Return ONLY strict JSON.

Allowed intents:
- chat: normal conversation or clarification
- market_analysis: news, technicals, fundamentals, market/sector/industry questions
- fundamental_screen: screen many stocks for valuation/fundamental candidates
- strategy_explain: explain/review/show a saved strategy/code/result; read-only
- strategy_generate: create/find/generate a new strategy and backtest it
- strategy_improve: improve/optimize/beat a benchmark or previous strategy
- backtest: run an existing strategy on existing data
- data_task: download/sync/list/check market datasets

Rules:
- If the user says explain, what does, how does, review, show code, or asks about "Strategy Code: X", choose strategy_explain and should_start_agent=false.
- If the user asks for insider buys/sells/trades/activity/transactions, choose market_analysis and should_start_agent=false. The normal chat tool layer will call insider tools.
- Choose fundamental_screen when the user asks to find/screen undervalued/value/cheap stocks or asks for PEG, P/E, price/sales, revenue growth, margins, options, or news across a universe of stocks. Use workflow=fundamental_screener.
- Do not require a single ticker for fundamental_screen.
- Only choose strategy_generate/strategy_improve/backtest when the user asks to run work, test, generate, improve, optimize, or beat a benchmark.
- Do not start a generation/backtest workflow just because the message contains the word strategy.
- Use recent history to resolve references like "this", "last one", or "accepted strategy".
- If pending_agent_request is present, decide whether the new message is actually a clarification/answer for that pending request.
- A short ticker, timeframe, "defaults", or "custom" can continue a pending request.
- A full new question/request, especially market/news/heatmap/overview analysis, should set continues_pending=false and classify the new request on its own.
- Set needs_clarification=true only when required execution details are genuinely missing. Do not ask for timeframe when the user already gave one as 1m, 5m, 15m, 30m, 1h, daily, weekly, or as premarket/postmarket/extended-hours intraday logic.
- A request like "Generate a QQQ strategy using 5m extended-hours data: if premarket is up 2% on high volume, enter after open and exit before close" is a complete strategy_generate request: workflow=strategy_create, should_start_agent=true, ticker=QQQ, needs_clarification=false.

JSON shape:
{"intent":"...", "workflow":null|"strategy_create"|"strategy_race"|"market_review"|"fundamental_screener", "should_start_agent":true|false, "ticker":null|string, "strategy_name":null|string, "needs_clarification":false, "continues_pending":false, "confidence":0.0, "reason":"short user-visible reason"}"""
    user_prompt = json.dumps({
        "message": request.message,
        "recent_history": recent_history,
        "conversation_state": request.context or {},
        "agent_instructions": _agent_instruction_block(getattr(request, "agent_instructions", None), max_chars=700),
        "available_strategies": strategy_names[:80],
        "available_files": (request.available_files or [])[:80],
    })

    try:
        raw = await call_llm(
            provider=request.provider,
            model=request.model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            api_key=request.api_key,
            provider_config=request.provider_config,
            json_mode=True,
            history=None,
            max_tokens=max(256, min(int(request.max_tokens or 1024), 2048)),
        )
        decision = parse_llm_json_object(raw)
    except Exception as exc:
        decision = _fallback_agent_intent(request.message)
        decision["fallback"] = True
        decision["error"] = str(exc)[:240]

    intent = str(decision.get("intent") or "chat")
    if any(term in message_lc for term in insider_terms):
        intent = "market_analysis"
        decision["should_start_agent"] = False
        decision["workflow"] = None
    if intent == "create_strategy":
        intent = "strategy_generate"
    if intent == "optimize":
        intent = "strategy_improve"
    decision["continues_pending"] = bool(decision.get("continues_pending"))
    if intent in {"strategy_explain", "market_analysis", "chat"}:
        decision["should_start_agent"] = False
        decision["workflow"] = None
    elif intent == "strategy_generate":
        decision["should_start_agent"] = True
        decision["workflow"] = decision.get("workflow") or "strategy_create"
    elif intent in {"strategy_improve", "backtest"}:
        decision["should_start_agent"] = True
        decision["workflow"] = decision.get("workflow") or "strategy_race"
    elif intent == "data_task":
        decision["should_start_agent"] = True
        decision["workflow"] = decision.get("workflow") or "market_review"
    elif intent == "fundamental_screen":
        decision["should_start_agent"] = True
        decision["workflow"] = "fundamental_screener"
    decision["intent"] = intent
    return _sanitize_nan(decision)


@app.post("/api/agent/runs")
async def start_agent_run(request: AgentRunRequest, background_tasks: BackgroundTasks):
    request = normalize_agent_run_request(request)
    run_id = f"AGENT_{uuid.uuid4().hex[:10].upper()}"
    run = {
        "run_id": run_id,
        "workflow": request.workflow,
        "status": "queued",
        "progress": 0,
        "current_step": "Queued",
        "events": [],
        "plan_steps": _agent_plan_for_request(request),
        "config": request.dict(),
        "created_at": datetime.now().isoformat(),
        "user_id": LOCAL_USER_ID,
        "stop_requested": False,
    }
    agent_runs[run_id] = run
    agent_runs_table.upsert(_safe_agent_run(run), Query().run_id == run_id)
    background_tasks.add_task(agent_run_task, run_id, request)
    return {"run_id": run_id, **_safe_agent_run(run)}


@app.get("/api/agent/runs")
async def list_agent_runs(limit: int = 12, include_terminal: bool = True):
    limit = max(1, min(int(limit or 12), 50))
    by_id = {}
    for run_id, run in agent_runs.items():
        safe = _safe_agent_run(run)
        if include_terminal or safe.get("status") not in AGENT_TERMINAL_STATUSES:
            by_id[run_id] = safe
    try:
        docs = agent_runs_table.all()
    except Exception:
        docs = []
    for doc in docs:
        run_id = doc.get("run_id")
        if not run_id or run_id in by_id:
            continue
        safe = _safe_agent_run(doc)
        if include_terminal or safe.get("status") not in AGENT_TERMINAL_STATUSES:
            by_id[run_id] = safe

    def sort_key(item):
        run = item[1] or {}
        return run.get("updated_at") or run.get("created_at") or ""

    runs = [run for _, run in sorted(by_id.items(), key=sort_key, reverse=True)]
    summaries = [_agent_run_monitor_summary(run) for run in runs[:limit]]
    return {"runs": summaries, "active": [run for run in summaries if run.get("status") not in AGENT_TERMINAL_STATUSES]}


@app.get("/api/agent/runs/{run_id}")
async def get_agent_run(run_id: str):
    if run_id in agent_runs:
        return _safe_agent_run(agent_runs[run_id])
    doc = agent_runs_table.get(Query().run_id == run_id)
    if doc:
        if doc.get("status") not in AGENT_TERMINAL_STATUSES:
            doc = _mark_persisted_agent_run_stale(doc)
        return _safe_agent_run(doc)
    raise HTTPException(status_code=404, detail="Agent run not found")


@app.post("/api/agent/runs/{run_id}/stop")
async def stop_agent_run(run_id: str):
    if run_id in agent_runs:
        if agent_runs[run_id].get("status") in AGENT_TERMINAL_STATUSES:
            return {"message": f"Run is already {agent_runs[run_id].get('status')}", **_safe_agent_run(agent_runs[run_id])}
        agent_runs[run_id]["stop_requested"] = True
        _update_agent_run(run_id, status="stopped", current_step="Stop requested")
        _append_agent_event(run_id, "stopped", "Stop requested")
        return {"message": "Stop requested", **_safe_agent_run(agent_runs[run_id])}
    doc = agent_runs_table.get(Query().run_id == run_id)
    if doc and doc.get("status") not in AGENT_TERMINAL_STATUSES:
        stopped = dict(doc)
        now_iso = datetime.now().isoformat()
        stopped.update({
            "status": "stopped",
            "current_step": "Stop requested",
            "updated_at": now_iso,
            "completed_at": stopped.get("completed_at") or now_iso,
        })
        stopped.setdefault("events", []).append({
            "ts": _utc_iso_now(),
            "type": "stopped",
            "message": "Stop requested for persisted run with no active worker.",
        })
        agent_runs_table.upsert(_safe_agent_run(stopped), Query().run_id == run_id)
        return {"message": "Stop requested", **_safe_agent_run(stopped)}
    raise HTTPException(status_code=404, detail="Agent run not found")


@app.delete("/api/agent/runs/{run_id}")
async def delete_agent_run(run_id: str):
    """Delete a single agent run by ID."""
    in_memory = agent_runs.pop(run_id, None)
    removed = False
    try:
        removed = bool(agent_runs_table.remove(Query().run_id == run_id))
    except Exception:
        pass
    if in_memory or removed:
        return {"message": f"Run {run_id} deleted"}
    raise HTTPException(status_code=404, detail="Agent run not found")


@app.delete("/api/agent/runs")
async def clear_terminal_agent_runs():
    """Delete all agent runs with terminal status."""
    terminal_statuses = {"completed", "failed", "stopped", "error"}
    count = 0
    for run_id in list(agent_runs.keys()):
        if agent_runs[run_id].get("status") in terminal_statuses:
            agent_runs.pop(run_id)
            count += 1
    try:
        docs = agent_runs_table.all()
    except Exception:
        docs = []
    for doc in docs:
        if doc.get("status") in terminal_statuses:
            try:
                agent_runs_table.remove(Query().run_id == doc["run_id"])
                count += 1
            except Exception:
                pass
    return {"message": f"Deleted {count} terminal agent run(s)"}


@app.post("/api/agent/runs/{run_id}/continue")
async def continue_agent_run(run_id: str, background_tasks: BackgroundTasks):
    run = agent_runs.get(run_id) or agent_runs_table.get(Query().run_id == run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Agent run not found")
    config = dict(run.get("config", {}) or {})
    if config.get("workflow") == "fundamental_screener":
        previous_checked = int(config.get("screen_max_checked") or 30)
        config["screen_max_checked"] = min(previous_checked + 30, 80)
        config["screen_max_results"] = max(int(config.get("screen_max_results") or 5), 5)
        config["prompt"] = f"{config.get('prompt') or 'Continue the fundamental screen.'}\nContinue screening a wider universe/check more names, keep the same requirements, and surface only supported candidates."
    if run.get("accepted_version") and not config.get("strategies"):
        strategy_name = run.get("accepted_version", {}).get("strategy")
        if strategy_name:
            config["strategies"] = []
            config["workflow"] = "strategy_race"
            config["benchmark_strategy"] = strategy_name
            config["benchmark_mode"] = "strategy"
            config["prompt"] = f"Continue improving and benchmarking {strategy_name}. Keep only versions that beat the previous accepted version."
    request = normalize_agent_run_request(AgentRunRequest(**config))
    next_run_id = f"AGENT_{uuid.uuid4().hex[:10].upper()}"
    next_run = {
        "run_id": next_run_id,
        "workflow": request.workflow,
        "status": "queued",
        "progress": 0,
        "current_step": f"Queued from {run_id}",
        "events": [{"ts": datetime.now().isoformat(), "type": "continued_from", "message": f"Continued from {run_id}", "run_id": run_id}],
        "plan_steps": _agent_plan_for_request(request),
        "config": request.dict(),
        "created_at": datetime.now().isoformat(),
        "user_id": LOCAL_USER_ID,
        "stop_requested": False,
        "continued_from": run_id,
    }
    agent_runs[next_run_id] = next_run
    agent_runs_table.upsert(_safe_agent_run(next_run), Query().run_id == next_run_id)
    background_tasks.add_task(agent_run_task, next_run_id, request)
    _append_agent_event(run_id, "continued", f"Started follow-up run {next_run_id}", next_run_id=next_run_id)
    return {"message": "Started follow-up run", "run_id": next_run_id, **_safe_agent_run(next_run)}

def _a2a_message_text(body: Dict[str, Any]) -> str:
    if isinstance(body.get("text"), str):
        return body["text"]
    if isinstance(body.get("input"), str):
        return body["input"]
    message = body.get("message")
    if isinstance(message, str):
        return message
    if isinstance(message, dict):
        parts = message.get("parts") or []
        texts = []
        for part in parts:
            if isinstance(part, dict):
                texts.append(str(part.get("text") or part.get("content") or ""))
            elif isinstance(part, str):
                texts.append(part)
        return "\n".join(t for t in texts if t).strip()
    messages = body.get("messages") or []
    if isinstance(messages, list) and messages:
        last = messages[-1]
        if isinstance(last, dict):
            return str(last.get("content") or last.get("text") or "")
        return str(last)
    return ""

def _a2a_task_payload(run_id: str) -> Dict[str, Any]:
    run = agent_runs.get(run_id) or agent_runs_table.get(Query().run_id == run_id) or {}
    return {
        "id": run_id,
        "agent_run_id": run_id,
        "status": run.get("status", "unknown"),
        "current_step": run.get("current_step"),
        "progress": run.get("progress", 0),
        "created_at": run.get("created_at"),
        "updated_at": run.get("updated_at"),
        "result": run.get("summary") or run.get("accepted_version") or run.get("outcome"),
        "error": run.get("error"),
        "events": (run.get("events") or [])[-20:],
    }

@app.get("/.well-known/agent-card.json")
async def a2a_agent_card():
    return {
        "name": "TradingSpy Assistant",
        "description": "Market analysis, strategy generation, backtesting, optimization, and dataset-aware trading assistant.",
        "version": "0.1.0",
        "url": "/a2a",
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
            "longRunning": True,
        },
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["application/json", "text/plain"],
        "skills": [
            {
                "id": "assistant",
                "name": "Trading Assistant",
                "description": "Routes user requests to the same strategy and market agent runtime used by the web UI.",
            }
        ],
    }

@app.get("/a2a/agent-card.json")
async def a2a_agent_card_alias():
    return await a2a_agent_card()

@app.post("/a2a/tasks/send")
async def a2a_tasks_send(background_tasks: BackgroundTasks, body: Dict[str, Any] = Body(default_factory=dict)):
    text = _a2a_message_text(body)
    if not text:
        raise HTTPException(status_code=400, detail="A2A task requires a text message or input")

    intent = _fallback_agent_intent(text)
    workflow = body.get("workflow") or intent.get("workflow") or "market_review"
    ticker = (body.get("ticker") or _extract_ticker_from_text(text) or "").upper() or None
    request = normalize_agent_run_request(AgentRunRequest(
        workflow=workflow,
        prompt=text,
        ticker=ticker,
        period=body.get("period") or "5y",
        interval=body.get("interval") or "1d",
        max_rounds=int(body.get("max_rounds") or 30),
        candidate_count=int(body.get("candidate_count") or 3),
        benchmark_buy_hold=bool(body.get("benchmark_buy_hold", True)),
        benchmark_strategy=body.get("benchmark_strategy"),
        benchmark_mode=body.get("benchmark_mode") or "auto",
        start_date=body.get("start_date"),
        end_date=body.get("end_date"),
        initial_cash=float(body.get("initial_cash") or 100000.0),
        commission=float(body.get("commission") or 0.001),
        agent_instructions=body.get("agent_instructions"),
        provider=body.get("provider"),
        model=body.get("model"),
        api_key=body.get("api_key"),
        provider_config=body.get("provider_config"),
    ))
    run_id = f"AGENT_{uuid.uuid4().hex[:10].upper()}"
    run = {
        "run_id": run_id,
        "workflow": request.workflow,
        "status": "queued",
        "progress": 0,
        "current_step": "Queued from A2A",
        "events": [{"ts": _utc_iso_now(), "type": "queued", "message": "Queued from A2A Remote Agent output"}],
        "config": request.dict(),
        "created_at": datetime.now().isoformat(),
        "user_id": LOCAL_USER_ID,
        "stop_requested": False,
        "source": "a2a",
    }
    agent_runs[run_id] = run
    agent_runs_table.upsert(_safe_agent_run(run), Query().run_id == run_id)
    background_tasks.add_task(agent_run_task, run_id, request)
    return {"task": _a2a_task_payload(run_id)}

@app.get("/a2a/tasks/{task_id}")
async def a2a_get_task(task_id: str):
    if task_id not in agent_runs and not agent_runs_table.get(Query().run_id == task_id):
        raise HTTPException(status_code=404, detail="A2A task not found")
    return {"task": _a2a_task_payload(task_id)}

@app.post("/a2a/tasks/{task_id}/cancel")
async def a2a_cancel_task(task_id: str):
    stopped = await stop_agent_run(task_id)
    return {"task": _a2a_task_payload(task_id), "message": stopped.get("message", "Stop requested")}

@app.get("/api/backtest/history/{result_id}")
async def get_backtest_history_item(result_id: str):
    doc = results_table.get(Query().id == result_id)
    if doc: return doc
    raise HTTPException(status_code=404, detail="Result not found")

@app.delete("/api/backtest/history/{result_id}")
async def delete_backtest_history_item(result_id: str):
    results_table.remove(Query().id == result_id)
    return {"message": "Deleted"}

@app.get("/api/backtest/history")
async def get_backtest_history():
    user_id = LOCAL_USER_ID
    results = results_table.search(Query().user_id == user_id)
    
    # Legacy data check: add summary if missing
    enriched = []
    for r in results:
        if "summary" not in r:
            sorted_res = r.get("results", [])
            r["summary"] = {
                "total_strategies": len(sorted_res),
                "best_strategy": sorted_res[0].get('strategy', 'N/A') if sorted_res else 'N/A',
                "best_roi": sorted_res[0].get('roi', 0) if sorted_res else 0,
                "avg_roi": sum(item.get('roi', 0) for item in sorted_res) / len(sorted_res) if sorted_res else 0
            }
        enriched.append(r)
        
    # Return last 50 results
    return {"history": enriched[-50:][::-1]}

@app.get("/api/backtest/strategies")
async def list_strategies():
    user_id = LOCAL_USER_ID
    strats = [{"name": n, "is_custom": False, "category": STRATEGY_CATEGORIES.get(n, "General")} for n in STRATEGY_MAP.keys()]
    items = strategies_table.search(Query().user_id == user_id)
    for doc in items:
        strats.append({"name": doc["name"], "is_custom": True, "category": doc.get("category", "General"), "ticker": doc.get("ticker", "")})
    return {"strategies": strats}

@app.get("/api/backtest/strategies/{name}")
async def get_strategy(name: str):
    if name in STRATEGY_MAP:
        strat_class = STRATEGY_MAP[name]
        try:
            import inspect
            code = inspect.getsource(strat_class)
        except Exception:
            code = STRATEGY_BOILERPLATE + "\n# Built-in strategy source unavailable"
        return {"name": name, "is_custom": False, "code": code, "class_name": strat_class.__name__, "category": STRATEGY_CATEGORIES.get(name, "General")}
    doc = strategies_table.get((Query().name == name) & (Query().user_id == LOCAL_USER_ID))
    if doc:
        return {"name": doc["name"], "is_custom": True, "code": doc["code"], "class_name": doc["class_name"], "category": doc.get("category", "General")}
    raise HTTPException(status_code=404, detail="Strategy not found")


@app.delete("/api/backtest/strategies/{name}")
async def delete_strategy(name: str):
    if name in STRATEGY_MAP:
        raise HTTPException(status_code=400, detail="Cannot delete built-in strategy")
    doc = strategies_table.get((Query().name == name) & (Query().user_id == LOCAL_USER_ID))
    if not doc:
        raise HTTPException(status_code=404, detail="Strategy not found")
    strategies_table.remove(doc_ids=[doc.doc_id])
    return {"message": "Deleted"}


@app.post("/api/reset")
async def reset_data(payload: dict = Body({}), background_tasks: BackgroundTasks = None):
    """Delete non-built-in data: strategies, files, watchlist, results."""
    user_id = LOCAL_USER_ID
    removed = {"strategies": 0, "files": 0, "watchlist": False, "results": 0}
    
    # 1. Delete custom strategies
    if payload.get("strategies", True):
        items = strategies_table.search(Query().user_id == user_id)
        for doc in items:
            if doc.get("name") not in STRATEGY_MAP:
                strategies_table.remove(doc_ids=[doc.doc_id])
                removed["strategies"] += 1
    
    # 2. Delete user-downloaded data files (not sample files in MARKET_DATA_DIR root)
    if payload.get("files", True):
        _, _, user_data_dir = get_user_dirs(user_id)
        if os.path.exists(user_data_dir):
            for f in os.listdir(user_data_dir):
                if f.endswith('.txt') or f.endswith('.csv'):
                    os.remove(os.path.join(user_data_dir, f))
                    removed["files"] += 1
        
        # Auto-download SPY and QQQ after clearing files so the asset library isn't empty
        if background_tasks:
            def seed_default_assets():
                download_ticker_data("SPY", interval="1d", period="max", output_dir=user_data_dir)
                download_ticker_data("QQQ", interval="1d", period="max", output_dir=user_data_dir)
            background_tasks.add_task(seed_default_assets)
    
    # 3. Clear watchlist
    if payload.get("watchlist", True):
        items = watchlist_table.search(Query().user_id == user_id)
        if items:
            watchlist_table.update({"tickers": [], "categories": []}, Query().user_id == user_id)
        else:
            watchlist_table.upsert({"user_id": user_id, "tickers": [], "categories": []}, Query().user_id == user_id)
        removed["watchlist"] = True
    
    # 4. Delete backtest results
    if payload.get("results", True):
        results_docs = results_table.search(Query().user_id == user_id)
        for doc in results_docs:
            results_table.remove(doc_ids=[doc.doc_id])
            removed["results"] += 1
    
    return {"message": "Reset complete", "removed": removed}


@app.post("/api/backtest/strategies/custom")
async def save_strategy(request: SaveStrategyRequest):
    strategies_table.upsert(
        {**request.dict(), "user_id": LOCAL_USER_ID, "updated_at": datetime.now().isoformat()},
        (Query().name == request.name) & (Query().user_id == LOCAL_USER_ID)
    )
    return {"message": "Saved"}

@app.post("/api/backtest/strategies/validate")
async def validate_strategy(request: ValidateStrategyRequest):
    valid, _cleaned_code, message, details = validate_strategy_code_payload(request.code, request.class_name)
    if not valid:
        return {"valid": False, "error": message, "details": details}
    return {"valid": True, "details": message}

# --- Optimization Routes ---

# --- AI Forge (Strategy Generation) ---

@app.post("/api/optimizer/ai/improve")
async def start_improvement(request: ImprovementRequest, background_tasks: BackgroundTasks):
    session_id = f"IMPROVE_{uuid.uuid4().hex[:8].upper()}"
    improvement_sessions[session_id] = {
        "session_id": session_id,
        "status": "running",
        "progress": 0,
        "current": "Initializing agent...",
        "iterations": [],
        "logs": ["Session initialized."],
        "config": request.dict(),
        # Top-level fields for frontend
        "strategy_name": request.strategy_name,
        "dataset": request.dataset_filename,
        "iteration_count": 0,
        "best_roi": None,
        "baseline_roi": None,
        "best_code": None,
        "reasoning": "",
        "proposal": "",
        "created_at": datetime.now().isoformat(),
        "user_id": LOCAL_USER_ID,
        # Internal control fields (stripped before JSON serialization)
        "stop_requested": False,
        "last_rejection_feedback": "",
        "event": asyncio.Event(),
    }
    background_tasks.add_task(improvement_loop_task, session_id, request)
    return {"session_id": session_id}


@app.post("/api/optimizer/ai/improve-auto")
async def start_improvement_auto(request: ImprovementRequest, background_tasks: BackgroundTasks):
    """
    Fully autonomous optimization - no UI interaction needed.
    Runs complete optimization loop automatically.
    """
    # Force auto_mode to True for autonomous operation
    request.auto_mode = True
    
    session_id = f"IMPROVE_{uuid.uuid4().hex[:8].upper()}"
    improvement_sessions[session_id] = {
        "session_id": session_id,
        "status": "running",
        "progress": 0,
        "current": "Initializing autonomous optimization...",
        "iterations": [],
        "logs": ["Autonomous optimization started."],
        "config": request.dict(),
        # Top-level fields for frontend
        "strategy_name": request.strategy_name,
        "dataset": request.dataset_filename,
        "iteration_count": 0,
        "best_roi": None,
        "baseline_roi": None,
        "best_code": None,
        "reasoning": "",
        "proposal": "",
        "created_at": datetime.now().isoformat(),
        "user_id": LOCAL_USER_ID,
        # Internal control fields (stripped before JSON serialization)
        "stop_requested": False,
        "last_rejection_feedback": "",
        "event": asyncio.Event(),
    }
    background_tasks.add_task(improvement_loop_task, session_id, request)
    return {"session_id": session_id, "message": "Autonomous optimization started. Check status with GET /api/optimizer/ai/improve/{session_id}"}


def _safe_session(data: dict) -> dict:
    """Return session dict safe for JSON serialization (no asyncio.Event)."""
    return {k: v for k, v in data.items() if k not in ("event", "stop_requested", "last_rejection_feedback")}


async def improvement_loop_task(session_id: str, request: ImprovementRequest):
    session = improvement_sessions[session_id]
    loop = asyncio.get_event_loop()
    
    async def broadcast_update(update_data: dict):
        """Helper to broadcast session updates via WebSocket"""
        await manager.broadcast(session_id, {
            "type": "progress",
            "session_id": session_id,
            **update_data
        })
    
    async def update_and_broadcast(update_dict: dict):
        """Update session and broadcast to all connected clients"""
        session.update(update_dict)
        await broadcast_update(update_dict)
    
    try:
        logger.info(f"Starting improvement loop for session {session_id}")
        
        # Fetch base strategy - check custom strategies first, then built-ins
        strat_doc = strategies_table.get((Query().name == request.strategy_name) & (Query().user_id == LOCAL_USER_ID))
        
        if not strat_doc:
            # Check if it's a built-in strategy
            if request.strategy_name in STRATEGY_MAP:
                logger.warning(f"Session {session_id}: Attempted to optimize built-in strategy {request.strategy_name}")
                session.update({
                    "status": "failed", 
                    "current": "Cannot optimize built-in strategies. Please save as custom strategy first.", 
                    "error": "Built-in strategies cannot be optimized directly. Save as custom strategy first."
                })
                await persist_session(session_id)
                return
            else:
                logger.error(f"Session {session_id}: Strategy {request.strategy_name} not found")
                session.update({"status": "failed", "current": "Strategy not found.", "error": "Strategy not found"})
                await persist_session(session_id)
                return

        logger.info(f"Session {session_id}: Found strategy {request.strategy_name}, starting baseline backtest")

        current_code = strat_doc["code"]
        class_name = strat_doc["class_name"]
        best_roi = None
        no_improve_streak = 0
        iteration = 0

        # ── Baseline backtest ──────────────────────────────────────────────────
        await update_and_broadcast({"current": "Running baseline backtest..."})
        _, _, user_data_dir = get_user_dirs(LOCAL_USER_ID)
        local_path = resolve_safe_child_path(user_data_dir, request.dataset_filename)
        if not os.path.exists(local_path):
            local_path = resolve_safe_child_path(MARKET_DATA_DIR, request.dataset_filename)

        temp_base = os.path.join(TEMP_DATA_DIR, f"opt_{uuid.uuid4().hex}.py")
        try:
            with open(temp_base, "w") as f:
                f.write(current_code)
            b_val, _, _, _ = await loop.run_in_executor(
                None, find_best_parallel, {"file": temp_base, "class": class_name},
                local_path, request.stake_range, request.trail_range, request.start_date, request.end_date
            )
            baseline_roi = ((b_val - 100000.0) / 100000.0) * 100
            await update_and_broadcast({"baseline_roi": baseline_roi, "best_roi": baseline_roi, "best_code": current_code})
            session["logs"].append(f"Baseline ROI: {baseline_roi:.2f}%")
            best_roi = baseline_roi
        except Exception as e:
            session["logs"].append(f"Baseline backtest failed: {e}. Continuing from zero.")
            baseline_roi = 0.0
        finally:
            if os.path.exists(temp_base):
                os.remove(temp_base)

        # ── Main optimization loop ─────────────────────────────────────────────
        MAX_AUTO_ITERS = 100
        MAX_NO_IMPROVE = 5

        # Outer loop for continuous mode
        while True:
            iteration = 0
            no_improve_streak = 0
            
            # Inner optimization loop
            while True:
                # ── Stop check ────────────────────────────────────────────────────
                if session.get("stop_requested"):
                    await update_and_broadcast({"status": "stopped", "current": "⏹ Stopped by user."})
                    await persist_session(session_id)
                    return  # Exit completely

                iteration += 1
                await update_and_broadcast({
                    "iteration_count": iteration,
                    "current": f"Round {iteration}: AI drafting improvements...",
                    "progress": min(99, iteration * 5) if request.auto_mode else int((iteration / request.iterations) * 99),
                })

                # ── AI generation ─────────────────────────────────────────────────
                dynamic_feedback = session.get("last_rejection_feedback") or request.user_prompt or "Enhance performance, reduce drawdown"
                session["last_rejection_feedback"] = ""  # consume after use

                market_ctx = ""
                try:
                    market_ctx = get_price_action_summary(request.dataset_filename, bar_limit=50)
                except Exception:
                    pass

                system_prompt = (
                    "You are an expert Quantitative Developer improving a Backtrader strategy. "
                    "Return a strict JSON object with exactly two keys: "
                    "\"code\" (the full improved Python class as a string) and "
                    "\"reasoning\" (a brief explanation of changes made)."
                )
                user_prompt = (
                    f"Feedback / Goal: {dynamic_feedback}\n\n"
                    f"Market Context:\n{market_ctx}\n\n"
                    f"Current Strategy Code:\n{current_code}"
                )

                try:
                    llm_res = await call_llm(
                        provider=request.provider,
                        model=request.model,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        api_key=request.api_key,
                        provider_config=request.provider_config,
                        json_mode=True,
                    )
                    res = json.loads(llm_res)
                    new_code = res.get("code", current_code)
                    reasoning = res.get("reasoning", "")
                except Exception as e:
                    session["logs"].append(f"Round {iteration} AI failed: {e}")
                    reasoning = f"AI error: {e}"
                    new_code = current_code

                # ── Human approval gate (supervised mode) ─────────────────────────
                if not request.auto_mode:
                    await update_and_broadcast({
                        "status": "waiting_for_approval",
                        "proposal": new_code,
                        "reasoning": reasoning,
                        "current": f"Round {iteration}: Awaiting your review...",
                    })
                    session["event"].clear()
                    await session["event"].wait()

                    # After event is set, check if user stopped or if proposal was replaced by edit
                    if session.get("stop_requested"):
                        await update_and_broadcast({"status": "stopped", "current": "⏹ Stopped by user."})
                        await persist_session(session_id)
                        return  # Exit completely

                    # Use possibly-edited proposal code
                    new_code = session.get("proposal", new_code)
                    await update_and_broadcast({"status": "running", "reasoning": reasoning})

                # ── Backtest the new code ─────────────────────────────────────────
                await update_and_broadcast({"current": f"Round {iteration}: Running backtest..."})
                temp_file = os.path.join(TEMP_DATA_DIR, f"opt_{uuid.uuid4().hex}.py")
                try:
                    with open(temp_file, "w") as f:
                        f.write(new_code)

                    val, cfg, markers, stats = await loop.run_in_executor(
                        None, find_best_parallel,
                        {"file": temp_file, "class": class_name},
                        local_path, request.stake_range, request.trail_range, request.start_date, request.end_date
                    )
                    roi = ((val - 100000.0) / 100000.0) * 100
                except Exception as e:
                    session["logs"].append(f"Round {iteration} backtest error: {e}")
                    roi = -999.0
                    cfg = {}
                    stats = {}
                    markers = []
                finally:
                    if os.path.exists(temp_file):
                        os.remove(temp_file)

                # ── Track improvement ─────────────────────────────────────────────
                is_improvement = best_roi is None or roi > best_roi
                if is_improvement:
                    best_roi = roi
                    no_improve_streak = 0
                    current_code = new_code  # Only update baseline if improved
                    await update_and_broadcast({"best_roi": roi, "best_code": current_code})
                    # Auto-save best strategy
                    try:
                        improved_name = f"{request.strategy_name} [Optimized v{iteration}]"
                        strategies_table.upsert(
                            {
                                "name": improved_name,
                                "code": current_code,
                                "class_name": class_name,
                                "user_id": LOCAL_USER_ID,
                                "updated_at": datetime.now().isoformat(),
                                "description": f"Auto-optimized from {request.strategy_name}, ROI: {roi:.2f}%",
                            },
                            (Query().name == improved_name) & (Query().user_id == LOCAL_USER_ID),
                        )
                        session["logs"].append(f"✅ Round {iteration} IMPROVED → ROI: {roi:.2f}% (saved as '{improved_name}')")
                    except Exception as e:
                        session["logs"].append(f"Round {iteration} save failed: {e}")
                else:
                    no_improve_streak += 1
                    session["logs"].append(f"Round {iteration} ROI: {roi:.2f}% (no improvement, streak: {no_improve_streak})")

                session["iterations"].append({
                    "iteration": iteration,
                    "roi": roi,
                    "reasoning": reasoning,
                    "is_improvement": is_improvement,
                    "stats": stats if isinstance(stats, dict) else {},
                    "config": cfg if isinstance(cfg, dict) else {},
                })

                # ── Exit conditions ───────────────────────────────────────────────
                if request.auto_mode:
                    if no_improve_streak >= MAX_NO_IMPROVE:
                        await update_and_broadcast({"status": "completed", "current": f"✅ Auto-stopped: no improvement in {MAX_NO_IMPROVE} rounds.", "progress": 100})
                        break  # Exit inner loop
                    if iteration >= MAX_AUTO_ITERS:
                        await update_and_broadcast({"status": "completed", "current": "✅ Reached max iterations (100).", "progress": 100})
                        break  # Exit inner loop
                    # Brief cooldown so we don't hammer the AI rate limits
                    await asyncio.sleep(5)
                else:
                    if iteration >= request.iterations:
                        await update_and_broadcast({"status": "completed", "current": "✅ Optimization complete.", "progress": 100})
                        break  # Exit inner loop

            # ── Continuous mode: restart after completion ─────────────────────────
            if request.continuous_mode and not session.get("stop_requested"):
                session["logs"].append(f"🔄 Continuous mode enabled. Restarting in {request.cooldown_minutes} minutes...")
                await update_and_broadcast({"status": "cooldown", "current": f"⏸ Cooldown: {request.cooldown_minutes}min before next run"})
                await persist_session(session_id)
                
                # Wait during cooldown, checking for stop signal periodically
                cooldown_seconds = request.cooldown_minutes * 60
                check_interval = 10  # Check every 10 seconds
                elapsed = 0
                while elapsed < cooldown_seconds:
                    if session.get("stop_requested"):
                        await update_and_broadcast({"status": "stopped", "current": "⏹ Stopped during cooldown."})
                        await persist_session(session_id)
                        return
                    await asyncio.sleep(min(check_interval, cooldown_seconds - elapsed))
                    elapsed += check_interval
                
                # Reset for next run
                session["logs"].append("🔄 Restarting optimization cycle...")
                await update_and_broadcast({"status": "running", "current": "Restarting optimization...", "iteration_count": 0})
                session["iterations"] = []  # Clear previous iterations or keep them?
                # Continue outer loop
            else:
                # Not continuous mode or stopped, exit completely
                break

        await persist_session(session_id)

    except Exception as e:
        logger.error(f"Improvement loop error: {e}", exc_info=True)
        await update_and_broadcast({"status": "failed", "current": f"Error: {e}", "error": str(e)})


async def persist_session(session_id: str):
    data = _safe_session(improvement_sessions.get(session_id, {}))
    sessions_table.upsert({**data, "session_id": session_id}, Query().session_id == session_id)


@app.get("/api/optimizer/ai/improve/sessions")
async def list_improvement_sessions():
    user_id = LOCAL_USER_ID
    active = [_safe_session(data) for data in improvement_sessions.values()]
    db_items = sessions_table.search(Query().user_id == user_id)

    seen = {s["session_id"] for s in active}
    combined = list(active)
    for s in db_items:
        if s.get("session_id") not in seen:
            combined.append(s)

    return {"sessions": combined[::-1]}


@app.delete("/api/optimizer/ai/improve/{session_id}")
async def delete_improvement_session(session_id: str):
    if session_id in improvement_sessions:
        improvement_sessions[session_id]["stop_requested"] = True  # signal the loop to stop
        del improvement_sessions[session_id]
    sessions_table.remove(Query().session_id == session_id)
    return {"message": "Deleted"}


@app.delete("/api/optimizer/ai/improve/cleanup/unused")
async def cleanup_sessions():
    sessions_table.remove((Query().status == "completed") | (Query().status == "stopped") | (Query().status.test(lambda x: str(x).startswith("failed"))))
    # Also clean memory
    to_remove = [sid for sid, s in improvement_sessions.items() if s.get("status") in ("completed", "stopped", "failed")]
    for sid in to_remove:
        del improvement_sessions[sid]
    return {"deleted_count": len(to_remove)}


@app.get("/api/optimizer/ai/improve/{session_id}")
async def get_improvement_status(session_id: str):
    if session_id in improvement_sessions:
        return _safe_session(improvement_sessions[session_id])
    doc = sessions_table.get(Query().session_id == session_id)
    if doc:
        return doc
    raise HTTPException(status_code=404, detail="Session not found")


@app.post("/api/optimizer/ai/improve/{session_id}/stop")
async def stop_improvement_session(session_id: str):
    if session_id in improvement_sessions:
        session = improvement_sessions[session_id]
        session["stop_requested"] = True
        session["current"] = "⏹ Stop requested..."
        # If waiting for approval, unblock the event so the loop can check the stop flag
        if "event" in session:
            session["event"].set()
        return {"message": "Stop signal sent"}
    raise HTTPException(status_code=404, detail="Session not found")


@app.post("/api/optimizer/ai/improve/{session_id}/approve")
async def approve_session(session_id: str):
    if session_id in improvement_sessions:
        session = improvement_sessions[session_id]
        session["logs"].append(f"✅ Proposal approved by user.")
        if "event" in session:
            session["event"].set()
            return {"message": "Approved"}
    raise HTTPException(status_code=404, detail="Session not found or already finished")


@app.post("/api/optimizer/ai/improve/{session_id}/reject")
async def reject_session(session_id: str, feedback: Optional[Dict] = None):
    if session_id in improvement_sessions:
        session = improvement_sessions[session_id]
        fb_text = (feedback or {}).get("feedback", "No specific feedback provided.")
        session["last_rejection_feedback"] = fb_text
        session["logs"].append(f"❌ Rejected: {fb_text}")
        # Reset proposal so the loop generates a fresh one next iteration
        session["proposal"] = ""
        if "event" in session:
            session["event"].set()
            return {"message": "Rejected, AI will incorporate feedback in next round"}
    raise HTTPException(status_code=404, detail="Session not found")


@app.post("/api/optimizer/ai/improve/{session_id}/edit-code")
async def edit_session_proposal(session_id: str, body: Dict):
    """Allow user to manually edit the proposed code before approving."""
    if session_id not in improvement_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = improvement_sessions[session_id]
    new_code = body.get("code", "")
    reason = body.get("reason", "Manual edit")
    if not new_code.strip():
        raise HTTPException(status_code=400, detail="Code cannot be empty")
    session["proposal"] = new_code
    session["logs"].append(f"✏️ Proposal manually edited: {reason}")
    return {"message": "Proposal updated"}


@app.post("/api/optimizer/ai/improve/{session_id}/ai-refine")
async def ai_refine_proposal(session_id: str, body: Dict):
    """Ask AI to refine the current proposal based on user feedback without advancing the iteration."""
    if session_id not in improvement_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = improvement_sessions[session_id]
    feedback = body.get("feedback", "")
    current_proposal = session.get("proposal", "")
    if not current_proposal:
        raise HTTPException(status_code=400, detail="No proposal to refine")

    try:
        llm_res = await call_llm(
            provider=session["config"].get("provider"),
            model=session["config"].get("model"),
            system_prompt="You are an expert Quant Dev. Refine the given strategy code based on user feedback. Return JSON with 'code' and 'reasoning'.",
            user_prompt=f"Feedback: {feedback}\n\nCurrent Code:\n{current_proposal}",
            api_key=session["config"].get("api_key"),
            provider_config=session["config"].get("provider_config"),
            json_mode=True,
        )
        res = json.loads(llm_res)
        refined_code = res.get("code", current_proposal)
        reasoning = res.get("reasoning", "")
        session["proposal"] = refined_code
        session["reasoning"] = f"[AI Refined] {reasoning}"
        session["logs"].append(f"🤖 AI refined proposal based on: {feedback}")
        return {"message": "Proposal refined", "reasoning": reasoning}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI refinement failed: {e}")

# --- AI Forge (Strategy Generation) ---

@app.post("/api/backtest/ai/generate")
async def generate_strategy(request: AIStrategyRequest, background_tasks: BackgroundTasks):
    task_id = str(uuid.uuid4())
    init_task_state(task_id, {
        "status": "running",
        "progress": 10,
        "current": "Consulting AI Experts...",
        "user_id": LOCAL_USER_ID,
        "stream_preview": "",
    })
    emit_task_event(
        task_id,
        "progress",
        progress=10,
        current="Consulting AI Experts...",
        label="Preparing generation",
        detail=request.prompt[:160],
    )
    background_tasks.add_task(ai_generation_task, task_id, request)
    return {"task_id": task_id}


@app.get("/api/backtest/ai/generate/stream/{task_id}")
async def stream_generate_strategy(task_id: str):
    async def event_stream():
        last_seq = 0
        idle_cycles = 0

        while True:
            task = results_store.get(task_id)
            if not task:
                yield f"data: {json.dumps({'type': 'error', 'error': 'Task not found'})}\n\n"
                return

            events = task.get("events", [])
            new_events = [event for event in events if event.get("seq", 0) > last_seq]

            if new_events:
                idle_cycles = 0
                for event in new_events:
                    last_seq = event.get("seq", last_seq)
                    yield f"data: {json.dumps(event)}\n\n"
            else:
                idle_cycles += 1
                if idle_cycles % 10 == 0:
                    heartbeat = {
                        "type": "heartbeat",
                        "status": task.get("status"),
                        "progress": task.get("progress", 0),
                        "current": task.get("current", ""),
                    }
                    yield f"data: {json.dumps(heartbeat)}\n\n"

            if task.get("status") in {"completed", "failed"} and not new_events:
                return

            await asyncio.sleep(0.25)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    })

async def ai_generation_task(task_id: str, request: AIStrategyRequest):
    try:
        model = request.model
        agent_run_id = request.agent_run_id
        generation_round = request.generation_round

        def mirror_agent_event(event_type: str, message: str, progress: Optional[int] = None, **payload):
            if not agent_run_id:
                return
            if generation_round is not None:
                payload.setdefault("round", generation_round)
            _append_agent_event(agent_run_id, event_type, message, **payload)
            update_fields = {"current_step": message}
            if progress is not None:
                update_fields["progress"] = min(58, 35 + int(max(0, min(progress, 100)) * 0.23))
            _update_agent_run(agent_run_id, **update_fields)

        async def call_llm_with_agent_heartbeat(
            *,
            phase: str,
            heartbeat_detail: str,
            progress: int,
            **kwargs,
        ):
            started_at = time.monotonic()
            task = asyncio.create_task(call_llm(**kwargs))
            heartbeat_index = 0
            while not task.done():
                await asyncio.sleep(8)
                if task.done():
                    break
                heartbeat_index += 1
                elapsed = int(time.monotonic() - started_at)
                mirror_agent_event(
                    "llm_waiting",
                    f"Round {generation_round or '?'}: {phase} ({elapsed}s)",
                    progress=progress,
                    detail=heartbeat_detail,
                    elapsed_seconds=elapsed,
                    heartbeat=heartbeat_index,
                )
                emit_task_event(
                    task_id,
                    "progress",
                    progress=progress,
                    current=f"{phase} ({elapsed}s)",
                    label="Waiting for model",
                    detail=heartbeat_detail,
                )
            return await task

        mode_labels = {
            "pattern_fit": "Analysis Fit",
            "user_defined": "User Defined",
            "random_agnostic": "Random",
        }
        selected_mode = request.mode or "pattern_fit"
        market_analysis_report = "Agnostic Mode: No price action analysis performed."
        mode_instruction = {
            "pattern_fit": "Fit each strategy to the supplied market-analysis report and dataset characteristics.",
            "user_defined": "Follow the user's strategy objective closely. Do not invent unrelated strategy families.",
            "random_agnostic": "Create original, diverse strategy ideas. The user prompt is optional inspiration, not a constraint.",
        }.get(selected_mode, "Generate practical Backtrader strategies for the user's objective.")

        if request.mode == "pattern_fit" and request.dataset_filename:
            update_task_state(task_id, progress=30, current="Analyzing market patterns...")
            mirror_agent_event(
                "generation_analysis",
                f"Round {generation_round or '?'}: reading candle pattern context",
                progress=30,
                dataset_filename=request.dataset_filename,
            )
            emit_task_event(
                task_id,
                "progress",
                progress=30,
                current="Analyzing market patterns...",
                label="Analyzing dataset",
                detail=request.dataset_filename,
            )
            price_summary = get_price_action_summary(request.dataset_filename, request.learn_lookback)
            mirror_agent_event(
                "data_note",
                f"Round {generation_round or '?'}: candle profile loaded for model context",
                progress=34,
                detail="Recent bars, moving averages, RSI, range, volume, and possible triggers are being used as public strategy context.",
                preview=public_agent_preview(price_summary, 700),
            )

            analyst_prompt = f"Analyze specifically the provided bar sequence for candlestick patterns, SMA tests, and RSI momentum:\n{price_summary}"
            mirror_agent_event(
                "llm_call",
                f"Round {generation_round or '?'}: asking model to summarize candle regime",
                progress=40,
                model=model,
                provider=request.provider,
            )

            market_analysis_report = await call_llm_with_agent_heartbeat(
                phase="summarizing candle regime",
                heartbeat_detail="The model is reading recent candles and extracting public setup notes for strategy generation.",
                progress=42,
                provider=request.provider,
                model=model,
                system_prompt="You are a Technical Analyst.",
                user_prompt=analyst_prompt,
                api_key=request.api_key,
                provider_config=request.provider_config,
                json_mode=False,
                max_tokens=max(1024, min(int(request.max_tokens or 8192), 20000))
            )
            update_task_state(
                task_id,
                progress=50,
                current="Pattern analysis complete...",
                market_analysis=market_analysis_report
            )
            emit_task_event(
                task_id,
                "analysis",
                progress=50,
                current="Pattern analysis complete...",
                market_analysis=market_analysis_report,
            )
            mirror_agent_event(
                "generation_analysis",
                f"Round {generation_round or '?'}: candle regime summary ready",
                progress=50,
                detail="This public analysis is passed into the strategy-code prompt so the generator can react to the actual candle profile.",
                preview=public_agent_preview(market_analysis_report, 900),
            )

        system_prompt = f"""You are an expert quantitative developer. Generate {request.count} UNIQUE, DISTINCT Python Backtrader Strategy classes.
GENERATION MODE: {mode_labels.get(selected_mode, selected_mode)}
MODE INSTRUCTION: {mode_instruction}
MODE CONTEXT: {market_analysis_report}
Each strategy MUST strictly follow Backtrader conventions:
1. Inherit from 'bt.Strategy'.
2. Support a 'trailpercent' parameter in its 'params' (default 0.0), e.g. `params = (('trailpercent', 0.0), ('some_other_param', 14),)`
3. Use `def __init__(self, *args, **kwargs):` and call `super().__init__(*args, **kwargs)`.
4. Initialize ALL indicators exclusively in `__init__`, accessing data as `self.data.close` instead of `data[0]`.
5. Use logic like `if not self.position:` for entries and `if self.position:` for exits.
6. Avoid sizing hardcodes like `size=1` in `self.buy()` or `self.sell()`; let the default sizer handle trades to avoid 'Order Rejected' or 'Margin' errors on small equity curves.
7. Must have explicit `self.buy()` and `self.sell()` or `self.close()` logic.
8. Never create indicators inside `next()`; precompute every SMA/EMA/RSI/ATR/CrossOver in `__init__`.
9. Never assign to Backtrader line buffers such as `self.indicator[0] = ...` or `self.stop_line[0] = ...`; mutable trailing stops must use scalar attributes like `self.stop_price`.
10. In `next()`, read indicator values with `[0]`, e.g. `self.crossover[0] > 0`, `self.rsi[0] < 30`, `self.atr[0] > self.atr_ma[0]`.
11. Do not wrap the code value in markdown fences; the JSON `code` field must contain raw Python only.
12. Never use `self.position.baropen`; Backtrader Position does not expose it. If a strategy needs a time stop, initialize `self.entry_bar = None` in `__init__`, set `self.entry_bar = len(self)` immediately after `self.buy()`, and reset it after exit.
13. Never read data with absolute state indexes like `self.data.close[self.entry_bar]`; Backtrader line indexes are relative. If a strategy needs the entry price, initialize `self.entry_price = None` and set `self.entry_price = float(self.data.close[0])` when entering.
14. For trailing stops, use scalar state only: initialize `self.stop_price = None` or `self.highest_close = None`, update it with `float(self.data.close[0])`, and compare `self.data.close[0]` to that scalar. Do not write or read `self.stop_price[0]`.
15. For intraday, premarket, postmarket, or session-aware strategies, use `self.data.datetime.datetime(0)` in `next()` to inspect the current bar time. Track daily/session state with scalar attributes such as `self.current_date`, `self.premarket_open`, `self.premarket_high`, `self.premarket_last`, and `self.traded_today`. Reset those values when the date changes. Do not use wall-clock `datetime.now()` for backtest decisions.
16. If the user asks for rules like "premarket up X%, enter, then leave", calculate the premarket move from extended-hours bars before the regular open, optionally confirm with premarket volume using `self.data.volume[0]` or accumulated scalar volume, enter only during the intended regular-session time window, and close by the requested exit time or before the session ends. Guard the logic so it also works when the dataset does not contain extended-hours bars.
SAFE TIME-EXIT EXAMPLE:
```
self.entry_bar = None
self.entry_price = None
...
if not self.position and entry_condition:
    self.buy()
    self.entry_bar = len(self)
    self.entry_price = float(self.data.close[0])
elif self.position and self.entry_bar is not None and len(self) - self.entry_bar >= self.p.max_hold:
    self.close()
    self.entry_bar = None
    self.entry_price = None
```
Return a strict JSON object with a 'strategies' key containing an array of objects (+ name, class_name, code, description, analysis).
If you include markdown while drafting, still finish with parseable Python code blocks or valid JSON so the platform can save the strategies."""
        custom_agent_instructions = _agent_instruction_block(getattr(request, "agent_instructions", None))
        if custom_agent_instructions:
            system_prompt += f"""

USER AGENT INSTRUCTIONS:
{custom_agent_instructions}

Apply these as run-level preferences when they do not conflict with Backtrader validity, JSON output requirements, or benchmark/rejection rules."""

        emit_task_event(
            task_id,
            "progress",
            progress=55,
            current="Generating strategies...",
            label="Generating strategy code",
            detail=f"{request.count} candidate strategy{'ies' if request.count != 1 else ''}",
        )
        mirror_agent_event(
            "llm_call",
            f"Round {generation_round or '?'}: calling model for {request.count} candidate strategy code",
            progress=55,
            model=model,
            provider=request.provider,
            count=request.count,
            detail=f"Objective: {request.prompt[:280]}",
        )
        mirror_agent_event(
            "generation_plan",
            f"Round {generation_round or '?'}: asking for distinct candidate families",
            progress=56,
            detail=f"Mode: {mode_labels.get(selected_mode, selected_mode)}. Candidates should follow the candle regime, use Backtrader-safe scalar state, and include real entry/exit logic.",
        )

        stream_buffer = []
        last_emitted_chars = 0
        last_mirrored_chars = 0
        total_estimated_tokens = 2000  # rough estimate for progress scaling
        def on_gen_token(token: str):
            stream_buffer.append(token)
            full_text = "".join(stream_buffer)
            nonlocal last_emitted_chars, last_mirrored_chars
            chars_since_emit = len(full_text) - last_emitted_chars
            if chars_since_emit >= 120:
                preview = full_text[-1200:]
                estimated_tokens = max(1, len(full_text) // 4)
                token_progress = min(estimated_tokens / total_estimated_tokens, 1.0)
                scaled_progress = 50 + int(token_progress * 25)
                update_task_state(
                    task_id,
                    progress=scaled_progress,
                    current=f"Generating strategies... (~{estimated_tokens} tokens)",
                    stream_preview=preview
                )
                emit_task_event(
                    task_id,
                    "token",
                    progress=scaled_progress,
                    current=f"Generating strategies... (~{estimated_tokens} tokens)",
                    delta=full_text[last_emitted_chars:],
                    stream_preview=preview,
                )
                last_emitted_chars = len(full_text)
            if len(full_text) - last_mirrored_chars >= 2000:
                mirror_agent_event(
                    "llm_generation_progress",
                    f"Round {generation_round or '?'}: model is drafting strategy code (~{max(1, len(full_text) // 4)} tokens)",
                    progress=min(74, 55 + int((len(full_text) // 4) / 120)),
                    estimated_tokens=max(1, len(full_text) // 4),
                    detail="Draft preview is shown for transparency; validation still decides whether any candidate is usable.",
                    preview=public_agent_preview(full_text, 900),
                )
                last_mirrored_chars = len(full_text)

        llm_res = await call_llm_with_agent_heartbeat(
            phase=f"calling model for {request.count} candidate strategy code",
            heartbeat_detail="The provider has not returned tokens yet. The agent is still waiting for the candidate-code response.",
            progress=58,
            provider=request.provider,
            model=model,
            system_prompt=system_prompt,
            user_prompt=f"User Request: {request.prompt}",
            api_key=request.api_key,
            provider_config=request.provider_config,
            json_mode=False,
            max_tokens=max(1024, min(int(request.max_tokens or 8192), 20000)),
            on_token=on_gen_token
        )
        final_preview = llm_res[-1200:] if llm_res else ""
        if len(llm_res) > last_emitted_chars:
            emit_task_event(
                task_id,
                "token",
                progress=78,
                current="Generation draft complete",
                delta=llm_res[last_emitted_chars:],
                stream_preview=final_preview,
            )
        mirror_agent_event(
            "llm_generation_complete",
            f"Round {generation_round or '?'}: model draft complete; validating code",
            progress=78,
            detail="The draft will now be parsed, linted, repaired where safe, and rejected if it cannot run.",
            preview=public_agent_preview(llm_res, 900),
        )
        update_task_state(task_id, progress=80, current="Validating and saving strategies...", stream_preview="")
        emit_task_event(
            task_id,
            "progress",
            progress=80,
            current="Validating and saving strategies...",
            label="Validating output",
            detail="Checking generated code and saving valid strategies",
        )

        data = extract_strategy_output(
            llm_res,
            fallback_ticker=request.ticker or "",
            fallback_category=request.target_category or "General",
        )

        # Auto-save each generated strategy to strategies_table so Arsenal UI shows them
        saved_names = []
        # LLM returns strategies in one of three shapes:
        # 1. {"strategies": [...]}
        # 2. {"response": {"strategies": [...]}, ...}
        # 3. {"response": "text", "actions": [{"strategies": [...]}, ...], ...}
        strategies_list = (
            data.get("strategies")
            or (data.get("response", {}).get("strategies") if isinstance(data.get("response"), dict) else None)
            or next((a.get("strategies") for a in data.get("actions", []) if isinstance(a, dict) and a.get("strategies")), None)
            or []
        )
        total_strategies = len(strategies_list)
        mirror_agent_event(
            "validation_start",
            f"Round {generation_round or '?'}: validating {total_strategies} generated candidate(s)",
            progress=80,
            candidate_count=total_strategies,
        )
        validation_errors = []
        for idx, strat in enumerate(strategies_list):
            name = strat.get("name") or strat.get("class_name")
            code = strip_code_fence(strat.get("code", ""))
            if not name or not code:
                continue
            validation_progress = 80 + int((idx / max(total_strategies, 1)) * 15)
            mirror_agent_event(
                "validation_check",
                f"Round {generation_round or '?'}: checking candidate {idx + 1}/{total_strategies}: {name}",
                progress=validation_progress,
                strategy=name,
                preview=public_agent_preview(code, 700),
            )
            update_task_state(
                task_id,
                progress=validation_progress,
                current=f"Validating strategy {idx + 1}/{total_strategies}...",
            )
            emit_task_event(
                task_id,
                "progress",
                progress=validation_progress,
                current=f"Validating strategy {idx + 1}/{total_strategies}...",
                label="Validating strategy",
                detail=name,
            )

            # Extract the ACTUAL class name from the code (regex beats trusting the LLM)
            import re as _re
            class_match = _re.search(r'class\s+(\w+)\s*\(', code)
            class_name = class_match.group(1) if class_match else (strat.get("class_name") or name)

            # Validate the code compiles, follows safe Backtrader patterns, and the class exists before saving.
            valid, cleaned_code, validation_message, validation_details = validate_strategy_code_payload(code, class_name)
            if not valid:
                logger.warning(f"Generated strategy {name} failed validation: {validation_message} {validation_details}")
                validation_errors.append(f"{name}: {validation_details or validation_message}")
                mirror_agent_event(
                    "validation_error",
                    f"Round {generation_round or '?'}: rejected invalid candidate {name}",
                    progress=validation_progress,
                    error=validation_details or validation_message,
                )
                emit_task_event(
                    task_id,
                    "validation_error",
                    progress=validation_progress,
                    current=f"Skipped invalid strategy: {name}",
                    detail=validation_details or validation_message,
                )
                continue
            code = cleaned_code

            ticker = request.ticker or strat.get("ticker") or ""
            strategies_table.upsert(
                {
                    "name": name,
                    "class_name": class_name,
                    "code": code,
                    "description": strat.get("description", ""),
                    "ticker": ticker,
                    "category": request.target_category or ticker or "General",
                    "user_id": LOCAL_USER_ID,
                    "updated_at": datetime.now().isoformat(),
                    "source": "ai_generated",
                },
                (Query().name == name) & (Query().user_id == LOCAL_USER_ID)
            )
            saved_names.append(name)
            logger.info(f"Auto-saved generated strategy: {name} (class: {class_name})")
            mirror_agent_event(
                "strategy_saved",
                f"Round {generation_round or '?'}: saved valid candidate {name}",
                progress=min(95, validation_progress + 5),
                strategy=name,
                class_name=class_name,
            )
            emit_task_event(
                task_id,
                "strategy_saved",
                progress=min(95, validation_progress + 5),
                current=f"Saved strategy: {name}",
                name=name,
                class_name=class_name,
            )

        if not saved_names:
            if total_strategies == 0:
                raise RuntimeError("The model did not return any strategy code to save. Try a more specific strategy request or use a stronger model.")
            detail = "; ".join(validation_errors[:3])
            raise RuntimeError(f"The model returned {total_strategies} strategy candidate(s), but none passed validation.{f' {detail}' if detail else ''}")

        update_task_state(task_id, status="completed", progress=100, current="Generation complete", results=data, saved_names=saved_names)
        emit_task_event(
            task_id,
            "complete",
            progress=100,
            current="Generation complete",
            saved_names=saved_names,
            results=data,
        )
        mirror_agent_event(
            "generation_complete",
            f"Round {generation_round or '?'}: saved {len(saved_names)} valid candidate strategy(s)",
            progress=100,
            strategies=saved_names,
        )
    except Exception as e:
        logger.error(f"AI Gen Failed: {e}")
        if getattr(request, "agent_run_id", None):
            _append_agent_event(
                request.agent_run_id,
                "generation_retry",
                f"Round {getattr(request, 'generation_round', None) or '?'} generation failed",
                error=str(e),
                round=getattr(request, "generation_round", None),
            )
            _update_agent_run(
                request.agent_run_id,
                current_step=f"Round {getattr(request, 'generation_round', None) or '?'} generation failed",
                last_generation_error=str(e),
                last_generation_round=getattr(request, "generation_round", None),
            )
        update_task_state(task_id, status="failed", error=str(e), current="Generation failed")
        emit_task_event(task_id, "error", error=str(e), current="Generation failed")


@app.get("/api/openapi-schema")
async def get_openapi_schema():
    """Return the OpenAPI schema for the AI agent to discover available APIs"""
    from fastapi.openapi.utils import get_openapi
    
    if app.openapi_schema:
        return app.openapi_schema
    
    openapi_schema = get_openapi(
        title=app.title,
        version="1.0.0",
        description="TradingSpy API",
        routes=app.routes,
    )
    
    app.openapi_schema = openapi_schema
    return openapi_schema


@app.post("/api/backtest/ai/chat-langgraph-legacy")
async def chat_agentic_langgraph_legacy(request: AIChatRequest):
    """Legacy endpoint — kept for reference only. Use /api/backtest/ai/chat-langgraph instead."""
    return {"response": "This endpoint is deprecated. Please use /api/backtest/ai/chat-langgraph", "actions": []}


@app.post("/api/backtest/ai/chat-agentic")
async def chat_agentic(request: AIChatRequest):
    """Enhanced agentic chat — streams SSE events so the frontend can track tasks in real-time."""

    async def event_stream():
        model = request.model

        MARKET_TOOLS = [
            {"name": "get_quote",        "method": "POST", "path": "/api/intelligence/agent-lookup",  "body": {"ticker": "SYMBOL", "lookup_type": "quote"},      "description": "Real-time price, change%, volume, market cap"},
            {"name": "get_chart",        "method": "POST", "path": "/api/intelligence/agent-lookup",  "body": {"ticker": "SYMBOL", "lookup_type": "chart", "period": "1mo", "interval": "1d"}, "description": "OHLCV price chart data"},
            {"name": "get_technicals",   "method": "POST", "path": "/api/intelligence/agent-lookup",  "body": {"ticker": "SYMBOL", "lookup_type": "technicals"},  "description": "RSI, SMA20/50/200, trend, support/resistance"},
            {"name": "get_news",         "method": "POST", "path": "/api/intelligence/agent-lookup",  "body": {"ticker": "SYMBOL", "lookup_type": "news"},        "description": "Latest news headlines"},
            {"name": "get_fundamentals", "method": "POST", "path": "/api/intelligence/agent-lookup",  "body": {"ticker": "SYMBOL", "lookup_type": "fundamentals"}, "description": "Fundamental valuation metrics including trailing PE, forward PE, PEG, margins, growth, analyst target, recommendation"},
            {"name": "get_insider_trades", "method": "POST", "path": "/api/intelligence/insider-trades", "body": {"tickers": ["SYMBOL"], "limit": 20, "days_back": 365}, "description": "Recent insider buying and selling records, shares, values, insider role, and ownership context"},
            {"name": "get_full_analysis","method": "POST", "path": "/api/intelligence/agent-lookup",  "body": {"ticker": "SYMBOL", "lookup_type": "full"},        "description": "Quote + technicals + news combined — best for buy/sell/analysis questions"},
            {"name": "list_datasets",    "method": "GET",  "path": "/api/market-data/files",          "body": {},                                                 "description": "List all downloaded datasets available for backtesting — ALWAYS call this before run_backtest or start_optimization"},
            {"name": "list_strategies",  "method": "GET",  "path": "/api/backtest/strategies",        "body": {},                                                 "description": "List all saved strategies — ALWAYS call this before run_backtest or start_optimization"},
            {"name": "download_data",    "method": "POST", "path": "/api/market-data/download",       "body": {"tickers": ["SYMBOL"], "period": "max", "interval": "1d"}, "description": "Download historical CSV data for backtesting"},
            {"name": "run_backtest",     "method": "POST", "path": "/api/backtest/backtest",          "body": {"strategies": ["ExactStrategyName"], "dataset_filename": "exact-file.txt"}, "description": "Run a backtest — strategy name and dataset_filename MUST be exact values from list_strategies / list_datasets"},
            {"name": "generate_strategy","method": "POST", "path": "/api/backtest/ai/generate",       "body": {"prompt": "...", "mode": "agnostic"},               "description": "Generate a new AI trading strategy (async — result not immediately available for backtesting)"},
            {"name": "fetch_article",    "method": "POST", "path": "/api/intelligence/fetch-article", "body": {"url": "https://..."},                               "description": "Fetch and read the full text of a news article URL — use after get_news to read article content"},
            {"name": "wait",             "method": "WAIT", "path": "",                                  "body": {"seconds": 10, "reason": "Waiting for optimization to progress"}, "description": "Pause for N seconds before the next action — use after starting an async task (optimize/generate) to give it time before checking status or running dependent steps"},
            {"name": "confirm",          "method": "CONFIRM", "path": "",                               "body": {"question": "Do you want to proceed?", "options": ["Yes", "No"], "default": "Yes"}, "description": "Ask the user a yes/no (or custom options) question and wait for their answer before continuing — use before destructive or expensive operations like optimization or strategy overwrite"},
            {"name": "web_search",       "method": "GET",  "path": "/api/intelligence/web-search",    "body": {"q": "search query"},                              "description": "Search the web for news, analyst opinions, market sentiment — use for anything not covered by get_news"},
            {"name": "fetch_website",    "method": "GET",  "path": "/api/intelligence/fetch-website", "body": {"url": "https://..."},                             "description": "Fetch full text content from any URL — use after web_search to read an article"},
            {"name": "get_dividends",    "method": "GET",  "path": "/api/intelligence/dividends/SYMBOL", "body": {},                                              "description": "Get dividend history for a ticker"},
            {"name": "get_options",      "method": "GET",  "path": "/api/intelligence/options/SYMBOL",   "body": {},                                              "description": "Get options chain (calls + puts) for nearest expiry"},
            {"name": "get_earnings",     "method": "GET",  "path": "/api/intelligence/earnings/SYMBOL",  "body": {},                                              "description": "Get earnings calendar and history for a ticker"},
            {"name": "get_recommendations", "method": "GET", "path": "/api/intelligence/recommendations/SYMBOL", "body": {},                                      "description": "Get analyst buy/sell/hold recommendations"},
            {"name": "get_market_overview", "method": "GET",  "path": "/api/intelligence/market-overview", "body": {},                                                 "description": "Get market overview — S&P500, Nasdaq, Dow, Russell 2000 indices"},
            {"name": "get_industry_heatmap", "method": "POST", "path": "/api/intelligence/industry-heatmap", "body": {"period": "1d"},                                "description": "Get industry/sector heatmap — returns sectors with performance metrics, top movers"},
            {"name": "get_sector_heatmap", "method": "POST", "path": "/api/intelligence/sector-heatmap", "body": {"tickers": ["SPY", "QQQ", "IWM"], "period": "1d"},  "description": "Get sector heatmap for specific tickers — returns change_percent, price, volume"},
            {"name": "search_ticker",    "method": "GET",  "path": "/api/intelligence/search",        "body": {"q": "company name or symbol"},                    "description": "Search for a ticker symbol by company name"},
            {"name": "get_ticker_info",  "method": "GET",  "path": "/api/intelligence/info/SYMBOL",   "body": {},                                                 "description": "Get comprehensive company info — sector, industry, description, market cap, P/E, 52w range"},
            ]

        system_prompt = f"""You are a sharp, no-BS trading buddy with real-time market data and platform tools. Talk like a knowledgeable friend who trades — direct, casual, a bit opinionated. No corporate speak, no "it is worth noting", no bullet-point walls.

You can:
- Answer questions about stocks, technicals, news
- Generate and backtest trading strategies (I'll walk you through it step-by-step)
- Optimize strategies to improve returns
- Have real conversations — ask follow-ups, challenge the user, share your take
- Be opinionated and conversational, not robotic

WORKFLOWS:
- **Strategy Creation**: I'll ask clarifying questions → propose an idea → generate code → backtest → analyze results → optionally optimize
- **Quick Analysis**: Just answer your question about a stock or market
- **Optimization**: Take an existing strategy and improve it

The workflow adapts to what you need. If you just want analysis, I give you analysis. If you want to build a strategy, I guide you through it conversationally.

TONE:
- Sound like a trader talking to another trader
- Lead with the most interesting insight
- Use numbers naturally: "RSI's at 21 — that's deep oversold" not formal language
- Short sentences. Skip filler.
- If something looks interesting, say so. If it looks bad, say that too.
- OK to have a take: "Honestly at RSI 21 this is more of a bounce watch than a buy"
- Ask questions back: "You thinking of shorting this or going long?" or "What's your thesis here?"
- Never use bullet points — write in natural flowing sentences
- Be conversational, not a report writer

TOOLS (use EXACTLY these paths and body shapes):
{json.dumps(MARKET_TOOLS, indent=2)}

Available Datasets (pre-fetched): {request.available_files}
Available Strategies (pre-fetched): {request.available_strategies}

DATA SOURCES: agent-lookup tries internal API first, falls back to yfinance MCP. Always use actual numbers returned, never invent data.

MULTI-STEP PLANNING RULES (critical):
1. For backtest or optimize: ALWAYS call list_datasets AND list_strategies first, then run_backtest/start_optimization with exact names.
2. NEVER guess strategy names or dataset filenames — use only names from list_strategies/list_datasets.
3. generate_strategy is ASYNC — poll until saved, then backtest automatically in the loop.
4. When user says "backtest" without a strategy, call list_strategies + list_datasets first, pick the best match.
5. When you download_data for a ticker, the task result will include "filenames" list. Use the exact filename from that result for backtest — don't guess or modify it.

INTENT → TOOL MAPPING:
- "price / quote X"                                   → get_quote
- "chart X"                                           → get_chart
- "technicals / RSI / bullish / bearish X"            → get_technicals
- "news / what's happening with X"                    → get_news
- "read article"                                      → fetch_article (URL from prior get_news)
- after starting async task (generate)                → wait(seconds=30) before next dependent step
- "should I buy / analyse / tell me about X"          → get_full_analysis
- "market overview / what is moving"                  → get_market_overview + get_industry_heatmap for requested timeframe
- "market down / market drops / why stocks fell today"→ get_market_overview + get_industry_heatmap + web_search for today's market selloff/news
- "sector / industry movement / what is weak today"   → get_market_overview + get_industry_heatmap
- "download data"                                     → download_data
- "backtest / run strategy"                           → list_datasets + list_strategies + run_backtest
- "generate / create strategy for X"                  → WORKFLOW: market/industry context → clarify → propose → confirm → generate → backtest → compare
- "improve after backtest"                            → baseline current version → generate candidate → backtest → compare → keep only better version

FULL WORKFLOW (generate → backtest):
1. create+backtest: generate_strategy → loop polls until saved → backtest automatically.
2. Always use EXACT strategy name from generation step for backtest.
3. Compare against previous strategy versions and buy-and-hold only when tool data supports real numbers.
4. For optimization: use the available optimization/backtest workflow when the user asks for it; ask for stop rules before open-ended loops.

TONE RULES (important):
- Sound like a trader talking to another trader, not a financial advisor writing a report
- Lead with the most interesting/actionable insight, not a summary of what you did
- Use numbers naturally: "RSI's at 21 — that's deep oversold" not "The RSI indicator reads 21.54, indicating oversold conditions"
- Short sentences. Skip filler phrases like "it is worth noting", "based on the data", "consider monitoring"
- If something looks interesting, say so directly. If it looks bad, say that too.
- OK to have a take: "Honestly at RSI 21 this is more of a bounce watch than a buy" is better than "the data suggests caution"
- Never use bullet points in the response field — write in natural flowing sentences

AUTONOMY RULES (critical):
- You are autonomous. Think through the FULL solution before acting.
- Plan multiple steps ahead, not just one action at a time.
- Execute the plan automatically — don't ask for confirmation unless it's a critical decision (like optimization).
- Keep looping and iterating until you've ACTUALLY SOLVED the user's problem, not just completed one step.
- If a backtest fails, try a different strategy. If optimization stalls, try different parameters.
- Don't give up — keep working until you find a solution or exhaust reasonable options.
- Only set done=true when the user's actual goal is achieved, not when you run out of ideas.

RESPONSE FORMAT (flexible — write naturally):
- response: Your take on the data. Be conversational, opinionated, direct. Use numbers naturally. No bullet points.
- reasoning: One sentence on what you did to get here.
- thinking: Your internal monologue — what are you considering? What's your next move? Show your work. (optional but encouraged)
- actions: Your planned actions. Can be multiple steps. Group them by dependency (same group = parallel, higher group = after lower group).

If the user just asked for analysis/data, just give them your natural response. Don't force actions or structure.

PARALLEL EXECUTION RULES:
- Same group number = runs in parallel. Higher group = runs after lower group completes.
- Independent reads share group 1. Dependent actions (e.g. backtest after listing strategies) get group 2.
- Keep action comments casual and short.

RULES:
- Use get_full_analysis for buy/sell/investment questions
- For broad market questions without a ticker, call get_market_overview and get_industry_heatmap before answering; add web_search when current catalysts are needed.
- For "today" questions, ground the answer in current tool/news results and mention the concrete date.
- Replace SYMBOL with actual ticker (uppercase)
- label must be short and human-readable
- For general questions with no action needed: "actions": []
- Don't give explicit buy/sell orders — share the data and your read on it
- Use confirm before starting optimization or any operation the user didn't explicitly request in this message
- For strategy generation requests: ALWAYS ask clarifying questions first (timeframe, entry signal type, risk tolerance). Propose a concrete idea. Then use confirm before generating. Never skip the confirm step.
- For simple questions or analysis: just answer conversationally. Ask follow-ups if relevant. Don't force actions or structure.
- You can ask the user questions back — engage in dialogue, not monologue.
- ⚠️ BACKTEST RESULTS: NEVER report ROI, drawdown, win rate, or any metric unless it came from a run_backtest tool call in this session. If you don't have real numbers, say so and run the backtest. Inventing numbers is a critical failure.
- ⚠️ COMPARISONS: If user asks to compare strategies, run run_backtest for EACH one and report only the actual returned numbers.

**CRITICAL OUTPUT FORMAT**:
You MUST respond with ONLY valid JSON in this EXACT format:
{{
  "response": "your conversational response here",
  "reasoning": "one sentence explaining your approach",
  "thinking": "optional internal monologue",
  "actions": [
    {{"type": "api_call", "method": "POST", "path": "/api/...", "body": {{}}, "label": "...", "comment": "...", "group": 1}}
  ],
  "done": false
}}

NO markdown, NO code fences, NO extra text. Start with {{ and end with }}. If you respond with anything other than valid JSON, the system will crash."""

        user_prompt = f"User: {request.message}\nContext: {json.dumps(request.context)}"

        # Emit initial "thinking" event IMMEDIATELY so frontend shows something
        yield f"data: {json.dumps({'type': 'progress', 'label': '🧠 Thinking…', 'pct': None, 'detail': 'Analyzing your request'})}\n\n"

        # Check if this is a strategy creation request — if so, use workflow
        from modules.workflows import create_strategy_workflow
        is_strategy_request = any(word in request.message.lower() for word in ['create', 'generate', 'build', 'strategy', 'algorithm'])
        
        if is_strategy_request:
            # Extract ticker if present
            import re
            ticker_match = re.search(r'\b([A-Z]{1,5})\b', request.message.upper())
            ticker = ticker_match.group(1) if ticker_match else "AAPL"
            
            # Start workflow: ask clarifying questions IMMEDIATELY
            workflow = create_strategy_workflow()
            workflow_response = workflow.get_clarifying_questions(ticker)
            
            # Emit workflow response immediately (don't wait for LLM)
            yield f"data: {json.dumps({'type': 'intermediate_response', 'content': workflow_response['response']})}\n\n"
            
            # Store workflow state for next iteration
            request.context = request.context or {}
            request.context['workflow'] = 'strategy_creation'
            request.context['workflow_stage'] = 'clarify'
            request.context['ticker'] = ticker

        # NOW call LLM (user already sees something)
        yield f"data: {json.dumps({'type': 'progress', 'label': '🧠 Calling AI…', 'pct': None, 'detail': 'Getting response'})}\n\n"
        
        total_prompt_tokens = 0
        total_completion_tokens = 0
        
        init_prompt_text = system_prompt + "\n" + user_prompt
        for h in (request.history or []):
            if h.get("content"):
                init_prompt_text += "\n" + h["content"]
        total_prompt_tokens += _count_tokens(init_prompt_text)
        
        try:
            llm_res = await call_llm(
                provider=request.provider,
                model=model,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                api_key=request.api_key,
                provider_config=request.provider_config,
                json_mode=True,
                history=request.history
            )
        except Exception as e:
            logger.error(f"Initial LLM call failed: {e}")
            final_response = f"⚠️ AI service error: {str(e)[:100]}. Please try again."
            yield f"data: {json.dumps({'type': 'result', 'payload': {'response': final_response, 'reasoning': '', 'execution_steps': [], 'needs_refresh': {}, 'market_data': None, 'triggered_tasks': [], 'backtest_results': None}})}\n\n"
            return
        
        total_completion_tokens += _count_tokens(llm_res)
        
        # Validate LLM response is not empty
        if not llm_res or not llm_res.strip():
            logger.error(f"LLM returned empty response. Provider: {request.provider}, Model: {model}")
            final_response = f"⚠️ AI returned empty response. This may be a rate limit or API issue. Please try again in a moment."
            yield f"data: {json.dumps({'type': 'result', 'payload': {'response': final_response, 'reasoning': '', 'execution_steps': [], 'needs_refresh': {}, 'market_data': None, 'triggered_tasks': [], 'backtest_results': None}})}\n\n"
            return

        import httpx
        from itertools import groupby as _groupby

        # ── shared helpers (defined once, used across all loop iterations) ──────

        async def _execute_one(action: dict, http_client: httpx.AsyncClient) -> dict:
            """Execute a single api_call action and return an enriched step dict."""
            label = action.get("label") or "Running step"
            comment = action.get("comment", "")  # human-readable commentary from LLM
            step = {"label": label, "status": "running", "comment": comment}
            try:
                method = action.get("method", "GET")
                path = action.get("path", "")
                body = action.get("body", {})
                if method == "POST":
                    resp = await http_client.post(f"http://localhost:8000{path}", json=body, timeout=30.0)
                else:
                    # Pass body as query params for GET requests (filter out empty values)
                    params = {k: v for k, v in body.items() if v not in (None, "", [], {})} if body else {}
                    resp = await http_client.get(f"http://localhost:8000{path}", params=params, timeout=30.0)

                if resp.status_code >= 400:
                    step.update({"status": "error", "note": f"HTTP {resp.status_code}"})
                    return step
                raw = resp.text.strip()
                if not raw:
                    step.update({"status": "error", "note": "Empty response from server"})
                    return step
                try:
                    result = resp.json()
                except Exception as json_err:
                    step.update({"status": "error", "note": f"Bad JSON: {str(json_err)[:80]}"})
                    return step

                step["status"] = "success"
                step["_result"] = result   # stash for post-processing
                step["_path"] = path
                step["_body"] = body
            except Exception as e:
                step.update({"status": "error", "note": str(e)})
            return step

        def _process_result(step: dict) -> tuple[dict, list, list]:
            """Extract market data / summaries from a completed step. Returns (step, market_items, summary_lines)."""
            result = step.pop("_result", None)
            path   = step.pop("_path", "")
            body   = step.pop("_body", {})
            market_items = []
            summaries = []
            if result is None:
                return step, market_items, summaries

            label = step["label"]
            if "/agent-lookup" in path and "type" in result:
                market_items.append(result)
                ticker = body.get("ticker", "")
                step["note"] = f"Got {result.get('type')} for {ticker}"
                summaries.append(f"[{label}] Real data for {ticker}: {json.dumps(result)}")
            elif "/fetch-article" in path:
                if "error" in result:
                    step["note"] = f"Could not fetch article: {result['error']}"
                    summaries.append(f"[{label}] Article fetch failed: {result['error']}")
                else:
                    content = result.get("content", "")
                    truncated = result.get("truncated", False)
                    step["note"] = f"Read {len(content)} chars{' (truncated)' if truncated else ''}"
                    summaries.append(f"[{label}] Article content from {result.get('url', '')}:\n{content}")
            elif "/market-data/files" in path and "files" in result:
                files_list = result["files"]
                step["note"] = f"{len(files_list)} datasets available"
                # compact internal format — not shown in reasoning
                summaries.append(f"[{label}] DATASETS={json.dumps(files_list)}")
            elif "/backtest/strategies" in path and "strategies" in result:
                strat_names = [s["name"] for s in result["strategies"]]
                step["note"] = f"{len(strat_names)} strategies available"
                # compact internal format — not shown in reasoning
                summaries.append(f"[{label}] STRATEGIES={json.dumps(strat_names)}")
            elif "task_id" in result:
                step["note"] = f"Task started ({result['task_id'][:8]}...)"
                step["task_id"] = result["task_id"]
                step["_task_path"] = path  # remember what kind of task for polling
                if "/download" in path: needs_refresh["files"] = True
                if "/generate" in path: needs_refresh["strategies"] = True
                summaries.append(f"[{label}] task_id={result['task_id']} path={path}")
            elif "session_id" in result:
                # Optimization sessions not handled by agent — user goes to Battle Station/Forge tabs
                summaries.append(f"[{label}] Session started: {result['session_id']}")
            else:
                summaries.append(f"[{label}] Result: {json.dumps(result)[:300]}")
            return step, market_items, summaries

        # ── Agent loop (ReAct style) ─────────────────────────────────────────────
        # NO MAX ITERATIONS — loop until agent says done (it solved the problem)
        needs_refresh = {"files": False, "strategies": False}
        collected_market_data = []
        market_data_shown = False  # Track if we've already shown market data
        fetched_data_summary = []   # grows across iterations; fed back each loop
        execution_steps = []
        all_backtest_results = []   # accumulated across all backtest polls
        triggered_tasks = []
        final_response = ""
        final_reasoning = ""
        iteration = 0

        async def _poll_task(task_id: str, path: str, label: str, poll_client: httpx.AsyncClient):
            """Async generator: yields SSE progress strings, then yields a final '__done__:...' line."""
            is_generate = "/generate" in path
            is_backtest = "/backtest/backtest" in path

            poll_url = f"http://localhost:8000/api/backtest/results/{task_id}"
            deadline = asyncio.get_event_loop().time() + (300 if is_generate else 300)

            last_pct = -1

            while asyncio.get_event_loop().time() < deadline:
                await asyncio.sleep(3 if is_generate else 2)
                yield ": keepalive\n\n"
                try:
                    pr = await poll_client.get(poll_url, timeout=10.0)
                    if pr.status_code != 200:
                        continue
                    pd_ = pr.json()
                    status = pd_.get("status")
                    pct = pd_.get("progress", 0)
                    cur = pd_.get("current", "")

                    if pct != last_pct:
                        last_pct = pct
                        yield f"data: {json.dumps({'type': 'progress', 'label': label, 'pct': pct, 'detail': cur})}\n\n"

                    if status == "completed":
                        if is_generate:
                            # Prefer saved_names (validated class names) over raw LLM output
                            saved = pd_.get("saved_names", [])
                            strats = pd_.get("results", {}).get("strategies", [])
                            if saved:
                                name = saved[0]
                            elif strats:
                                name = strats[0].get("name") or strats[0].get("class_name", "GeneratedStrategy")
                            else:
                                yield f"__done__:[{label}] Strategy generation completed but no strategies were saved (validation may have failed)."
                                return
                            needs_refresh["strategies"] = True
                            yield f"__done__:[{label}] Strategy generated and saved as: \"{name}\". Use this EXACT name for backtest."
                            return
                        elif is_backtest:
                            results = pd_.get("results", [])
                            all_backtest_results.extend(results)
                            summary = ", ".join(
                                f"{r['strategy']}: ROI={r.get('roi', 0):.2f}% MaxDD={r.get('max_drawdown', r.get('maxDrawdown', 0)):.2f}% WinRate={r.get('win_rate', r.get('winRate', 0)):.1f}%"
                                for r in results[:5]
                            )
                            yield f"__done__:[{label}] Backtest completed. {summary}"
                            return
                    elif status in ("failed", "stopped"):
                        yield f"__done__:[{label}] Task {status}: {pd_.get('error', pd_.get('current', 'unknown'))}"
                        return
                    else:
                        logger.info(f"Polling {task_id}: {pct}% {cur}")
                except Exception:
                    pass
            yield f"__done__:[{label}] Task timed out."

        # First plan comes from the initial LLM call above
        loop_llm_res = llm_res
        iteration = 0

        async with httpx.AsyncClient() as http_client:
            while True:  # Loop until agent says done (no artificial limit)
                iteration += 1
                
                # Safety: if iteration gets very high, warn but keep going
                if iteration > 50:
                    logger.warning(f"Agent loop iteration {iteration} — still working on solving the problem")
                
                # Show progress (minimal overhead)
                if iteration == 1:
                    yield f"data: {json.dumps({'type': 'progress', 'label': '🧠 Planning…', 'pct': None, 'detail': 'Deciding next steps'})}\n\n"
                else:
                    yield f"data: {json.dumps({'type': 'progress', 'label': f'🧠 Step {iteration}', 'pct': None, 'detail': 'Executing…'})}\n\n"

                try:
                    loop_plan = json.loads(loop_llm_res)
                except Exception as e:
                    logger.warning(f"Agent loop JSON parse failed at iteration {iteration}: {e}")
                    logger.warning(f"LLM response was: {loop_llm_res[:200]}")
                    # Fallback: treat as error and break
                    final_response = f"⚠️ I encountered an error processing your request. Please try again."
                    break

                if loop_plan.get("response"):
                    final_response = str(loop_plan["response"])
                
                # Extract actions early so we can reference them
                api_actions = [a for a in (loop_plan.get("actions") or []) if a.get("type") == "api_call" or a.get("method") in ("WAIT", "CONFIRM")]
                
                # Emit intermediate response so user sees progress during the loop
                if not loop_plan.get("done") and api_actions:
                    yield f"data: {json.dumps({'type': 'intermediate_response', 'content': final_response})}\n\n"
                
                if loop_plan.get("reasoning"):
                    final_reasoning = str(loop_plan["reasoning"])
                if loop_plan.get("thinking"):
                    # Emit thinking so user sees agent's internal monologue
                    yield f"data: {json.dumps({'type': 'thinking', 'content': str(loop_plan['thinking'])})}\n\n"

                if loop_plan.get("comment"):
                    execution_steps.append({"label": "🤖 Agent", "status": "info", "note": str(loop_plan["comment"])})

                # If LLM signals done OR has no more actions to run, stop
                if loop_plan.get("done") is True or not api_actions:
                    break

                def _gkey(a): return int(a.get("group", 1))
                sorted_actions = sorted(api_actions, key=_gkey)

                for _gid, _gactions in _groupby(sorted_actions, key=_gkey):
                    wave = list(_gactions)
                    wave_comment = next((a.get("comment") for a in wave if a.get("comment")), None)
                    if wave_comment:
                        execution_steps.append({"label": "💬", "status": "info", "note": wave_comment})
                        yield f"data: {json.dumps({'type': 'progress', 'label': '💬 Agent', 'pct': None, 'detail': wave_comment})}\n\n"

                    # ── Handle special actions before HTTP wave ──────────────────
                    confirm_actions = [a for a in wave if a.get("method") == "CONFIRM"]
                    wait_actions    = [a for a in wave if a.get("method") == "WAIT"]
                    http_actions    = [a for a in wave if a.get("method") not in ("WAIT", "CONFIRM")]

                    # ── Confirm actions — pause loop, ask user ───────────────────
                    user_declined = False
                    for ca in confirm_actions:
                        body = ca.get("body", {})
                        question = body.get("question", "Do you want to proceed?")
                        options  = body.get("options", ["Yes", "No"])
                        default  = body.get("default", options[0] if options else "Yes")
                        label    = ca.get("label") or "Confirm"
                        cid      = str(uuid.uuid4())

                        # Register in global registry so the HTTP endpoint can unblock us
                        evt = asyncio.Event()
                        _confirm_registry[cid] = {"event": evt, "answer": None}

                        step = {"label": label, "status": "info", "note": question}
                        execution_steps.append(step)
                        yield f"data: {json.dumps({'type': 'confirm_request', 'confirm_id': cid, 'question': question, 'options': options, 'default': default, 'label': label})}\n\n"

                        # Wait up to 5 minutes for user response
                        try:
                            await asyncio.wait_for(evt.wait(), timeout=300)
                        except asyncio.TimeoutError:
                            _confirm_registry.pop(cid, None)
                            step["status"] = "error"
                            step["note"] = "Confirmation timed out — skipping"
                            fetched_data_summary.append(f"[{label}] Confirmation timed out.")
                            yield f"data: {json.dumps({'type': 'step', 'label': label, 'status': 'error', 'note': 'Timed out waiting for confirmation'})}\n\n"
                            user_declined = True
                            continue

                        answer = _confirm_registry.pop(cid, {}).get("answer", default)
                        # Treat first option (or "yes"-like) as proceed
                        declined = answer.lower() in ("no", "cancel", "skip", "n") or (options and answer == options[-1] and answer.lower() not in ("yes", "y", options[0].lower()))
                        step["status"] = "success" if not declined else "error"
                        step["note"] = f"User answered: {answer}"
                        fetched_data_summary.append(f"[{label}] User confirmed: {answer}")
                        yield f"data: {json.dumps({'type': 'step', 'label': label, 'status': step['status'], 'note': step['note']})}\n\n"
                        if declined:
                            user_declined = True

                    if user_declined:
                        # Tell LLM the user declined so it can wrap up gracefully
                        fetched_data_summary.append("[Agent] User declined the confirmation — do not proceed with that action. Wrap up and set done=true.")
                        break  # exit wave loop, LLM will get the summary and set done=true

                    for wa in wait_actions:
                        secs = min(int(wa.get("body", {}).get("seconds", 10)), 120)  # cap at 2 min
                        reason = wa.get("body", {}).get("reason", "Waiting…")
                        label = wa.get("label") or f"⏳ Waiting {secs}s"
                        step = {"label": label, "status": "info", "note": reason}
                        execution_steps.append(step)
                        for remaining in range(secs, 0, -1):
                            yield f"data: {json.dumps({'type': 'progress', 'label': label, 'pct': int((secs - remaining) / secs * 100), 'detail': f'{reason} — {remaining}s remaining'})}\n\n"
                            await asyncio.sleep(1)
                        step["status"] = "success"
                        step["note"] = f"Waited {secs}s — {reason}"
                        fetched_data_summary.append(f"[{label}] Waited {secs}s. {reason}")
                        yield f"data: {json.dumps({'type': 'step', 'label': label, 'status': 'success', 'note': step['note']})}\n\n"

                    if not http_actions:
                        continue

                    wave_results = await asyncio.gather(*[_execute_one(a, http_client) for a in http_actions])
                    for step in wave_results:
                        step, market_items, summaries = _process_result(step)
                        
                        # Emit market data immediately (only first time)
                        if market_items and not market_data_shown:
                            yield f"data: {json.dumps({'type': 'market_data', 'data': market_items})}\n\n"
                            market_data_shown = True
                        
                        collected_market_data.extend(market_items)
                        fetched_data_summary.extend(summaries)
                        execution_steps.append(step)
                        # Emit step completion
                        yield f"data: {json.dumps({'type': 'step', 'label': step.get('label',''), 'status': step.get('status',''), 'note': step.get('note','')})}\n\n"

                        # ── Immediately poll generate/backtest tasks inline ──
                        tid = step.get("task_id")
                        task_path = step.pop("_task_path", "")
                        if tid:
                            triggered_tasks.append({"task_id": tid, "label": step.get("label", "Task")})
                            task_type = "forge" if "/generate" in task_path else "backtest"
                            yield f"data: {json.dumps({'type': 'task_started', 'task_id': tid, 'task_type': task_type, 'label': step.get('label', 'Agent Task')})}\n\n"
                            should_poll = "/generate" in task_path or "/backtest/backtest" in task_path
                            if should_poll:
                                step["note"] = "⏳ Waiting for task to complete..."
                                poll_summary = None
                                async for sse_chunk in _poll_task(tid, task_path, step.get("label", "Task"), http_client):
                                    if sse_chunk.startswith("data:"):
                                        yield sse_chunk  # forward progress ticks to frontend
                                    else:
                                        poll_summary = sse_chunk  # final return value
                                if poll_summary is None:
                                    poll_summary = f"[{step.get('label','Task')}] Task timed out."
                                step["note"] = poll_summary.split("] ", 1)[-1] if "] " in poll_summary else poll_summary
                                step["status"] = "error" if "failed" in poll_summary or "timed out" in poll_summary else "success"
                                fetched_data_summary.append(poll_summary)
                                yield f"data: {json.dumps({'type': 'step', 'label': step.get('label',''), 'status': step.get('status',''), 'note': step.get('note','')})}\n\n"

                # ── LLM thinking for next iteration ─────────────────────────────
                # (skip progress event — user already sees step completion)

                # ── Feed results back to LLM for next iteration ──────────────────
                completed_labels = [s["label"] for s in execution_steps if s.get("status") == "success"]
                loop_user_prompt = (
                    f"Original request: {request.message}\n\n"
                    f"Steps completed so far:\n" + "\n".join(fetched_data_summary) +
                    f"\n\nCompleted actions: {completed_labels}\n\n"
                    f"CONTINUATION RULES (read carefully):\n"
                    f"- ONLY set done=true when the user's ACTUAL GOAL is achieved.\n"
                    f"- If you just listed datasets/strategies, you MUST now run the actual task (backtest/generate) — do NOT set done=true yet.\n"
                    f"- If a strategy was just generated, its exact name is above — run the backtest NOW, do NOT set done=true yet.\n"
                    f"- If backtest just completed with results above, analyze them. If ROI is poor, try a different strategy or parameters.\n"
                    f"- If backtest failed, try again with different settings or a different strategy.\n"
                    f"- Never repeat an action that already succeeded.\n"
                    f"- ⚠️ CRITICAL: When reporting backtest results, ONLY use the EXACT numbers from 'Steps completed so far' above. NEVER invent ROI%, drawdown, or any metric. If the results are not in the steps above, say you don't have them yet and run the backtest.\n"
                    f"- ⚠️ CRITICAL: If the user asks to compare strategies (e.g. vs buy-and-hold), you MUST run run_backtest for EACH strategy separately and report the actual returned numbers. Do NOT estimate or assume any result.\n"
                    f"- For simple analysis/data requests: just give your response and set done=true. Don't force actions if not needed.\n"
                    f"- For conversational questions: answer naturally, ask follow-ups if relevant, set done=true. No actions needed.\n"
                    f"- KEEP LOOPING until you've actually solved the problem. Don't stop just because you ran out of ideas — try different approaches.\n"
                    f"- If nothing more is needed, set done=true.\n\n"
                    f"Return JSON: {{\"response\": \"...\", \"reasoning\": \"...\", \"thinking\": \"...\", \"done\": true/false, \"actions\": [...]}}\n"
                    f"If done=false, actions array MUST be non-empty. If done=true, actions can be empty."
                )
                # (skip progress event — reduce overhead)
                total_prompt_tokens += _count_tokens(loop_user_prompt + "\n" + system_prompt)
                try:
                    llm_task = asyncio.ensure_future(call_llm(
                        provider=request.provider, model=model,
                        system_prompt=system_prompt,
                        user_prompt=loop_user_prompt,
                        api_key=request.api_key, provider_config=request.provider_config, json_mode=True,
                    ))
                    while not llm_task.done():
                        yield ": keepalive\n\n"
                        await asyncio.sleep(15)
                    loop_llm_res = await llm_task
                    total_completion_tokens += _count_tokens(loop_llm_res)
                except Exception as e:
                    logger.warning(f"Agent loop LLM call failed at iteration {iteration}: {e}")
                    break

        # ── Final grounding pass ─────────────────────────────────────────────────
        import re as _re
        def _clean_reasoning(text: str) -> str:
            if not text:
                return text
            # Remove internal data dumps (DATASETS=[], STRATEGIES=[], Available X: [...])
            text = _re.sub(r'(DATASETS|STRATEGIES)=\[.*?\]', '', text, flags=_re.DOTALL)
            text = _re.sub(r'Available (datasets|strategies)[:\s]*\[.*?\]\.?', '', text, flags=_re.DOTALL | _re.IGNORECASE)
            # Remove lines that are just file lists or strategy arrays
            lines = [l for l in text.split('\n') if not _re.match(r"^\s*[\'\"][\w\-\.]+\.txt[\'\"]", l)]
            return '\n'.join(lines).strip()

        final_reasoning = _clean_reasoning(final_reasoning)

        if fetched_data_summary:
            grounded_prompt = (
                f"User asked: {request.message}\n\n"
                f"Here's what happened:\n" + "\n".join(fetched_data_summary) +
                "\n\nWrite a natural, conversational response like you're talking to a trader friend. "
                "Be direct and opinionated. Use the data to back up your take. "
                "If there are results (backtest, strategy, data), weave them into the narrative naturally. "
                "Don't use bullet points or formal structure — just talk. "
                "You can ask follow-up questions or challenge the user's thinking if relevant. "
                "Return JSON: {\"response\": \"your natural response here\", \"reasoning\": \"one sentence on what you did\"}"
            )
            system_grounding = "You are a sharp trading buddy. Talk like a trader, not a report writer. Be casual, direct, opinionated. Ask questions. Engage."
            total_prompt_tokens += _count_tokens(grounded_prompt + "\n" + system_grounding)
            try:
                gr = await call_llm(
                    provider=request.provider, model=model,
                    system_prompt=system_grounding,
                    user_prompt=grounded_prompt,
                    api_key=request.api_key, provider_config=request.provider_config, json_mode=True,
                )
                total_completion_tokens += _count_tokens(gr)
                gd = json.loads(gr)
                if gd.get("response"): final_response = str(gd["response"])
                if gd.get("reasoning"): final_reasoning = _clean_reasoning(str(gd.get("reasoning", "")))
            except Exception as e:
                logger.warning(f"Final grounding pass failed: {e}")

        # ── Stream final result ──────────────────────────────────────────────
        # First stream response text in chunks so user sees token-by-token like Analyst mode
        response_text = final_response or "Done."
        chunk_size = 3
        for i in range(0, len(response_text), chunk_size):
            yield f"data: {json.dumps({'type': 'response', 'content': response_text[:i + chunk_size]})}\n\n"
            await asyncio.sleep(0.01)

        final_payload = {
            "response": response_text,
            "reasoning": final_reasoning,
            "execution_steps": execution_steps,
            "needs_refresh": needs_refresh,
            "market_data": collected_market_data if collected_market_data and not market_data_shown else None,
            "triggered_tasks": triggered_tasks,
            "backtest_results": all_backtest_results if all_backtest_results else None,
            "usage": {
                "prompt_tokens": total_prompt_tokens,
                "completion_tokens": total_completion_tokens,
                "total_tokens": total_prompt_tokens + total_completion_tokens,
            },
        }
        yield f"data: {json.dumps({'type': 'result', 'payload': final_payload})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


@app.post("/api/backtest/ai/chat-langgraph")
async def chat_langgraph(request: AIChatRequest):
    """Simple tool-calling chat - REPLACES buggy LangGraph with working approach from debug server"""
    from langchain_core.messages import HumanMessage, AIMessage
    from modules.tool_calling_agent import ALL_TOOLS, SYSTEM_PROMPT
    from datetime import datetime
    
    try:
        settings = load_system_settings()
        provider = request.provider or normalize_app_llm_provider(settings.get("default_provider"))
        model = request.model or settings.get("default_model") or "gemini-2.5-flash"
        
        logger.info(f"=== Tool-Calling Chat Request ===")
        logger.info(f"Provider: {provider}, Model: {model}")
        
        # Inject current datetime into system prompt
        current_datetime = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p %Z")
        system_prompt_with_time = SYSTEM_PROMPT.replace('{current_datetime}', str(current_datetime))
        
        # Add thinking detail instructions based on user preference
        thinking_detail = getattr(request, 'thinking_detail', 'normal')
        if thinking_detail == 'brief':
            system_prompt_with_time += "\n\n⚡ THINKING STYLE: Keep your reasoning brief and to the point. Only explain key decisions."
        elif thinking_detail == 'detailed':
            system_prompt_with_time += "\n\n🔍 THINKING STYLE: Provide detailed reasoning. Explain your thought process, alternatives considered, and why you chose specific tools or approaches."
        custom_agent_instructions = _agent_instruction_block(getattr(request, "agent_instructions", None))
        if custom_agent_instructions:
            system_prompt_with_time += f"\n\nUSER AGENT INSTRUCTIONS:\n{custom_agent_instructions}\n\nFollow these operator preferences when they do not conflict with tool safety, data accuracy, or user-visible answer requirements."
        # 'normal' doesn't add extra instructions
        
        try:
            llm, api_key = build_langchain_chat_model(provider, model, request.api_key, request.provider_config, temperature=0)
        except Exception as provider_error:
            return {"response": f"Provider setup failed for {provider}: {provider_error}", "data": {}, "actions": []}
        
        # Build messages
        from langchain_core.messages import SystemMessage
        lc_messages = [SystemMessage(content=system_prompt_with_time)]
        history_limit = max(0, min(80, int(getattr(request, "history_limit", 20) or 0)))
        history_items = (request.history or [])[-history_limit:] if history_limit else []
        for h in history_items:
            role, content = h.get("role"), h.get("content", "")
            if role == "user":
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant" and content:  # Only add assistant messages with content
                lc_messages.append(AIMessage(content=content))
        
        # Add context
        context_note = ""
        if request.available_files:
            context_note += f"\n[Available datasets: {', '.join(request.available_files)}]"
        if request.available_strategies:
            context_note += f"\n[Available strategies: {', '.join(s if isinstance(s, str) else s.get('name','') for s in request.available_strategies)}]"
        
        lc_messages.append(HumanMessage(content=f"{request.message}{context_note}"))
        
        # Call LLM with tools
        logger.info(f"Calling LLM with tools...")
        llm_with_tools = llm.bind_tools(ALL_TOOLS)
        response = llm_with_tools.invoke(lc_messages)
        
        steps = []
        tools_used = []
        tool_data = {}
        
        # Check if LLM wants to call tools
        if hasattr(response, "tool_calls") and response.tool_calls:
            logger.info(f"LLM requested {len(response.tool_calls)} tool calls")
            
            for tool_call in response.tool_calls:
                tool_name = tool_call.get("name")
                tool_input = tool_call.get("args", {})
                
                steps.append({
                    "label": f"🔧 {tool_name}",
                    "status": "running",
                    "comment": f"Calling {tool_name}",
                    "note": str(tool_input)[:100]
                })
                
                # Execute tool
                for t in ALL_TOOLS:
                    if t.name == tool_name:
                        try:
                            # Call the tool directly (invoke method) instead of .func
                            result = t.invoke(tool_input)
                            
                            tool_data[tool_name] = result
                            tools_used.append(tool_name)
                            steps.append({
                                "label": f"✅ {tool_name}",
                                "status": "success",
                                "comment": f"Got {tool_name} result",
                                "note": str(result)[:100]
                            })
                            logger.info(f"✓ Tool {tool_name} executed")
                        except Exception as e:
                            logger.error(f"Tool {tool_name} error: {e}")
                            steps.append({
                                "label": f"❌ {tool_name}",
                                "status": "error",
                                "comment": "Tool error",
                                "note": str(e)[:100]
                            })
                        break
            
            # Build tool summary and call LLM again
            tool_summary = "Tool results:\n"
            for tool_name, result in tool_data.items():
                tool_summary += f"\n{tool_name}:\n{json.dumps(result, indent=2)[:500]}\n"
            
            lc_messages.append(HumanMessage(content=tool_summary + "\nBased on these results, provide a concise answer to the original question."))
            logger.info(f"Calling LLM again with tool results...")
            final_response = llm.invoke(lc_messages)
            response_text = final_response.content
        else:
            response_text = response.content
        
        steps.append({
            "label": "💬 Response",
            "status": "success",
            "comment": "Generated response",
            "note": f"Response: {len(response_text)} chars"
        })
        
        return {
            "response": response_text,
            "thinking": f"Used {len(tools_used)} tools: {', '.join(tools_used) if tools_used else 'none'}",
            "steps": steps,
            "execution_steps": steps,  # Backward compatibility
            "tools_used": list(set(tools_used)),
            "data": tool_data,
            "actions": [{"tool": t, "status": "completed"} for t in tools_used]
        }
    
    except Exception as e:
        logger.error(f"Error: {e}", exc_info=True)
        return {
            "response": f"Error: {str(e)}",
            "data": {},
            "actions": [],
        }


@app.post("/api/backtest/ai/chat-simple")
async def chat_simple(request: AIChatRequest):
    """Simple agent with yfinance and APIs - no complex workflows."""
    from modules.simple_agent import SimpleTradingAgent
    
    try:
        # Create agent instance
        agent = SimpleTradingAgent(llm_caller=call_llm)
        
        # Process message
        result = await agent.chat(
            message=request.message,
            provider=request.provider or normalize_app_llm_provider(load_system_settings().get("default_provider")),
            model=request.model or "gemini-2.5-flash",
            api_key=request.api_key,
            provider_config=request.provider_config,
            history=request.history or [],
            available_files=request.available_files or [],
            available_strategies=request.available_strategies or []
        )
        
        return {
            "response": result.get("response", "I couldn't process that request."),
            "data": result.get("data", {}),
            "actions": result.get("actions", []),
            "thinking": result.get("thinking", "")
        }
    except Exception as e:
        logger.error(f"Simple agent error: {e}", exc_info=True)
        return {
            "response": f"Sorry, I encountered an error: {str(e)}",
            "data": {},
            "actions": [],
            "error": str(e)
        }


@app.post("/api/backtest/ai/chat")
async def chat_with_ai(request: AIChatRequest):
    try:
        model = request.model

        system_prompt = f"""You are the TradingSpy assistant. The user is asking for help with their trading platform.
Available Datasets: {request.available_files}
Available Strategies: {request.available_strategies}
Recognized Intent: {request.intent}

You MUST return a strict JSON object with EXACTLY two keys:
1. "response": A string containing your conversational response (use Markdown formatting if helpful).
2. "actions": A list of action objects (can be empty []). If the user wants to do something, provide an action so the frontend can execute it.
Action object format:
- For creating a strategy: {{"type": "create_strategy", "label": "Generate Strategy", "prompt": "..."}}
- For backtesting: {{"type": "backtest", "label": "Run Backtest", "strategy": "StrategyName", "dataset": "DatasetName.txt"}}
- For downloading data: {{"type": "download_data", "label": "Download AAPL", "tickers": ["AAPL"], "period": "max"}}
- For optimizing: {{"type": "optimize", "label": "Optimize Strategy", "strategy": "StrategyName", "dataset": "DatasetName.txt", "prompt": "..."}}
- Use list_strategies or list_data if they ask to see available items.
"""

        user_prompt = f"User Message: {request.message}"

        prompt_text = system_prompt + "\n" + user_prompt
        for h in (request.history or []):
            if h.get("content"):
                prompt_text += "\n" + h["content"]

        llm_res = await call_llm(
            provider=request.provider,
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            api_key=request.api_key,
            provider_config=request.provider_config,
            json_mode=True,
            history=request.history,
            max_tokens=request.max_tokens
        )
        data = json.loads(llm_res)
        prompt_tokens = _count_tokens(prompt_text)
        completion_tokens = _count_tokens(llm_res)
        return {
            "response": data.get("response", "I could not understand the response."),
            "actions": data.get("actions", []),
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens
            }
        }
    except Exception as e:
        logger.error(f"AI Chat Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# --- Settings Routes ---

KEY_FIELDS = {
    "openai_api_key", "openrouter_api_key", "groq_api_key", "mistral_api_key",
    "google_ai_studio_api_key", "litellm_api_key", "gcp_api_key",
    "azure_openai_api_key", "aws_access_key_id", "aws_secret_access_key",
    "tavily_api_key",
}
SENSITIVE_SETTINGS = KEY_FIELDS | {"remote_agent_auth_token"}

# ── Agent confirmation endpoint ───────────────────────────────────────────────
@app.post("/api/ai/confirm/{confirm_id}")
async def agent_confirm(confirm_id: str, body: Dict):
    """Frontend posts the user's answer here to unblock a waiting agent loop."""
    entry = _confirm_registry.get(confirm_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Confirmation request not found or already answered")
    entry["answer"] = body.get("answer", "yes")
    entry["event"].set()
    return {"ok": True}

@app.get("/api/settings")
async def get_settings():
    data = load_system_settings()
    visible = {k: v for k, v in data.items() if k not in SENSITIVE_SETTINGS}
    raw_provider = visible.get("default_provider") or os.getenv("DEFAULT_PROVIDER")
    visible["default_provider"] = normalize_app_llm_provider(raw_provider)
    raw_provider_supported = bool(raw_provider) and normalize_provider(raw_provider) in APP_LLM_PROVIDERS
    raw_model = visible.get("default_model") if raw_provider_supported else None
    env_model = os.getenv("DEFAULT_MODEL") if raw_provider_supported else None
    visible["default_model"] = raw_model or normalize_model(visible["default_provider"], env_model)
    visible["litellm_base_url"] = visible.get("litellm_base_url") or os.getenv("LITELLM_BASE_URL") or "http://localhost:4000/v1"
    visible["remote_agent_auth_token_configured"] = bool(_remote_agent_token(data))
    for key in KEY_FIELDS:
        env_key = key.upper()
        if key == "google_ai_studio_api_key":
            configured = bool(data.get(key) or os.getenv("GOOGLE_AI_STUDIO_API_KEY") or os.getenv("GEMINI_API_KEY"))
        elif key == "azure_openai_api_key":
            configured = bool(data.get(key) or os.getenv("AZURE_OPENAI_API_KEY"))
        else:
            configured = bool(data.get(key) or os.getenv(env_key))
        visible[f"{key}_configured"] = configured
    return visible

@app.post("/api/settings")
async def update_settings(settings: SystemSettings):
    try:
        # Only persist non-sensitive fields plus the optional remote auth token.
        # Provider API keys stay in the browser and are passed per request.
        incoming = settings.dict(exclude_unset=True)
        safe = {k: v for k, v in incoming.items() if k not in KEY_FIELDS}
        if "default_provider" in safe:
            raw_provider = safe["default_provider"]
            raw_supported = normalize_provider(raw_provider) in APP_LLM_PROVIDERS
            safe["default_provider"] = normalize_app_llm_provider(raw_provider)
            if not raw_supported:
                safe["default_model"] = normalize_model(safe["default_provider"], None)
        if safe.get("default_provider") and not safe.get("default_model"):
            safe["default_model"] = normalize_model(safe["default_provider"], None)
        # Merge with existing file so we don't wipe other stored config
        existing = load_system_settings()
        existing.update(safe)
        with open(CONFIG_FILE, 'w') as f:
            json.dump(existing, f, indent=2)
        return {"ok": True}
    except Exception as e:
        logger.error(f"Failed to save settings: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat/share")
async def share_chat_thread(request: ShareChatRequest):
    """Create a shareable link for a chat thread"""
    try:
        # Generate unique share ID
        share_id = str(uuid.uuid4())[:8]
        
        # Process messages - filter out tool calls and thinking sections
        messages = []
        for msg in request.messages:
            content = msg.get('content', '')
            # Remove thinking sections and tool calls for cleaner sharing
            content = re.sub(r'🧠\s*Thinking[\s\S]*?(?=\n\n|$)', '', content)
            content = re.sub(r'●[\s\S]*?(?=\n\n|$)', '', content)
            content = re.sub(r'💬\s*Final Response[\s\S]*?(?=\n|$)', '', content)
            content = content.strip()
            
            if content:  # Only include messages with content
                messages.append({**msg, 'content': content})
        
        # Limit messages if requested
        if request.limit_lines and request.limit_lines > 0:
            messages = messages[-request.limit_lines:]
        
        # Store shared chat data
        shared_data = {
            "id": share_id,
            "thread_id": request.thread_id,
            "title": request.title,
            "messages": messages,
            "history": request.history,
            "created_at": datetime.now().isoformat(),
            "limited": bool(request.limit_lines)
        }
        
        # Save to database
        db = TinyDB(os.path.join(get_user_dirs()["data"], "shared_chats.json"))
        db.insert(shared_data)
        
        return {"share_id": share_id, "url": f"/shared/{share_id}"}
    except Exception as e:
        logger.error(f"Error sharing chat: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/chat/shared/{share_id}")
async def get_shared_chat(share_id: str):
    """Retrieve a shared chat thread"""
    try:
        db = TinyDB(os.path.join(get_user_dirs()["data"], "shared_chats.json"))
        Chat = Query()
        result = db.search(Chat.id == share_id)
        
        if not result:
            raise HTTPException(status_code=404, detail="Shared chat not found")
        
        return result[0]
    except Exception as e:
        logger.error(f"Error retrieving shared chat: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ── OpenAI Compatible API ────────────────────────────────────────────────────

class OpenAIMessage(BaseModel):
    role: str  # "user", "assistant", "system"
    content: str

class OpenAIChatRequest(BaseModel):
    model: str = "trading-ai"
    messages: List[OpenAIMessage]
    stream: bool = False
    temperature: float = 0.7
    max_tokens: int = 2000
    provider: Optional[str] = None
    provider_model: Optional[str] = None
    api_key: Optional[str] = None
    provider_config: Optional[Dict[str, Any]] = None

@app.post("/v1/chat/completions")
async def openai_chat_completions(request: OpenAIChatRequest):
    """OpenAI-compatible chat completions endpoint.
    Use model ID to select mode:
      trading-ai / trading-ai-manual  -> manual (plain LLM, no tools)
      trading-ai-agentic              -> agentic (tool-calling with SSE)
      trading-ai-strands              -> strands (iterative agent loop)
    """
    try:
        logger.info(f"OpenAI endpoint called with model: {request.model}, stream: {request.stream}")
        # Convert OpenAI format to our format
        last_message = request.messages[-1].content if request.messages else ""
        history = []
        
        # Convert message history
        for msg in request.messages[:-1]:
            history.append({
                "role": "user" if msg.role == "user" else "assistant",
                "content": msg.content
            })
        
        # Determine mode from model ID
        model_id = request.model or "trading-ai"
        if "strands" in model_id:
            chat_mode = "strands"
        elif "agentic" in model_id:
            chat_mode = "agentic"
        else:
            chat_mode = "manual"

        logger.info(f"Chat mode: {chat_mode}, message: {last_message[:50]}...")

        # Call our agent
        agent_request = AIChatRequest(
            message=last_message,
            history=history,
            max_tokens=request.max_tokens,
            provider=request.provider,
            model=request.provider_model,
            api_key=request.api_key,
            provider_config=request.provider_config,
        )
        
        # Streaming: route to the appropriate streaming endpoint
        stream_path = {
            "strands": "http://localhost:8000/api/backtest/ai/chat-strands",
            "agentic": "http://localhost:8000/api/backtest/ai/chat-agentic",
        }

        if request.stream:
            # Streaming response
            async def generate():
                yield 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}\n\n'
                
                if chat_mode == "manual":
                    # manual mode has no SSE stream — call sync and emit as single chunk
                    result = await chat_with_ai(agent_request)
                    content = result["response"]
                    chunk = {"object": "chat.completion.chunk", "choices": [{"delta": {"content": content}}]}
                    yield f'data: {json.dumps(chunk)}\n\n'
                else:
                    # Call our streaming endpoint — forward thinking, tool_call, and response events
                    import httpx
                    logger.info(f"Calling {stream_path[chat_mode]} with agent_request")
                    async with httpx.AsyncClient(timeout=None) as client:
                        async with client.stream(
                            'POST',
                            stream_path[chat_mode],
                            json=agent_request.dict()
                        ) as response:
                            logger.info(f"Got response status: {response.status_code}")
                            async for line in response.aiter_lines():
                                if line.startswith('data: '):
                                    try:
                                        event = json.loads(line[6:])
                                        etype = event.get('type')
                                        econtent = event.get('content', '')
                                        if etype == 'thinking' and econtent:
                                            chunk = {"object": "chat.completion.chunk", "choices": [{"delta": {"content": f"💭 {econtent}\n"}}]}
                                            yield f'data: {json.dumps(chunk)}\n\n'
                                        elif etype == 'tool_call' and econtent:
                                            chunk = {"object": "chat.completion.chunk", "choices": [{"delta": {"content": f"🔧 {econtent}\n"}}]}
                                            yield f'data: {json.dumps(chunk)}\n\n'
                                        elif etype == 'response' and econtent:
                                            chunk = {"object": "chat.completion.chunk", "choices": [{"delta": {"content": econtent}}]}
                                            yield f'data: {json.dumps(chunk)}\n\n'
                                    except:
                                        pass
                
                yield 'data: [DONE]\n\n'
            
            return StreamingResponse(generate(), media_type="text/plain")
        
        else:
            # Non-streaming: collect the full SSE stream and return assembled text
            if chat_mode == "manual":
                result = await chat_with_ai(agent_request)
                content = result["response"]
            else:
                # Consume the SSE stream internally, take the first 'response' chunk only
                import httpx
                content = ''
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream(
                        'POST',
                        stream_path[chat_mode],
                        json=agent_request.dict()
                    ) as response:
                        async for line in response.aiter_lines():
                            if line.startswith('data: '):
                                try:
                                    event = json.loads(line[6:])
                                    if event.get('type') == 'response' and event.get('content'):
                                        content = event['content']
                                        break  # take first response only
                                except:
                                    pass
                content = content or 'No response generated.'

            return {
                "object": "chat.completion",
                "model": request.model,
                "choices": [{
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": len(last_message.split()),
                    "completion_tokens": len(content.split()),
                    "total_tokens": len(last_message.split()) + len(content.split())
                }
            }
            
    except Exception as e:
        logger.error(f"OpenAI API error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/v1/models")
async def openai_models():
    """OpenAI-compatible models endpoint"""
    return {
        "object": "list",
        "data": [
            {"id": "trading-ai",         "object": "model", "created": 1677610602, "owned_by": "trading-ai"},
            {"id": "trading-ai-manual",  "object": "model", "created": 1677610602, "owned_by": "trading-ai"},
            {"id": "trading-ai-agentic", "object": "model", "created": 1677610602, "owned_by": "trading-ai"},
            {"id": "trading-ai-strands", "object": "model", "created": 1677610602, "owned_by": "trading-ai"},
        ]
    }


# --- Market Intelligence Routes ---

HIGH_VOLUME_UNIVERSE_CANDIDATES = [
    "SPY", "QQQ", "IWM", "DIA", "TQQQ", "SQQQ", "SOXL", "SOXS", "XLF", "XLK",
    "SMH", "XLE", "XLI", "XLV", "XLY", "XLP", "XLC", "XLRE", "XLU", "ARKK",
    "AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "TSLA", "AVGO",
    "AMD", "INTC", "QCOM", "MU", "ARM", "SMCI", "TSM", "ASML", "ORCL", "CRM",
    "ADBE", "PLTR", "SNOW", "MDB", "SHOP", "UBER", "PYPL", "COIN", "HOOD",
    "RBLX", "SNAP", "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS", "JPM", "BAC",
    "WFC", "C", "GS", "MS", "BLK", "SCHW", "SOFI", "AFRM", "UPST", "V", "MA",
    "AXP", "XOM", "CVX", "COP", "SLB", "OXY", "EOG", "F", "GM", "NIO",
    "RIVN", "LCID", "WMT", "COST", "TGT", "HD", "LOW", "MCD", "SBUX", "NKE",
    "LULU", "JNJ", "UNH", "LLY", "ABBV", "MRK", "PFE", "TMO", "AMGN", "GILD",
    "BMY", "CVS", "ISRG", "GE", "BA", "CAT", "HON", "RTX", "LMT", "MMM", "UPS",
    "FDX", "PG", "KO", "PEP", "PM", "MO",
]

HIGH_VOLUME_SCAN_CANDIDATES = [
    "SPY", "QQQ", "IWM", "DIA", "TQQQ", "SQQQ", "SOXL", "SOXS", "XLF", "XLK",
    "SMH", "XLE", "NVDA", "TSLA", "AMD", "AAPL", "INTC", "PLTR", "SOFI", "HOOD",
    "AMZN", "META", "GOOGL", "MSFT", "BAC", "F", "SNAP", "NIO", "RIVN", "XOM",
    "WFC", "PFE", "T", "VZ", "UBER", "COIN", "MU", "SMCI", "NFLX", "PYPL",
]

UNIVERSE_PRESET_FALLBACKS = {
    "high-market-cap": ["AAPL", "MSFT", "NVDA", "GOOGL", "GOOG", "AMZN", "META", "AVGO", "TSLA", "LLY", "JPM", "V", "MA", "XOM", "WMT", "UNH", "COST", "NFLX", "ORCL", "JNJ"],
    "market-etfs": ["SPY", "QQQ", "IWM", "DIA", "TQQQ", "SQQQ", "SOXL", "SOXS", "XLK", "SMH", "XLF", "XLE", "XLV", "XLY", "XLI", "XLC", "XLP", "XLRE", "XLU"],
    "semis": ["NVDA", "AMD", "AVGO", "INTC", "QCOM", "MU", "ARM", "SMCI", "TSM", "ASML", "MRVL", "AMAT", "LRCX", "KLAC", "TXN", "ADI", "ON", "MCHP"],
    "software-ai": ["MSFT", "ORCL", "CRM", "ADBE", "PLTR", "SNOW", "MDB", "NOW", "DDOG", "NET", "CRWD", "PANW", "ZS", "SHOP", "UBER"],
    "financials": ["JPM", "BAC", "WFC", "C", "GS", "MS", "BLK", "SCHW", "SOFI", "HOOD", "COIN", "V", "MA", "AXP", "PYPL"],
    "healthcare": ["LLY", "UNH", "JNJ", "ABBV", "MRK", "PFE", "TMO", "AMGN", "GILD", "BMY", "CVS", "ISRG", "REGN", "VRTX", "ABT"],
    "energy": ["XOM", "CVX", "COP", "SLB", "OXY", "EOG", "MPC", "PSX", "VLO", "HAL", "DVN", "FANG", "KMI", "WMB"],
    "consumer": ["AMZN", "TSLA", "WMT", "COST", "TGT", "HD", "LOW", "MCD", "SBUX", "NKE", "LULU", "DIS", "NFLX", "PG", "KO", "PEP"],
    "industrials": ["GE", "BA", "CAT", "HON", "RTX", "LMT", "MMM", "UPS", "FDX", "DE", "ETN", "EMR", "PH", "ITW"],
}

UNIVERSE_PRESET_META = {
    "high-market-cap": {"label": "High Market Cap", "sector": None, "sort": "intradaymarketcap"},
    "semis": {"label": "Semis", "sector": "Technology", "industries": ["Semiconductors", "Semiconductor Equipment & Materials"], "sort": "intradaymarketcap"},
    "software-ai": {"label": "Software / AI", "sector": "Technology", "industries": ["Software - Infrastructure", "Software - Application", "Information Technology Services"], "sort": "intradaymarketcap"},
    "financials": {"label": "Financials", "sector": "Financial Services", "sort": "intradaymarketcap"},
    "healthcare": {"label": "Healthcare", "sector": "Healthcare", "sort": "intradaymarketcap"},
    "energy": {"label": "Energy", "sector": "Energy", "sort": "intradaymarketcap"},
    "consumer": {"label": "Consumer", "sectors": ["Consumer Cyclical", "Consumer Defensive"], "sort": "intradaymarketcap"},
    "industrials": {"label": "Industrials", "sector": "Industrials", "sort": "intradaymarketcap"},
}

UNIVERSE_SYMBOL_DENYLIST = {"SPCX"}

COMMON_PEER_TOKEN_DENYLIST = {
    "A", "AI", "AM", "ARE", "AS", "AT", "CEO", "CFO", "CPU", "ETF", "EV", "EPS",
    "FOR", "GPU", "HDD", "IPO", "LLC", "LTD", "NAS", "NYSE", "NASDAQ", "NEW",
    "NOW", "NAND", "DRAM", "PC", "PE", "QOQ", "SEC", "THE", "TO", "US", "USA",
    "USD", "YOY",
}

@app.get("/api/intelligence/quote/{ticker}")
async def get_quote(ticker: str):
    """Get real-time quote for a ticker"""
    return market_intel.get_ticker_quote(ticker)

@app.get("/api/intelligence/info/{ticker}")
async def get_ticker_info(ticker: str):
    """Get comprehensive ticker information"""
    return market_intel.get_ticker_info(ticker)

@app.get("/api/intelligence/news/{ticker}")
async def get_ticker_news(ticker: str, limit: int = 10):
    """Get recent news for a ticker"""
    try:
        news = await asyncio.wait_for(
            asyncio.to_thread(market_intel.get_ticker_news, ticker, limit),
            timeout=6,
        )
        return {"news": news}
    except asyncio.TimeoutError:
        logger.warning(f"News fetch timed out for {ticker}")
        return {"news": [], "warning": "News provider timed out"}

@app.post("/api/intelligence/news-titles")
async def get_news_titles(tickers: List[str], limit: int = 1):
    """Get one lightweight headline per ticker with a hard bounded response time."""
    clean_tickers = []
    seen = set()
    for ticker in tickers or []:
        symbol = str(ticker).upper().strip()
        if symbol and symbol not in seen:
            clean_tickers.append(symbol)
            seen.add(symbol)
    if not clean_tickers:
        return {"news": []}

    per_ticker_limit = max(1, min(int(limit or 1), 2))
    semaphore = asyncio.Semaphore(8)
    started_at = time.time()
    logger.info("news_titles_start tickers=%s limit=%s", clean_tickers, per_ticker_limit)

    async def _one(symbol: str):
        async with semaphore:
            items = []
            try:
                articles = await asyncio.wait_for(
                    asyncio.to_thread(market_intel.get_ticker_news, symbol, per_ticker_limit),
                    timeout=3,
                )
                first = (articles or [])[:per_ticker_limit]
                items = [
                    {
                        "ticker": symbol,
                        "title": article.get("title"),
                        "publisher": article.get("publisher"),
                        "link": article.get("link"),
                        "published": article.get("published"),
                        "source": "yfinance",
                    }
                    for article in first
                    if article.get("title")
                ]
            except Exception as exc:
                logger.warning(f"News title fetch failed for {symbol}: {exc}")
            if items:
                return items

            try:
                from modules.web_news_tools import web_search as _web_search
                query = f"{symbol} stock news today"
                fallback = await asyncio.wait_for(
                    asyncio.to_thread(_web_search.func, query),
                    timeout=5,
                )
                results = (fallback or {}).get("results") or []
                if results:
                    first_result = results[0]
                    logger.info("news_titles_fallback symbol=%s source=%s", symbol, first_result.get("source"))
                    return [{
                        "ticker": symbol,
                        "title": first_result.get("title") or f"{symbol} latest news",
                        "publisher": first_result.get("source") or (fallback or {}).get("source") or "Web search",
                        "link": first_result.get("url"),
                        "published": None,
                        "source": "web_search",
                    }]
            except Exception as exc:
                logger.warning(f"News title fallback failed for {symbol}: {exc}")
            return []

    results = await asyncio.gather(*[_one(symbol) for symbol in clean_tickers])
    flattened = [item for group in results for item in group]
    logger.info(
        "news_titles_done tickers=%s returned=%s elapsed=%.2fs",
        len(clean_tickers),
        len(flattened),
        time.time() - started_at,
    )
    return {"news": flattened}

@app.get("/api/intelligence/technicals/{ticker}")
async def get_technicals(ticker: str, period: str = "3mo"):
    """Get technical indicators for a ticker"""
    return market_intel.get_ticker_technicals(ticker, period)

@app.get("/api/intelligence/earnings/{ticker}")
async def get_earnings(ticker: str):
    """Get earnings calendar for a ticker"""
    return market_intel.get_earnings_calendar(ticker)

@app.get("/api/intelligence/recommendations/{ticker}")
async def get_recommendations(ticker: str):
    """Get analyst recommendations"""
    return market_intel.get_analyst_recommendations(ticker)

@app.get("/api/intelligence/market-overview")
async def get_market_overview(period: str = "1d", interval: str = None):
    """Get market overview with indices"""
    indices = {
        "SPY": "S&P 500",
        "DIA": "Dow Jones",
        "QQQ": "NASDAQ 100",
        "IWM": "Russell 2000",
    }
    try:
        prices = await _bulk_price_changes(list(indices.keys()), period, interval, False)
        index_data = {}
        for symbol, name in indices.items():
            row = prices.get(symbol) or {}
            if row.get("price") is None and row.get("change_percent") is None:
                continue
            index_data[symbol] = {
                "name": name,
                "symbol": symbol,
                "price": _safe_float(row.get("price")),
                "change": _safe_float(row.get("change")),
                "change_percent": _safe_float(row.get("change_percent")),
                "volume": _safe_float(row.get("volume")),
            }
        if index_data:
            return _sanitize_nan({
                "indices": index_data,
                "gainers": [],
                "losers": [],
                "most_active": [],
                "timestamp": datetime.now().isoformat(),
                "source": "ETF proxy prices using latest intraday price versus previous daily close for 1D",
            })
    except Exception as exc:
        logger.warning("market overview bulk index fetch failed: %s", exc)
    return _sanitize_nan(market_intel.get_market_movers(period, interval))

@app.post("/api/intelligence/batch-quotes")
async def get_batch_quotes(tickers: List[str]):
    """Get quotes for multiple tickers using a cached batch fetch."""
    return {"quotes": market_intel.get_batch_quotes(tickers)}

@app.post("/api/intelligence/batch-price-changes")
async def get_batch_price_changes(tickers: List[str], period: str = "1d", interval: str = None, extended: bool = False):
    """Get fast price/change rows for movers without per-ticker metadata calls."""
    clean_tickers = []
    seen = set()
    for ticker in tickers or []:
        symbol = str(ticker).upper().strip()
        if symbol and symbol not in seen:
            clean_tickers.append(symbol)
            seen.add(symbol)
    if not clean_tickers:
        return {"quotes": []}

    cache_key = f"batch_price_changes:{period}:{interval or 'auto'}:ext={int(extended)}:v3:{','.join(clean_tickers)}"
    cached = _get_cached(cache_key, ttl=45)
    if cached is not None:
        return cached

    prices = await _bulk_price_changes(clean_tickers, period, interval, extended)
    quotes = []
    for ticker in clean_tickers:
        row = prices.get(ticker) or {}
        quotes.append({
            "symbol": ticker,
            "name": ticker,
            "price": _safe_float(row.get("price")),
            "change": _safe_float(row.get("change")),
            "change_percent": _safe_float(row.get("change_percent")),
            "volume": _safe_float(row.get("volume")),
            "market_cap": None,
            "avg_daily_move_pct": _safe_float(row.get("avg_daily_move_pct")),
            "move_strength": _safe_float(row.get("move_strength")),
            "avg_volume": _safe_float(row.get("avg_volume")),
            "session": row.get("session"),
        })
    payload = _sanitize_nan({
        "quotes": quotes,
        "period": period,
        "interval": interval,
        "extended": extended,
        "source": "bulk yfinance price history without per-ticker metadata",
    })
    _set_cache(cache_key, payload)
    return payload

@app.get("/api/intelligence/high-volume-universe")
async def high_volume_universe(limit: int = 50):
    """Return a yfinance-backed liquid universe ranked by current reported volume."""
    import yfinance as yf
    safe_limit = max(5, min(int(limit or 50), 100))
    cache_key = "high_volume_universe:5d-1d:v2"
    ranked = _get_cached(cache_key, ttl=120)

    def _load_ranked():
        try:
            dataset = _locked_yf_download(
                yf,
                " ".join(HIGH_VOLUME_SCAN_CANDIDATES),
                period="5d",
                interval="1d",
                group_by="ticker",
                auto_adjust=False,
                progress=False,
                threads=False,
            )
        except Exception as exc:
            logger.warning(f"High-volume universe download failed: {exc}")
            dataset = pd.DataFrame()

        rows = []
        for ticker in HIGH_VOLUME_SCAN_CANDIDATES:
            hist = market_intel._extract_history_frame(dataset, ticker) if hasattr(market_intel, "_extract_history_frame") else pd.DataFrame()
            if hist is None or hist.empty or "Volume" not in hist.columns or "Close" not in hist.columns:
                continue
            clean = hist.dropna(subset=["Close", "Volume"]).tail(2)
            if clean.empty:
                continue
            latest = clean.iloc[-1]
            volume = _safe_float(latest.get("Volume"))
            price = _safe_float(latest.get("Close"))
            if volume is None or volume <= 0 or price is None:
                continue
            previous_close = _safe_float(clean.iloc[-2].get("Close")) if len(clean) > 1 else None
            change = price - previous_close if previous_close else None
            change_percent = (change / previous_close * 100) if previous_close else None
            rows.append({
                "symbol": ticker,
                "name": ticker,
                "price": price,
                "change": _safe_float(change),
                "change_percent": _safe_float(change_percent),
                "volume": volume,
            })
        return sorted(rows, key=lambda q: q.get("volume") or 0, reverse=True)

    if ranked is None:
        ranked = await asyncio.to_thread(_load_ranked)
        if not ranked:
            fallback = await asyncio.to_thread(market_intel.get_batch_quotes, HIGH_VOLUME_SCAN_CANDIDATES)
            ranked = sorted(
                [
                    q for q in fallback
                    if q and not q.get("error") and q.get("symbol") and (_safe_float(q.get("volume")) or 0) > 0
                ],
                key=lambda q: _safe_float(q.get("volume")) or 0,
                reverse=True,
            )
        _set_cache(cache_key, ranked)

    selected = ranked[:safe_limit]
    return _sanitize_nan({
        "tickers": [str(q.get("symbol")).upper() for q in selected],
        "quotes": selected,
        "candidate_count": len(HIGH_VOLUME_SCAN_CANDIDATES),
        "source": "yfinance 5d/1d daily volume over a focused liquid ETF and stock candidate universe",
    })

@app.get("/api/intelligence/universe-preset/{preset_key}")
async def universe_preset(preset_key: str, limit: int = 50):
    """Return a latest ticker universe for a UI preset, with cached yfinance screener fallback."""
    import yfinance as yf
    try:
        from yfinance import EquityQuery
    except Exception:
        EquityQuery = None

    key = (preset_key or "").strip().lower()
    safe_limit = max(5, min(int(limit or 50), 100))
    fallback = UNIVERSE_PRESET_FALLBACKS.get(key)
    if not fallback:
        raise HTTPException(status_code=404, detail=f"Unknown universe preset: {preset_key}")

    if key == "market-etfs":
        return {
            "key": key,
            "label": "Market ETFs",
            "tickers": fallback[:safe_limit],
            "source": "curated ETF universe",
            "dynamic": False,
        }

    cache_key = f"universe_preset:{key}:{safe_limit}:v1"
    cached = _get_cached(cache_key, ttl=900)
    if cached is not None:
        return cached

    def _extract_symbols(response):
        quotes = (response or {}).get("quotes") or []
        symbols = []
        seen = set()
        for quote in quotes:
            symbol = str(quote.get("symbol") or "").upper().strip()
            quote_type = str(quote.get("quoteType") or quote.get("typeDisp") or "").upper()
            if not symbol or symbol in seen:
                continue
            if symbol in UNIVERSE_SYMBOL_DENYLIST:
                continue
            if quote_type and "EQUITY" not in quote_type:
                continue
            symbols.append(symbol)
            seen.add(symbol)
        return symbols

    def _screen_latest():
        if EquityQuery is None:
            return []
        meta = UNIVERSE_PRESET_META.get(key, {})
        filters = [
            EquityQuery("eq", ["region", "us"]),
            EquityQuery("is-in", ["exchange", "NMS", "NYQ"]),
            EquityQuery("gte", ["intradaymarketcap", 1_000_000_000]),
            EquityQuery("gte", ["intradayprice", 3]),
        ]
        if meta.get("sector"):
            filters.append(EquityQuery("eq", ["sector", meta["sector"]]))
        if meta.get("sectors"):
            filters.append(EquityQuery("or", [EquityQuery("eq", ["sector", sector]) for sector in meta["sectors"]]))
        if meta.get("industries"):
            filters.append(EquityQuery("or", [EquityQuery("eq", ["industry", industry]) for industry in meta["industries"]]))
        query = EquityQuery("and", filters)
        response = yf.screen(
            query,
            size=safe_limit,
            sortField=meta.get("sort") or "intradaymarketcap",
            sortAsc=False,
        )
        return _extract_symbols(response)

    try:
        tickers = await asyncio.wait_for(asyncio.to_thread(_screen_latest), timeout=12)
    except Exception as exc:
        logger.warning(f"Universe preset screener failed for {key}: {exc}")
        tickers = []

    if not tickers:
        payload = {
            "key": key,
            "label": UNIVERSE_PRESET_META.get(key, {}).get("label", key),
            "tickers": fallback[:safe_limit],
            "source": "fallback curated universe because yfinance screener was unavailable",
            "dynamic": False,
        }
    else:
        payload = {
            "key": key,
            "label": UNIVERSE_PRESET_META.get(key, {}).get("label", key),
            "tickers": tickers[:safe_limit],
            "source": "yfinance screener",
            "dynamic": True,
        }
    _set_cache(cache_key, payload)
    return payload

@app.get("/api/intelligence/peers/{ticker}")
async def ticker_peers(ticker: str, limit: int = 5):
    """Resolve comparable tickers using validated same-sector/industry discovery."""
    import yfinance as yf
    try:
        from yfinance import EquityQuery
    except Exception:
        EquityQuery = None

    symbol = str(ticker or "").upper().strip().replace("$", "")
    if not symbol:
        raise HTTPException(status_code=400, detail="Ticker is required")

    safe_limit = max(1, min(int(limit or 5), 10))
    cache_key = f"ticker_peers:{symbol}:{safe_limit}:v3"
    cached = _get_cached(cache_key, ttl=3600)
    if cached is not None:
        return cached

    sector = None
    industry = None
    company_name = None
    peers = []
    sources = []
    target_root = ""
    candidate_info_cache = {}

    def _clean_symbol(value):
        return str(value or "").upper().strip().replace("$", "")

    def _is_primary_us_symbol(value):
        cleaned = _clean_symbol(value)
        return bool(re.fullmatch(r"[A-Z][A-Z0-9\-]{0,5}", cleaned))

    def _candidate_matches_profile(candidate):
        if not (sector or industry):
            return True
        cleaned = _clean_symbol(candidate)
        if cleaned in candidate_info_cache:
            info = candidate_info_cache[cleaned]
        else:
            try:
                info = market_intel.get_ticker_info(cleaned) or {}
            except Exception:
                info = {}
            candidate_info_cache[cleaned] = info
        candidate_sector = (info or {}).get("sector")
        candidate_industry = (info or {}).get("industry")
        if industry:
            return candidate_industry == industry
        if sector and candidate_sector == sector:
            return True
        return False

    def _add_peer(candidate, source, candidate_name=None):
        raw = _clean_symbol(candidate)
        normalized = raw
        if not normalized or normalized == symbol:
            return
        if normalized.startswith(symbol):
            return
        if target_root and target_root in str(candidate_name or "").upper():
            return
        if normalized in COMMON_PEER_TOKEN_DENYLIST or normalized in UNIVERSE_SYMBOL_DENYLIST:
            return
        if not _is_primary_us_symbol(normalized):
            return
        if not _candidate_matches_profile(normalized):
            return
        if normalized not in peers:
            peers.append(normalized)
            if source not in sources:
                sources.append(source)

    def _yahoo_symbol_search(query: str):
        try:
            resp = requests.get(
                "https://query2.finance.yahoo.com/v1/finance/search",
                params={"q": query, "quotesCount": 6, "newsCount": 0},
                headers={"User-Agent": "Mozilla/5.0"},
                timeout=5,
            )
            if resp.status_code != 200:
                return []
            quotes = (resp.json() or {}).get("quotes") or []
            matches = []
            for quote in quotes:
                quote_type = str(quote.get("quoteType") or "").upper()
                symbol_value = str(quote.get("symbol") or "").upper().strip()
                name_value = str(quote.get("shortname") or quote.get("longname") or "").strip()
                if quote_type and quote_type != "EQUITY":
                    continue
                if symbol_value:
                    matches.append({"symbol": symbol_value, "name": name_value})
            return matches
        except Exception as exc:
            logger.warning("ticker_peers yahoo search failed for %s: %s", query, exc)
            return []

    try:
        info = await asyncio.wait_for(
            asyncio.to_thread(market_intel.get_ticker_info, symbol),
            timeout=4,
        )
        company_name = (info or {}).get("name") or (info or {}).get("shortName") or symbol
        sector = (info or {}).get("sector")
        industry = (info or {}).get("industry")
        target_root = re.sub(r"[^A-Z0-9]", "", str(company_name).upper().split(",")[0].split()[0]) if company_name else symbol
    except Exception as exc:
        logger.warning("ticker_peers info failed for %s: %s", symbol, exc)

    if len(peers) < safe_limit and EquityQuery is not None and (sector or industry):
        def _screen_peers():
            filters = [
                EquityQuery("eq", ["region", "us"]),
                EquityQuery("is-in", ["exchange", "NMS", "NYQ", "ASE"]),
                EquityQuery("gte", ["intradaymarketcap", 300_000_000]),
                EquityQuery("gte", ["intradayprice", 1]),
            ]
            if sector:
                filters.append(EquityQuery("eq", ["sector", sector]))
            if industry:
                filters.append(EquityQuery("eq", ["industry", industry]))
            response = yf.screen(
                EquityQuery("and", filters),
                size=max(safe_limit + 8, 16),
                sortField="intradaymarketcap",
                sortAsc=False,
            )
            return (response or {}).get("quotes") or []

        try:
            quotes = await asyncio.wait_for(asyncio.to_thread(_screen_peers), timeout=7)
            for quote in quotes:
                _add_peer(quote.get("symbol"), "yfinance screener")
                if len(peers) >= safe_limit:
                    break
        except Exception as exc:
            logger.warning("ticker_peers screener failed for %s: %s", symbol, exc)

    if len(peers) < safe_limit and company_name:
        for match in _yahoo_symbol_search(f"{company_name} competitors {industry or sector or ''}"):
            _add_peer(match.get("symbol"), "Yahoo symbol lookup", match.get("name"))
            if len(peers) >= safe_limit:
                break

    payload = {
        "ticker": symbol,
        "peers": peers[:safe_limit],
        "name": company_name,
        "sector": sector,
        "industry": industry,
        "source": " + ".join(sources) if sources else "none",
        "note": "Peers are restricted to primary US-style equity symbols and validated against the target sector or industry when profile data is available. No ticker-specific hardcoded peer list is used.",
    }
    _set_cache(cache_key, payload)
    return payload

@app.post("/api/intelligence/trading-signal")
async def trading_signal(request: TradingSignalRequest):
    """Compute candle/volume signal stats for a batch of tickers."""
    import yfinance as yf
    tickers = []
    seen = set()
    for ticker in request.tickers or []:
        symbol = str(ticker).upper().strip()
        if symbol and symbol not in seen:
            tickers.append(symbol)
            seen.add(symbol)
    if not tickers:
        return {"signals": []}

    period = request.period or "3mo"
    interval = request.interval or "1d"

    def _signal_from_frame(ticker: str, frame):
        try:
            if frame is None or frame.empty:
                return {"ticker": ticker, "error": "No data available"}
            required = {"Open", "High", "Low", "Close"}
            if not required.issubset(set(frame.columns)):
                return {"ticker": ticker, "error": "Incomplete OHLC data"}
            clean = frame.dropna(subset=["Open", "High", "Low", "Close"]).copy()
            if clean.empty:
                return {"ticker": ticker, "error": "Incomplete OHLC data"}
            clean = clean.tail(80)
            open_s = clean["Open"].astype(float)
            high_s = clean["High"].astype(float)
            low_s = clean["Low"].astype(float)
            close_s = clean["Close"].astype(float)
            body_pct = (close_s - open_s) / open_s.replace(0, pd.NA) * 100
            close_return_pct = close_s.pct_change(fill_method=None) * 100
            usable_returns = close_return_pct.dropna()
            range_pct = (high_s - low_s) / open_s.replace(0, pd.NA) * 100
            up_moves = usable_returns[usable_returns > 0]
            down_moves = usable_returns[usable_returns < 0]
            last = clean.iloc[-1]
            last_open = float(last["Open"])
            last_high = float(last["High"])
            last_low = float(last["Low"])
            last_close = float(last["Close"])
            current_move = _safe_float(close_return_pct.iloc[-1])
            if current_move is None:
                current_move = _safe_float(body_pct.iloc[-1])
            current_range = (last_high - last_low) / last_open * 100 if last_open else None
            avg_range = _safe_float(range_pct.mean())
            avg_abs_move = _safe_float(usable_returns.abs().mean())
            range_score = (current_range / avg_range) if avg_range and current_range is not None else None
            move_score = (abs(current_move) / avg_abs_move) if avg_abs_move and current_move is not None else None
            close_location = ((last_close - last_low) / (last_high - last_low) * 100) if last_high != last_low else 50
            volume_ratio = None
            if "Volume" in clean.columns:
                vol = clean["Volume"].dropna().astype(float)
                if len(vol) >= 5:
                    avg_vol = vol.tail(20).mean()
                    volume_ratio = float(vol.iloc[-1] / avg_vol) if avg_vol else None
            max_up = _safe_float(usable_returns.max())
            max_down = _safe_float(usable_returns.min())
            avg_up = _safe_float(up_moves.mean())
            avg_down = _safe_float(down_moves.mean())

            if current_move is None:
                label = "No signal"
            elif move_score and move_score >= 1.8 and volume_ratio and volume_ratio >= 1.2:
                label = "Confirmed momentum"
            elif move_score and move_score >= 1.8:
                label = "Abnormal move"
            elif close_location >= 75 and current_move > 0:
                label = "Strong close"
            elif close_location <= 25 and current_move < 0:
                label = "Weak close"
            else:
                label = "Normal movement"

            return _sanitize_nan({
                "ticker": ticker,
                "price": round(last_close, 2),
                "current_move_pct": round(current_move, 3) if current_move is not None else None,
                "current_range_pct": round(current_range, 3) if current_range is not None else None,
                "avg_range_pct": round(avg_range, 3) if avg_range is not None else None,
                "avg_up_pct": round(avg_up, 3) if avg_up is not None else None,
                "avg_down_pct": round(avg_down, 3) if avg_down is not None else None,
                "max_up_pct": round(max_up, 3) if max_up is not None else None,
                "max_down_pct": round(max_down, 3) if max_down is not None else None,
                "move_basis": "close_to_previous_close",
                "move_score": round(move_score, 2) if move_score is not None else None,
                "range_score": round(range_score, 2) if range_score is not None else None,
                "volume_ratio": round(volume_ratio, 2) if volume_ratio is not None else None,
                "close_location_pct": round(close_location, 1),
                "label": label,
                "samples": int(usable_returns.count()),
            })
        except Exception as exc:
            logger.warning(f"trading_signal({ticker}) failed: {exc}")
            return {"ticker": ticker, "error": str(exc)}

    try:
        dataset = await asyncio.to_thread(
            _locked_yf_download,
            yf,
            tickers,
            period=period,
            interval=interval,
            group_by="ticker",
            progress=False,
            auto_adjust=False,
            threads=True,
        )
    except Exception as exc:
        logger.warning(f"trading signal batch download failed: {exc}")
        return {"signals": [{"ticker": t, "error": str(exc)} for t in tickers]}

    signals = []
    for ticker in tickers:
        frame = _extract_yf_ticker_frame(dataset, ticker)
        signals.append(_signal_from_frame(ticker, frame))
    return {"signals": signals, "period": period, "interval": interval}


# Simple TTL cache for yfinance data to reduce rate limiting
_yf_cache = {}
_yf_cache_lock = threading.Lock()
_yf_download_lock = threading.Lock()
YF_CACHE_TTL = 300  # seconds

def _get_cached(key: str, ttl: int = None):
    """Get cached value if still fresh."""
    with _yf_cache_lock:
        if key in _yf_cache:
            ts, val = _yf_cache[key]
            if time.time() - ts < (ttl or YF_CACHE_TTL):
                return val
    return None

def _set_cache(key: str, value):
    with _yf_cache_lock:
        _yf_cache[key] = (time.time(), value)

def _locked_yf_download(yf_module, tickers, **kwargs):
    with _yf_download_lock:
        return yf_module.download(tickers, **kwargs)

def _fetch_with_retry(fetch_func, max_retries=2, base_delay=1.0):
    """Execute a fetch function with retry and backoff."""
    for attempt in range(max_retries):
        result = fetch_func()
        if result is not None:
            return result
        if attempt < max_retries - 1:
            delay = base_delay * (attempt + 1) + random.uniform(0, 0.5)
            time.sleep(delay)
    return None

INDUSTRY_ETFS = {
    # Broad Market
    "SPY": {"name": "S&P 500", "sector": "Broad Market", "industry": "Large Cap"},
    "QQQ": {"name": "NASDAQ 100", "sector": "Broad Market", "industry": "Tech/Growth"},
    "IWM": {"name": "Russell 2000", "sector": "Broad Market", "industry": "Small Cap"},
    # Technology
    "XLK": {"name": "Technology Select", "sector": "Technology", "industry": "Broad Technology"},
    "SMH": {"name": "Semiconductors", "sector": "Technology", "industry": "Semiconductors"},
    "IGV": {"name": "Software", "sector": "Technology", "industry": "Software"},
    "FDN": {"name": "Internet", "sector": "Technology", "industry": "Internet"},
    # Financials
    "XLF": {"name": "Financial Select", "sector": "Financial Services", "industry": "Broad Financials"},
    "KBE": {"name": "Bank ETF", "sector": "Financial Services", "industry": "Banks"},
    "KRE": {"name": "Regional Banks", "sector": "Financial Services", "industry": "Regional Banks"},
    # Healthcare
    "XLV": {"name": "Healthcare Select", "sector": "Healthcare", "industry": "Broad Healthcare"},
    "XBI": {"name": "Biotech", "sector": "Healthcare", "industry": "Biotechnology"},
    "IHI": {"name": "Medical Devices", "sector": "Healthcare", "industry": "Medical Devices"},
    # Energy
    "XLE": {"name": "Energy Select", "sector": "Energy", "industry": "Broad Energy"},
    "OIH": {"name": "Oil Services", "sector": "Energy", "industry": "Oil Services"},
    "XOP": {"name": "Oil & Gas E&P", "sector": "Energy", "industry": "Oil Exploration"},
    # Consumer
    "XLY": {"name": "Consumer Disc.", "sector": "Consumer Cyclical", "industry": "Broad Discretionary"},
    "XLP": {"name": "Consumer Staples", "sector": "Consumer Defensive", "industry": "Broad Staples"},
    "XRT": {"name": "Retail", "sector": "Consumer Cyclical", "industry": "Retail"},
    # Industrials
    "XLI": {"name": "Industrial Select", "sector": "Industrials", "industry": "Broad Industrials"},
    # Materials
    "XLB": {"name": "Materials Select", "sector": "Basic Materials", "industry": "Broad Materials"},
    # Real Estate
    "XLRE": {"name": "Real Estate Select", "sector": "Real Estate", "industry": "Broad Real Estate"},
    "RWR": {"name": "REIT ETF", "sector": "Real Estate", "industry": "REITs"},
    # Utilities
    "XLU": {"name": "Utilities Select", "sector": "Utilities", "industry": "Broad Utilities"},
    # Communication
    "XLC": {"name": "Comm. Services", "sector": "Communication Services", "industry": "Broad Communication"},
}


def _calc_change_pct(ticker: str, period: str, interval: str = None, extended: bool = False):
    """Calculate return for a ticker over a given period using yfinance history."""
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        kwargs = {"period": "2d" if (not interval and period == "1d") else period}
        if interval:
            kwargs["period"] = "1d"
            kwargs["interval"] = interval
            if extended:
                kwargs["prepost"] = True
        hist = t.history(**kwargs)
        if hist.empty or "Close" not in hist:
            return None, None, None
        if interval:
            vals, _, _session_label = _session_anchored_intraday_values(hist, extended)
            if vals is None or len(vals) < 1:
                return None, None, None
            end = vals[-1]
            start = vals[0] if len(vals) >= 2 else None
            if start is None:
                return None, round(end, 2), None
        else:
            close = hist["Close"]
            end = close.iloc[-1]
            if period == "1d":
                start = close.iloc[0] if len(close) < 2 else close.iloc[-2]
            else:
                start = close.iloc[0]
        if not start or not end:
            return None, None, None
        pct = round((end - start) / start * 100, 2)
        price = round(end, 2)
        change = round(end - start, 2)
        return pct, price, change
    except Exception as e:
        logger.warning(f"_calc_change_pct({ticker}, {period}): {e}")
        return None, None, None

def _fetch_etf_quote_raw(ticker: str, period: str = "1d", interval: str = None, extended: bool = False) -> dict:
    """Fetch quote data for an industry ETF (no cache/retry)."""
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        info = t.info
        if interval and extended:
            change_pct, price, change = _calc_change_pct(ticker, period, interval, extended)
            if change_pct is None:
                price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
        elif not interval and extended:
            pct = info.get("postMarketChangePercent") or info.get("preMarketChangePercent")
            if pct is not None:
                change_pct = pct
                price = info.get("postMarketPrice") or info.get("preMarketPrice") or info.get("regularMarketPrice") or info.get("previousClose")
                change = round(price - info.get("previousClose"), 2) if price and info.get("previousClose") else None
            else:
                change_pct, price, change = _calc_change_pct(ticker, period, interval)
                if change_pct is None:
                    price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
                    change = round(price - info.get("previousClose"), 2) if price and info.get("previousClose") else None
                    change_pct = info.get("regularMarketChangePercent")
        else:
            change_pct, price, change = _calc_change_pct(ticker, period, interval)
            if change_pct is None:
                price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
                change = round(price - info.get("previousClose"), 2) if price and info.get("previousClose") else None
                change_pct = info.get("regularMarketChangePercent")
        if change_pct is not None:
            change_pct = round(change_pct, 2)
        market_cap = info.get("marketCap")
        volume = info.get("volume")
        return {
            "ticker": ticker,
            "price": round(price, 2) if price else None,
            "change": change,
            "change_percent": change_pct,
            "market_cap": market_cap,
            "volume": volume,
        }
    except Exception as e:
        logger.warning(f"_fetch_etf_quote({ticker}): {e}")
        return None

def _fetch_etf_quote(ticker: str, period: str = "1d", interval: str = None, extended: bool = False) -> dict:
    """Fetch ETF quote with caching and retry."""
    cache_key = f"etf:{ticker}:{period}:{interval or 'auto'}:ext={int(extended)}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached
    result = _fetch_with_retry(lambda: _fetch_etf_quote_raw(ticker, period, interval, extended))
    if result is not None:
        _set_cache(cache_key, result)
    return result

def _extract_yf_ticker_frame(dataset, ticker: str):
    """Return one ticker's OHLCV frame from a yfinance single/multi ticker download."""
    try:
        import pandas as pd
        if dataset is None or dataset.empty:
            return None
        if isinstance(dataset.columns, pd.MultiIndex):
            if ticker in dataset.columns.get_level_values(0):
                return dataset[ticker]
            if ticker in dataset.columns.get_level_values(-1):
                return dataset.xs(ticker, axis=1, level=-1)
            return None
        return dataset
    except Exception:
        return None

def _last_valid_close(frame):
    try:
        if frame is None or frame.empty or "Close" not in frame:
            return None
        vals = frame["Close"].dropna()
        if vals.empty:
            return None
        return float(vals.iloc[-1])
    except Exception:
        return None

def _previous_daily_close(frame):
    """Pick the last completed daily close before today's US session."""
    try:
        import pandas as pd
        if frame is None or frame.empty or "Close" not in frame:
            return None
        close = frame["Close"].dropna()
        if close.empty:
            return None
        today_et = pd.Timestamp.now(tz="America/New_York").date()
        previous = []
        for idx, value in close.items():
            idx_date = pd.Timestamp(idx).date()
            if idx_date < today_et:
                previous.append(float(value))
        if previous:
            return previous[-1]
        if len(close) >= 2:
            return float(close.iloc[-2])
        return float(close.iloc[0])
    except Exception:
        return None

def _frame_index_as_et(frame):
    """Return a DatetimeIndex converted/localized to America/New_York."""
    import pandas as pd
    idx = pd.DatetimeIndex(frame.index)
    if idx.tz is None:
        return idx.tz_localize("America/New_York")
    return idx.tz_convert("America/New_York")

def _extended_session_start_timestamp(now_et=None):
    """Pick the active US extended-hours session anchor.

    Premarket anchors at 04:00 ET. After-hours anchors at 16:00 ET. During the
    regular session, an extended-hours view anchors at 04:00 ET so the move
    includes premarket plus regular trading.
    """
    import pandas as pd
    now_et = now_et or pd.Timestamp.now(tz="America/New_York")
    session_date = now_et.date()
    market_open = pd.Timestamp.combine(session_date, pd.Timestamp("09:30").time()).tz_localize("America/New_York")
    market_close = pd.Timestamp.combine(session_date, pd.Timestamp("16:00").time()).tz_localize("America/New_York")
    premarket_open = pd.Timestamp.combine(session_date, pd.Timestamp("04:00").time()).tz_localize("America/New_York")
    if now_et >= market_close:
        return market_close, "after_hours"
    if now_et >= market_open:
        return premarket_open, "extended_day"
    if now_et >= premarket_open:
        return premarket_open, "premarket"
    previous_day = session_date - timedelta(days=1)
    previous_close = pd.Timestamp.combine(previous_day, pd.Timestamp("16:00").time()).tz_localize("America/New_York")
    return previous_close, "overnight"

def _session_anchored_intraday_values(frame, extended: bool = False):
    """Return close/volume arrays anchored to the active intraday session."""
    if frame is None or frame.empty or "Close" not in frame:
        return None, None, None
    import pandas as pd
    working = frame.copy()
    if extended:
        try:
            start_ts, session_label = _extended_session_start_timestamp()
            et_index = _frame_index_as_et(working)
            mask = et_index >= start_ts
            if mask.any():
                working = working.loc[mask]
            return working["Close"].dropna().values, working.get("Volume"), session_label
        except Exception as exc:
            logger.warning("extended session anchor failed: %s", exc)
            return working["Close"].dropna().values, working.get("Volume"), "extended_day"
    return working["Close"].dropna().values, working.get("Volume"), "regular_or_period"

def _enrich_with_daily_stats(built: dict, frame) -> None:
    if frame is None or "Close" not in frame:
        return
    try:
        vals = frame["Close"].dropna().values
        if len(vals) < 2:
            return
        daily_returns = [(vals[i] - vals[i-1]) / vals[i-1] * 100 for i in range(1, len(vals))]
        avg_abs = sum(abs(r) for r in daily_returns) / len(daily_returns)
        built["avg_daily_move_pct"] = round(avg_abs, 3)
        cp = built.get("change_percent")
        if cp is not None and avg_abs > 0:
            built["move_strength"] = round(cp / avg_abs, 2)
        vol_vals = frame["Volume"].dropna().values if "Volume" in frame else None
        if vol_vals is not None and len(vol_vals) > 0:
            built["avg_volume"] = int(vol_vals.mean())
    except Exception:
        pass


def _build_intraday_change(latest_price, previous_close, volume=None):
    if latest_price is None or previous_close in (None, 0):
        return None
    change = float(latest_price) - float(previous_close)
    return {
        "price": float(latest_price),
        "change_percent": change / float(previous_close) * 100,
        "change": change,
        "volume": int(volume) if volume is not None else None,
    }

async def _bulk_price_changes(tickers: List[str], period: str = "1d", interval: str = None, extended: bool = False) -> dict:
    """Fetch price/change data for many tickers with live intraday handling for 1D."""
    import yfinance as yf
    loop = asyncio.get_event_loop()
    clean_tickers = [str(t).upper().strip() for t in tickers if str(t).strip()]
    if not clean_tickers:
        return {}

    prices = {}
    try:
        if not interval and period == "1d":
            def download_intraday_and_daily():
                with _yf_download_lock:
                    intraday_data = yf.download(
                        clean_tickers,
                        period="1d",
                        interval="1m",
                        group_by='ticker',
                        progress=False,
                        auto_adjust=False,
                        prepost=extended,
                        threads=True,
                    )
                    daily_data = yf.download(
                        clean_tickers,
                        period="5d",
                        interval="1d",
                        group_by='ticker',
                        progress=False,
                        auto_adjust=False,
                        threads=True,
                    )
                    return intraday_data, daily_data

            intraday, daily = await loop.run_in_executor(None, download_intraday_and_daily)
            for ticker in clean_tickers:
                try:
                    intraday_frame = _extract_yf_ticker_frame(intraday, ticker)
                    daily_frame = _extract_yf_ticker_frame(daily, ticker)
                    latest = _last_valid_close(intraday_frame)
                    previous = _previous_daily_close(daily_frame)
                    volume = None
                    if intraday_frame is not None and "Volume" in intraday_frame:
                        vol_vals = intraday_frame["Volume"].dropna().values
                        volume = vol_vals.sum() if len(vol_vals) > 0 else None
                    built = _build_intraday_change(latest, previous, volume)
                    if built is not None:
                        _enrich_with_daily_stats(built, daily_frame)
                        prices[ticker] = built
                except Exception:
                    pass
        else:
            kwargs = {"period": period, "group_by": 'ticker', "progress": False, "auto_adjust": True, "threads": True}
            if interval:
                kwargs["period"] = "1d"
                kwargs["interval"] = interval
                if extended:
                    kwargs["prepost"] = True
            bulk = await loop.run_in_executor(None, lambda: _locked_yf_download(yf, clean_tickers, **kwargs))
            if bulk is not None and not bulk.empty:
                for ticker in clean_tickers:
                    try:
                        frame = _extract_yf_ticker_frame(bulk, ticker)
                        if frame is None or "Close" not in frame:
                            continue
                        vals, volume_series, session_label = _session_anchored_intraday_values(frame, extended and bool(interval))
                        vol_vals = volume_series.dropna().values if volume_series is not None else None
                        if len(vals) >= 2 and vals[0]:
                            built = {
                                "price": float(vals[-1]),
                                "change_percent": (vals[-1] - vals[0]) / vals[0] * 100,
                                "change": float(vals[-1] - vals[0]),
                                "volume": int(vol_vals[-1]) if vol_vals is not None and len(vol_vals) > 0 else None,
                                "session": session_label,
                            }
                            _enrich_with_daily_stats(built, frame)
                            prices[ticker] = built
                        elif len(vals) == 1:
                            prices[ticker] = {"price": float(vals[0]), "change_percent": None, "change": None, "volume": None}
                    except Exception:
                        pass
    except Exception as e:
        logger.warning(f"_bulk_price_changes failed: {e}")
    return prices


@app.post("/api/intelligence/industry-heatmap")
async def industry_heatmap(tickers: Optional[List[str]] = Body(None), period: str = "1d", interval: str = None, extended: bool = False):
    """Get industry ETF heatmap grouped by sector/industry"""
    import yfinance as yf
    loop = asyncio.get_event_loop()
    requested = [str(t).upper().strip() for t in (tickers or []) if str(t).strip()]
    etf_tickers = [t for t in requested if t in INDUSTRY_ETFS] if requested else list(INDUSTRY_ETFS.keys())

    # Bulk download all ETF prices in a single yfinance call (dramatically faster)
    all_prices = {}
    all_prices = await _bulk_price_changes(etf_tickers, period, interval, extended)

    if not all_prices:
        try:
            dl_period = "2d" if (not interval and period == "1d") else period
            dl_kwargs = {"period": dl_period, "group_by": 'ticker', "progress": False, "auto_adjust": True}
            if interval:
                dl_kwargs["period"] = "1d"
                dl_kwargs["interval"] = interval
                if extended:
                    dl_kwargs["prepost"] = True
            bulk = await loop.run_in_executor(None, lambda: _locked_yf_download(yf, etf_tickers, **dl_kwargs))
            if bulk is not None and not bulk.empty:
                for t in etf_tickers:
                    try:
                        col = _extract_yf_ticker_frame(bulk, t)
                        if col is not None and 'Close' in col.columns:
                            vals = col['Close'].dropna().values
                            vol_vals = col['Volume'].dropna().values if 'Volume' in col.columns else None
                            if len(vals) >= 2:
                                all_prices[t] = {
                                    "price": float(vals[-1]),
                                    "change_percent": (vals[-1] - vals[-2]) / vals[-2] * 100,
                                    "change": float(vals[-1] - vals[-2]),
                                    "volume": int(vol_vals[-1]) if vol_vals is not None and len(vol_vals) > 0 else None,
                                }
                            elif len(vals) == 1:
                                all_prices[t] = {"price": float(vals[0]), "change_percent": None, "change": None, "volume": None}
                    except Exception:
                        pass
        except Exception:
            pass

    results = []
    for ticker in etf_tickers:
        prefetched = all_prices.get(ticker)
        if prefetched is not None:
            results.append(prefetched)
        else:
            # Fallback to per-ticker fetch for any tickers download() missed
            cached = _get_cached(f"etf:{ticker}:{period}:{interval or 'auto'}:ext={int(extended)}")
            if cached is not None:
                results.append(cached)
            else:
                r = _fetch_with_retry(lambda t=ticker, p=period, iv=interval, ex=extended: _fetch_etf_quote_raw(t, p, iv, ex))
                if r is not None:
                    _set_cache(f"etf:{ticker}:{period}:{interval or 'auto'}:ext={int(extended)}", r)
                results.append(r)

    sectors = {}
    for ticker, res in zip(etf_tickers, results):
        if isinstance(res, Exception) or res is None:
            continue
        meta = INDUSTRY_ETFS[ticker]
        sector = meta["sector"]
        industry = meta["industry"]
        entry = {
            "ticker": ticker,
            "name": meta["name"],
            "price": res.get("price"),
            "change": res.get("change"),
            "change_percent": round(res.get("change_percent"), 2) if res.get("change_percent") is not None else None,
            "market_cap": res.get("market_cap"),
            "volume": res.get("volume"),
        }
        if sector not in sectors:
            sectors[sector] = {}
        if industry not in sectors[sector]:
            sectors[sector][industry] = []
        sectors[sector][industry].append(entry)
    return {"sectors": sectors}


@app.post("/api/intelligence/sector-heatmap")
async def sector_heatmap(tickers: List[str], period: str = "1d", interval: str = None, extended: bool = False):
    """Get sector/industry breakdown with performance for a list of tickers (parallelized)"""
    loop = asyncio.get_event_loop()
    # Fetch price data for all tickers at once via download
    all_prices = {}
    try:
        fetched_prices = await _bulk_price_changes(tickers, period, interval, extended)
        all_prices = {
            ticker: {"price": data.get("price"), "change_pct": data.get("change_percent"), "change": data.get("change")}
            for ticker, data in fetched_prices.items()
        }
    except:
        pass

    # Fetch sector info + fallback price per ticker
    BATCH_SIZE = int(os.getenv("HEATMAP_BATCH_SIZE", "50"))
    results = []
    for i in range(0, len(tickers), BATCH_SIZE):
        batch = tickers[i:i+BATCH_SIZE]
        tasks = [loop.run_in_executor(None, lambda t=t, p=period, iv=interval, ex=extended: _fetch_sector_info_fast(t, p, iv, ex, all_prices.get(t))) for t in batch]
        batch_results = await asyncio.gather(*tasks, return_exceptions=True)
        results.extend(batch_results)
    sectors = {}
    for ticker, res in zip(tickers, results):
        if isinstance(res, Exception) or res is None:
            continue
        sector = res.get("sector", "Other")
        industry = res.get("industry", "Other")
        entry = {
            "ticker": ticker,
            "name": res.get("name"),
            "price": _safe_float(res.get("price")),
            "change": _safe_float(res.get("change")),
            "change_percent": _safe_float(res.get("change_percent")),
            "market_cap": _safe_float(res.get("market_cap")),
            "volume": _safe_float(res.get("volume")),
        }
        if sector not in sectors:
            sectors[sector] = {}
        if industry not in sectors[sector]:
            sectors[sector][industry] = []
        sectors[sector][industry].append(entry)
    return {"sectors": sectors}


def _fetch_sector_info_fast(ticker: str, period: str = "1d", interval: str = None, extended: bool = False, prefetched: dict = None) -> dict:
    """Fetch sector info with caching; uses pre-fetched price data if available."""
    cache_key = f"sector:{ticker}:{period}:{interval or 'auto'}:ext={int(extended)}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached
    result = _fetch_with_retry(lambda: _fetch_sector_info_raw(ticker, period, interval, extended, prefetched))
    if result is not None:
        _set_cache(cache_key, result)
    return result


def _fetch_sector_info_raw(ticker: str, period: str = "1d", interval: str = None, extended: bool = False, prefetched: dict = None) -> dict:
    """Fetch sector/industry + quote for a single ticker (no cache/retry)."""
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        info = t.info
        sector = info.get("sector", "Other") or "Other"
        industry = info.get("industry", "Other") or "Other"
        # Use pre-fetched price if available, otherwise compute
        if prefetched and prefetched.get("price") is not None:
            price = prefetched.get("price")
            change = prefetched.get("change")
            change_pct = prefetched.get("change_pct")
        else:
            if interval and extended:
                change_pct, price, change = _calc_change_pct(ticker, period, interval, extended)
                if change_pct is None:
                    price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
            elif not interval and extended:
                pct = info.get("postMarketChangePercent") or info.get("preMarketChangePercent")
                if pct is not None:
                    change_pct = pct
                    price = info.get("postMarketPrice") or info.get("preMarketPrice") or info.get("regularMarketPrice") or info.get("previousClose")
                    change = round(price - info.get("previousClose"), 2) if price and info.get("previousClose") else None
                else:
                    change_pct, price, change = _calc_change_pct(ticker, period, interval)
                    if change_pct is None:
                        price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
                        change = round(price - info.get("previousClose"), 2) if price and info.get("previousClose") else None
                        change_pct = info.get("regularMarketChangePercent")
            else:
                change_pct, price, change = _calc_change_pct(ticker, period, interval)
                if change_pct is None:
                    price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
                    change = round(price - info.get("previousClose"), 2) if price and info.get("previousClose") else None
                    change_pct = info.get("regularMarketChangePercent")
        if change_pct is not None:
            change_pct = round(change_pct, 2)
        market_cap = info.get("marketCap")
        return {
            "sector": sector,
            "industry": industry,
            "name": info.get("shortName") or info.get("longName") or ticker,
            "price": round(price, 2) if price else None,
            "change": change,
            "change_percent": change_pct,
            "market_cap": market_cap,
            "volume": info.get("volume") or info.get("regularMarketVolume"),
        }
    except Exception as e:
        logger.warning(f"_fetch_sector_info({ticker}): {e}")
        return None

def _fetch_sector_info(ticker: str, period: str = "1d", interval: str = None, extended: bool = False) -> dict:
    """Fetch sector info with caching and retry."""
    cache_key = f"sector:{ticker}:{period}:{interval or 'auto'}:ext={int(extended)}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached
    result = _fetch_with_retry(lambda: _fetch_sector_info_raw(ticker, period, interval, extended))
    if result is not None:
        _set_cache(cache_key, result)
    return result


@app.post("/api/intelligence/etf-holdings")
async def etf_holdings(etf_tickers: List[str], period: str = "1d", interval: str = None, extended: bool = False):
    """Get top holdings of one or more ETFs with per-stock performance data."""
    loop = asyncio.get_event_loop()
    results = {}
    for etf_ticker in etf_tickers:
        try:
            cache_key = f"holdings:{etf_ticker}:{period}:{interval or 'auto'}:ext={int(extended)}"
            cached = _get_cached(cache_key)
            if cached is not None:
                results[etf_ticker] = _sanitize_nan(cached)
                continue
            import yfinance as yf
            t = yf.Ticker(etf_ticker)
            holdings = {}
            holding_names = {}
            try:
                td = t.funds_data.top_holdings
                if td is not None and not td.empty:
                    for sym, row in td.iterrows():
                        if not sym:
                            continue
                        holding_names[sym] = row.get("Name", "")
                        pct = _safe_float(row.get("Holding Percent"))
                        if pct is not None:
                            holdings[sym] = pct * 100
            except Exception as e:
                logger.warning(f"top_holdings({etf_ticker}): {e}")
            top = sorted(holdings.items(), key=lambda x: x[1], reverse=True)[:50]
            holding_results = []
            tickers_to_fetch = [sym for sym, _ in top]
            price_changes = await _bulk_price_changes(tickers_to_fetch, period, interval, extended)
            missing = [sym for sym in tickers_to_fetch if sym not in price_changes]
            fallback_changes = {}
            if missing:
                BATCH = 5
                for i in range(0, len(missing), BATCH):
                    batch = missing[i:i+BATCH]
                    tasks = [loop.run_in_executor(None, lambda s=s, p=period, iv=interval, ex=extended: _calc_change_pct(s, p, iv, ex)) for s in batch]
                    batch_results = await asyncio.gather(*tasks, return_exceptions=True)
                    for sym, r in zip(batch, batch_results):
                        if isinstance(r, Exception) or r is None:
                            continue
                        pct, price, change = r
                        fallback_changes[sym] = {"change_percent": pct, "price": price, "change": change}
                    if i + BATCH < len(missing):
                        await asyncio.sleep(0.5)

            for sym in tickers_to_fetch:
                quote = price_changes.get(sym) or fallback_changes.get(sym) or {}
                pct = _safe_float(quote.get("change_percent"))
                price = _safe_float(quote.get("price"))
                change = _safe_float(quote.get("change"))
                holding_results.append({
                    "ticker": sym,
                    "name": holding_names.get(sym, ""),
                    "weight": round(_safe_float(holdings.get(sym)) or 0, 4),
                    "change_percent": round(pct, 4) if pct is not None else None,
                    "price": round(price, 2) if price is not None else None,
                    "change": round(change, 2) if change is not None else None,
                })
            holding_results = _sanitize_nan(holding_results)
            if any(item.get("price") is not None or item.get("change_percent") is not None for item in holding_results):
                _set_cache(cache_key, holding_results)
            results[etf_ticker] = holding_results
        except Exception as e:
            logger.warning(f"etf_holdings({etf_ticker}): {e}")
            results[etf_ticker] = []
    return _sanitize_nan({"holdings": results})


class InsiderTradesRequest(BaseModel):
    tickers: List[str] = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "JPM", "V", "WMT"]
    limit: int = 50
    offset: int = 0
    days_back: int = 365

@app.post("/api/intelligence/insider-trades")
async def get_insider_trades(req: InsiderTradesRequest):
    """Get recent insider buy/sell transactions for a list of tickers with pagination"""
    return market_intel.get_insider_transactions(req.tickers, req.limit, req.offset, req.days_back)

@app.get("/api/intelligence/chart/{ticker}")
async def get_chart_data(ticker: str, period: str = "1mo", interval: str = "1d"):
    """Get OHLCV chart data for a ticker — used by the AI chat chart renderer"""
    try:
        import yfinance as yf
        t = yf.Ticker(ticker.upper())
        hist = t.history(period=period, interval=interval)
        if hist.empty:
            raise HTTPException(status_code=404, detail=f"No data for {ticker}")
        hist = hist.reset_index()
        # Normalise datetime column name (yfinance returns 'Datetime' for intraday, 'Date' for daily)
        date_col = 'Datetime' if 'Datetime' in hist.columns else 'Date'
        bars = []
        for _, row in hist.iterrows():
            bars.append({
                "date": str(row[date_col])[:10],
                "open": round(float(row["Open"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "close": round(float(row["Close"]), 4),
                "volume": int(row["Volume"]),
            })
        return {"symbol": ticker.upper(), "period": period, "interval": interval, "bars": bars}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class MarketLookupRequest(BaseModel):
    ticker: str
    lookup_type: str = "quote"   # quote | technicals | news | chart | full | fundamentals
    period: Optional[str] = "1mo"
    interval: Optional[str] = "1d"

def _has_error(data) -> bool:
    """Check if an API result contains an error or empty data."""
    if data is None:
        return True
    if isinstance(data, dict) and "error" in data:
        return True
    if isinstance(data, list) and len(data) == 0:
        return True
    return False


async def _mcp_fallback(ticker: str, lt: str, period: str = "1mo", interval: str = "1d") -> Optional[Dict]:
    """Try to satisfy a lookup via yfinance MCP. Returns shaped result or None."""
    # Map lookup_type → MCP tool name + args
    tool_map = {
        "quote":      ("get_stock_info",    {"symbol": ticker}),
        "technicals": ("get_stock_info",    {"symbol": ticker}),
        "fundamentals": ("get_stock_info",  {"symbol": ticker}),
        "news":       ("get_stock_news",    {"symbol": ticker}),
        "chart":      ("get_price_history", {"symbol": ticker, "period": period, "interval": interval}),
        "full":       ("get_stock_info",    {"symbol": ticker}),
    }
    if lt not in tool_map:
        return None

    tool_name, args = tool_map[lt]
    result = await yf_mcp.call_tool(tool_name, args)
    if not result:
        return None

    logger.info(f"yfmcp fallback used for {ticker}/{lt}")

    # Shape the MCP result to match our internal format
    if lt == "quote":
        info = result if isinstance(result, dict) else {}
        return {
            "type": "quote", "source": "mcp",
            "data": {
                "symbol": ticker,
                "name": info.get("longName") or info.get("shortName", ticker),
                "price": info.get("currentPrice") or info.get("regularMarketPrice"),
                "change": info.get("regularMarketChange"),
                "change_percent": info.get("regularMarketChangePercent"),
                "volume": info.get("regularMarketVolume") or info.get("volume"),
                "high": info.get("regularMarketDayHigh") or info.get("dayHigh"),
                "low": info.get("regularMarketDayLow") or info.get("dayLow"),
                "open": info.get("regularMarketOpen") or info.get("open"),
                "previous_close": info.get("regularMarketPreviousClose") or info.get("previousClose"),
                "market_cap": info.get("marketCap"),
                "pe_ratio": info.get("trailingPE"),
            }
        }
    elif lt == "news":
        items = result if isinstance(result, list) else result.get("articles", [])
        return {
            "type": "news", "source": "mcp",
            "data": [{"title": a.get("title"), "publisher": a.get("publisher") or a.get("source"),
                      "link": a.get("link") or a.get("url"), "published": a.get("providerPublishTime")}
                     for a in items[:5]]
        }
    elif lt == "chart":
        bars = result if isinstance(result, list) else result.get("bars") or result.get("data", [])
        return {"type": "chart", "symbol": ticker, "source": "mcp", "data": bars}
    elif lt == "fundamentals":
        info = result if isinstance(result, dict) else {}
        return {
            "type": "fundamentals", "source": "mcp",
            "data": {
                "symbol": ticker,
                "name": info.get("longName") or info.get("shortName", ticker),
                "market_cap": info.get("marketCap"),
                "enterprise_value": info.get("enterpriseValue"),
                "trailing_pe": info.get("trailingPE"),
                "forward_pe": info.get("forwardPE"),
                "peg_ratio": info.get("pegRatio"),
                "price_to_sales": info.get("priceToSalesTrailing12Months"),
                "price_to_book": info.get("priceToBook"),
                "enterprise_to_revenue": info.get("enterpriseToRevenue"),
                "enterprise_to_ebitda": info.get("enterpriseToEbitda"),
                "profit_margin": info.get("profitMargins"),
                "operating_margin": info.get("operatingMargins"),
                "revenue_growth": info.get("revenueGrowth"),
                "earnings_growth": info.get("earningsGrowth"),
                "earnings_quarterly_growth": info.get("earningsQuarterlyGrowth"),
                "eps_trailing_12m": info.get("trailingEps"),
                "eps_forward": info.get("forwardEps"),
                "beta": info.get("beta"),
                "dividend_yield": info.get("dividendYield"),
                "short_percent_float": info.get("shortPercentOfFloat"),
                "held_by_insiders_pct": info.get("heldPercentInsiders"),
                "held_by_institutions_pct": info.get("heldPercentInstitutions"),
                "target_mean_price": info.get("targetMeanPrice"),
                "target_high_price": info.get("targetHighPrice"),
                "target_low_price": info.get("targetLowPrice"),
                "recommendation": info.get("recommendationKey"),
                "number_of_analyst_opinions": info.get("numberOfAnalystOpinions"),
            }
        }
    elif lt in ("technicals", "full"):
        # For full/technicals, also try to get news separately
        news_result = await yf_mcp.call_tool("get_stock_news", {"symbol": ticker}) or []
        news_items = news_result if isinstance(news_result, list) else []
        info = result if isinstance(result, dict) else {}
        return {
            "type": "full", "source": "mcp",
            "quote": {
                "symbol": ticker,
                "name": info.get("longName") or info.get("shortName", ticker),
                "price": info.get("currentPrice") or info.get("regularMarketPrice"),
                "change": info.get("regularMarketChange"),
                "change_percent": info.get("regularMarketChangePercent"),
                "volume": info.get("regularMarketVolume") or info.get("volume"),
                "high": info.get("regularMarketDayHigh") or info.get("dayHigh"),
                "low": info.get("regularMarketDayLow") or info.get("dayLow"),
                "market_cap": info.get("marketCap"),
                "pe_ratio": info.get("trailingPE"),
            },
            "technicals": {
                "symbol": ticker,
                "sma_50": info.get("fiftyDayAverage"),
                "sma_200": info.get("twoHundredDayAverage"),
                "52w_high": info.get("fiftyTwoWeekHigh"),
                "52w_low": info.get("fiftyTwoWeekLow"),
                "beta": info.get("beta"),
                "forward_pe": info.get("forwardPE"),
                "target_price": info.get("targetMeanPrice"),
                "recommendation": info.get("recommendationKey"),
            },
            "news": [{"title": a.get("title"), "publisher": a.get("publisher") or a.get("source"),
                      "link": a.get("link") or a.get("url")} for a in news_items[:3]]
        }
    return None


@app.post("/api/intelligence/agent-lookup")
async def agent_market_lookup(request: MarketLookupRequest):
    """
    Single endpoint the AI agent calls to fetch market data.
    Tries internal API first; falls back to yfinance MCP if data is missing/errored.
    """
    ticker = request.ticker.upper()
    lt = request.lookup_type

    # ── 1. Try internal API ───────────────────────────────────────────────────
    api_result = None
    try:
        if lt == "quote":
            data = market_intel.get_ticker_quote(ticker)
            if not _has_error(data):
                api_result = {"type": "quote", "source": "api", "data": data}
        elif lt == "technicals":
            data = market_intel.get_ticker_technicals(ticker, request.period or "3mo")
            if not _has_error(data):
                api_result = {"type": "technicals", "source": "api", "data": data}
        elif lt == "news":
            data = market_intel.get_ticker_news(ticker, 5)
            if not _has_error(data):
                api_result = {"type": "news", "source": "api", "data": data}
        elif lt == "fundamentals":
            data = market_intel.get_ticker_info(ticker)
            if not _has_error(data):
                api_result = {
                    "type": "fundamentals",
                    "source": "api",
                    "data": {
                        "symbol": ticker,
                        "name": data.get("name"),
                        "sector": data.get("sector"),
                        "industry": data.get("industry"),
                        "market_cap": data.get("market_cap"),
                        "trailing_pe": data.get("pe_ratio"),
                        "forward_pe": data.get("forward_pe"),
                        "dividend_yield": data.get("dividend_yield"),
                        "beta": data.get("beta"),
                        "eps_growth": data.get("eps_growth"),
                        "eps_current_year": data.get("eps_current_year"),
                        "eps_forward": data.get("eps_forward"),
                        "eps_ttm": data.get("eps_ttm"),
                        "pe_next_q": data.get("pe_next_q"),
                        "eps_estimate_next_q": data.get("eps_estimate_next_q"),
                        "52w_high": data.get("52w_high"),
                        "52w_low": data.get("52w_low"),
                        "50d_avg": data.get("50d_avg"),
                        "200d_avg": data.get("200d_avg"),
                    }
                }
        elif lt == "chart":
            import yfinance as yf
            t = yf.Ticker(ticker)
            hist = t.history(period=request.period or "1mo", interval=request.interval or "1d")
            if not hist.empty:
                hist = hist.reset_index()
                date_col = 'Datetime' if 'Datetime' in hist.columns else 'Date'
                bars = [{"date": str(row[date_col])[:10], "open": round(float(row["Open"]), 4),
                         "high": round(float(row["High"]), 4), "low": round(float(row["Low"]), 4),
                         "close": round(float(row["Close"]), 4), "volume": int(row["Volume"])}
                        for _, row in hist.iterrows()]
                api_result = {"type": "chart", "symbol": ticker, "source": "api",
                              "period": request.period, "data": bars}
        elif lt == "full":
            quote = market_intel.get_ticker_quote(ticker)
            tech = market_intel.get_ticker_technicals(ticker, "3mo")
            news = market_intel.get_ticker_news(ticker, 3)
            if not _has_error(quote):
                api_result = {"type": "full", "source": "api",
                              "quote": quote, "technicals": tech, "news": news}
        else:
            raise HTTPException(status_code=400, detail=f"Unknown lookup_type: {lt}")
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Internal API failed for {ticker}/{lt}: {e}")

    if api_result:
        return api_result

    # ── 2. Fallback to yfinance MCP ───────────────────────────────────────────
    logger.info(f"Internal API returned no data for {ticker}/{lt} — trying yfmcp fallback")
    mcp_result = await _mcp_fallback(ticker, lt, request.period or "1mo", request.interval or "1d")
    if mcp_result:
        return mcp_result

    # ── 3. Both failed ────────────────────────────────────────────────────────
    return {"type": lt, "symbol": ticker, "source": "none",
            "error": f"No data available for {ticker} from internal API or MCP"}


class FetchArticleRequest(BaseModel):
    url: str

@app.post("/api/intelligence/fetch-article")
async def fetch_article(request: FetchArticleRequest):
    """Fetch and extract readable text from a news article URL."""
    import httpx
    import re as _re
    try:
        url = validate_public_http_url(request.url)
        async with httpx.AsyncClient(follow_redirects=False, timeout=10.0) as client:
            headers = {"User-Agent": "Mozilla/5.0 (compatible; TradingSpy/1.0)"}
            resp = None
            for _ in range(4):
                resp = await client.get(url, headers=headers)
                if resp.status_code not in {301, 302, 303, 307, 308}:
                    break
                location = resp.headers.get("location")
                if not location:
                    break
                url = validate_public_http_url(urljoin(url, location))
            if resp is None:
                return {"error": "No response", "url": url}
            if resp.status_code != 200:
                return {"error": f"HTTP {resp.status_code}", "url": url}
            html = resp.text
        # Strip tags, collapse whitespace, extract readable text
        text = _re.sub(r'<script[^>]*>.*?</script>', '', html, flags=_re.DOTALL | _re.IGNORECASE)
        text = _re.sub(r'<style[^>]*>.*?</style>', '', text, flags=_re.DOTALL | _re.IGNORECASE)
        text = _re.sub(r'<[^>]+>', ' ', text)
        text = _re.sub(r'&[a-z]+;', ' ', text)
        text = _re.sub(r'\s+', ' ', text).strip()
        # Limit to first 3000 chars to keep token usage reasonable
        snippet = text[:3000]
        return {"url": url, "content": snippet, "truncated": len(text) > 3000}
    except HTTPException:
        raise
    except Exception as e:
        return {"error": str(e), "url": request.url}


@app.get("/api/intelligence/web-search")
async def web_search_endpoint(q: str):
    """Web search via SearXNG with DuckDuckGo fallback."""
    from modules.web_news_tools import web_search as _web_search
    return _web_search.func(q)


@app.get("/api/intelligence/fetch-website")
async def fetch_website_endpoint(url: str):
    """Fetch and extract text content from a URL."""
    from modules.web_news_tools import fetch_website as _fetch_website
    safe_url = validate_public_http_url(url)
    return _fetch_website.func(safe_url)


@app.get("/api/intelligence/dividends/{ticker}")
async def get_dividends_endpoint(ticker: str):
    """Get dividend history for a ticker."""
    try:
        import yfinance as yf
        t = yf.Ticker(ticker.upper())
        divs = t.dividends
        if divs.empty:
            return {"symbol": ticker.upper(), "dividends": [], "count": 0}
        recent = divs.tail(8).reset_index()
        return {"symbol": ticker.upper(), "dividends": [
            {"date": str(r.iloc[0])[:10], "amount": round(float(r.iloc[1]), 4)}
            for _, r in recent.iterrows()
        ], "count": len(recent)}
    except Exception as e:
        return {"symbol": ticker, "error": str(e), "dividends": []}


@app.get("/api/intelligence/options/{ticker}")
async def get_options_endpoint(ticker: str):
    """Get options chain summary for a ticker."""
    try:
        import yfinance as yf
        t = yf.Ticker(ticker.upper())
        exps = t.options
        if not exps:
            return {"symbol": ticker.upper(), "error": "No options data", "expirations": []}
        # Return nearest expiry chain
        chain = t.option_chain(exps[0])
        calls = chain.calls[['strike','lastPrice','bid','ask','volume','openInterest','impliedVolatility']].head(10).to_dict('records')
        puts  = chain.puts [['strike','lastPrice','bid','ask','volume','openInterest','impliedVolatility']].head(10).to_dict('records')
        return {"symbol": ticker.upper(), "expiration": exps[0], "calls": calls, "puts": puts, "all_expirations": list(exps[:6])}
    except Exception as e:
        return {"symbol": ticker, "error": str(e)}


@app.get("/api/intelligence/search")
async def search_ticker_endpoint(q: str):
    """Search for tickers by company name or symbol."""
    try:
        import yfinance as yf
        results = yf.Search(q, max_results=8)
        quotes = results.quotes if hasattr(results, 'quotes') else []
        return {"query": q, "results": [
            {"symbol": r.get("symbol",""), "name": r.get("longname") or r.get("shortname",""), "type": r.get("quoteType","")}
            for r in quotes
        ]}
    except Exception as e:
        return {"query": q, "error": str(e), "results": []}


# --- Auto-Sync Management ---

async def sync_watchlist_data():
    """Background task to sync watchlist data"""
    try:
        config_doc = sync_config_table.get(Query().user_id == LOCAL_USER_ID)
        if not config_doc or not config_doc.get("enabled"):
            return
        
        tickers = config_doc.get("tickers", [])
        if not tickers:
            # Fallback to watchlist
            watchlist_doc = watchlist_table.get(Query().user_id == LOCAL_USER_ID)
            if watchlist_doc:
                tickers = watchlist_doc.get("tickers", [])
        
        if not tickers:
            logger.info("No tickers to sync")
            return
        
        _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
        
        # Check if multi-granularity mode is enabled
        use_multi = config_doc.get("use_multi_granularity", False)
        
        if use_multi and config_doc.get("sync_granularities"):
            # Multi-granularity mode: sync different timeframes
            granularities = config_doc.get("sync_granularities", [])
            logger.info(f"Auto-sync (multi-granularity): Syncing {len(tickers)} tickers across {len(granularities)} timeframes")
            
            for gran in granularities:
                interval = gran.get("interval", "1d")
                period = gran.get("period", "5d")
                
                logger.info(f"Auto-sync: Syncing {interval}/{period} data")
                for ticker in tickers:
                    try:
                        download_ticker_data(ticker, interval=interval, period=period, output_dir=user_dir)
                        logger.info(f"Auto-sync: ✓ {ticker} ({interval}/{period})")
                    except Exception as e:
                        logger.error(f"Auto-sync: ✗ {ticker} ({interval}/{period}) - {e}")
        else:
            # Legacy single-granularity mode
            interval = config_doc.get("data_interval", "1d")
            period = config_doc.get("data_period", "5d")
            
            logger.info(f"Auto-sync: Syncing {len(tickers)} tickers ({interval}/{period})")
            
            for ticker in tickers:
                try:
                    download_ticker_data(ticker, interval=interval, period=period, output_dir=user_dir)
                    logger.info(f"Auto-sync: ✓ {ticker}")
                except Exception as e:
                    logger.error(f"Auto-sync: ✗ {ticker} - {e}")
        
        # Update last sync time
        config_doc["last_sync"] = datetime.now().isoformat()
        sync_config_table.upsert(config_doc, Query().user_id == LOCAL_USER_ID)
        
        logger.info("Auto-sync: Complete")
    except Exception as e:
        logger.error(f"Auto-sync error: {e}")


async def sync_granularity_data(granularity_config: Dict):
    """Background task to sync a specific granularity"""
    try:
        config_doc = sync_config_table.get(Query().user_id == LOCAL_USER_ID)
        if not config_doc or not config_doc.get("enabled"):
            return
        
        tickers = config_doc.get("tickers", [])
        if not tickers:
            watchlist_doc = watchlist_table.get(Query().user_id == LOCAL_USER_ID)
            if watchlist_doc:
                tickers = watchlist_doc.get("tickers", [])
        
        if not tickers:
            return
        
        interval = granularity_config.get("interval", "1d")
        period = granularity_config.get("period", "5d")
        
        _, _, user_dir = get_user_dirs(LOCAL_USER_ID)
        
        logger.info(f"Granularity sync ({interval}): Syncing {len(tickers)} tickers")
        
        for ticker in tickers:
            try:
                download_ticker_data(ticker, interval=interval, period=period, output_dir=user_dir)
                logger.info(f"Granularity sync ({interval}): ✓ {ticker}")
            except Exception as e:
                logger.error(f"Granularity sync ({interval}): ✗ {ticker} - {e}")
        
        logger.info(f"Granularity sync ({interval}): Complete")
    except Exception as e:
        logger.error(f"Granularity sync error: {e}")


@app.get("/api/intelligence/sync-config")
async def get_sync_config():
    """Get current auto-sync configuration"""
    config = sync_config_table.get(Query().user_id == LOCAL_USER_ID)
    if not config:
        # Return default config with recommended multi-granularity setup
        return {
            "enabled": False,
            "interval_minutes": 60,
            "tickers": [],
            "data_interval": "1d",
            "data_period": "5d",
            "use_multi_granularity": False,
            "sync_granularities": [
                {"interval": "1m", "period": "1d", "sync_every_minutes": 5},
                {"interval": "5m", "period": "5d", "sync_every_minutes": 15},
                {"interval": "1h", "period": "1mo", "sync_every_minutes": 60},
                {"interval": "1d", "period": "max", "sync_every_minutes": 360}
            ],
            "next_sync": None,
            "last_sync": None
        }
    return config


@app.post("/api/intelligence/sync-config")
async def update_sync_config(config: SyncConfig):
    """Update auto-sync configuration"""
    global sync_jobs
    
    config_data = config.dict()
    config_data["user_id"] = LOCAL_USER_ID
    config_data["updated_at"] = datetime.now().isoformat()
    
    # Update database
    sync_config_table.upsert(config_data, Query().user_id == LOCAL_USER_ID)
    
    # Remove all existing sync jobs for this user
    jobs_to_remove = [job_id for job_id in sync_jobs.keys() if job_id.startswith(f"sync_{LOCAL_USER_ID}")]
    for job_id in jobs_to_remove:
        try:
            scheduler.remove_job(job_id)
            del sync_jobs[job_id]
        except:
            pass
    
    # Add new jobs if enabled
    if config.enabled:
        if config.use_multi_granularity and config.sync_granularities:
            # Multi-granularity mode: create separate jobs for each granularity
            logger.info(f"Setting up multi-granularity sync with {len(config.sync_granularities)} timeframes")
            
            for i, gran in enumerate(config.sync_granularities):
                interval = gran.get("interval", "1d")
                sync_minutes = gran.get("sync_every_minutes", 60)
                
                job_id = f"sync_{LOCAL_USER_ID}_{interval}"
                
                # Create a closure to capture the granularity config
                async def make_sync_task(gran_config):
                    return await sync_granularity_data(gran_config)
                
                job = scheduler.add_job(
                    lambda g=gran: asyncio.create_task(sync_granularity_data(g)),
                    trigger=IntervalTrigger(minutes=sync_minutes),
                    id=job_id,
                    replace_existing=True
                )
                sync_jobs[job_id] = job
                logger.info(f"Created sync job for {interval} data (every {sync_minutes} minutes)")
            
            # Run initial sync for all granularities
            await sync_watchlist_data()
            
            return {
                "message": f"Multi-granularity auto-sync enabled with {len(config.sync_granularities)} timeframes",
                "jobs": list(sync_jobs.keys())
            }
        else:
            # Legacy single-granularity mode
            job_id = f"sync_{LOCAL_USER_ID}"
            
            if config.interval_minutes > 0:
                job = scheduler.add_job(
                    sync_watchlist_data,
                    trigger=IntervalTrigger(minutes=config.interval_minutes),
                    id=job_id,
                    replace_existing=True
                )
                sync_jobs[job_id] = job
                
                # Run immediately on enable
                await sync_watchlist_data()
                
                next_run = job.next_run_time.isoformat() if job.next_run_time else None
                logger.info(f"Auto-sync enabled: every {config.interval_minutes} minutes. Next run: {next_run}")
                
                return {
                    "message": "Auto-sync enabled",
                    "next_sync": next_run,
                    "interval_minutes": config.interval_minutes
                }
    
    logger.info("Auto-sync disabled")
    return {"message": "Auto-sync disabled"}


@app.post("/api/intelligence/sync-now")
async def trigger_sync_now(background_tasks: BackgroundTasks):
    """Manually trigger a sync immediately"""
    background_tasks.add_task(sync_watchlist_data)
    return {"message": "Sync triggered"}


@app.get("/api/intelligence/sync-status")
async def get_sync_status():
    """Get current sync job status"""
    user_jobs = {job_id: job for job_id, job in sync_jobs.items() if job_id.startswith(f"sync_{LOCAL_USER_ID}")}
    
    if user_jobs:
        jobs_info = []
        for job_id, job in user_jobs.items():
            # Extract granularity from job_id (e.g., "sync_local_user_1m" -> "1m")
            parts = job_id.split('_')
            granularity = parts[-1] if len(parts) > 2 else "default"
            
            # Get next run time safely
            try:
                next_run = job.next_run_time.isoformat() if hasattr(job, 'next_run_time') and job.next_run_time else None
            except:
                next_run = None
            
            jobs_info.append({
                "job_id": job_id,
                "granularity": granularity,
                "next_run": next_run
            })
        
        return {
            "enabled": True,
            "jobs": jobs_info,
            "total_jobs": len(jobs_info)
        }
    
    return {"enabled": False, "jobs": [], "total_jobs": 0}


# ── Tool-Calling Chat Endpoint (Streaming) ────────────────────────────────────
@app.post("/api/backtest/ai/chat-with-tools")
async def chat_with_tools_streaming(request: AIChatRequest, http_request: Request):
    """Streaming ReAct + Parallel tool-calling chat endpoint
    
    Implements ReAct (Reasoning + Action + Observation) with parallel tool execution:
    - Thought: Explicit reasoning about what to do
    - Action: Call tools in parallel
    - Observation: Analyze results
    - Final Answer: Generate response
    """
    from fastapi.responses import StreamingResponse
    from langchain_core.messages import HumanMessage, AIMessage
    from modules.tool_calling_agent import ALL_TOOLS, SYSTEM_PROMPT
    from datetime import datetime
    import asyncio
    
    async def generate_stream():
        try:
            yield f"data: {json.dumps({'type': 'status', 'content': 'Backend received request...'})}\n\n"
            settings = load_system_settings()
            provider = normalize_provider(request.provider or normalize_app_llm_provider(settings.get("default_provider")))
            model = normalize_model(provider, request.model or settings.get("default_model") or "gemini-2.5-flash")
            
            logger.info(f"=== ReAct + Parallel Tool-Calling Chat ===")
            logger.info(f"Provider: {provider}, Model: {model}")
            
            # Inject current datetime into system prompt
            current_datetime = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p %Z")
            system_prompt_with_time = SYSTEM_PROMPT.replace('{current_datetime}', str(current_datetime))
            response_budget = max(512, min(int(request.max_tokens or 8192), 20000))
            if response_budget <= 2500:
                answer_depth_instruction = (
                    "ANSWER BUDGET: Short. Final answers should be compact: 1 short paragraph or 3-5 bullets, "
                    "only the highest-signal facts."
                )
                tool_result_limit = 800
            elif response_budget <= 9000:
                answer_depth_instruction = (
                    "ANSWER BUDGET: Mid. Final answers should be useful and structured: short summary, key details, "
                    "and a practical takeaway when relevant."
                )
                tool_result_limit = 2000
            else:
                answer_depth_instruction = (
                    "ANSWER BUDGET: Long. Final answers should be materially more complete: organize with sections, "
                    "cover the important evidence from tools, include caveats, and do not compress to one paragraph."
                )
                tool_result_limit = 5000

            system_prompt_with_time += f"""

UNIFIED ASSISTANT CONFIG:
- You are the only assistant mode. Do not mention Advisor/Analyst/Agent modes.
- Use ReAct internally: decide what is needed, call tools, observe results, then answer.
- Parallelize independent read-only tools in the same turn whenever useful.
- Match the final response depth to the user's selected answer budget.
- {answer_depth_instruction}
- In final answers, never mention internal tool/function names such as get_market_overview, get_industry_heatmap, web_search, read_market_data, or read_candles. Use user-facing labels like market overview data, industry heatmap, news search, local dataset, or candle data.
- If a data field is unavailable, say unavailable or missing; do not expose raw values like NaN.
- Do not expose chain-of-thought. Short process summaries are okay; detailed internal reasoning is not needed.
- Ask confirmation before expensive, destructive, or long-running actions unless the user explicitly requested them.
- Explicit requests to download data, generate a strategy, run a backtest, or optimize may be executed.
- For "explain/review/show strategy code" requests, stay read-only: use list_available_strategies and get_strategy_code, then explain the actual saved code. Do not generate, optimize, or backtest unless the user explicitly asks to run work.
- If the user asks for market overview, market direction, "what is moving", or "why is the market up/down", do not stop at top indices. Use get_market_overview plus get_industry_heatmap for the requested timeframe; add web_search/news only when the user asks why or asks about current catalysts.
- If the user asks for a daily trading insight, daily brief, morning brief, daily SOP, daily market checklist, "what should I watch today", or similar broad workflow, build a structured brief: market breadth/leadership, key news, macro/rates/geopolitical risks, scheduled catalysts likely to drive volatility, notable earnings/events, sector or industry movers, and notable insider buying/selling in the requested universe. Use market overview and industry heatmap for breadth, news search/SearXNG for current catalysts and event risks, ticker news for named tickers, earnings dates when tickers or a universe are provided, and insider activity scans for watchlist/sector/industry/custom ticker scopes. If the user asks to scan "all" without scope, ask whether to use watchlist, Nasdaq 100, S&P 500 large caps, Magnificent 7, strongest/weakest Market Overview industry, a sector/industry, or custom tickers.
- Be time-aware. If the user says today/this week/this month, choose the matching period such as 1d/5d/1mo and mention the concrete date from the system time.
- For industry/sector questions, use get_industry_heatmap first and then drill into representative ETFs/stocks only when useful.
- For strategy planning, first form a thesis from market context, industry strength/weakness, ticker technicals/news, and available data. Then generate/backtest only after the plan is clear or the user explicitly requests execution.
- For create-and-backtest requests, generate the strategy, wait for it, run the backtest, and compare against buy-and-hold for the same ticker/date window when enough data exists. If there is a previous strategy/version in context, compare against that too.
- For improvement requests, treat the optimizer as an iterative workflow: baseline current version, create or start improvements, backtest each candidate, keep only versions that beat the last accepted version or buy-and-hold benchmark, and ask before continuing if the user did not explicitly request an open-ended/infinite loop.
- If the user asks for "infinite loop" optimization, explain the stop controls and use sensible checkpoints: report each accepted improvement, no-improvement streak, benchmark comparison, and ask whether to continue when a configured round limit or stagnation threshold is reached.
- If the user asks what APIs/tools are available or how the assistant is configured, explain the active provider/model and available tool categories.
"""
            
            # Add thinking detail instructions based on user preference
            thinking_detail = getattr(request, 'thinking_detail', 'normal')
            if thinking_detail == 'brief':
                system_prompt_with_time += "\n\n⚡ THINKING STYLE: Keep your reasoning brief and to the point. Only explain key decisions."
            elif thinking_detail == 'detailed':
                system_prompt_with_time += "\n\n🔍 THINKING STYLE: Provide detailed reasoning. Explain your thought process, alternatives considered, and why you chose specific tools or approaches."
            custom_agent_instructions = _agent_instruction_block(getattr(request, "agent_instructions", None))
            if custom_agent_instructions:
                system_prompt_with_time += f"\n\nUSER AGENT INSTRUCTIONS:\n{custom_agent_instructions}\n\nFollow these operator preferences when they do not conflict with tool safety, data accuracy, or user-visible answer requirements."
            
            try:
                llm, api_key = build_langchain_chat_model(provider, model, request.api_key, request.provider_config, temperature=0)
            except Exception as provider_error:
                yield f"data: {json.dumps({'type': 'error', 'content': f'Provider setup failed for {provider}: {provider_error}'})}\n\n"
                return

            simple_message = (request.message or "").strip().lower()
            recent_history_text = "\n".join(
                str(item.get("content") or "").lower()
                for item in (request.history or [])[-8:]
                if isinstance(item, dict)
            )
            insider_terms = (
                "insider buy", "insider buys", "insider buying",
                "insider sell", "insider sells", "insider selling",
                "insider trade", "insider trades", "insider trading",
                "insider activity", "insider transactions",
            )
            insider_followup_terms = (
                "key buy", "key buys", "any buy", "any buys", "buy?", "buys?",
                "selling?", "sell?", "sold?", "purchase?", "purchases?",
                "what price", "how much", "what percentage",
            )
            is_insider_activity_request = (
                any(term in simple_message for term in insider_terms)
                or ("insider" in recent_history_text and any(term in simple_message for term in insider_followup_terms))
            )
            if simple_message in {"hi", "hello", "hey", "yo", "hiya"}:
                response_text = "Hi. I can help with market analysis, news, strategy generation, data downloads, backtests, and optimization. What do you want to look at?"
                quick_step = {
                    "label": "Greeting",
                    "status": "success",
                    "comment": "Answered directly",
                    "note": "No tools needed"
                }
                yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
                yield f"data: {json.dumps({'type': 'step', 'step': quick_step})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'thinking': 'Simple greeting answered directly.', 'steps': [quick_step], 'tools_used': [], 'data': {}, 'triggered_tasks': []})}\n\n"
                return
            
            # PHASE 1: THOUGHT - Visible process summary, scaled by user preference.
            if thinking_detail != "brief":
                yield f"data: {json.dumps({'type': 'thinking', 'content': '🧠 THOUGHT: Analyzing your request and planning approach...'})}\n\n"
                await asyncio.sleep(0.1)
            
            # Build messages
            from langchain_core.messages import SystemMessage
            lc_messages = [SystemMessage(content=system_prompt_with_time)]
            history_limit = max(0, min(80, int(getattr(request, "history_limit", 20) or 0)))
            history_items = (request.history or [])[-history_limit:] if history_limit else []
            for h in history_items:
                role, content = h.get("role"), h.get("content", "")
                if role == "user":
                    lc_messages.append(HumanMessage(content=content))
                elif role == "assistant" and content:
                    lc_messages.append(AIMessage(content=content))
            
            lc_messages.append(HumanMessage(content=request.message))
            
            # Call LLM with tools - this is the THOUGHT phase
            if thinking_detail != "brief":
                yield f"data: {json.dumps({'type': 'thinking', 'content': '🧠 THOUGHT: Determining which tools to use...'})}\n\n"
            try:
                llm_with_tools = llm.bind_tools(ALL_TOOLS)
                loop = asyncio.get_event_loop()
                response = await asyncio.wait_for(
                    loop.run_in_executor(None, lambda: llm_with_tools.invoke(lc_messages)),
                    timeout=25
                )
            except Exception as tool_select_error:
                logger.warning(f"Tool selection failed or timed out; falling back to direct response: {tool_select_error}", exc_info=True)
                yield f"data: {json.dumps({'type': 'thinking', 'content': 'Tool selection did not return in time; answering directly...'})}\n\n"
                if is_insider_activity_request:
                    response_text = (
                        "I could not verify insider transactions because the data-tool selection timed out. "
                        "I will not guess insider names, dates, prices, or amounts. Please retry the insider scan."
                    )
                    direct_step = {
                        "label": "Insider data unavailable",
                        "status": "error",
                        "comment": "Tool selection timed out",
                        "note": "No insider trades reported without data",
                    }
                    yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
                    yield f"data: {json.dumps({'type': 'step', 'step': direct_step})}\n\n"
                    yield f"data: {json.dumps({'type': 'done', 'thinking': 'Insider answer blocked because no verified data source completed.', 'steps': [direct_step], 'tools_used': [], 'data': {}, 'triggered_tasks': []})}\n\n"
                    return
                response_text = await call_llm(
                    provider=provider,
                    model=model,
                    system_prompt=system_prompt_with_time,
                    user_prompt=request.message,
                    api_key=api_key,
                    provider_config=request.provider_config,
                    json_mode=False,
                    history=request.history or [],
                    max_tokens=response_budget
                )
                response_text = _sanitize_assistant_response(response_text or "I am here, but the model returned an empty response.")
                direct_step = {
                    "label": "Direct response fallback",
                    "status": "success",
                    "comment": "Tool selection timed out",
                    "note": f"Provider: {provider}"
                }
                yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
                yield f"data: {json.dumps({'type': 'step', 'step': direct_step})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'thinking': 'Answered directly after tool selection timeout.', 'steps': [direct_step], 'tools_used': [], 'data': {}, 'triggered_tasks': []})}\n\n"
                return
            
            steps = []
            tools_used = []
            tool_data = {}
            tool_records = []
            triggered_tasks = []

            tool_calls = list(getattr(response, "tool_calls", []) or [])
            market_driver_terms = ["why", "explain", "catalyst", "driver", "up", "down", "going up", "going down", "rally", "selloff", "drop", "today"]
            market_scope_terms = ["market", "stocks", "s&p", "sp500", "nasdaq", "dow", "heatmap", "mover", "movers", "movement", "sector", "industry"]
            is_market_driver_question = (
                any(term in simple_message for term in market_scope_terms)
                and any(term in simple_message for term in market_driver_terms)
            )
            is_market_news_question = (
                "news" in simple_message
                and any(term in simple_message for term in market_scope_terms)
            )
            if is_market_driver_question or is_market_news_question:
                existing_tool_names = {tc.get("name") for tc in tool_calls if isinstance(tc, dict)}
                period = "1d" if "today" in simple_message else "5d"
                search_query = "latest stock market sector movers news today Reuters CNBC Federal Reserve earnings"
                if "heatmap" in simple_message or "sector" in simple_message or "industry" in simple_message:
                    search_query = "latest stock market sector performance today technology energy financials healthcare Reuters CNBC"
                elif "mover" in simple_message or "movement" in simple_message:
                    search_query = "latest stock market biggest movers today company news earnings analyst Reuters CNBC"
                required_calls = [
                    {"name": "get_market_overview", "args": {}},
                    {"name": "get_industry_heatmap", "args": {"period": period}},
                    {"name": "web_search", "args": {"query": search_query}},
                ]
                for required_call in required_calls:
                    if required_call["name"] not in existing_tool_names:
                        tool_calls.append(required_call)
                if len(tool_calls) != len(getattr(response, "tool_calls", []) or []):
                    if thinking_detail != "brief":
                        yield f"data: {json.dumps({'type': 'thinking', 'content': 'Added required market breadth and news checks for a market-driver question...'})}\n\n"

            if is_insider_activity_request:
                existing_tool_names = {_normalize_agent_tool_name(tc.get("name")) for tc in tool_calls if isinstance(tc, dict)}
                if not {"get_insider_trades", "screen_industry_insider_activity"}.intersection(existing_tool_names):
                    focus = "all"
                    if any(term in simple_message for term in ("buy", "buys", "buying", "purchase", "purchases")):
                        focus = "buys"
                    elif any(term in simple_message for term in ("sell", "sells", "selling", "sold")):
                        focus = "sells"
                    tool_calls.append({
                        "name": "screen_industry_insider_activity",
                        "args": {"universe": "default", "days_back": 30, "max_checked": 30, "focus": focus},
                    })
                    if thinking_detail != "brief":
                        yield f"data: {json.dumps({'type': 'thinking', 'content': 'Added an insider-activity data check so the answer stays grounded in returned transactions...'})}\n\n"
            
            # Check if LLM wants to call tools
            if tool_calls:
                # PHASE 2: ACTION - Execute tools in parallel
                yield f"data: {json.dumps({'type': 'thinking', 'content': f'⚡ ACTION: Executing {len(tool_calls)} tools in parallel...'})}\n\n"
                tool_call_inputs = {}
                
                # Stream all tool starts first
                for tool_call in tool_calls:
                    raw_tool_name = tool_call.get("name")
                    tool_name = _normalize_agent_tool_name(raw_tool_name)
                    tool_call["name"] = tool_name
                    tool_input = tool_call.get("args", {})
                    tool_key = f"{tool_name}:{len(tool_call_inputs)}"
                    tool_call["_tool_key"] = tool_key
                    tool_call_inputs[tool_key] = tool_input
                    public_tool_name = _public_tool_label(tool_name)
                    step_start = {
                        "label": f"🔧 {public_tool_name}",
                        "status": "running",
                        "comment": f"Checking {public_tool_name}",
                        "note": str(tool_input)[:100],
                        "tool": tool_name,
                        "tool_args": tool_input,
                        "_tool_key": tool_key,
                    }
                    steps.append(step_start)
                    yield f"data: {json.dumps({'type': 'step', 'step': step_start})}\n\n"
                
                # Execute all tools in parallel
                async def execute_tool(tool_call):
                    tool_name = tool_call.get("name")
                    tool_input = tool_call.get("args", {})
                    tool_key = tool_call.get("_tool_key")
                    
                    for t in ALL_TOOLS:
                        if t.name == tool_name:
                            try:
                                loop = asyncio.get_event_loop()
                                result = await loop.run_in_executor(None, lambda: t.invoke(tool_input))
                                
                                return (tool_name, result, None, tool_key, tool_input)
                            except Exception as e:
                                logger.error(f"Tool {tool_name} error: {e}")
                                return (tool_name, None, str(e), tool_key, tool_input)
                    return (tool_name, None, "Tool not found", tool_key, tool_input)
                
                # Execute all tools concurrently
                tool_results = await asyncio.gather(*[execute_tool(tc) for tc in tool_calls])
                
                # PHASE 3: OBSERVATION - Process results
                if thinking_detail != "brief":
                    yield f"data: {json.dumps({'type': 'thinking', 'content': '👁️ OBSERVATION: Analyzing tool results...'})}\n\n"
                
                for tool_name, result, error, tool_key, tool_input in tool_results:
                    semantic_error = _tool_result_error(result) if not error else None
                    if semantic_error:
                        error = semantic_error
                    tool_records.append({
                        "tool": tool_name,
                        "args": tool_input,
                        "result": result,
                        "error": error,
                    })
                    if error:
                        public_tool_name = _public_tool_label(tool_name)
                        step_error = {
                            "label": f"❌ {public_tool_name}",
                            "status": "error",
                            "comment": "Tool error",
                            "note": error[:100],
                            "tool": tool_name,
                            "tool_args": tool_input,
                            "tool_error": error,
                            "_tool_key": tool_key,
                        }
                        steps.append(step_error)
                        yield f"data: {json.dumps({'type': 'step', 'step': step_error})}\n\n"
                    else:
                        tool_data[tool_name] = result
                        tools_used.append(tool_name)
                        
                        # Only task-creating tools may register a background task.
                        # Status tools also echo task_id, which must never start a
                        # second polling loop or Task Center card.
                        if tool_name in {"generate_strategy", "run_backtest", "download_market_data"} and isinstance(result, dict) and result.get("task_id"):
                            task_id = result["task_id"]
                            public_tool_name = _public_tool_label(tool_name)
                            task_label = f"{public_tool_name}: {result.get('ticker', result.get('strategy', 'Task'))}"
                            
                            # Determine task type
                            if tool_name == "generate_strategy":
                                task_type = "forge"
                            elif tool_name == "run_backtest":
                                task_type = "backtest"
                            elif tool_name == "download_market_data":
                                task_type = "download"
                            else:
                                task_type = "task"
                            
                            # Emit task_started event for Task Center
                            triggered_tasks.append({"task_id": task_id, "task_type": task_type, "label": task_label})
                            yield f"data: {json.dumps({'type': 'task_started', 'task_id': task_id, 'task_type': task_type, 'label': task_label})}\n\n"
                            
                            # Poll task status until completion with dynamic timeout
                            yield f"data: {json.dumps({'type': 'thinking', 'content': f'⏳ Waiting for {public_tool_name} to complete...'})}\n\n"
                            
                            # Dynamic timeout based on task type (matches strands agent)
                            if tool_name == "download_market_data":
                                max_seconds = 300  # 5 minutes
                            elif tool_name == "generate_strategy":
                                max_seconds = 600  # 10 minutes
                            elif tool_name == "run_backtest":
                                max_seconds = 1800  # 30 minutes for backtests
                            else:
                                max_seconds = 1200  # 20 minutes default
                            
                            # Poll with 1-second interval (2x faster feedback)
                            max_polls = max_seconds
                            task_completed = False
                            for poll_count in range(max_polls):
                                await asyncio.sleep(1)  # 1-second interval instead of 2s
                                
                                status_result = None
                                for t in ALL_TOOLS:
                                    if t.name == "check_task_status":
                                        try:
                                            loop = asyncio.get_event_loop()
                                            status_result = await loop.run_in_executor(None, lambda: t.invoke({"task_id": task_id}))
                                            logger.info(f"Poll {poll_count+1}: task_id={task_id}, status={status_result.get('status') if status_result else 'None'}")
                                            break
                                        except Exception as e:
                                            logger.error(f"check_task_status error: {e}")
                                            break
                                
                                if status_result:
                                    status = status_result.get("status")
                                    progress = status_result.get("progress", 0)
                                    current = status_result.get("current", "")
                                    
                                    yield f"data: {json.dumps({'type': 'progress', 'label': task_label, 'pct': progress, 'detail': current})}\n\n"
                                    
                                    if status == "completed":
                                        result["status"] = "completed"
                                        result["results"] = status_result.get("results")
                                        tool_data[tool_name] = result
                                        
                                        step_complete = {
                                            "label": f"✅ {public_tool_name} completed",
                                            "status": "success",
                                            "comment": f"{public_tool_name} finished successfully",
                                            "note": f"Completed: {result.get('ticker', result.get('strategy', 'Task'))}",
                                            "_tool_key": tool_key,
                                        }
                                        steps.append(step_complete)
                                        yield f"data: {json.dumps({'type': 'step', 'step': step_complete})}\n\n"
                                        task_completed = True
                                        break
                                    elif status == "failed":
                                        error_msg = status_result.get("error", "Unknown error")
                                        result["status"] = "failed"
                                        result["error"] = error_msg
                                        tool_data[tool_name] = result
                                        
                                        step_failed = {
                                            "label": f"❌ {public_tool_name} failed",
                                            "status": "error",
                                            "comment": "Task failed",
                                            "note": error_msg[:100],
                                            "_tool_key": tool_key,
                                        }
                                        steps.append(step_failed)
                                        yield f"data: {json.dumps({'type': 'step', 'step': step_failed})}\n\n"
                                        task_completed = True
                                        break
                            
                            # Handle timeout
                            if not task_completed:
                                result["status"] = "timeout"
                                result["note"] = f"Task still running after {max_seconds} seconds"
                                tool_data[tool_name] = result
                                
                                timeout_step = {
                                    "label": f"⏱️ {public_tool_name} timeout",
                                    "status": "info",
                                    "comment": f"Task still running after {max_seconds} seconds",
                                    "note": "Task continues in background. Check Task Center for status.",
                                    "_tool_key": tool_key,
                                }
                                steps.append(timeout_step)
                                yield f"data: {json.dumps({'type': 'step', 'step': timeout_step})}\n\n"
                        else:
                            # Regular tool (not async)
                            public_tool_name = _public_tool_label(tool_name)
                            step_success = {
                                "label": f"✅ {public_tool_name}",
                                "status": "success",
                                "comment": f"Got {public_tool_name} result",
                                "note": str(result)[:100],
                                "tool": tool_name,
                                "tool_args": tool_input,
                                "tool_result": result,
                                "_tool_key": tool_key,
                            }
                            steps.append(step_success)
                            yield f"data: {json.dumps({'type': 'step', 'step': step_success})}\n\n"
                        
                        logger.info(f"✓ Tool {tool_name} executed")
                
                # Build tool summary for context
                tool_summary = "Tool execution results:\n"
                for record in tool_records:
                    record_payload = record["result"] if record["result"] is not None else {"error": record["error"]}
                    tool_summary += (
                        f"\n{record['tool']} args={json.dumps(record['args'], default=str)}:\n"
                        f"{json.dumps(record_payload, indent=2, default=str)[:tool_result_limit]}\n"
                    )

                failed_symbols = sorted({
                    str(record["args"].get("ticker") or record["args"].get("symbol") or "").upper()
                    for record in tool_records
                    if record["error"] and isinstance(record["args"], dict)
                    and (record["args"].get("ticker") or record["args"].get("symbol"))
                })
                evidence_guard = ""
                if failed_symbols:
                    evidence_guard = (
                        f"\nEVIDENCE GATE: Data lookup failed for {', '.join(failed_symbols)}. "
                        "Do not identify, describe, compare, value, or recommend those symbols from memory or search-result inference. "
                        "State that the symbol could not be verified and ask the user to confirm the ticker. "
                        "If search results show similarly spelled symbols, present them only as possible corrections, not as the same security.\n"
                    )

                deterministic_tool_answer = ""
                if "screen_undervalued_stocks" in tool_data:
                    deterministic_tool_answer = _render_screen_undervalued_answer(tool_data["screen_undervalued_stocks"])
                elif "screen_industry_insider_activity" in tool_data:
                    deterministic_tool_answer = _render_insider_activity_answer(tool_data["screen_industry_insider_activity"])
                elif is_insider_activity_request and "get_insider_trades" in tool_data:
                    deterministic_tool_answer = _render_insider_trades_answer(tool_data["get_insider_trades"])
                
                # Only add AIMessage if response has content
                if hasattr(response, 'content') and response.content:
                    lc_messages.append(AIMessage(content=response.content))
                
                if not deterministic_tool_answer:
                    lc_messages.append(HumanMessage(content=tool_summary + evidence_guard + f"\nBased on these completed observations, answer the original question.\n{answer_depth_instruction}\nDo not mention internal tool or function names. If a value is NaN/null/missing, describe it as unavailable.\nDo not say you will check another source or perform another step; either use the tool results already available or state clearly what remains unavailable.\nPercentage fields ending in `_pct` are already percentages. Ratio fields such as revenue_growth are decimals: 1.96 means 196%, not 1.96%. Never infer RSI, price targets, entry levels, stop losses, or likely percentage declines when those exact values were not returned.\nFor insider buying/selling/trading answers, include transaction date, insider, buy/sell/grant classification, shares, transaction price, approximate value, and ownership/percentage context when those fields are present. If price or percentage context is absent, say it is unavailable from the feed.\nCRITICAL: Use ONLY the tool result numbers/names. Do not add examples, prices, insider names, catalysts, support/resistance, or market stats that are not present in the tool JSON."))
                
                # PHASE 4: FINAL ANSWER - Generate response
                yield f"data: {json.dumps({'type': 'thinking', 'content': f'💬 FINAL ANSWER: Generating response with {len(tools_used)} tool results...'})}\n\n"
                
                # Stream the LLM response token-by-token. Some providers occasionally
                # drop SSE/TLS streams, so retry once with a normal non-stream call.
                response_text = ""
                if deterministic_tool_answer:
                    response_text = deterministic_tool_answer
                    yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
                else:
                    try:
                        final_llm = llm.bind(max_tokens=response_budget)
                        for chunk in final_llm.stream(lc_messages):
                            if hasattr(chunk, 'content') and chunk.content:
                                response_text += chunk.content
                                yield f"data: {json.dumps({'type': 'response', 'content': _sanitize_assistant_response(response_text)})}\n\n"
                    except Exception as stream_error:
                        logger.warning(f"LLM stream failed; retrying non-stream response: {stream_error}")
                        yield f"data: {json.dumps({'type': 'thinking', 'content': 'Provider stream dropped; retrying final answer without streaming...'})}\n\n"
                        try:
                            fallback_response = final_llm.invoke(lc_messages)
                            response_text = _sanitize_assistant_response(getattr(fallback_response, "content", str(fallback_response)) or "")
                        except Exception as fallback_error:
                            logger.error(f"LLM fallback response failed: {fallback_error}", exc_info=True)
                            response_text = (
                                "The data checks finished, but the model provider connection dropped while writing the final answer. "
                                f"I used {len(tools_used)} internal data source(s). "
                                "Please retry the same question, or switch provider/model if this keeps happening."
                            )
                        response_text = _sanitize_assistant_response(response_text)
                        yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
            else:
                # No tools needed - direct response
                yield f"data: {json.dumps({'type': 'thinking', 'content': '💬 FINAL ANSWER: No tools needed, generating direct response...'})}\n\n"
                
                response_text = ""
                try:
                    final_llm = llm.bind(max_tokens=response_budget)
                    for chunk in final_llm.stream(lc_messages):
                        if hasattr(chunk, 'content') and chunk.content:
                            response_text += chunk.content
                            yield f"data: {json.dumps({'type': 'response', 'content': _sanitize_assistant_response(response_text)})}\n\n"
                except Exception as stream_error:
                    logger.warning(f"LLM stream failed; retrying non-stream response: {stream_error}")
                    yield f"data: {json.dumps({'type': 'thinking', 'content': 'Provider stream dropped; retrying final answer without streaming...'})}\n\n"
                    try:
                        fallback_response = final_llm.invoke(lc_messages)
                        response_text = _sanitize_assistant_response(getattr(fallback_response, "content", str(fallback_response)) or "")
                    except Exception as fallback_error:
                        logger.error(f"LLM fallback response failed: {fallback_error}", exc_info=True)
                        response_text = (
                            "The model provider connection dropped while writing the answer. "
                            "Please retry the same question, or switch provider/model if this keeps happening."
                        )
                    response_text = _sanitize_assistant_response(response_text)
                    yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
            
            # Send final step after streaming completes
            final_step = {
                "label": "💬 Response",
                "status": "success",
                "comment": "Generated response",
                "note": f"Response: {len(response_text)} chars"
            }
            steps.append(final_step)
            yield f"data: {json.dumps({'type': 'step', 'step': final_step})}\n\n"
            
            # Send final summary
            public_sources = [_public_tool_label(name) for name in tools_used]
            tools_summary = f"Completed. Used {len(tools_used)} data source(s): {', '.join(public_sources) if public_sources else 'none'}"
            yield f"data: {json.dumps({'type': 'done', 'thinking': tools_summary, 'steps': steps, 'tools_used': list(set(tools_used)), 'data': tool_data, 'triggered_tasks': triggered_tasks})}\n\n"
            
        except asyncio.CancelledError:
            logger.info("Streaming chat client disconnected")
            return
        except Exception as e:
            logger.error(f"Streaming error: {e}", exc_info=True)
            error_text = str(e)
            if "UNEXPECTED_EOF" in error_text or "EOF occurred in violation of protocol" in error_text:
                error_text = "The model provider closed the HTTPS stream before finishing. Please retry, or switch provider/model if it keeps happening."
            yield f"data: {json.dumps({'type': 'error', 'content': error_text})}\n\n"

    async def guarded_stream():
        async for event in generate_stream():
            if await http_request.is_disconnected():
                logger.info("Streaming chat client disconnected before next event")
                break
            yield event
    
    return StreamingResponse(guarded_stream(), media_type="text/event-stream")


# ── Strands Agent Loop Endpoint (Third Mode) ────────────────────────────────────
@app.post("/api/backtest/ai/chat-strands")
async def chat_strands_agent_loop(request: AIChatRequest, http_request: Request):
    """Strands-style agent loop: Reasoning → Tool Selection → Tool Execution → Repeat until response"""
    from fastapi.responses import StreamingResponse
    from langchain_core.messages import HumanMessage, AIMessage
    from modules.tool_calling_agent import ALL_TOOLS, SYSTEM_PROMPT
    from datetime import datetime
    import asyncio
    
    async def generate_strands_loop():
        try:
            yield f"data: {json.dumps({'type': 'status', 'content': 'Backend received request...'})}\n\n"
            settings = load_system_settings()
            provider = normalize_provider(request.provider or normalize_app_llm_provider(settings.get("default_provider")))
            model = normalize_model(provider, request.model or settings.get("default_model") or "gemini-2.5-flash")
            
            logger.info(f"=== Strands Agent Loop ===")
            logger.info(f"Provider: {provider}, Model: {model}")
            
            try:
                llm, api_key = build_langchain_chat_model(provider, model, request.api_key, request.provider_config, temperature=0)
            except Exception as provider_error:
                yield f"data: {json.dumps({'type': 'error', 'content': f'Provider setup failed for {provider}: {provider_error}'})}\n\n"
                return
            
            # Initialize conversation history (Strands accumulates context)
            conversation_history = []
            
            # Inject current datetime into system prompt
            from langchain_core.messages import SystemMessage
            current_datetime = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p %Z")
            system_prompt_with_time = SYSTEM_PROMPT.replace('{current_datetime}', str(current_datetime))
            
            # Add system prompt as SystemMessage (not HumanMessage) so model treats it as instructions
            conversation_history.append(SystemMessage(content=system_prompt_with_time))
            
            history_limit = max(0, min(80, int(getattr(request, "history_limit", 20) or 0)))
            history_items = (request.history or [])[-history_limit:] if history_limit else []
            for h in history_items:
                role, content = h.get("role"), h.get("content", "")
                if role == "user":
                    conversation_history.append(HumanMessage(content=content))
                elif role == "assistant" and content:
                    conversation_history.append(AIMessage(content=content))
            
            # Add current user message
            conversation_history.append(HumanMessage(content=request.message))
            
            # Strands Agent Loop: Iterate until model produces final response
            loop_iteration = 0
            # NO MAX ITERATION LIMIT - Rely on dynamic timeout instead
            # Timeout handles: download (5m), generate (10m), backtest (30m), default (20m)
            # User can stop via DELETE /api/backtest/ai/chat-strands/{task_id}/stop
            tools_used_total = []
            all_steps = []
            triggered_tasks = []
            tool_data = {}
            total_prompt_tokens = 0
            total_completion_tokens = 0
            
            # Generate unique task ID for this chat session
            import uuid
            chat_task_id = str(uuid.uuid4())
            chat_sessions = getattr(app.state, 'chat_sessions', {})
            chat_sessions[chat_task_id] = {"stop_requested": False}
            app.state.chat_sessions = chat_sessions
            
            yield f"data: {json.dumps({'type': 'thinking', 'content': 'Starting Strands agent loop (unlimited iterations, timeout-based)...'})}\n\n"
            
            while True:  # Continue until model responds or user stops
                loop_iteration += 1
                logger.info(f"Strands Loop Iteration {loop_iteration}")
                
                # CHECK FOR STOP SIGNAL
                if chat_sessions.get(chat_task_id, {}).get("stop_requested"):
                    stop_step = {
                        "label": "⏹️ User Stopped",
                        "status": "warning",
                        "comment": "Task stopped by user",
                        "note": f"Completed {loop_iteration - 1} iterations before stop"
                    }
                    all_steps.append(stop_step)
                    yield f"data: {json.dumps({'type': 'step', 'step': stop_step})}\n\n"
                    break
                
                # REASONING PHASE: Invoke LLM
                yield f"data: {json.dumps({'type': 'thinking', 'content': f'[Loop {loop_iteration}] Reasoning phase: analyzing context...'})}\n\n"
                
                # Count prompt tokens for this iteration
                prompt_text = ""
                for m in conversation_history:
                    if hasattr(m, 'content') and m.content:
                        prompt_text += "\n" + str(m.content)
                total_prompt_tokens += _count_tokens(prompt_text)
                
                llm_with_tools = llm.bind_tools(ALL_TOOLS)
                response = llm_with_tools.invoke(conversation_history)
                total_completion_tokens += _count_tokens(str(getattr(response, 'content', '')))
                
                # TOOL SELECTION PHASE: Check if LLM wants to use tools
                if hasattr(response, "tool_calls") and response.tool_calls:
                    yield f"data: {json.dumps({'type': 'thinking', 'content': f'[Loop {loop_iteration}] Tool selection: LLM selected {len(response.tool_calls)} tools'})}\n\n"
                    
                    # TOOL EXECUTION PHASE: Execute selected tools
                    tool_results = []
                    
                    for tool_call in response.tool_calls:
                        tool_name = tool_call.get("name")
                        tool_input = tool_call.get("args", {})
                        
                        yield f"data: {json.dumps({'type': 'thinking', 'content': f'[Loop {loop_iteration}] Executing tool: {tool_name}'})}\n\n"
                        
                        step_start = {
                            "label": f"🔧 {tool_name}",
                            "status": "running",
                            "comment": f"Executing {tool_name}",
                            "note": str(tool_input)[:100]
                        }
                        all_steps.append(step_start)
                        yield f"data: {json.dumps({'type': 'step', 'step': step_start})}\n\n"
                        
                        # Find and execute tool
                        tool_executed = False
                        for t in ALL_TOOLS:
                            if t.name == tool_name:
                                try:
                                    loop = asyncio.get_event_loop()
                                    result = await loop.run_in_executor(None, lambda: t.invoke(tool_input))
                                    
                                    tool_results.append({
                                        "tool_name": tool_name,
                                        "result": result,
                                        "error": None
                                    })
                                    
                                    tool_data[tool_name] = result
                                    tools_used_total.append(tool_name)
                                    
                                    # Only task-creating tools may register a background task.
                                    # check_task_status returns the queried ID too.
                                    if tool_name in {"generate_strategy", "run_backtest", "download_market_data"} and isinstance(result, dict) and result.get("task_id"):
                                        task_id = result["task_id"]
                                        task_label = f"{tool_name}: {result.get('ticker', result.get('strategy', 'Task'))}"
                                        
                                        if tool_name == "generate_strategy":
                                            task_type = "forge"
                                        elif tool_name == "run_backtest":
                                            task_type = "backtest"
                                        elif tool_name == "download_market_data":
                                            task_type = "download"
                                        else:
                                            task_type = "task"
                                        
                                        triggered_tasks.append({"task_id": task_id, "task_type": task_type, "label": task_label})
                                        yield f"data: {json.dumps({'type': 'task_started', 'task_id': task_id, 'task_type': task_type, 'label': task_label})}\n\n"
                                        
                                        # Poll for completion - with dynamic timeout based on task type
                                        yield f"data: {json.dumps({'type': 'thinking', 'content': f'[Loop {loop_iteration}] Waiting for {tool_name} to complete...'})}\n\n"
                                        
                                        # Set timeout dynamically based on task type
                                        # Format: max_seconds = timeout in seconds (1 poll per second)
                                        if tool_name == "download_market_data":
                                            max_seconds = 300  # 5 minutes for downloads
                                        elif tool_name == "generate_strategy":
                                            max_seconds = 600  # 10 minutes for generation
                                        elif tool_name == "run_backtest":
                                            max_seconds = 1800  # 30 minutes for backtests (can be very slow)
                                        else:
                                            max_seconds = 1200  # 20 minutes default
                                        
                                        task_completed = False
                                        poll_count = 0
                                        timeout_reached = False
                                        
                                        while poll_count < max_seconds and not task_completed:
                                            await asyncio.sleep(1)
                                            poll_count += 1
                                            
                                            for t2 in ALL_TOOLS:
                                                if t2.name == "check_task_status":
                                                    try:
                                                        loop = asyncio.get_event_loop()
                                                        status_result = await loop.run_in_executor(None, lambda: t2.invoke({"task_id": task_id}))
                                                        
                                                        if status_result:
                                                            status = status_result.get("status")
                                                            progress = status_result.get("progress", 0)
                                                            current = status_result.get("current", "")
                                                            
                                                            yield f"data: {json.dumps({'type': 'progress', 'label': task_label, 'pct': progress, 'detail': current})}\n\n"
                                                            
                                                            if status == "completed":
                                                                result["status"] = "completed"
                                                                result["results"] = status_result.get("results")
                                                                tool_data[tool_name] = result
                                                                task_completed = True
                                                                break
                                                            elif status == "failed":
                                                                result["status"] = "failed"
                                                                result["error"] = status_result.get("error")
                                                                tool_data[tool_name] = result
                                                                task_completed = True
                                                                break
                                                    except Exception as e:
                                                        logger.error(f"check_task_status error: {e}")
                                                        break
                                        
                                        # Check if we hit timeout
                                        if not task_completed:
                                            timeout_reached = True
                                            # Preserve the work done so far - store partial result
                                            result["status"] = "timeout"
                                            result["note"] = f"Task still running after {max_seconds} seconds ({tool_name})"
                                            tool_data[tool_name] = result
                                            
                                            timeout_step = {
                                                "label": f"⏱️ {tool_name} Timeout",
                                                "status": "info",
                                                "comment": f"Task did not complete within {max_seconds} seconds",
                                                "note": f"Task {task_id} still running. Can check status in Task Center."
                                            }
                                            all_steps.append(timeout_step)
                                            yield f"data: {json.dumps({'type': 'step', 'step': timeout_step})}\n\n"
                                    
                                    step_success = {
                                        "label": f"✅ {tool_name}",
                                        "status": "success",
                                        "comment": f"Tool executed successfully",
                                        "note": str(result)[:100]
                                    }
                                    all_steps.append(step_success)
                                    yield f"data: {json.dumps({'type': 'step', 'step': step_success})}\n\n"
                                    
                                    tool_executed = True
                                    logger.info(f"✓ Tool {tool_name} executed in loop iteration {loop_iteration}")
                                    break
                                except Exception as e:
                                    logger.error(f"Tool {tool_name} error: {e}")
                                    tool_results.append({
                                        "tool_name": tool_name,
                                        "result": None,
                                        "error": str(e)
                                    })
                                    
                                    step_error = {
                                        "label": f"❌ {tool_name}",
                                        "status": "error",
                                        "comment": "Tool execution failed",
                                        "note": str(e)[:100]
                                    }
                                    all_steps.append(step_error)
                                    yield f"data: {json.dumps({'type': 'step', 'step': step_error})}\n\n"
                                    break
                        
                        if not tool_executed:
                            tool_results.append({
                                "tool_name": tool_name,
                                "result": None,
                                "error": "Tool not found"
                            })
                    
                    # Add tool results to conversation history (Strands accumulates context)
                    # Only add AIMessage if there's actual content (Mistral requires content or tool_calls)
                    if hasattr(response, 'content') and response.content:
                        conversation_history.append(AIMessage(content=response.content))
                    
                    # Add tool results as user message
                    tool_summary = "Tool execution results:\n"
                    for tr in tool_results:
                        if tr["error"]:
                            tool_summary += f"\n{tr['tool_name']}: ERROR - {tr['error']}"
                        else:
                            tool_summary += f"\n{tr['tool_name']}: {json.dumps(tr['result'], indent=2)[:300]}"
                    
                    conversation_history.append(HumanMessage(content=tool_summary))
                    
                    # Loop continues: Go back to REASONING PHASE with accumulated context
                    yield f"data: {json.dumps({'type': 'thinking', 'content': f'[Loop {loop_iteration}] Tool results added to context. Continuing loop...'})}\n\n"
                    
                else:
                    # NO TOOLS SELECTED: LLM produced final response
                    yield f"data: {json.dumps({'type': 'thinking', 'content': f'[Loop {loop_iteration}] No tools selected. Generating final response...'})}\n\n"
                    
                    # Stream the response token-by-token
                    response_text = ""
                    if hasattr(response, 'content'):
                        response_text = response.content
                    
                    # If response is empty, stream it
                    if response_text:
                        for chunk in response_text:
                            yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
                    else:
                        # Try streaming from LLM
                        for chunk in llm.stream(conversation_history):
                            if hasattr(chunk, 'content') and chunk.content:
                                response_text += chunk.content
                                yield f"data: {json.dumps({'type': 'response', 'content': response_text})}\n\n"
                    
                    # Exit loop: Final response generated
                    final_step = {
                        "label": "💬 Final Response",
                        "status": "success",
                        "comment": f"Generated after {loop_iteration} loop iterations",
                        "note": f"Response length: {len(response_text)} chars"
                    }
                    all_steps.append(final_step)
                    yield f"data: {json.dumps({'type': 'step', 'step': final_step})}\n\n"
                    
                    # Send completion
                    tools_summary = f"Strands loop completed in {loop_iteration} iterations. Used {len(set(tools_used_total))} unique tools: {', '.join(set(tools_used_total)) if tools_used_total else 'none'}"
                    yield f"data: {json.dumps({'type': 'done', 'thinking': tools_summary, 'steps': all_steps, 'tools_used': list(set(tools_used_total)), 'data': tool_data, 'triggered_tasks': triggered_tasks, 'loop_iterations': loop_iteration, 'task_id': chat_task_id, 'usage': {'prompt_tokens': total_prompt_tokens, 'completion_tokens': total_completion_tokens, 'total_tokens': total_prompt_tokens + total_completion_tokens}})}\n\n"
                    break
        
        except asyncio.CancelledError:
            logger.info("Strands chat client disconnected")
            return
        except Exception as e:
            logger.error(f"Strands loop error: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"

    async def guarded_strands_loop():
        async for event in generate_strands_loop():
            if await http_request.is_disconnected():
                logger.info("Strands chat client disconnected before next event")
                break
            yield event
    
    return StreamingResponse(guarded_strands_loop(), media_type="text/event-stream")


@app.delete("/api/backtest/ai/chat-strands/{task_id}/stop")
async def stop_strands_chat(task_id: str):
    """Stop a running Strands chat session"""
    chat_sessions = getattr(app.state, 'chat_sessions', {})
    if task_id in chat_sessions:
        chat_sessions[task_id]["stop_requested"] = True
        return {"message": f"Stop signal sent to task {task_id}"}
    raise HTTPException(status_code=404, detail=f"Task {task_id} not found")


# --- MAIN ENTRY ---
if __name__ == "__main__":
    import uvicorn
    
    # Start the scheduler
    scheduler.start()
    logger.info("Auto-sync scheduler started")
    
    # Load existing sync config and start jobs
    config = sync_config_table.get(Query().user_id == LOCAL_USER_ID)
    if config and config.get("enabled"):
        job_id = f"sync_{LOCAL_USER_ID}"
        interval_minutes = config.get("interval_minutes", 60)
        scheduler.add_job(
            sync_watchlist_data,
            trigger=IntervalTrigger(minutes=interval_minutes),
            id=job_id,
            replace_existing=True
        )
        sync_jobs[job_id] = scheduler.get_job(job_id)
        logger.info(f"Restored auto-sync job: every {interval_minutes} minutes")
    
    try:
        uvicorn.run(app, host="0.0.0.0", port=8000)
    finally:
        scheduler.shutdown()
        logger.info("Scheduler shut down")

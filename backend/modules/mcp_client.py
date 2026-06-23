"""
YFinance MCP Client
Spawns `uvx yfmcp@latest` as a subprocess and communicates via MCP stdio JSON-RPC.
Used as a fallback when the internal API cannot satisfy a request.
"""
import asyncio
import json
import logging
import shutil
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_INIT_TIMEOUT = 15.0
_CALL_TIMEOUT = 20.0


class YFinanceMCPClient:
    """Lazy-start MCP stdio client for yfmcp@latest."""

    def __init__(self):
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._lock = asyncio.Lock()
        self._msg_id = 0
        self._available: Optional[bool] = None  # None = not yet checked
        self._tools: Dict[str, Any] = {}

    # ── availability check ────────────────────────────────────────────────────
    def is_uvx_available(self) -> bool:
        return shutil.which("uvx") is not None

    async def ensure_started(self) -> bool:
        """Start the subprocess if not running. Returns True if ready."""
        if self._available is False:
            return False
        async with self._lock:
            if self._proc and self._proc.returncode is None:
                return True
            if not self.is_uvx_available():
                logger.warning("uvx not found — yfinance MCP fallback disabled")
                self._available = False
                return False
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    "uvx", "yfmcp@latest",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                # MCP initialize handshake
                await self._send({
                    "jsonrpc": "2.0", "id": self._next_id(),
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "trading-bot", "version": "1.0"}
                    }
                })
                resp = await self._read(timeout=_INIT_TIMEOUT)
                if resp and "result" in resp:
                    # send initialized notification
                    await self._send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
                    await self._load_tools()
                    self._available = True
                    logger.info(f"yfmcp started — tools: {list(self._tools.keys())}")
                    return True
                self._available = False
                return False
            except Exception as e:
                logger.warning(f"yfmcp start failed: {e}")
                self._available = False
                return False

    async def _load_tools(self):
        await self._send({"jsonrpc": "2.0", "id": self._next_id(), "method": "tools/list", "params": {}})
        resp = await self._read(timeout=_INIT_TIMEOUT)
        if resp and "result" in resp:
            for t in resp["result"].get("tools", []):
                self._tools[t["name"]] = t

    # ── public call interface ─────────────────────────────────────────────────
    async def call_tool(self, tool_name: str, arguments: Dict) -> Optional[Dict]:
        """Call an MCP tool. Returns parsed result or None on failure."""
        if not await self.ensure_started():
            return None
        try:
            msg_id = self._next_id()
            await self._send({
                "jsonrpc": "2.0", "id": msg_id,
                "method": "tools/call",
                "params": {"name": tool_name, "arguments": arguments}
            })
            resp = await self._read(timeout=_CALL_TIMEOUT)
            if not resp or "result" not in resp:
                return None
            content = resp["result"].get("content", [])
            # MCP returns content as list of {type, text} blocks
            texts = [c["text"] for c in content if c.get("type") == "text" and c.get("text")]
            if not texts:
                return None
            # try to parse as JSON, else return raw text
            raw = "\n".join(texts)
            try:
                return json.loads(raw)
            except Exception:
                return {"raw": raw}
        except Exception as e:
            logger.warning(f"yfmcp call_tool({tool_name}) failed: {e}")
            return None

    def get_tools(self) -> Dict[str, Any]:
        return self._tools

    # ── low-level stdio helpers ───────────────────────────────────────────────
    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    async def _send(self, msg: Dict):
        line = json.dumps(msg) + "\n"
        self._proc.stdin.write(line.encode())
        await self._proc.stdin.drain()

    async def _read(self, timeout: float = _CALL_TIMEOUT) -> Optional[Dict]:
        try:
            line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=timeout)
            if not line:
                return None
            return json.loads(line.decode().strip())
        except asyncio.TimeoutError:
            logger.warning("yfmcp read timeout")
            return None
        except Exception as e:
            logger.warning(f"yfmcp read error: {e}")
            return None

    async def shutdown(self):
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            await self._proc.wait()


# singleton
yf_mcp = YFinanceMCPClient()

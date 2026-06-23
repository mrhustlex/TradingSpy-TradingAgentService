"""Interactive REPL mode for conversational CLI interaction."""

import click
import sys
import os
import shutil
import asyncio
import httpx
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

try:
    import readline
    READLINE_AVAILABLE = True
except ImportError:
    READLINE_AVAILABLE = False

from utils.config import load_config, get


@click.command()
@click.option('--verbose', '-v', is_flag=True, help='Verbose output')
@click.option('--api', default=None, help='Backend API URL (e.g., http://backend:8000)')
@click.option('--mode', '-m', type=click.Choice(['analyst', 'agent', 'advisor']), default='agent', help='Agent mode: analyst (strands), agent (agentic), advisor (manual)')
@click.option('--show-openai', is_flag=True, help='Show OpenAI-compatible API endpoint info')
def interactive_cmd(verbose, api, mode, show_openai):
    """Interactive mode - have a conversation with the AI agent."""

    api_url = api or get('api_url', 'http://localhost:8000')

    agent_available = False
    try:
        r = httpx.get(f"{api_url}/health", timeout=2.0)
        if r.status_code == 200:
            agent_available = True
    except Exception:
        pass

    click.secho("╔════════════════════════════════════════════════════════╗", fg='blue')
    click.secho("║            TradingSpy Interactive Agent Mode           ║", fg='blue', bold=True)
    click.secho("╚════════════════════════════════════════════════════════╝", fg='blue')

    if agent_available:
        mode_names = {'analyst': 'Analyst Mode (strands)', 'agent': 'Agent Mode (agentic)', 'advisor': 'Advisor Mode'}
        click.secho(f"✅ Connected to {mode_names[mode]} — full chat enabled", fg='green', bold=True)
        click.secho("💡 Use -v/--verbose to see tool calls and thinking process", fg='cyan')
        click.secho("💡 Use -m/--mode [analyst|agent|advisor] to switch agent modes", fg='cyan')
    else:
        click.secho(f"⚠️  Backend not reachable at {api_url}", fg='yellow')
        click.secho("   Start the backend first: docker-compose up -d", fg='yellow')

    click.secho(f"🔗 API URL: {api_url}\n", fg='cyan')
    
    if show_openai:
        click.secho("🔌 OpenAI-Compatible API Endpoints:", fg='blue', bold=True)
        click.secho(f"   Base URL: {api_url}/v1", fg='cyan')
        click.secho(f"   Chat: POST {api_url}/v1/chat/completions", fg='cyan')
        click.secho(f"   Models: GET {api_url}/v1/models", fg='cyan')
        click.secho("\n📋 Example Usage:", fg='yellow', bold=True)
        click.secho("   curl -X POST \\", fg='white')
        click.secho(f"     {api_url}/v1/chat/completions \\", fg='white')
        click.secho("     -H 'Content-Type: application/json' \\", fg='white')
        click.secho("     -d '{", fg='white')
        click.secho('       "model": "trading-ai",', fg='white')
        click.secho('       "messages": [{"role": "user", "content": "Analyze AAPL"}]', fg='white')
        click.secho("     }'", fg='white')
        click.secho("\n🔗 Use this endpoint with any OpenAI-compatible client!", fg='green')
        return

    if READLINE_AVAILABLE:
        history_file = Path.home() / '.tradingspy_history'
        if history_file.exists():
            try:
                readline.read_history_file(str(history_file))
            except Exception:
                pass

    # Conversation history shared across turns
    conversation_history = []

    try:
        while True:
            try:
                query = click.prompt('> ', type=str).strip()
                if not query:
                    continue

                if query.lower() in ('exit', 'quit', 'bye'):
                    click.secho("\n👋 Goodbye!", fg='green')
                    break

                if query.lower() in ('clear', 'cls'):
                    click.clear()
                    continue

                if agent_available:
                    asyncio.run(process_query(query, api_url, conversation_history, mode, verbose))
                else:
                    click.secho("\n⚠️  Backend is offline. Start it with: docker-compose up -d", fg='yellow')

                if READLINE_AVAILABLE:
                    try:
                        readline.write_history_file(str(Path.home() / '.tradingspy_history'))
                    except Exception:
                        pass

            except click.Abort:
                continue

    except KeyboardInterrupt:
        click.echo("\n\n⏹️  Interrupted")
        sys.exit(0)


def _print_markdown(text: str):
    """Render markdown to terminal: bold, italic, tables, lists, code blocks, headers."""
    import re
    try:
        from tabulate import tabulate
        has_tabulate = True
    except ImportError:
        has_tabulate = False

    # ANSI helpers
    BOLD  = '\033[1m'
    DIM   = '\033[2m'
    RESET = '\033[0m'
    CYAN  = '\033[36m'
    GREEN = '\033[32m'
    YELLOW= '\033[33m'

    def inline(s):
        """Apply bold/italic/code inline formatting."""
        s = re.sub(r'\*\*(.+?)\*\*', lambda m: f"{BOLD}{m.group(1)}{RESET}", s)
        s = re.sub(r'__(.+?)__',     lambda m: f"{BOLD}{m.group(1)}{RESET}", s)
        s = re.sub(r'\*([^*]+)\*',   lambda m: f"\033[3m{m.group(1)}{RESET}", s)
        s = re.sub(r'_([^_]+)_',     lambda m: f"\033[3m{m.group(1)}{RESET}", s)
        s = re.sub(r'`([^`]+)`',     lambda m: f"{CYAN}{m.group(1)}{RESET}", s)
        return s

    lines = text.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i]

        # Fenced code block
        if line.startswith('```'):
            lang = line[3:].strip()
            code_lines = []
            i += 1
            while i < len(lines) and not lines[i].startswith('```'):
                code_lines.append(lines[i])
                i += 1
            if lang:
                click.secho(f"  [{lang}]", fg='cyan', dim=True)
            for cl in code_lines:
                click.secho(f"  {cl}", fg='cyan')
            i += 1
            continue

        # Table: collect rows until non-table line
        if '|' in line and i + 1 < len(lines) and re.match(r'^\|?[\s:|-]+\|', lines[i + 1]):
            table_lines = []
            while i < len(lines) and '|' in lines[i]:
                table_lines.append(lines[i])
                i += 1
            # Parse: split by |, strip, drop separator row
            rows = []
            for tl in table_lines:
                cells = [c.strip() for c in tl.strip('|').split('|')]
                if re.match(r'^[-: ]+$', ''.join(cells)):
                    continue  # separator
                rows.append(cells)
            if rows and has_tabulate:
                click.echo(tabulate(rows[1:], headers=rows[0], tablefmt='simple'))
            elif rows:
                for r in rows:
                    click.echo('  ' + '  │  '.join(r))
            click.echo()
            continue

        # Heading
        m = re.match(r'^(#{1,3})\s+(.*)', line)
        if m:
            level = len(m.group(1))
            title = m.group(2)
            if level == 1:
                click.secho(f"\n{BOLD}{title}{RESET}", bold=True)
                click.secho('─' * min(len(title), 60), fg='white', dim=True)
            elif level == 2:
                click.secho(f"\n{BOLD}{title}{RESET}", bold=True)
            else:
                click.secho(f"  {title}", bold=True)
            i += 1
            continue

        # Bullet list
        m = re.match(r'^(\s*)[-*]\s+(.*)', line)
        if m:
            indent = len(m.group(1)) // 2
            bullet = '  ' * indent + '  •'
            click.echo(f"{bullet} {inline(m.group(2))}")
            i += 1
            continue

        # Numbered list
        m = re.match(r'^(\s*)\d+\.\s+(.*)', line)
        if m:
            indent = len(m.group(1)) // 2
            num = re.match(r'\d+', line.lstrip()).group()
            click.echo(f"{'  ' * indent}  {BOLD}{num}.{RESET} {inline(m.group(2))}")
            i += 1
            continue

        # Horizontal rule
        if re.match(r'^[-*_]{3,}$', line.strip()):
            click.secho('─' * 60, dim=True)
            i += 1
            continue

        # Blank line
        if not line.strip():
            click.echo()
            i += 1
            continue

        # Normal paragraph
        click.echo(inline(line))
        i += 1


def _sparkline(prices: list) -> str:
    """Render a list of prices as a unicode sparkline."""
    bars = '▁▂▃▄▅▆▇█'
    if not prices or len(prices) < 2:
        return ''
    lo, hi = min(prices), max(prices)
    if hi == lo:
        return bars[3] * len(prices)
    return ''.join(bars[int((p - lo) / (hi - lo) * 7)] for p in prices)


def _render_market_item(item: dict):
    """Pretty-print a market data item (quote, chart, technicals, news)."""
    kind = item.get('type', '')
    ticker = item.get('ticker', '')

    if kind == 'chart':
        candles = item.get('data', [])
        closes = [c.get('close') for c in candles if c.get('close') is not None]
        if closes:
            spark = _sparkline(closes)
            pct = ((closes[-1] - closes[0]) / closes[0] * 100) if closes[0] else 0
            color = 'green' if pct >= 0 else 'red'
            sign = '+' if pct >= 0 else ''
            click.secho(f"\n  {ticker}  {spark}  {sign}{pct:.1f}%  "
                        f"${closes[-1]:.2f}", fg=color)

    elif kind == 'quote':
        price = item.get('price') or item.get('regularMarketPrice')
        change_pct = item.get('regularMarketChangePercent') or item.get('change_pct', 0)
        if price:
            color = 'green' if (change_pct or 0) >= 0 else 'red'
            sign = '+' if (change_pct or 0) >= 0 else ''
            click.secho(f"\n  {ticker}  ${price:.2f}  {sign}{change_pct:.2f}%", fg=color)

    elif kind == 'technicals':
        rsi = item.get('rsi')
        trend = item.get('trend', '')
        sma20 = item.get('sma20')
        if rsi is not None:
            rsi_color = 'red' if rsi > 70 else 'green' if rsi < 30 else 'white'
            line = f"\n  {ticker}  RSI {rsi:.1f}"
            if trend:
                line += f"  {trend}"
            if sma20:
                line += f"  SMA20 ${sma20:.2f}"
            click.secho(line, fg=rsi_color)

    elif kind == 'news':
        articles = item.get('articles', item.get('news', []))
        if articles:
            click.echo(f"\n  📰 {ticker} news:")
            for a in articles[:3]:
                title = a.get('title', '')
                click.secho(f"    • {title}", fg='cyan')

    elif kind == 'full':
        for sub_key in ('quote', 'technicals', 'news'):
            sub = item.get(sub_key)
            if isinstance(sub, dict):
                _render_market_item({**sub, 'type': sub_key, 'ticker': ticker})
            elif isinstance(sub, list) and sub_key == 'news':
                _render_market_item({'type': 'news', 'ticker': ticker, 'articles': sub})


async def process_query(query: str, api_url: str, history: list, mode: str = 'agent', verbose: bool = False):
    """Send query to agent with full conversation history, stream and display response."""

    # ── display helpers ──────────────────────────────────────────────────────
    _activity_line = ['']  # mutable so nested fns can update it

    def _write_activity(msg: str):
        """Overwrite the current activity line in place."""
        truncated = msg[:shutil.get_terminal_size((120, 24)).columns - 4]
        sys.stdout.write(f"\r\033[K\033[2m  {truncated}\033[0m")
        sys.stdout.flush()
        _activity_line[0] = msg

    def _end_activity():
        """Clear the activity line and move to a fresh line."""
        if _activity_line[0]:
            sys.stdout.write("\r\033[K")
            sys.stdout.flush()
            _activity_line[0] = ''

    def _tool_line(icon: str, label: str, color: str, dim: bool = False):
        """Print a permanent tool result line (like ● Tool in Claude Code)."""
        _end_activity()
        click.secho(f"  {icon} {label}", fg=color, dim=dim)

    # ── state ────────────────────────────────────────────────────────────────
    final_response = ""
    intermediate_shown = set()  # deduplicate intermediate_response content

    # Select endpoint based on mode
    endpoint_map = {
        'analyst': f"{api_url}/api/backtest/ai/chat-strands",
        'agent': f"{api_url}/api/backtest/ai/chat-agentic", 
        'advisor': f"{api_url}/api/backtest/ai/chat"
    }
    endpoint = endpoint_map[mode]
    
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                endpoint,
                json={"message": query, "history": history},
                headers={"Accept": "text/event-stream"}
            ) as response:
                if response.status_code != 200:
                    click.secho(f"❌ Error: {response.status_code}", fg='red')
                    return

                async for line in response.aiter_lines():
                    if not line.strip() or not line.startswith('data: '):
                        continue
                    try:
                        event = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue

                    t = event.get('type', '')

                    # ── activity line (overwrites in place, never scrolls) ──
                    if t == 'progress':
                        label = event.get('label', '').strip()
                        detail = event.get('detail', '').strip()
                        _write_activity(f"{label}  {detail}" if detail else label)

                    elif t == 'thinking':
                        if verbose:
                            _write_activity(event.get('content', '')[:100])

                    # ── permanent tool lines (only show in verbose mode) ───────────────────────────────
                    elif t == 'step':
                        if verbose:  # Only show tool calls in verbose mode
                            step = event.get('step', {})
                            status = step.get('status', '')
                            label = step.get('label', '').strip()
                            note = step.get('note', '').strip()
                            display = f"{label}" + (f"  \033[2m{note[:60]}\033[0m" if note else "")
                            if status == 'success':
                                _tool_line('●', display, 'green', dim=False)
                            elif status == 'error':
                                _tool_line('●', display, 'red', dim=False)
                            elif status == 'running':
                                _write_activity(f"● {label}")

                    elif t == 'market_data':
                        _end_activity()
                        data = event.get('data', [])
                        # data can be a list of items or a list of lists
                        for item in data:
                            if isinstance(item, list):
                                for sub in item:
                                    if isinstance(sub, dict):
                                        _render_market_item(sub)
                            elif isinstance(item, dict):
                                _render_market_item(item)

                    # ── mid-stream agent commentary (thinking out loud) ────
                    elif t == 'intermediate_response':
                        content = event.get('content', '').strip()
                        if content and content not in intermediate_shown:
                            intermediate_shown.add(content)
                            _end_activity()
                            click.secho(f"  ↳ {content}", fg='bright_black')

                    # ── confirm dialog ─────────────────────────────────────
                    elif t == 'confirm_request':
                        _end_activity()
                        confirm_id = event.get('confirm_id')
                        question = event.get('question', 'Proceed?')
                        options = event.get('options', ['Yes', 'No'])
                        default = event.get('default', options[0])
                        opts_str = '/'.join(o.upper() if o == default else o for o in options)
                        click.echo(f"\n  ❓ {question} [{opts_str}] ", nl=False)
                        try:
                            answer = input().strip() or default
                        except (EOFError, KeyboardInterrupt):
                            answer = default
                        try:
                            async with httpx.AsyncClient(timeout=5.0) as c:
                                await c.post(f"{api_url}/api/ai/confirm/{confirm_id}", json={"answer": answer})
                        except Exception:
                            pass

                    # ── final response ─────────────────────────────────────
                    elif t == 'response':
                        final_response = event.get('content', '')
                    elif t == 'result':
                        final_response = event.get('payload', {}).get('response', '')
                    elif t == 'done':
                        final_response = event.get('response', final_response)
                        break

        _end_activity()

        if final_response:
            click.echo()
            _print_markdown(final_response)
            click.echo()

        # Update conversation history
        if final_response:
            history.append({"role": "user", "content": query})
            history.append({"role": "assistant", "content": final_response})
            if len(history) > 20:
                history[:] = history[-20:]

    except asyncio.TimeoutError:
        _end_activity()
        click.secho("❌ Request timeout", fg='red')
    except Exception as e:
        _end_activity()
        click.secho(f"❌ {e}", fg='red')

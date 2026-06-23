#!/usr/bin/env python3
"""Main CLI entry point - exposes the Strands agent as command-line interface."""

import sys
import click
from pathlib import Path

# Add parent directory to path so we can import backend modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from commands import strategy, backtest, data, analyze, interactive, chat, acp


@click.group()
@click.version_option(version="0.1.0")
@click.pass_context
def cli(ctx):
    """
    TradingSpy CLI Agent
    
    Access the Strands agent from your terminal. Generate strategies, 
    backtest them, download data, and analyze stocks with natural language.
    
    Examples:
        tradingspy strategy generate "momentum strategy for NVDA"
        tradingspy backtest run SMA_Cross --dataset aapl-1d-1y.csv
        tradingspy data download AAPL --period 5y
        tradingspy analyze MSFT
        tradingspy acp ping
        tradingspy interactive
        tradingspy ask "What's the price of AAPL?"
    """
    ctx.ensure_object(dict)


@cli.command()
@click.argument('query')
@click.option('--mode', '-m', type=click.Choice(['auto', 'tool', 'manual']), default='tool', help='Agent mode')
@click.option('--api', default='http://localhost:8000', help='Backend API URL')
@click.option('--verbose', '-v', is_flag=True, help='Show tool calls and thinking')
def ask(query, mode, api, verbose):
    """Ask the AI agent a single question (non-interactive mode)"""
    import asyncio
    from commands.interactive import process_query
    
    try:
        asyncio.run(process_query(query, api, [], mode, verbose))
    except KeyboardInterrupt:
        click.echo("\n⏹️  Cancelled by user")
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)


# Register command groups
cli.add_command(strategy.strategy_group, name='strategy')
cli.add_command(backtest.backtest_group, name='backtest')
cli.add_command(data.data_group, name='data')
cli.add_command(analyze.analyze_group, name='analyze')
cli.add_command(interactive.interactive_cmd, name='interactive')
cli.add_command(chat.chat_group, name='chat')
cli.add_command(acp.acp_group, name='acp')


@cli.command()
def hello():
    """Test command - verify CLI is working."""
    click.secho("TradingSpy CLI is ready!", fg='green', bold=True)
    click.echo("Use 'tradingspy --help' to see available commands")


if __name__ == '__main__':
    try:
        cli(obj={})
    except KeyboardInterrupt:
        click.echo("\n⏹️  Cancelled by user")
        sys.exit(0)
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)

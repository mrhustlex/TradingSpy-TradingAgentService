"""Output formatting utilities for CLI."""

import json as json_lib
from tabulate import tabulate
import click


def to_json(data):
    """Convert data to pretty JSON string."""
    return json_lib.dumps(data, indent=2)


def strategy_table(strategies):
    """Format strategies as a table."""
    
    if not strategies:
        return "No strategies found"
    
    headers = ['Name', 'Class', 'Type', 'Status']
    rows = [
        [
            s.get('name', 'N/A'),
            s.get('class_name', 'N/A'),
            s.get('type', 'custom'),
            s.get('status', 'active'),
        ]
        for s in strategies
    ]
    
    return tabulate(rows, headers=headers, tablefmt='grid')


def backtest_results(results):
    """Format backtest results nicely."""
    
    output = []
    output.append(f"Strategy:       {results.get('strategy', 'N/A')}")
    output.append(f"Dataset:        {results.get('dataset', 'N/A')}")
    output.append("")
    output.append(f"Total Return:   {results.get('total_return', 0):+.1f}%")
    output.append(f"Sharpe Ratio:   {results.get('sharpe_ratio', 0):.2f}")
    output.append(f"Max Drawdown:   {results.get('max_drawdown', 0):.1f}%")
    output.append(f"Win Rate:       {results.get('win_rate', 0):.1%}")
    output.append(f"Total Trades:   {results.get('trades', 0)}")
    
    return "\n".join(output)


def comparison_table(results):
    """Format comparison results as a table."""
    
    if not results:
        return "No results to compare"
    
    headers = ['Strategy', 'Return', 'Sharpe', 'Drawdown']
    rows = [
        [
            r.get('strategy', 'N/A'),
            f"{r.get('return', 0):+.1f}%",
            f"{r.get('sharpe', 0):.2f}",
            f"{r.get('drawdown', 0):+.1f}%",
        ]
        for r in results
    ]
    
    return tabulate(rows, headers=headers, tablefmt='grid')


def format_error(msg):
    """Format error message."""
    return click.style(f"❌ {msg}", fg='red')


def format_success(msg):
    """Format success message."""
    return click.style(f"✅ {msg}", fg='green')


def format_info(msg):
    """Format info message."""
    return click.style(f"ℹ️  {msg}", fg='blue')


def format_warning(msg):
    """Format warning message."""
    return click.style(f"⚠️  {msg}", fg='yellow')

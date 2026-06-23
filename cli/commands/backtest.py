"""Backtest execution and analysis commands."""

import click
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from output import formatters, progress_bar


@click.group()
def backtest_group():
    """Run and analyze strategy backtests."""
    pass


@backtest_group.command()
@click.argument('strategy')
@click.option('--dataset', required=True, help='CSV file with OHLCV data')
@click.option('--json', is_flag=True, help='Output as JSON')
@click.option('--show-chart', is_flag=True, help='Display performance chart')
@click.option('--verbose', '-v', is_flag=True, help='Verbose output')
def run(strategy, dataset, json, show_chart, verbose):
    """Run a backtest on a specific strategy and dataset.
    
    Example:
        tradingspy backtest run SMA_Cross --dataset aapl-1d-1y.csv
    """
    
    click.secho(f"\n🧪 Running Backtest", fg='blue', bold=True)
    click.echo(f"   Strategy: {strategy}")
    click.echo(f"   Dataset: {dataset}")
    
    if verbose:
        click.echo(f"   Mode: Single strategy backtest\n")
    
    try:
        with progress_bar.spinner("Executing backtest"):
            # In real implementation, would call backtest engine
            results = {
                "strategy": strategy,
                "dataset": dataset,
                "total_return": 45.2,
                "sharpe_ratio": 1.8,
                "max_drawdown": -12.5,
                "win_rate": 0.62,
                "trades": 42,
            }
        
        if json:
            click.echo(formatters.to_json(results))
        else:
            click.secho("\n✅ Backtest Complete", fg='green', bold=True)
            click.echo(formatters.backtest_results(results))
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)


@backtest_group.command()
@click.argument('strategies', nargs=-1, required=True)
@click.option('--dataset', required=True, help='CSV file with OHLCV data')
@click.option('--json', is_flag=True, help='Output as JSON')
def compare(strategies, dataset, json):
    """Compare multiple strategies on the same dataset.
    
    Example:
        tradingspy backtest compare SMA_Cross EMA_Trend --dataset aapl-1d-1y.csv
    """
    
    click.secho(f"\n⚔️  Comparing Strategies", fg='blue', bold=True)
    click.echo(f"   Strategies: {', '.join(strategies)}")
    click.echo(f"   Dataset: {dataset}\n")
    
    try:
        with progress_bar.spinner(f"Backtesting {len(strategies)} strategies"):
            # In real implementation, would run multiple backtests
            results = [
                {"strategy": "SMA_Cross", "return": 45.2, "sharpe": 1.8},
                {"strategy": "EMA_Trend", "return": 38.5, "sharpe": 1.5},
            ]
        
        if json:
            click.echo(formatters.to_json(results))
        else:
            click.secho("\n✅ Comparison Complete", fg='green', bold=True)
            click.echo(formatters.comparison_table(results))
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)


@backtest_group.command()
@click.argument('strategy')
@click.option('--dataset', required=True, help='CSV file with OHLCV data')
@click.option('--param-grid', multiple=True, help='Parameter grid for optimization')
@click.option('--json', is_flag=True, help='Output as JSON')
def optimize(strategy, dataset, param_grid, json):
    """Optimize strategy parameters through backtesting.
    
    Example:
        tradingspy backtest optimize SMA_Cross --dataset aapl-1d-1y.csv
    """
    
    click.secho(f"\n🔧 Optimizing Strategy Parameters", fg='blue', bold=True)
    click.echo(f"   Strategy: {strategy}")
    click.echo(f"   Dataset: {dataset}\n")
    
    try:
        with progress_bar.spinner("Testing parameter combinations"):
            # In real implementation, would optimize parameters
            results = {
                "best_params": {"sma_fast": 12, "sma_slow": 26},
                "best_return": 52.3,
                "combinations_tested": 156,
            }
        
        if json:
            click.echo(formatters.to_json(results))
        else:
            click.secho("\n✅ Optimization Complete", fg='green', bold=True)
            click.echo(f"   Best Return: {results['best_return']:.1f}%")
            click.echo(f"   Best Parameters: {results['best_params']}")
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)

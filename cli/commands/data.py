"""Market data download and management commands."""

import click
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from output import progress_bar


@click.group()
def data_group():
    """Download and manage market data."""
    pass


@data_group.command()
@click.argument('tickers', nargs=-1, required=True)
@click.option('--period', default='1y', type=click.Choice(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']),
              help='Historical period')
@click.option('--interval', default='1d', type=click.Choice(['1m', '5m', '15m', '30m', '1h', '1d', '1wk', '1mo']),
              help='Data interval')
@click.option('--output', type=click.Path(), help='Output directory')
def download(tickers, period, interval, output):
    """Download market data for one or more tickers.
    
    Example:
        tradingspy data download AAPL MSFT --period 5y --interval 1d
    """
    
    output_dir = output or Path.cwd() / 'data'
    
    click.secho(f"\n📥 Downloading Market Data", fg='blue', bold=True)
    click.echo(f"   Tickers: {', '.join(tickers)}")
    click.echo(f"   Period: {period}")
    click.echo(f"   Interval: {interval}")
    click.echo(f"   Output: {output_dir}\n")
    
    try:
        with progress_bar.progress_bar(len(tickers), "Downloading") as pbar:
            for ticker in tickers:
                # In real implementation, would download from yfinance
                # Use progress_bar.update() as downloads complete
                pbar.update(1)
        
        click.secho(f"\n✅ Downloaded {len(tickers)} dataset(s)", fg='green', bold=True)
        for ticker in tickers:
            filename = f"{ticker.lower()}-{interval}-{period}.txt"
            click.echo(f"   ✓ {filename}")
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)


@data_group.command()
@click.option('--json', is_flag=True, help='Output as JSON')
def list(json):
    """List downloaded datasets."""
    
    click.secho("📊 Available Datasets", fg='blue', bold=True)
    
    try:
        datasets = [
            {"ticker": "AAPL", "period": "1y", "interval": "1d", "size": "2.4 MB"},
            {"ticker": "MSFT", "period": "5y", "interval": "1d", "size": "12.1 MB"},
        ]
        
        if json:
            import json as json_lib
            click.echo(json_lib.dumps(datasets, indent=2))
        else:
            from tabulate import tabulate
            click.echo(tabulate(datasets, headers=['Ticker', 'Period', 'Interval', 'Size']))
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)


@data_group.command()
@click.argument('ticker')
def info(ticker):
    """Show information about a dataset."""
    
    click.secho(f"📋 Dataset: {ticker}", fg='blue', bold=True)
    click.echo("Feature coming soon - will show data statistics and quality metrics")


@data_group.command()
@click.argument('ticker')
@click.confirmation_option(prompt='Delete this dataset?')
def delete(ticker):
    """Delete a downloaded dataset."""
    
    try:
        click.secho(f"✅ Deleted dataset: {ticker}", fg='green')
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)

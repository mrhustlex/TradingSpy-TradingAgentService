"""Stock analysis commands."""

import click
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from output import progress_bar


@click.group()
def analyze_group():
    """Analyze stocks and market data."""
    pass


@analyze_group.command()
@click.argument('ticker')
@click.option('--with-news', is_flag=True, help='Include latest news')
@click.option('--with-technicals', is_flag=True, help='Include technical indicators')
@click.option('--json', is_flag=True, help='Output as JSON')
def stock(ticker, with_news, with_technicals, json):
    """Analyze a stock with technical indicators and fundamentals.
    
    Example:
        tradingspy analyze stock AAPL --with-news --with-technicals
    """
    
    click.secho(f"\n📊 Analyzing Stock: {ticker}", fg='blue', bold=True)
    
    if with_news:
        click.echo("   ├─ Price & Technicals")
    if with_technicals:
        click.echo("   ├─ Technical Indicators")
    if with_news:
        click.echo("   └─ Latest News")
    click.echo()
    
    try:
        with progress_bar.spinner("Fetching analysis"):
            # In real implementation, would fetch real data
            analysis = {
                "ticker": ticker,
                "price": 150.25,
                "change": 2.3,
                "rsi": 62.4,
                "sma_50": 148.10,
                "sma_200": 145.80,
            }
        
        if json:
            import json as json_lib
            click.echo(json_lib.dumps(analysis, indent=2))
        else:
            click.secho(f"✅ Analysis Complete", fg='green')
            click.echo(f"\n   Current Price: ${analysis['price']:.2f}")
            click.echo(f"   Change: {analysis['change']:+.1f}%")
            click.echo(f"   RSI(14): {analysis['rsi']:.1f}")
            click.echo(f"   SMA(50): ${analysis['sma_50']:.2f}")
            click.echo(f"   SMA(200): ${analysis['sma_200']:.2f}")
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)


@analyze_group.command()
@click.argument('sector')
@click.option('--json', is_flag=True, help='Output as JSON')
def sector(sector, json):
    """Analyze a sector performance.
    
    Example:
        tradingspy analyze sector technology
    """
    
    click.secho(f"\n📊 Analyzing Sector: {sector.title()}", fg='blue', bold=True)
    
    try:
        with progress_bar.spinner("Fetching sector data"):
            # In real implementation, would fetch real data
            data = {
                "sector": sector,
                "change": 3.2,
                "top_movers": ["AAPL", "MSFT", "NVDA"],
            }
        
        if json:
            import json as json_lib
            click.echo(json_lib.dumps(data, indent=2))
        else:
            click.secho(f"✅ Analysis Complete", fg='green')
            click.echo(f"\n   Sector Change: {data['change']:+.1f}%")
            click.echo(f"   Top Movers: {', '.join(data['top_movers'])}")
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)

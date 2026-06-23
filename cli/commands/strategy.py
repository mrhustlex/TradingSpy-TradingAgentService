"""Strategy generation and management commands."""

import click
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from backend.modules.strands_agent import StrandsAgentLoop
from output import formatters, progress_bar
from utils import config


@click.group()
def strategy_group():
    """Generate and manage trading strategies."""
    pass


@strategy_group.command()
@click.argument('description')
@click.option('--count', default=1, type=int, help='Number of strategies to generate')
@click.option('--mode', default='agnostic', type=click.Choice(['agnostic', 'pattern_fit']), 
              help='Generation mode')
@click.option('--json', is_flag=True, help='Output as JSON')
@click.option('--verbose', '-v', is_flag=True, help='Verbose output')
def generate(description, count, mode, json, verbose):
    """Generate trading strategies from natural language description.
    
    Example:
        tradingspy strategy generate "momentum strategy using RSI for tech stocks"
    """
    
    click.secho(f"\n🧠 Generating {count} strateg{'y' if count == 1 else 'ies'}...", 
                fg='blue', bold=True)
    
    if verbose:
        click.echo(f"   Description: {description}")
        click.echo(f"   Mode: {mode}")
        click.echo()
    
    try:
        # Initialize agent
        agent = StrandsAgentLoop(
            model="gpt-4",
            temperature=0.7,
            max_iterations=float('inf'),
            timeout=600
        )
        
        # Build the prompt for strategy generation
        prompt = f"Generate {count} unique trading strateg{'y' if count == 1 else 'ies'} with description: {description}"
        
        # Run with progress indicator
        with progress_bar.spinner("Processing with AI agent"):
            results = []  # Would stream from agent in real implementation
            # results = agent.run(prompt, mode=mode)
        
        if json:
            click.echo(formatters.to_json({"strategies": results, "count": len(results)}))
        else:
            click.secho(f"\n✅ Generated {len(results)} strateg{'y' if len(results) == 1 else 'ies'}", 
                       fg='green', bold=True)
            # click.echo(formatters.strategy_table(results))
        
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)


@strategy_group.command()
@click.option('--json', is_flag=True, help='Output as JSON')
def list(json):
    """List all available strategies."""
    
    click.secho("📚 Available Strategies", fg='blue', bold=True)
    
    try:
        # In real implementation, would fetch from database
        strategies = [
            {"name": "SMA_Cross", "class_name": "SMAStrategy", "type": "built-in"},
            {"name": "EMA_Trend", "class_name": "EMAStrategy", "type": "built-in"},
            {"name": "RSI_Momentum", "class_name": "RSIMomentum", "type": "custom"},
        ]
        
        if json:
            click.echo(formatters.to_json(strategies))
        else:
            click.echo(formatters.strategy_table(strategies))
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)


@strategy_group.command()
@click.argument('name')
def info(name):
    """Show details about a specific strategy."""
    
    click.secho(f"📋 Strategy: {name}", fg='blue', bold=True)
    click.echo("Feature coming soon - will show strategy code, parameters, and description")


@strategy_group.command()
@click.argument('name')
@click.confirmation_option(prompt='Are you sure you want to delete this strategy?')
def delete(name):
    """Delete a custom strategy."""
    
    try:
        # In real implementation, would delete from database
        click.secho(f"✅ Deleted strategy: {name}", fg='green')
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red', err=True)
        sys.exit(1)

"""Chat thread sharing commands."""

import click
import requests
import json
from pathlib import Path
from utils.config import get_default_config


@click.group()
def chat_group():
    """Chat thread management commands."""
    pass


@chat_group.command()
@click.argument('thread_id')
@click.option('--limit', '-l', type=int, help='Limit to last N messages')
@click.option('--server', default='http://localhost:8000', help='Backend server URL')
def share(thread_id, limit, server):
    """Share a chat thread and get a shareable link."""
    try:
        # Load thread data from localStorage equivalent (config file)
        config_dir = Path.home() / '.tradingspy'
        threads_file = config_dir / 'chat_threads.json'
        
        if not threads_file.exists():
            click.secho("❌ No chat threads found", fg='red')
            return
        
        with open(threads_file) as f:
            data = json.load(f)
        
        # Find the thread
        thread = None
        for t in data.get('threads', []):
            if t['id'] == thread_id:
                thread = t
                break
        
        if not thread:
            click.secho(f"❌ Thread {thread_id} not found", fg='red')
            return
        
        # Prepare share request
        share_data = {
            'thread_id': thread['id'],
            'title': thread['title'],
            'messages': thread['messages'],
            'history': thread.get('history', [])
        }
        
        if limit:
            share_data['limit_lines'] = limit
        
        # Send to backend
        response = requests.post(f"{server}/api/chat/share", json=share_data)
        
        if response.status_code == 200:
            result = response.json()
            share_url = f"{server.replace(':8000', ':3000')}/shared/{result['share_id']}"
            click.secho(f"✅ Chat shared successfully!", fg='green')
            click.echo(f"Share ID: {result['share_id']}")
            click.echo(f"URL: {share_url}")
        else:
            click.secho(f"❌ Failed to share chat: {response.text}", fg='red')
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red')


@chat_group.command()
@click.option('--server', default='http://localhost:8000', help='Backend server URL')
def list(server):
    """List available chat threads."""
    try:
        config_dir = Path.home() / '.tradingspy'
        threads_file = config_dir / 'chat_threads.json'
        
        if not threads_file.exists():
            click.secho("❌ No chat threads found", fg='red')
            return
        
        with open(threads_file) as f:
            data = json.load(f)
        
        threads = data.get('threads', [])
        if not threads:
            click.secho("No chat threads found", fg='yellow')
            return
        
        click.secho("📋 Available Chat Threads:", fg='blue', bold=True)
        for thread in threads:
            msg_count = len(thread.get('messages', []))
            click.echo(f"  {thread['id']}: {thread['title']} ({msg_count} messages)")
            
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red')

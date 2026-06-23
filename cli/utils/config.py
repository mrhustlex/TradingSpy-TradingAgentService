"""Configuration management for CLI."""

from pathlib import Path
import json
from typing import Dict, Any


CONFIG_DIR = Path.home() / '.tradingspy'
CONFIG_FILE = CONFIG_DIR / 'config.json'


def ensure_config_dir():
    """Ensure config directory exists."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_config() -> Dict[str, Any]:
    """Load configuration from file."""
    
    ensure_config_dir()
    
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE) as f:
            return json.load(f)
    
    return get_default_config()


def save_config(config: Dict[str, Any]):
    """Save configuration to file."""
    
    ensure_config_dir()
    
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)


def get_default_config() -> Dict[str, Any]:
    """Get default configuration."""
    
    return {
        "output_format": "pretty",  # pretty, json, csv
        "api_provider": "openai",
        "api_model": "gpt-4",
        "temperature": 0.7,
        "verbose": False,
        "data_dir": str(Path.home() / '.tradingspy' / 'data'),
        "cache_enabled": True,
        "api_url": "http://localhost:8000",  # Backend API URL (Docker: http://backend:8000)
    }


def get(key: str, default=None):
    """Get configuration value."""
    
    config = load_config()
    return config.get(key, default)


def set(key: str, value: Any):
    """Set configuration value."""
    
    config = load_config()
    config[key] = value
    save_config(config)

"""Setup configuration for TradingSpy CLI."""

from setuptools import setup, find_packages
from pathlib import Path

# Get the long description from README
readme_path = Path(__file__).parent / "README.md"
if readme_path.exists():
    with open(readme_path, "r", encoding="utf-8") as fh:
        long_description = fh.read()
else:
    long_description = "Command-line interface for TradingSpy Strands agent"

setup(
    name="tradingspy-cli",
    version="0.1.0",
    author="TradingSpy",
    description="Command-line interface for TradingSpy Strands agent",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/mrhustlex/TradingSpy",
    packages=find_packages(where="."),
    py_modules=["cli"],
    classifiers=[
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Development Status :: 3 - Alpha",
    ],
    python_requires=">=3.8",
    install_requires=[
        "click>=8.2.1",
        "tabulate>=0.9.0",
        "colorama>=0.4.6",
        "pyyaml>=6.0.1",
    ],
    entry_points={
        "console_scripts": [
            "tradingspy=cli:cli",
            "tradingai=cli:cli",
        ],
    },
)

FROM python:3.11-slim

WORKDIR /app

# Install system dependencies + uv (provides uvx for MCP servers)
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# Make uvx available on PATH
ENV PATH="/root/.local/bin:$PATH"

# Install Python dependencies
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt


# Copy application code
COPY . .

# Create data directories
RUN mkdir -p data/strategies data/results data/market_data data/temp_datas data/optimization_history

# Expose the API port
EXPOSE 8000

# Run with uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "1"]

FROM ghcr.io/astral-sh/uv:0.9.18 AS uv

FROM python:3.11-slim

WORKDIR /app

# Install the healthcheck client without pulling recommended packages.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Pin uv/uvx instead of downloading an installer script during the build.
COPY --from=uv /uv /uvx /usr/local/bin/

# Install Python dependencies
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install -r requirements.txt


# Copy application code
COPY . .

# Create data directories
RUN mkdir -p data/strategies data/results data/market_data data/temp_datas data/optimization_history

# Expose the API port
EXPOSE 8000

# Run with uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "1"]

FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for audio processing + git
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libsndfile1 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install PyTorch CPU first (largest dependency)
RUN pip install --no-cache-dir \
    torch==2.7.1+cpu \
    torchaudio==2.7.1+cpu \
    --index-url https://download.pytorch.org/whl/cpu

# Install stable-audio-3 from GitHub
RUN pip install --no-cache-dir --no-deps \
    "stable-audio-3 @ git+https://github.com/Stability-AI/stable-audio-3.git"

# Install remaining dependencies
RUN pip install --no-cache-dir \
    fastapi==0.139.0 \
    uvicorn==0.51.0 \
    httpx==0.28.1 \
    soundfile==0.14.0 \
    numpy==2.5.1 \
    pydantic==2.13.4 \
    anyio==4.14.1 \
    python-multipart==0.0.32 \
    huggingface_hub \
    safetensors \
    einops \
    transformers

# Copy application
COPY app/ app/
COPY static/ static/

# Create data directory
RUN mkdir -p /app/generated

# Expose port
EXPOSE 8600

# Default environment variables
ENV SFX_HOST=0.0.0.0
ENV SFX_PORT=${PORT:-8600}
ENV SFX_DEVICE=cpu
ENV SFX_DATA_DIR=/app/generated
ENV SFX_LLM_URL=""

EXPOSE ${PORT:-8600}

CMD ["sh", "-c", "python -m app.main --host 0.0.0.0 --port ${PORT:-8600}"]

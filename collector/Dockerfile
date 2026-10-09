# Build context: repository root (needs db/migrations as well as collector/).
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Asia/Yerevan \
    DATA_DIR=/app/data \
    MIGRATIONS_DIR=/app/migrations

RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 trichq

WORKDIR /app
COPY collector/pyproject.toml ./
COPY collector/trichq ./trichq
RUN pip install .
COPY db/migrations ./migrations

RUN mkdir -p /app/data && chown -R trichq:trichq /app
USER trichq

CMD ["python", "-m", "trichq", "scheduler"]

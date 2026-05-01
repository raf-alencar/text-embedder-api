# text-embedder-api Documentation

**Version:** 2.1.0
**Base URL:** `http://localhost:3233`
**Health check:** `GET /health` — returns status, embedding-provider connectivity, model, and dimensions

---

## Overview

A self-hosted HTTP API for vector embeddings via OpenRouter. All embedding endpoints require an `X-API-Key` header. The health check and service info endpoints are open.

### Auth

All write endpoints require:
```
X-API-Key: your-raw-key
```

The raw key is hashed with SHA-256 and compared against `API_KEY_HASH` in your environment. The raw key is never stored. If `API_KEY_HASH` is not set, auth is disabled (dev mode — all requests pass).

Generate a key hash:
```bash
echo -n "your-raw-key" | sha256sum
```

---

## Service Endpoints

---

### `GET /`

Returns service name, version, model configuration, and full endpoint listing.

**Returns:**
```json
{
  "status": "ok",
  "service": "text-embedder-api",
  "version": "2.0.0",
  "provider": "openrouter",
  "provider_url": "https://openrouter.ai/api/v1",
  "model": "qwen/qwen3-embedding-4b",
  "dimensions": 2560,
  "registered_services": 2,
  "endpoints": [...]
}
```

---

### `GET /health`

Pings the OpenRouter embedding endpoint with a test string. Use this for uptime monitoring.

**Returns:**
```json
{ "status": "ok", "provider": "openrouter", "model": "qwen/qwen3-embedding-4b", "dimensions": 2560 }
```

Returns `503` if OpenRouter is unreachable.

---

### `GET /info`

Returns model configuration so consuming services can verify compatibility before registering.

**Returns:**
```json
{
  "provider": "openrouter",
  "provider_url": "https://openrouter.ai/api/v1",
  "model": "qwen/qwen3-embedding-4b",
  "dimensions": 2560,
  "registered_services": 2
}
```

---

## Embedding Endpoints

---

### `POST /embed`

Embed a single text string.

**Headers:**
```
X-API-Key: your-raw-key
Content-Type: application/json
```

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | string | — | Text to embed (required) |
| `model` | string | `EMBED_MODEL` env var | Override the default model for this request |

**Returns:**
```json
{
  "embedding": [0.023, -0.041, 0.118, ...],
  "dimensions": 2560,
  "model": "qwen/qwen3-embedding-4b",
  "usage": { "prompt_tokens": 9, "total_tokens": 9, "cost": 1.8e-7 }
}
```

**Example:**
```bash
curl -X POST http://localhost:3233/embed \
  -H "X-API-Key: your-raw-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "Organizations fail because environments make misalignment easy"}'
```

---

### `POST /embed/batch`

Embed multiple strings in one call. More efficient than calling `/embed` in a loop.

**Headers:**
```
X-API-Key: your-raw-key
Content-Type: application/json
```

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `texts` | string[] | — | Array of strings to embed (required). Max 100. |
| `model` | string | `EMBED_MODEL` env var | Override the default model for this request |

**Returns:**
```json
{
  "embeddings": [
    [0.023, -0.041, ...],
    [0.118, 0.205, ...],
    [-0.033, 0.091, ...]
  ],
  "dimensions": 2560,
  "model": "qwen/qwen3-embedding-4b",
  "count": 3,
  "usage": { "prompt_tokens": 12, "total_tokens": 12, "cost": 2.4e-7 }
}
```

**Example:**
```bash
curl -X POST http://localhost:3233/embed/batch \
  -H "X-API-Key: your-raw-key" \
  -H "Content-Type: application/json" \
  -d '{
    "texts": [
      "First document",
      "Second document",
      "Third document"
    ]
  }'
```

Returns `400` if `texts` array exceeds 100 items.

---

## Polling Loop Endpoints

---

### `POST /register`

Register a PostgreSQL table for automatic null-embedding polling. After registration, text-embedder-api polls the table on the configured interval, embeds any rows where the embedding column is NULL, and writes the vectors back.

Registrations are in-memory — they do not survive a service restart. Services should re-register on their own startup.

**Headers:**
```
X-API-Key: your-raw-key
Content-Type: application/json
```

**Body parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `service_name` | string | — | Unique identifier for this registration (required) |
| `db_url` | string | — | PostgreSQL connection string (required) |
| `table` | string | — | Table name to poll (required) |
| `id_column` | string | — | Primary key column name (required) |
| `text_columns` | string[] | — | Columns to concatenate for embedding (required) |
| `embedding_column` | string | — | Vector column to write embeddings to (required) |
| `vector_type` | string | `vector` | pgvector type used for the cast on UPDATE. Set to `halfvec` if your column is `halfvec(N)` (16-bit float, supports HNSW up to 4000 dims). Allowed values: `vector`, `halfvec` |
| `batch_size` | number | `50` | Records to embed per polling run |
| `interval_seconds` | number | `300` | Polling interval in seconds |

**text_columns note:** Multiple columns are concatenated with a space before embedding. `["title", "summary"]` produces `"{title} {summary}"` as the embedding input.

**Returns:**
```json
{
  "registered": true,
  "service_name": "my-service",
  "table": "documents",
  "vector_type": "halfvec",
  "interval_seconds": 300,
  "next_run": "2026-04-23T19:05:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3233/register \
  -H "X-API-Key: your-raw-key" \
  -H "Content-Type: application/json" \
  -d '{
    "service_name": "my-service",
    "db_url": "postgresql://user:pass@host:5432/mydb",
    "table": "documents",
    "id_column": "id",
    "text_columns": ["title", "summary"],
    "embedding_column": "embedding",
    "batch_size": 50,
    "interval_seconds": 300
  }'
```

---

### `DELETE /register/:service_name`

Unregister a service. Stops the polling loop for that service and closes the DB connection pool.

**Headers:**
```
X-API-Key: your-raw-key
```

**Returns:** `{ "unregistered": true, "service_name": "my-service" }`

**Example:**
```bash
curl -X DELETE http://localhost:3233/register/my-service \
  -H "X-API-Key: your-raw-key"
```

---

### `GET /registrations`

List all currently registered polling targets with their configuration and last run time.

**Headers:**
```
X-API-Key: your-raw-key
```

**Returns:**
```json
[
  {
    "service_name": "my-service",
    "table": "documents",
    "embedding_column": "embedding",
    "vector_type": "halfvec",
    "batch_size": 50,
    "interval_seconds": 300,
    "last_run": "2026-04-23T19:00:00.000Z",
    "next_run": "2026-04-23T19:05:00.000Z",
    "last_count": 12
  }
]
```

---

### `POST /poll/:service_name`

Manually trigger a polling run for a registered service without waiting for the next scheduled interval. Useful for immediate embedding after a bulk import.

**Headers:**
```
X-API-Key: your-raw-key
```

**Returns:**
```json
{
  "service_name": "my-service",
  "records_processed": 8,
  "duration_ms": 2341
}
```

**Example:**
```bash
curl -X POST http://localhost:3233/poll/my-service \
  -H "X-API-Key: your-raw-key"
```

Returns `404` if the service is not registered.

---

## Error Response Shape

All errors:
```json
{ "error": "Human-readable description", "details": "specifics or null" }
```

Common codes:
- `400` — missing required field or batch limit exceeded
- `401` — missing or invalid API key
- `404` — service not registered (for poll/unregister endpoints)
- `503` — OpenRouter unreachable (health check)
- `500` — DB error during polling (logged, polling continues)

---

## Docker

**Image:** built locally from `Dockerfile`
**Base:** `node:20-alpine`
**Port:** `3233` (host) → `3000` (container)

```yaml
services:
  text-embedder-api:
    build: .
    container_name: text-embedder-api
    ports:
      - "3233:3000"
    environment:
      - OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
      - OPENROUTER_BASE_URL=${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}
      - EMBED_MODEL=${EMBED_MODEL:-qwen/qwen3-embedding-4b}
      - EMBED_DIMENSIONS=${EMBED_DIMENSIONS:-2560}
      - API_KEY_HASH=${API_KEY_HASH}
      - PORT=3000
    restart: unless-stopped
```

**Rebuild after code changes:**
```bash
docker build -t text-embedder-api . && \
docker stop text-embedder-api && \
docker rm text-embedder-api && \
docker run -d --name text-embedder-api -p 3233:3000 \
  -e OPENROUTER_API_KEY=sk-or-v1-... \
  -e EMBED_MODEL=qwen/qwen3-embedding-4b \
  -e EMBED_DIMENSIONS=2560 \
  -e API_KEY_HASH=your-hash \
  text-embedder-api
```

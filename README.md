# text-embedder-api

A self-hosted HTTP API for vector embeddings via Ollama. Designed for use in automated pipelines — n8n, custom workflows, multi-service architectures — where multiple services need text embeddings from a single shared model without each implementing their own polling loop.

Accepts text, returns vectors. Also runs an async null-embedding polling loop for any registered PostgreSQL table — so your services stay focused on their own logic while embeddings are handled in the background.

---

## What it does

**Embedding**
- Embed a single text string → float array
- Batch embed up to 100 strings in one call
- Configurable model per request or globally via env var
- Works with any Ollama-served embedding model

**Async polling loop**
- Register any PostgreSQL table with a vector column
- Automatically polls for NULL embeddings on a configurable interval
- Calls Ollama, writes vectors back — no code changes needed in your services
- Multiple services register independently, each with their own schedule

**Compatible with**
- Any Ollama embedding model (`nomic-embed-text`, `mxbai-embed-large`, etc.)
- Any PostgreSQL table with a `vector(N)` column (pgvector)
- n8n, Make, custom HTTP clients

---

## Quick start

### Docker Compose (recommended)

```yaml
services:
  text-embedder-api:
    image: ghcr.io/your-username/text-embedder-api:latest
    container_name: text-embedder-api
    ports:
      - "3233:3000"
    environment:
      - OLLAMA_BASE_URL=http://your-ollama-host:11434
      - OLLAMA_API_KEY=your-gateway-key
      - EMBED_MODEL=nomic-embed-text
      - EMBED_DIMENSIONS=768
      - API_KEY_HASH=your-sha256-hash
    restart: unless-stopped
```

Or build from source:

```yaml
services:
  text-embedder-api:
    build: .
    container_name: text-embedder-api
    ports:
      - "3233:3000"
    environment:
      - OLLAMA_BASE_URL=http://your-ollama-host:11434
      - OLLAMA_API_KEY=your-gateway-key
      - EMBED_MODEL=nomic-embed-text
      - EMBED_DIMENSIONS=768
      - API_KEY_HASH=your-sha256-hash
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Build manually

```bash
git clone https://github.com/your-username/text-embedder-api.git
cd text-embedder-api
docker build -t text-embedder-api .
docker run -d --name text-embedder-api -p 3233:3000 \
  -e OLLAMA_BASE_URL=http://your-ollama-host:11434 \
  -e OLLAMA_API_KEY=your-gateway-key \
  -e EMBED_MODEL=nomic-embed-text \
  -e EMBED_DIMENSIONS=768 \
  text-embedder-api
```

### Verify

```bash
curl http://localhost:3233/health
```

Returns `{ "status": "ok", "ollama": "ok", "model": "nomic-embed-text", "dimensions": 768 }`

### Generate your API key hash

```bash
echo -n "your-raw-key" | sha256sum
# copy the hex string into API_KEY_HASH
```

The raw key goes in your `X-API-Key` header. Only the hash is stored — the raw key is never saved anywhere.

---

## Usage

### Embed a single text

```bash
curl -X POST http://localhost:3233/embed \
  -H "X-API-Key: your-raw-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "The quick brown fox jumps over the lazy dog"}'
```

Returns:
```json
{
  "embedding": [0.023, -0.041, 0.118, ...],
  "dimensions": 768,
  "model": "nomic-embed-text"
}
```

### Batch embed multiple strings

```bash
curl -X POST http://localhost:3233/embed/batch \
  -H "X-API-Key: your-raw-key" \
  -H "Content-Type: application/json" \
  -d '{
    "texts": [
      "First document to embed",
      "Second document to embed",
      "Third document to embed"
    ]
  }'
```

Returns:
```json
{
  "embeddings": [[...], [...], [...]],
  "dimensions": 768,
  "model": "nomic-embed-text",
  "count": 3
}
```

### Register a table for async polling

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

After registration, text-embedder-api polls the table every 5 minutes. Any row where `embedding IS NULL` gets embedded and updated automatically. Your service never calls text-embedder-api again unless it wants to re-register after a restart.

### Check registered services

```bash
curl -H "X-API-Key: your-raw-key" http://localhost:3233/registrations
```

### Trigger a manual poll

```bash
curl -X POST -H "X-API-Key: your-raw-key" http://localhost:3233/poll/my-service
```

---

## Registration pattern for your services

On startup, each service that needs embeddings registers itself:

```javascript
// Call this on service startup — fire and forget
async function registerWithEmbeddingApi() {
  try {
    await fetch(`${process.env.EMBEDDING_API_URL}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.EMBEDDING_API_KEY,
      },
      body: JSON.stringify({
        service_name: 'my-service',
        db_url: process.env.DATABASE_URL,
        table: 'documents',
        id_column: 'id',
        text_columns: ['title', 'summary'],
        embedding_column: 'embedding',
        batch_size: 50,
        interval_seconds: 300,
      }),
    });
  } catch (err) {
    console.warn('text-embedder-api not reachable at startup — will retry on next restart');
  }
}
```

If text-embedder-api is down when your service starts, registration fails silently. Your service still starts. Embeddings resume when text-embedder-api comes back online and your service re-registers on its next restart.

---

## Common pipelines

### Single service with async embeddings
```
Service writes document → embedding IS NULL
text-embedder-api polls (every 5 min) → calls Ollama → writes vector back
Service queries with pgvector cosine similarity → semantic search works
```

### Multiple services, one embedding instance
```
Service A registers table_a → polling every 5 min
Service B registers table_b → polling every 10 min
Service C registers table_c → polling every 1 min
One text-embedder-api instance handles all three
```

### n8n workflow embedding
```
POST /embed/batch   { texts: [...] }   → embeddings[]
Store vectors in your DB via n8n Set node
```

---

## Full API reference

See [API.md](API.md) for complete endpoint documentation including all parameters, defaults, and examples.

---

## Requirements

- Docker
- Ollama instance with at least one embedding model pulled
- PostgreSQL with pgvector extension (for the polling loop feature)

No other dependencies. Node.js is installed inside the container.

---

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `OLLAMA_BASE_URL` | — | Base URL of your Ollama instance (required) |
| `OLLAMA_API_KEY` | — | API key forwarded as `X-API-Key` to Ollama (e.g. Caddy gateway auth). Leave blank if your Ollama is unprotected |
| `EMBED_MODEL` | `nomic-embed-text` | Default embedding model |
| `EMBED_DIMENSIONS` | `768` | Output dimensions (must match your vector column size) |
| `API_KEY_HASH` | — | SHA-256 hex of your raw API key. If unset, auth is disabled (dev mode) |
| `PORT` | `3000` | Port the server listens on inside the container |

### Choosing an embedding model

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `nomic-embed-text` | 768 | Fast, good quality, recommended for most use cases |
| `mxbai-embed-large` | 1024 | Higher quality, slower |
| `all-minilm` | 384 | Fastest, lower quality |

Pull models via Ollama before starting:
```bash
ollama pull nomic-embed-text
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.

Ollama is a dependency with its own license terms. This project's MIT license applies solely to the Node.js wrapper code in this repository.

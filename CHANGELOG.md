# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.1] — 2026-05-01

### Fixed

- **Embed function no longer crashes on malformed OpenRouter responses.** Previously, when OpenRouter returned HTTP 200 with an error body (a known behavior under upstream-provider failures or rate-limit edge cases), `embed()` would throw `Cannot read properties of undefined (reading 'map')` and surface as an uninformative HTTP 500. The function now: reads body unconditionally, parses defensively, surfaces `data.error` from the upstream when present, validates `data.data` is an array of expected length, and validates each item has an `embedding` array. Errors now name the actual upstream cause instead of a JS runtime error.

---

## [2.1.0] — 2026-04-30

### Added

- **`vector_type` field on `POST /register`** — controls the pgvector type used in the polling loop's `UPDATE ... SET embedding = $1::<type>` cast. Allowed values: `vector` (default, backward-compatible) or `halfvec`. Set to `halfvec` when your embedding column is `halfvec(N)`, which supports HNSW indexing up to 4000 dimensions (vs `vector`'s 2000-dim cap) and halves storage cost.
- `vector_type` is now echoed in `POST /register` response and listed per registration in `GET /registrations`.

### Why halfvec matters at 2560-dim

The locked-in model `qwen/qwen3-embedding-4b` produces 2560-dim vectors. pgvector's HNSW index only supports `vector` columns up to 2000 dims, so HNSW is impossible on `vector(2560)`. Using `halfvec(2560)` enables HNSW (limit 4000) at the cost of float16 precision — typically <0.5% recall@10 difference for cosine retrieval, while halving storage.

### Recommended consumer migration

```sql
UPDATE <table> SET embedding = NULL;
ALTER TABLE <table> ALTER COLUMN embedding TYPE halfvec(2560);
-- Add HNSW once row count justifies it (sub-100ms seq scan up to ~5K rows):
CREATE INDEX <table>_embedding_idx ON <table>
  USING hnsw (embedding halfvec_cosine_ops);
```

Then re-register with `vector_type: "halfvec"` so the polling loop casts to the right type on write.

---

## [2.0.0] — 2026-04-30

**Breaking change.** Migrated from Ollama to OpenRouter as the embedding provider. Locked in `qwen/qwen3-embedding-4b` (2560-dim, multilingual, 32K context, open-weight) as the canonical model — same vector space across all consumers (stighive-graph, konstant-knowledge, etc.) so vectors are cross-comparable for related-document discovery.

### Changed

- **Env vars renamed:** `OLLAMA_BASE_URL` / `OLLAMA_API_KEY` → `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL`.
- **Default model:** `nomic-embed-text` → `qwen/qwen3-embedding-4b`.
- **Default dimensions:** `768` → `2560`.
- **Embedder call:** OpenRouter's OpenAI-compatible `/embeddings` endpoint with `Authorization: Bearer`. Native batch support — no more parallel single-text calls.
- **Response shape:** `/embed` and `/embed/batch` now include a `usage` object (token count and cost from OpenRouter).
- **Response field rename:** `ollama_url` → `provider_url` on `/`, `/info`. New `provider` field on `/`, `/info`, `/health`.
- **docker-compose.yml:** dropped `extra_hosts: host-gateway` (no longer needed).

### Migration required for consumers

Any caller with a `vector(N)` column must alter it to `vector(2560)` and clear existing vectors:

```sql
UPDATE <your_table> SET embedding = NULL;
ALTER TABLE <your_table> ALTER COLUMN embedding TYPE vector(2560);
```

The polling loop will refill the cleared embeddings automatically. Direct `/embed` callers do not need code changes — request shape is unchanged.

### Why this lock-in

Open-weight model = self-hostable via vLLM if OpenRouter ever fails — vectors remain reproducible. Single model across all projects = a document indexed by one project can be cross-retrieved by any other.

---

## [1.0.1] — 2026-04-26

### Added

- `OLLAMA_API_KEY` env var — forwarded as `X-API-Key` header on every Ollama request, enabling Caddy gateway authentication in front of Ollama.
- `extra_hosts: host-gateway:host-gateway` in docker-compose — allows the container to reach Ollama when both run on the same host. Set `OLLAMA_BASE_URL=http://host-gateway:11434` in that case.

### Architecture

- Database URL injection pattern: this service does not maintain a static `DATABASE_URL`. It receives `db_url` dynamically from the caller (e.g. stighive-graph) via the `POST /register` body. The URL points at the write pool (`100.109.203.49:5433`). All `UPDATE documents SET embedding` writes go there.
- This service never connects to the read replica.

---

## [1.0.0] — 2026-04-23

Initial public release.

### Embedding

- `POST /embed` — embed a single text string via Ollama. Configurable model per request.
- `POST /embed/batch` — embed up to 100 strings in one call. Returns ordered array of vectors.

### Polling Loop

- `POST /register` — register any PostgreSQL table with a vector column for automatic null-embedding polling. Configurable batch size and interval per registration.
- `DELETE /register/:service_name` — unregister a service and stop its polling loop.
- `GET /registrations` — list all registered polling targets with last run time and next scheduled run.
- `POST /poll/:service_name` — manually trigger a polling run for a registered service.

### Service

- `GET /` — service info, model configuration, and full endpoint listing.
- `GET /health` — Ollama connectivity check with model and dimensions.
- `GET /info` — model configuration for consuming services to verify compatibility.

### Architecture

- In-memory registration store — services re-register on their own startup
- Auth via SHA-256 hashed `X-API-Key` header — raw key never stored
- Dev mode — auth disabled when `API_KEY_HASH` is not set
- Polling errors are logged and skipped — the loop never crashes
- pgvector-compatible vector format (`[f1,f2,...]` string) written back to DB
- Works with any Ollama embedding model

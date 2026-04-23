# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

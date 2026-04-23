# Contributing

Contributions are welcome. This document covers how to report bugs, suggest features, and submit pull requests.

---

## Reporting bugs

Open an issue with:

- The endpoint you were calling
- The exact request body (redact any connection strings or API keys)
- The full error response
- Your Ollama version and which model you were using

---

## Suggesting features

Open an issue describing:

- The use case (what pipeline are you building?)
- The input/output you'd expect
- Whether it fits the existing registration pattern or needs a new pattern

New endpoints are straightforward to add. The more specific the use case, the faster it gets implemented.

---

## Pull requests

### Setup

```bash
git clone https://github.com/your-username/text-embedder-api.git
cd text-embedder-api
npm install
```

You'll need Ollama running locally with at least one embedding model:

```bash
ollama pull nomic-embed-text
```

Set environment variables:

```bash
export OLLAMA_BASE_URL=http://localhost:11434
export EMBED_MODEL=nomic-embed-text
export EMBED_DIMENSIONS=768
node server.js
```

Or test inside Docker:

```bash
docker build -t text-embedder-api-dev .
docker run --rm -p 3233:3000 \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  -e EMBED_MODEL=nomic-embed-text \
  -e EMBED_DIMENSIONS=768 \
  text-embedder-api-dev
```

### Adding an endpoint

1. Add the route handler in `server.js`
2. Add the endpoint to the `GET /` listing
3. Add the endpoint to `CHANGELOG.md` under an `[Unreleased]` section
4. Add the endpoint to `API.md` following the existing format

### Code style

- No external dependencies beyond `express`, `pg`, `node-cron`
- No async libraries — Node's built-in `fetch` for Ollama calls, raw `pg` for DB
- Every route handler in a try/catch — errors always return `{ error, details }` JSON
- Polling loop errors are always caught and logged — never crash the loop

### Before submitting

- Test the endpoint with a real Ollama instance
- Confirm polling registrations survive the new code (re-register and verify polling runs)
- Confirm error responses return JSON with `error` and `details` fields

---

## Scope

This project is intentionally minimal — a thin HTTP wrapper around Ollama embeddings with an async polling loop. Pull requests that add databases, job queues, authentication libraries, or persistence layers will not be merged. If you need those features, this project is a good base to fork from.

Endpoints that are in scope: anything that maps cleanly to Ollama embedding calls or PostgreSQL vector column management.

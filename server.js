'use strict';

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || '').replace(/\/$/, '');
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const EMBED_DIMENSIONS = parseInt(process.env.EMBED_DIMENSIONS || '768', 10);
const API_KEY_HASH = process.env.API_KEY_HASH || '';
const PORT = parseInt(process.env.PORT || '3000', 10);
const VERSION = '1.0.0';

// service_name → { config, pool, timer, last_run, next_run, last_count }
const registrations = new Map();

// --- Auth ---

function requireAuth(req, res, next) {
  if (!API_KEY_HASH) return next();
  const raw = req.headers['x-api-key'];
  if (!raw) return res.status(401).json({ error: 'Missing X-API-Key header', details: null });
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  if (hash !== API_KEY_HASH) return res.status(401).json({ error: 'Invalid API key', details: null });
  next();
}

// --- Ollama ---

async function ollamaEmbed(texts, model) {
  if (!OLLAMA_BASE_URL) throw new Error('OLLAMA_BASE_URL is not set');
  const m = model || EMBED_MODEL;
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.OLLAMA_API_KEY) headers['X-API-Key'] = process.env.OLLAMA_API_KEY;

  const embeddings = await Promise.all(texts.map(async (text) => {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: m, prompt: text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${body}`);
    }
    const data = await res.json();
    return data.embedding;
  }));

  return { embeddings };
}

// --- Polling ---

async function runPoll(reg) {
  const { pool, config } = reg;
  const { table, id_column, text_columns, embedding_column, batch_size } = config;

  const textExpr = text_columns.map(c => `COALESCE(${c}::text, '')`).join(" || ' ' || ");
  const query = `
    SELECT ${id_column}, ${textExpr} AS _embed_text
    FROM ${table}
    WHERE ${embedding_column} IS NULL
    LIMIT $1
  `;

  const { rows } = await pool.query(query, [batch_size]);
  if (rows.length === 0) return 0;

  const texts = rows.map(r => r._embed_text);
  const result = await ollamaEmbed(texts, config.model || EMBED_MODEL);
  const embeddings = result.embeddings;

  for (let i = 0; i < rows.length; i++) {
    const vec = `[${embeddings[i].join(',')}]`;
    await pool.query(
      `UPDATE ${table} SET ${embedding_column} = $1::vector WHERE ${id_column} = $2`,
      [vec, rows[i][id_column]]
    );
  }

  return rows.length;
}

function schedulePolling(name) {
  const reg = registrations.get(name);
  if (!reg) return;

  const tick = async () => {
    const start = Date.now();
    try {
      const count = await runPoll(reg);
      reg.last_run = new Date();
      reg.last_count = count;
    } catch (err) {
      console.error(`[poll:${name}] error:`, err.message);
    }
    reg.next_run = new Date(Date.now() + reg.config.interval_seconds * 1000);
  };

  reg.next_run = new Date(Date.now() + reg.config.interval_seconds * 1000);
  reg.timer = setInterval(tick, reg.config.interval_seconds * 1000);
}

// --- Routes ---

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'text-embedder-api',
    version: VERSION,
    model: EMBED_MODEL,
    dimensions: EMBED_DIMENSIONS,
    ollama_url: OLLAMA_BASE_URL,
    registered_services: registrations.size,
    endpoints: [
      'GET  /',
      'GET  /health',
      'GET  /info',
      'POST /embed',
      'POST /embed/batch',
      'POST /register',
      'DELETE /register/:service_name',
      'GET  /registrations',
      'POST /poll/:service_name',
    ],
  });
});

app.get('/health', async (req, res) => {
  try {
    await ollamaEmbed(['health check'], EMBED_MODEL);
    res.json({ status: 'ok', ollama: 'ok', model: EMBED_MODEL, dimensions: EMBED_DIMENSIONS });
  } catch (err) {
    res.status(503).json({ status: 'error', ollama: 'unreachable', error: err.message });
  }
});

app.get('/info', (req, res) => {
  res.json({
    model: EMBED_MODEL,
    dimensions: EMBED_DIMENSIONS,
    ollama_url: OLLAMA_BASE_URL,
    registered_services: registrations.size,
  });
});

app.post('/embed', requireAuth, async (req, res) => {
  const { text, model } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required and must be a string', details: null });
  }
  try {
    const result = await ollamaEmbed([text], model || EMBED_MODEL);
    res.json({
      embedding: result.embeddings[0],
      dimensions: result.embeddings[0].length,
      model: model || EMBED_MODEL,
    });
  } catch (err) {
    res.status(500).json({ error: 'Embedding failed', details: err.message });
  }
});

app.post('/embed/batch', requireAuth, async (req, res) => {
  const { texts, model } = req.body;
  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ error: 'texts must be a non-empty array', details: null });
  }
  if (texts.length > 100) {
    return res.status(400).json({ error: 'texts array exceeds maximum of 100 items', details: null });
  }
  try {
    const result = await ollamaEmbed(texts, model || EMBED_MODEL);
    res.json({
      embeddings: result.embeddings,
      dimensions: result.embeddings[0]?.length ?? EMBED_DIMENSIONS,
      model: model || EMBED_MODEL,
      count: result.embeddings.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Batch embedding failed', details: err.message });
  }
});

app.post('/register', requireAuth, (req, res) => {
  const { service_name, db_url, table, id_column, text_columns, embedding_column, batch_size, interval_seconds } = req.body;

  if (!service_name) return res.status(400).json({ error: 'service_name is required', details: null });
  if (!db_url) return res.status(400).json({ error: 'db_url is required', details: null });
  if (!table) return res.status(400).json({ error: 'table is required', details: null });
  if (!id_column) return res.status(400).json({ error: 'id_column is required', details: null });
  if (!Array.isArray(text_columns) || text_columns.length === 0) {
    return res.status(400).json({ error: 'text_columns must be a non-empty array', details: null });
  }
  if (!embedding_column) return res.status(400).json({ error: 'embedding_column is required', details: null });

  // Clean up existing registration with the same name
  if (registrations.has(service_name)) {
    const existing = registrations.get(service_name);
    clearInterval(existing.timer);
    existing.pool.end().catch(() => {});
  }

  const pool = new Pool({ connectionString: db_url });
  const config = {
    service_name,
    db_url,
    table,
    id_column,
    text_columns,
    embedding_column,
    batch_size: batch_size || 50,
    interval_seconds: interval_seconds || 300,
  };

  const reg = { config, pool, timer: null, last_run: null, next_run: null, last_count: 0 };
  registrations.set(service_name, reg);
  schedulePolling(service_name);

  res.json({
    registered: true,
    service_name,
    table,
    interval_seconds: config.interval_seconds,
    next_run: reg.next_run,
  });
});

app.delete('/register/:service_name', requireAuth, async (req, res) => {
  const { service_name } = req.params;
  const reg = registrations.get(service_name);
  if (!reg) return res.status(404).json({ error: `Service '${service_name}' is not registered`, details: null });

  clearInterval(reg.timer);
  await reg.pool.end().catch(() => {});
  registrations.delete(service_name);

  res.json({ unregistered: true, service_name });
});

app.get('/registrations', requireAuth, (req, res) => {
  const list = [];
  for (const [name, reg] of registrations) {
    list.push({
      service_name: name,
      table: reg.config.table,
      embedding_column: reg.config.embedding_column,
      batch_size: reg.config.batch_size,
      interval_seconds: reg.config.interval_seconds,
      last_run: reg.last_run,
      next_run: reg.next_run,
      last_count: reg.last_count,
    });
  }
  res.json(list);
});

app.post('/poll/:service_name', requireAuth, async (req, res) => {
  const { service_name } = req.params;
  const reg = registrations.get(service_name);
  if (!reg) return res.status(404).json({ error: `Service '${service_name}' is not registered`, details: null });

  const start = Date.now();
  try {
    const count = await runPoll(reg);
    reg.last_run = new Date();
    reg.last_count = count;
    res.json({ service_name, records_processed: count, duration_ms: Date.now() - start });
  } catch (err) {
    res.status(500).json({ error: 'Poll failed', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`text-embedder-api v${VERSION} listening on :${PORT}`);
  console.log(`  model: ${EMBED_MODEL}, dimensions: ${EMBED_DIMENSIONS}`);
  console.log(`  ollama: ${OLLAMA_BASE_URL || '(not set)'}`);
  console.log(`  auth: ${API_KEY_HASH ? 'enabled' : 'disabled (dev mode)'}`);
});

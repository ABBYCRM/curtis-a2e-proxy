'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BUILD_SHA = process.env.RENDER_GIT_COMMIT || process.env.GIT_SHA || 'dev';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024);
const APP_PROXY_TOKEN = (process.env.APP_PROXY_TOKEN || '').trim();
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ||
    'https://curtis-image-gen.onrender.com,http://localhost:8080,http://127.0.0.1:8080')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

const PROVIDERS = {
  a2e: {
    base: process.env.A2E_BASE_URL || 'https://video.a2e.ai',
    envKey: () => (process.env.A2E_API_KEY || '').trim(),
    requestHeader: 'x-a2e-key',
  },
  openai: {
    base: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
    envKey: () => (process.env.OPENAI_API_KEY || '').trim(),
    requestHeader: 'x-openai-key',
  },
};

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Build-Sha', BUILD_SHA);
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, false);
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed: ${origin}`));
  },
  allowedHeaders: ['content-type', 'x-a2e-key', 'x-openai-key', 'x-app-token'],
  methods: ['GET', 'POST', 'OPTIONS'],
  maxAge: 600,
}));
app.use(express.json({ limit: '12mb' }));

const buckets = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = `${req.ip}:${Math.floor(now / 60000)}`;
  const count = (buckets.get(key) || 0) + 1;
  buckets.set(key, count);
  if (buckets.size > 5000) {
    for (const [bucketKey] of buckets) {
      const minute = Number(bucketKey.split(':').pop());
      if (minute < Math.floor(now / 60000) - 2) buckets.delete(bucketKey);
    }
  }
  if (count > 60) {
    return res.status(429).json(errorBody('rate_limited', 'Too many requests. Try again in a minute.', true));
  }
  next();
}
app.use(rateLimit);

function errorBody(code, message, retryable = false, details) {
  return {
    error: { code, message },
    friendly: message,
    retryable,
    ...(details ? { details } : {}),
  };
}

function resolveKey(providerName, req) {
  const provider = PROVIDERS[providerName];
  if (!provider) return '';
  const supplied = String(req.get(provider.requestHeader) || '').trim();
  if (supplied) return supplied;
  const appToken = String(req.get('x-app-token') || '').trim();
  if (APP_PROXY_TOKEN && appToken === APP_PROXY_TOKEN) return provider.envKey();
  return '';
}

function requireKey(providerName, req, res) {
  const key = resolveKey(providerName, req);
  if (key) return key;
  res.status(401).json(errorBody(
    'missing_provider_key',
    `A ${providerName === 'openai' ? 'OpenAI' : 'A2E'} API key is required. Paste it in Settings.`,
    false
  ));
  return null;
}

function requiredString(value, field, maxLength = 12000) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${field} is required`);
    error.status = 422;
    error.code = 'validation_error';
    throw error;
  }
  if (value.length > maxLength) {
    const error = new Error(`${field} is too long`);
    error.status = 413;
    error.code = 'validation_error';
    throw error;
  }
  return value.trim();
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

async function upstreamFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('The provider timed out. Try again.');
      timeoutError.status = 504;
      timeoutError.code = 'upstream_timeout';
      timeoutError.retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readProviderJson(response, providerName) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 1000) };
  }

  if (providerName === 'a2e' && typeof body.code === 'number' && body.code !== 0) {
    const message = body.msg || body.message || 'A2E rejected the request.';
    const lower = message.toLowerCase();
    const retryable = lower.includes('rate') || lower.includes('busy') || lower.includes('timeout');
    const error = new Error(message);
    error.status = retryable ? 503 : 422;
    error.code = 'a2e_error';
    error.retryable = retryable;
    error.providerBody = body;
    throw error;
  }

  if (!response.ok) {
    const providerMessage = body?.error?.message || body?.message || body?.msg || `Provider returned HTTP ${response.status}`;
    const error = new Error(providerMessage);
    error.status = response.status;
    error.code = body?.error?.code || 'provider_error';
    error.retryable = response.status === 429 || response.status >= 500;
    error.providerBody = body;
    throw error;
  }
  return body;
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value || '');
  if (!match) return null;
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  return { mime: match[1], bytes };
}

async function loadImageInput(input) {
  const value = requiredString(input, 'input_reference', 16 * 1024 * 1024);
  const data = parseDataUrl(value);
  if (data) {
    if (!data.mime.startsWith('image/')) throw Object.assign(new Error('Reference must be an image.'), { status: 422 });
    if (data.bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Reference image is too large.'), { status: 413 });
    return data;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error('Reference must be a data URL or an HTTPS image URL.'), { status: 422 });
  }
  if (url.protocol !== 'https:') throw Object.assign(new Error('Only HTTPS reference URLs are allowed.'), { status: 422 });

  const response = await upstreamFetch(url, { redirect: 'follow' });
  if (!response.ok) throw Object.assign(new Error(`Could not download the reference image (HTTP ${response.status}).`), { status: 422 });
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) throw Object.assign(new Error('Reference URL did not return an image.'), { status: 422 });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Reference image is too large.'), { status: 413 });
  return { mime, bytes };
}

function normalizeOpenAIImage(body) {
  const first = body?.data?.[0];
  if (!first) throw Object.assign(new Error('OpenAI returned no image.'), { status: 502, retryable: true });
  if (first.url) return { image_url: first.url, revised_prompt: first.revised_prompt || null, usage: body.usage || null };
  if (first.b64_json) {
    return {
      image_url: `data:image/png;base64,${first.b64_json}`,
      revised_prompt: first.revised_prompt || null,
      usage: body.usage || null,
    };
  }
  throw Object.assign(new Error('OpenAI returned an unsupported image response.'), { status: 502, retryable: true });
}

app.get('/', (_req, res) => {
  res.json({
    name: 'curtis-api-proxy',
    version: 2,
    build: BUILD_SHA,
    capabilities: {
      openai_images: true,
      openai_reference_edit: true,
      openai_video: false,
      a2e_images: true,
      a2e_video: true,
      gemini: false,
    },
    authentication: {
      request_keys: true,
      protected_env_keys: Boolean(APP_PROXY_TOKEN),
    },
  });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, build: BUILD_SHA, version: 2 });
});

app.post('/openai/images', async (req, res, next) => {
  const key = requireKey('openai', req, res);
  if (!key) return;
  try {
    const prompt = requiredString(req.body?.prompt, 'prompt');
    const model = 'gpt-image-2';
    const size = enumValue(req.body?.size, ['1024x1024', '1024x1536', '1536x1024'], '1536x1024');
    const quality = enumValue(req.body?.quality, ['low', 'medium', 'high', 'auto'], 'medium');
    const reference = typeof req.body?.input_reference === 'string' && req.body.input_reference.trim()
      ? req.body.input_reference.trim()
      : null;

    let response;
    if (reference) {
      const image = await loadImageInput(reference);
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('quality', quality);
      form.append('image', new Blob([image.bytes], { type: image.mime }), `reference.${image.mime.split('/')[1] || 'png'}`);
      response = await upstreamFetch(`${PROVIDERS.openai.base}/v1/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
    } else {
      response = await upstreamFetch(`${PROVIDERS.openai.base}/v1/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, size, quality, n: 1 }),
      });
    }
    const body = await readProviderJson(response, 'openai');
    res.json({ ok: true, model, ...normalizeOpenAIImage(body) });
  } catch (error) {
    next(error);
  }
});

app.all('/openai/videos*', (_req, res) => {
  res.status(410).json(errorBody(
    'openai_video_disabled',
    'OpenAI video generation is disabled because the configured Sora models are deprecated. Use A2E for clips.',
    false
  ));
});

async function a2eRequest(key, action, payload) {
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  let url;
  let method = 'POST';
  let body;
  if (action === 'image_start') {
    url = `${PROVIDERS.a2e.base}/api/v1/userNanoBanana/start`;
    body = JSON.stringify({
      name: payload.name || `curtis-image-${Date.now()}`,
      prompt: requiredString(payload.prompt, 'prompt'),
      input_images: Array.isArray(payload.input_images) ? payload.input_images.slice(0, 1) : [],
      aspectRatio: enumValue(payload.aspectRatio, ['16:9', '9:16', '1:1', '4:5'], '16:9'),
      resolution: enumValue(payload.resolution, ['1K', '2K', '4K'], '2K'),
    });
  } else if (action === 'video_start') {
    url = `${PROVIDERS.a2e.base}/api/v1/userImage2Video/start`;
    body = JSON.stringify({
      name: payload.name || `curtis-video-${Date.now()}`,
      image_url: requiredString(payload.image_url, 'image_url', 16 * 1024 * 1024),
      prompt: requiredString(payload.prompt, 'prompt'),
      negative_prompt: String(payload.negative_prompt || 'deformed face, blurry, low quality').slice(0, 2000),
      aspectRatio: enumValue(payload.aspectRatio, ['16:9', '9:16', '1:1', '4:5'], '16:9'),
    });
  } else if (action === 'image_status') {
    const id = encodeURIComponent(requiredString(payload.id, 'id', 256));
    url = `${PROVIDERS.a2e.base}/api/v1/userNanoBanana/detail/${id}`;
    method = 'GET';
    body = undefined;
  } else if (action === 'video_status') {
    const id = encodeURIComponent(requiredString(payload.id, 'id', 256));
    url = `${PROVIDERS.a2e.base}/api/v1/userImage2Video/${id}`;
    method = 'GET';
    body = undefined;
  } else {
    throw Object.assign(new Error('Unknown A2E action.'), { status: 422, code: 'validation_error' });
  }
  const response = await upstreamFetch(url, { method, headers, body });
  return readProviderJson(response, 'a2e');
}

app.post('/a2e', async (req, res, next) => {
  const key = requireKey('a2e', req, res);
  if (!key) return;
  try {
    const action = requiredString(req.body?.action, 'action', 64);
    const result = await a2eRequest(key, action, req.body || {});
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.get('/a2e/status', async (req, res, next) => {
  const key = requireKey('a2e', req, res);
  if (!key) return;
  try {
    const kind = enumValue(req.query.kind, ['image', 'video'], '');
    if (!kind) throw Object.assign(new Error('kind must be image or video'), { status: 422 });
    const result = await a2eRequest(key, `${kind}_status`, { id: req.query.id });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post('/a2e/status', async (req, res, next) => {
  const key = requireKey('a2e', req, res);
  if (!key) return;
  try {
    const action = req.body?.action || (req.body?.kind ? `${req.body.kind}_status` : '');
    const result = await a2eRequest(key, requiredString(action, 'action', 64), { id: req.body?.id });
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error('[proxy]', error.code || error.name, error.message);
  const status = Number(error.status || 500);
  const retryable = Boolean(error.retryable || status === 429 || status >= 500);
  const safeMessage = status >= 500 && !error.retryable
    ? 'The proxy encountered an unexpected error.'
    : error.message;
  res.status(status).json(errorBody(error.code || 'proxy_error', safeMessage, retryable));
});

app.listen(PORT, () => {
  console.log(`[curtis-api-proxy] listening on :${PORT} build=${BUILD_SHA}`);
});

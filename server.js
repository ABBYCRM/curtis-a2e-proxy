'use strict';

const express = require('express');
const cors = require('cors');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

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
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  maxAge: 600,
}));
app.use(express.json({ limit: '50mb' }));
// Raw bytes for the album upload endpoint (we accept image/* and video/mp4
// as raw request bodies, not as multipart, to keep the front-end simple).
app.use('/album/upload', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/octet-stream'], limit: '50mb' }));

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

// Read PNG dimensions from the IHDR chunk (bytes 16-23, big-endian).
// Returns {width, height} or null if the bytes aren't a PNG.
// We only need this so Sora 2 doesn't reject a 1024x1024 reference when
// the requested size is 1280x720 ("Inpaint image must match the
// requested width and height").
function pngDims(bytes) {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Pick the Sora 2 size that best matches a reference image's aspect ratio.
// Sora 2 only supports 720x1280 and 1280x720. We snap the reference's
// aspect to one of those two.
function soraSizeForRef(refDims, requested) {
  if (!refDims || !refDims.width || !refDims.height) return requested || '1280x720';
  const refIsPortrait = refDims.height > refDims.width;
  // If the requested size matches the reference's orientation, keep it.
  const reqIsPortrait = requested && requested.startsWith('720x');
  if (reqIsPortrait === refIsPortrait) return requested;
  return refIsPortrait ? '720x1280' : '1280x720';
}

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  return true;
}

async function assertPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error('Reference must be a data URL or an HTTPS image URL.'), { status: 422 });
  }
  if (url.protocol !== 'https:') throw Object.assign(new Error('Only HTTPS reference URLs are allowed.'), { status: 422 });
  if (url.username || url.password) throw Object.assign(new Error('Reference URLs cannot contain credentials.'), { status: 422 });
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw Object.assign(new Error('Private reference hosts are not allowed.'), { status: 422 });
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw Object.assign(new Error('Private reference hosts are not allowed.'), { status: 422 });
  }
  return url;
}

async function fetchPublicImage(value) {
  let url = await assertPublicHttpsUrl(value);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await upstreamFetch(url, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw Object.assign(new Error('Reference URL redirected without a destination.'), { status: 422 });
      url = await assertPublicHttpsUrl(new URL(location, url).toString());
      continue;
    }
    return response;
  }
  throw Object.assign(new Error('Reference URL redirected too many times.'), { status: 422 });
}

async function loadImageInput(input) {
  const value = requiredString(input, 'input_reference', 16 * 1024 * 1024);
  const data = parseDataUrl(value);
  if (data) {
    if (!data.mime.startsWith('image/')) throw Object.assign(new Error('Reference must be an image.'), { status: 422 });
    if (data.bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Reference image is too large.'), { status: 413 });
    return data;
  }

  const response = await fetchPublicImage(value);
  if (!response.ok) throw Object.assign(new Error(`Could not download the reference image (HTTP ${response.status}).`), { status: 422 });
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) throw Object.assign(new Error('Reference URL did not return an image.'), { status: 422 });
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw Object.assign(new Error('Reference image is too large.'), { status: 413 });
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
      openai_video: true,           // Sora 2 — deprecated 2026-09-24, still live
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
    const normalized = normalizeOpenAIImage(body);
    // Persist to the album (best-effort; failures here are logged but
    // do not fail the image response — the user still gets their image).
    const albumId = await saveAssetToAlbum({
      kind: 'image',
      url: normalized.image_url,
      mime: 'image/png',
      prompt,
      title: prompt.slice(0, 80),
      provider: 'openai',
      scene_n: null,
    }).catch((err) => { console.error('[proxy] album save failed:', err.message); return null; });
    res.json({ ok: true, model, ...normalized, album_id: albumId || null });
  } catch (error) {
    next(error);
  }
});

// OpenAI Sora 2 video (still live; scheduled for removal 2026-09-24).
// POST /openai/videos            -> start a job, returns {id, status}
// GET  /openai/videos/:id        -> poll status
// GET  /openai/videos/:id/content -> proxy the MP4 bytes (CORS-safe)
//
// Sora 2 sizes: 720x1280, 1280x720. sora-2-pro adds 1024x1792, 1792x1024.
// We always default to sora-2 and accept 16:9 / 9:16 only. Square aspect
// is not supported by Sora — the front-end should pick a valid aspect.
function soraSize(aspect) {
  if (aspect === '9:16') return '720x1280';
  if (aspect === '1:1')  return '720x720';  // Sora will reject; UI should pick 16:9 or 9:16
  return '1280x720';
}
function soraSeconds(value) {
  if (value === 'short') return '4';
  if (value === 'long')  return '12';
  return '8';
}

app.post('/openai/videos', async (req, res, next) => {
  const key = requireKey('openai', req, res);
  if (!key) return;
  try {
    const prompt = requiredString(req.body?.prompt, 'prompt', 4000);
    const model  = String(req.body?.model || 'sora-2');
    const size   = enumValue(req.body?.size, ['720x1280', '1280x720', '1024x1792', '1792x1024'], soraSize(req.body?.aspectRatio));
    const seconds = enumValue(req.body?.seconds, ['4', '8', '12'], soraSeconds(req.body?.duration));
    const reference = typeof req.body?.input_reference === 'string' && req.body.input_reference.trim()
      ? req.body.input_reference.trim()
      : null;

    // If the caller supplied a reference image, resize it to exactly the
    // requested size. Sora 2 strictly requires the inpaint reference to
    // match the requested width/height — it returns 422 "Inpaint image
    // must match the requested width and height" otherwise. We use sharp
    // to cover the reference to the target size (aspect-preserving, then
    // pad to the exact dimensions with the inverse color of the request).
    let finalReference = reference;
    if (reference) {
      const data = parseDataUrl(reference);
      if (data) {
        const [w, h] = size.split('x').map(Number);
        const padded = await sharp(data.bytes)
          .resize(w, h, { fit: 'cover', position: 'centre' })
          .png()
          .toBuffer();
        finalReference = `data:image/png;base64,${padded.toString('base64')}`;
      }
    }

    // Sora 2 expects `input_reference` as an OBJECT in JSON requests
    // ({ file_id } or { image_url }). A bare string or a data URL is rejected
    // with "Invalid type for 'input_reference': expected an object".
    // We forward the reference as { image_url } so the upstream can fetch
    // it. data: URLs are passed through as-is — OpenAI accepts them.
    const body = { model, prompt, size, seconds };
    if (finalReference) {
      body.input_reference = { image_url: finalReference };
    }

    const response = await upstreamFetch(`${PROVIDERS.openai.base}/v1/videos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readProviderJson(response, 'openai');
    res.json({ ok: true, provider: 'openai', model, job_id: data.id, status: data.status || 'queued', raw: data });
  } catch (error) {
    next(error);
  }
});

app.get('/openai/videos/:id', async (req, res, next) => {
  const key = requireKey('openai', req, res);
  if (!key) return;
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(422).json(errorBody('validation_error', 'video id is required', false));
    }
    const response = await upstreamFetch(`${PROVIDERS.openai.base}/v1/videos/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await readProviderJson(response, 'openai');
    // Sora returns { id, status, progress, ... }. Surface the bits the front-end needs.
    res.json({
      ok: true,
      provider: 'openai',
      job_id: data.id || id,
      status: data.status || 'in_progress',
      progress: typeof data.progress === 'number' ? data.progress : null,
      video_url: data.status === 'completed' ? `/openai/videos/${encodeURIComponent(id)}/content` : null,
      error: data.error || null,
      raw: data,
    });
  } catch (error) {
    next(error);
  }
});

// Proxy the MP4 bytes back to the browser so the <video> tag can stream them.
app.get('/openai/videos/:id/content', async (req, res, next) => {
  const key = requireKey('openai', req, res);
  if (!key) return;
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(422).json(errorBody('validation_error', 'video id is required', false));
    const upstream = await upstreamFetch(`${PROVIDERS.openai.base}/v1/videos/${encodeURIComponent(id)}/content`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      throw Object.assign(new Error(`Sora content fetch failed (${upstream.status})`), {
        status: upstream.status,
        code: 'provider_error',
        providerBody: text.slice(0, 1000),
      });
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    const buf = Buffer.from(await upstream.arrayBuffer());
    // Persist to the album. We use the prompt from the original job — the
    // front-end sends it in the x-scene-prompt header on the content fetch.
    // (CORS-safe: this is a server-side read, not browser code.)
    const scenePrompt = String(req.headers['x-scene-prompt'] || '').trim() || `Sora 2 clip ${id}`;
    saveAssetToAlbum({
      kind: 'video',
      bytes: buf,
      mime: 'video/mp4',
      prompt: scenePrompt,
      title: scenePrompt.slice(0, 80),
      provider: 'openai',
      scene_n: null,
    }).then((assetId) => {
      if (assetId) res.setHeader('x-album-id', assetId);
    }).catch((err) => { console.error('[proxy] album save failed:', err.message); });
    res.end(buf);
  } catch (error) {
    next(error);
  }
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

// ----- Album: persistent asset store (file-backed) -------------------------
// We store every generated image and video clip so the user can revisit
// them from the Album tab, even after the browser tab closes. The store
// is file-backed (data/album/<id>.<ext> + data/album/index.json) so we
// don't need Postgres. Render's free web service disk is ephemeral but
// holds long enough between deploys for this to be useful, and we can
// swap the storage layer for Postgres or S3 without changing the API.
const ALBUM_DIR = path.join(__dirname, 'data', 'album');
const ALBUM_INDEX = path.join(ALBUM_DIR, 'index.json');
const MAX_ALBUM_ENTRIES = 500;  // cap the index; oldest are pruned
const ALBUM_TOTAL_BYTES = Number(process.env.ALBUM_MAX_BYTES || 500 * 1024 * 1024);  // 500 MB default

// Save an asset to the album. `url` may be a data: URL, an https: URL,
// or a Buffer (for video bytes fetched upstream). Returns the new asset id.
async function saveAssetToAlbum({ kind, url, bytes, mime, prompt, title, provider, scene_n }) {
  if (!['image', 'video'].includes(kind)) throw new Error('kind must be image or video');
  if (!mime) throw new Error('mime is required');

  let buffer = null;
  if (Buffer.isBuffer(bytes)) {
    buffer = bytes;
  } else if (typeof url === 'string' && url.startsWith('data:')) {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error('Invalid data URL');
    buffer = parsed.bytes;
  } else if (typeof url === 'string' && /^https?:$/.test(new URL(url).protocol)) {
    const res = await upstreamFetch(url);
    if (!res.ok) throw new Error(`Failed to fetch asset URL: HTTP ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    throw new Error('Asset must be a data URL, https URL, or Buffer');
  }
  if (buffer.length === 0) throw new Error('Empty asset');

  await ensureAlbumDir();
  const id = makeAssetId();
  const ext = extForMime(mime);
  await fsp.writeFile(path.join(ALBUM_DIR, `${id}.${ext}`), buffer);

  let width = null;
  let height = null;
  if (kind === 'image' && mime === 'image/png') {
    try {
      const probe = await sharp(buffer).metadata();
      width = probe.width || null;
      height = probe.height || null;
    } catch { /* ignore */ }
  }

  const meta = {
    id,
    kind,
    mime,
    ext,
    bytes: buffer.length,
    prompt: prompt ? String(prompt).slice(0, 1000) : null,
    title: title ? String(title).slice(0, 200) : null,
    provider: provider || null,
    scene_n: typeof scene_n === 'number' ? scene_n : null,
    width,
    height,
    createdAt: Date.now(),
  };
  const entries = await readAlbumIndex();
  entries.push(meta);
  await writeAlbumIndex(entries);
  await enforceTotalBytes().catch(() => {});
  await pruneAlbum().catch(() => {});
  return id;
}

async function ensureAlbumDir() {
  await fsp.mkdir(ALBUM_DIR, { recursive: true });
  if (!fs.existsSync(ALBUM_INDEX)) {
    await fsp.writeFile(ALBUM_INDEX, '[]', 'utf8');
  }
}

async function readAlbumIndex() {
  await ensureAlbumDir();
  try {
    const text = await fsp.readFile(ALBUM_INDEX, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAlbumIndex(entries) {
  await fsp.writeFile(ALBUM_INDEX, JSON.stringify(entries, null, 2));
}

function makeAssetId() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${stamp}-${rand}`;
}

function extForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'video/mp4') return 'mp4';
  return 'bin';
}

async function pruneAlbum() {
  let entries = await readAlbumIndex();
  if (entries.length <= MAX_ALBUM_ENTRIES) return;
  // Drop the oldest until we're under the cap
  entries = entries.sort((a, b) => a.createdAt - b.createdAt);
  while (entries.length > MAX_ALBUM_ENTRIES) {
    const dropped = entries.shift();
    try { await fsp.unlink(path.join(ALBUM_DIR, `${dropped.id}.${dropped.ext}`)); }
    catch { /* file may already be gone */ }
  }
  await writeAlbumIndex(entries);
}

async function enforceTotalBytes() {
  let entries = await readAlbumIndex();
  if (!entries.length) return;
  let total = entries.reduce((sum, e) => sum + (e.bytes || 0), 0);
  if (total <= ALBUM_TOTAL_BYTES) return;
  // Drop the oldest until we're under the cap
  entries = entries.sort((a, b) => a.createdAt - b.createdAt);
  while (entries.length && total > ALBUM_TOTAL_BYTES) {
    const dropped = entries.shift();
    try {
      await fsp.unlink(path.join(ALBUM_DIR, `${dropped.id}.${dropped.ext}`));
      total -= dropped.bytes || 0;
    } catch { /* swallow */ }
  }
  await writeAlbumIndex(entries);
}

app.get('/album', async (_req, res, next) => {
  try {
    const entries = await readAlbumIndex();
    // Newest first
    const sorted = entries.sort((a, b) => b.createdAt - a.createdAt);
    res.json({
      ok: true,
      count: sorted.length,
      total_bytes: sorted.reduce((sum, e) => sum + (e.bytes || 0), 0),
      cap_bytes: ALBUM_TOTAL_BYTES,
      cap_entries: MAX_ALBUM_ENTRIES,
      items: sorted.map((e) => ({
        id: e.id,
        kind: e.kind,
        prompt: e.prompt || null,
        title: e.title || null,
        mime: e.mime,
        bytes: e.bytes,
        provider: e.provider || null,
        scene_n: typeof e.scene_n === 'number' ? e.scene_n : null,
        width: e.width || null,
        height: e.height || null,
        created_at: new Date(e.createdAt).toISOString(),
        url: `/album/${e.id}`,
      })),
    });
  } catch (error) { next(error); }
});

app.post('/album/upload', async (req, res, next) => {
  try {
    await ensureAlbumDir();
    const kind = String(req.query.kind || '').trim();
    if (!['image', 'video'].includes(kind)) {
      return res.status(422).json(errorBody('validation_error', 'kind must be "image" or "video"', false));
    }
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
      return res.status(422).json(errorBody('validation_error', 'Content-Type must be image/* or video/*', false));
    }
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(422).json(errorBody('validation_error', 'Empty request body', false));
    }
    if (bytes.length > 50 * 1024 * 1024) {
      return res.status(413).json(errorBody('too_large', 'Asset exceeds 50 MB.', false));
    }
    const id = makeAssetId();
    const ext = extForMime(mime);
    const filePath = path.join(ALBUM_DIR, `${id}.${ext}`);
    await fsp.writeFile(filePath, bytes);

    // Extract metadata (best-effort — video is expensive, image is cheap)
    let width = null;
    let height = null;
    let probe = null;
    if (kind === 'image') {
      try {
        probe = await sharp(bytes).metadata();
        width = probe.width || null;
        height = probe.height || null;
      } catch { /* ignore */ }
    }

    const meta = {
      id,
      kind,
      mime,
      ext,
      bytes: bytes.length,
      prompt: String(req.query.prompt || '').slice(0, 1000) || null,
      title: String(req.query.title || '').slice(0, 200) || null,
      provider: String(req.query.provider || '').trim() || null,
      scene_n: req.query.scene_n != null ? Number(req.query.scene_n) : null,
      width,
      height,
      createdAt: Date.now(),
    };
    const entries = await readAlbumIndex();
    entries.push(meta);
    await writeAlbumIndex(entries);
    await enforceTotalBytes();
    await pruneAlbum();
    res.json({ ok: true, id, url: `/album/${id}`, bytes: meta.bytes, kind, mime, width, height });
  } catch (error) { next(error); }
});

app.get('/album/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!/^[a-z0-9-]+$/i.test(id)) {
      return res.status(422).json(errorBody('validation_error', 'Invalid asset id', false));
    }
    const entries = await readAlbumIndex();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return res.status(404).json(errorBody('not_found', 'Asset not found', false));
    const filePath = path.join(ALBUM_DIR, `${entry.id}.${entry.ext}`);
    if (!fs.existsSync(filePath)) {
      return res.status(410).json(errorBody('gone', 'Asset file is missing from disk', false));
    }
    // Allow range requests for video scrubbing
    const stat = await fsp.stat(filePath);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', entry.mime);
    // Use Vary: Origin so Cloudflare / browser caches don't accidentally
    // serve a CORS-less response to a cross-origin fetch. Keep a short
    // max-age (5 minutes) so the file revalidates after the user
    // deletes / re-uploads; immutable would lock stale bytes in the
    // browser cache for a year.
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'public, max-age=300');
    // Content-Disposition: attachment makes the browser save the file
    // instead of navigating to it. We use the same filename scheme the
    // Album UI generates (kind-id.ext) so the user's saved file has a
    // sensible name.
    res.setHeader('Content-Disposition', `attachment; filename="${entry.kind}-${entry.id}.${entry.ext}"`);
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : Math.min(start + 1024 * 1024 - 1, stat.size - 1);
        if (start >= stat.size) {
          res.setHeader('Content-Range', `bytes */${stat.size}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) { next(error); }
});

app.delete('/album/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!/^[a-z0-9-]+$/i.test(id)) {
      return res.status(422).json(errorBody('validation_error', 'Invalid asset id', false));
    }
    let entries = await readAlbumIndex();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return res.status(404).json(errorBody('not_found', 'Asset not found', false));
    try { await fsp.unlink(path.join(ALBUM_DIR, `${entry.id}.${entry.ext}`)); } catch { /* swallow */ }
    entries = entries.filter((e) => e.id !== id);
    await writeAlbumIndex(entries);
    res.json({ ok: true, id });
  } catch (error) { next(error); }
});

app.delete('/album', async (_req, res, next) => {
  try {
    await ensureAlbumDir();
    const entries = await readAlbumIndex();
    for (const entry of entries) {
      try { await fsp.unlink(path.join(ALBUM_DIR, `${entry.id}.${entry.ext}`)); } catch { /* swallow */ }
    }
    await writeAlbumIndex([]);
    res.json({ ok: true, deleted: entries.length });
  } catch (error) { next(error); }
});

// Save an asset to the album by URL. The proxy downloads the bytes
// server-side (so CORS doesn't bite the browser), runs the same
// assertPublicHttpsUrl guard we use for reference images, and stores
// the result through saveAssetToAlbum. Used when the front-end has an
// external URL it can't fetch itself (e.g. an A2E result_url that
// doesn't return CORS headers, or a Sora 2 content URL that requires
// the x-openai-key header).
app.post('/album/save-from-url', async (req, res, next) => {
  try {
    const kind = String(req.body?.kind || '').trim();
    if (!['image', 'video'].includes(kind)) {
      return res.status(422).json(errorBody('validation_error', 'kind must be "image" or "video"', false));
    }
    const sourceUrl = requiredString(req.body?.url, 'url', 2048);
    const provider = String(req.body?.provider || '').trim() || null;
    const prompt = req.body?.prompt ? String(req.body.prompt).slice(0, 1000) : null;
    const title = req.body?.title ? String(req.body.title).slice(0, 200) : null;
    const sceneN = req.body?.scene_n != null ? Number(req.body.scene_n) : null;

    // HTTPS-only and SSRF-checked (the same guard we use for GPT Image 2
    // input_reference). Without this, an attacker could pivot through
    // the proxy to read AWS metadata at 169.254.169.254 or hit internal
    // services on the proxy's private network.
    await assertPublicHttpsUrl(sourceUrl);

    // Some upstream providers (notably Sora 2's /v1/videos/:id/content
    // route) require an Authorization header that the proxy already
    // has. If the request came in with x-openai-key / x-a2e-key, reuse
    // it for the upstream fetch. If only x-app-token is set and the
    // proxy has env-stored keys, use the env key.
    const upstreamHeaders = {};
    const openaiHeader = String(req.get('x-openai-key') || '').trim();
    const a2eHeader = String(req.get('x-a2e-key') || '').trim();
    if (openaiHeader) upstreamHeaders.Authorization = `Bearer ${openaiHeader}`;
    else if (APP_PROXY_TOKEN && String(req.get('x-app-token') || '').trim() === APP_PROXY_TOKEN) {
      const envKey = PROVIDERS.openai.envKey();
      if (envKey) upstreamHeaders.Authorization = `Bearer ${envKey}`;
    }
    if (!upstreamHeaders.Authorization && a2eHeader) upstreamHeaders.Authorization = `Bearer ${a2eHeader}`;

    const upstream = await upstreamFetch(sourceUrl, { headers: upstreamHeaders });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      throw Object.assign(new Error(`Upstream fetch failed (${upstream.status}): ${text.slice(0, 200)}`), {
        status: upstream.status,
        code: 'upstream_error',
        retryable: upstream.status === 429 || upstream.status >= 500,
      });
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const declaredMime = (upstream.headers.get('content-type') || '').split(';')[0].trim();
    const mime = declaredMime || (kind === 'image' ? 'image/png' : 'video/mp4');
    if (bytes.length === 0) throw Object.assign(new Error('Upstream returned empty body'), { status: 502, code: 'empty_body' });
    if (bytes.length > 50 * 1024 * 1024) throw Object.assign(new Error('Asset exceeds 50 MB'), { status: 413, code: 'too_large' });

    const id = await saveAssetToAlbum({
      kind,
      bytes,
      mime,
      prompt,
      title,
      provider,
      scene_n: sceneN,
    });
    res.json({ ok: true, id, url: `/album/${id}`, bytes: bytes.length, kind, mime });
  } catch (error) { next(error); }
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

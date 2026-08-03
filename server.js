/* ============================================================================
   curtis-api-proxy — multi-provider CORS proxy + auth holder
   ----------------------------------------------------------------------------
   Forwards requests from the Trailer Studio browser front-end to:
     • A2E.ai         (image + video gen, Free/Pro/Max plans)
     • OpenAI         (Sora 2 / Sora 2 Pro, image gen, Vision)
     • Google Gemini  (Veo 3, Imagen 3, text)
   Holds each provider's key server-side via env vars so the browser never
   sees them. Enforces CORS allowlist so random sites can't burn credits.
   ============================================================================ */

const express = require('express');
const cors = require('cors');

const app = express();

/* ---------- CORS allowlist ---------- */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://curtis-image-gen.onrender.com,http://localhost:8080,http://127.0.0.1:8080'
).split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  }
}));
app.use(express.json({ limit: '20mb' }));

/* ---------- Provider registry ---------- */
const PROVIDERS = {
  a2e: {
    label: 'A2E.ai',
    base: process.env.A2E_BASE_URL || 'https://video.a2e.ai',
    getKey: () => process.env.A2E_API_KEY,
  },
  openai: {
    label: 'OpenAI',
    base: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
    getKey: () => process.env.OPENAI_API_KEY,
  },
  gemini: {
    label: 'Google Gemini',
    base: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    getKey: () => process.env.GEMINI_API_KEY,
  },
};

/* ---------- Health + info ---------- */
app.get('/', (_req, res) => res.json({
  name: 'curtis-api-proxy',
  providers: Object.fromEntries(
    Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, ready: !!p.getKey() }])
  ),
  routes: {
    a2e:    ['POST /a2e  body:{action, ...}'],
    openai: ['POST /openai/videos', 'GET  /openai/videos/:id', 'GET  /openai/videos/:id/content', 'GET  /openai/usage'],
    gemini: ['POST /gemini/videos',  'GET  /gemini/videos/:id'],
  },
  notes: {
    sora_deprecation: 'Sora 2 / Sora 2 Pro shut down 2026-09-24. Plan migration to Sora 3 or a successor before that date.',
  }
}));

app.get('/healthz', (_req, res) => res.json({
  ok: Object.values(PROVIDERS).some(p => !!p.getKey()),
  providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, !!p.getKey()])),
}));

/* ============================================================================
   A2E  (unchanged from prior version)
   ============================================================================ */
app.post('/a2e', async (req, res) => {
  const KEY = PROVIDERS.a2e.getKey();
  if (!KEY) return res.status(500).json({ code: -1, message: 'A2E_API_KEY not configured' });
  const { action } = req.body || {};
  if (!action) return res.status(400).json({ code: -1, message: 'Missing action' });
  try {
    switch (action) {
      case 'image_start': {
        const r = await fetch(`${PROVIDERS.a2e.base}/api/v1/userNanoBanana/start`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: req.body.name || 'trailer-still',
            prompt: req.body.prompt,
            input_images: Array.isArray(req.body.input_images) ? req.body.input_images : [],
            aspectRatio: req.body.aspectRatio || '16:9',
            resolution: req.body.resolution || '2K',
          }),
        });
        return forwardJson(r, res);
      }
      case 'image_status': {
        if (!req.body.id) return res.status(400).json({ code: -1, message: 'id required' });
        const r = await fetch(`${PROVIDERS.a2e.base}/api/v1/userNanoBanana/detail/${encodeURIComponent(req.body.id)}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${KEY}` },
        });
        return forwardJson(r, res);
      }
      case 'video_start': {
        const r = await fetch(`${PROVIDERS.a2e.base}/api/v1/userImage2Video/start`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: req.body.name || 'trailer-clip',
            image_url: req.body.image_url,
            prompt: req.body.prompt,
            negative_prompt: req.body.negative_prompt || 'six fingers, bad hands, lowres, low quality, deformed face, blurry',
            aspectRatio: req.body.aspectRatio || '16:9',
          }),
        });
        return forwardJson(r, res);
      }
      case 'video_status': {
        if (!req.body.id) return res.status(400).json({ code: -1, message: 'id required' });
        const r = await fetch(`${PROVIDERS.a2e.base}/api/v1/userImage2Video/${encodeURIComponent(req.body.id)}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${KEY}` },
        });
        return forwardJson(r, res);
      }
      default:
        return res.status(400).json({ code: -1, message: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error('[a2e]', e);
    return res.status(500).json({ code: -1, message: e.message || 'a2e error' });
  }
});

/* ============================================================================
   OpenAI
   Sora 2 / Sora 2 Pro — create + poll + download
   Docs: https://developers.openai.com/api/docs/guides/video-generation
   Deprecation: 2026-09-24
   ============================================================================ */

// Create a video generation job
app.post('/openai/videos', async (req, res) => {
  const KEY = PROVIDERS.openai.getKey();
  if (!KEY) return res.status(500).json({ error: { message: 'OPENAI_API_KEY not configured' } });
  try {
    const { model = 'sora-2', prompt, size = '1280x720', seconds = '4',
            input_reference, /* base64 or url of reference image (face lock) */
            reference_type = 'character' } = req.body || {};
    if (!prompt) return res.status(400).json({ error: { message: 'prompt required' } });

    // OpenAI v1/videos accepts input_reference as multipart form data per
    // their curl example. Since we want to keep this a pure JSON proxy,
    // we accept input_reference as a URL and pass it as `image_url` instead
    // (Sora does accept this for i2v style requests where supported).
    // If the caller wants strict character consistency, they should use
    // /openai/videos/characters first to register a character.
    const body = { model, prompt, size, seconds };
    if (input_reference) {
      // Sora 2 image-to-video: pass as input_reference field
      body.input_reference = input_reference;
    }
    const r = await fetch(`${PROVIDERS.openai.base}/v1/videos`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return forwardJson(r, res);
  } catch (e) {
    console.error('[openai create]', e);
    return res.status(500).json({ error: { message: e.message } });
  }
});

// Poll a video job
app.get('/openai/videos/:id', async (req, res) => {
  const KEY = PROVIDERS.openai.getKey();
  if (!KEY) return res.status(500).json({ error: { message: 'OPENAI_API_KEY not configured' } });
  try {
    const r = await fetch(`${PROVIDERS.openai.base}/v1/videos/${encodeURIComponent(req.params.id)}`, {
      headers: { 'Authorization': `Bearer ${KEY}` },
    });
    return forwardJson(r, res);
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
});

// Download the finished MP4 (proxy streams it through so CORS works)
app.get('/openai/videos/:id/content', async (req, res) => {
  const KEY = PROVIDERS.openai.getKey();
  if (!KEY) return res.status(500).json({ error: { message: 'OPENAI_API_KEY not configured' } });
  try {
    const variant = req.query.variant || 'mp4';
    const r = await fetch(`${PROVIDERS.openai.base}/v1/videos/${encodeURIComponent(req.params.id)}/content?variant=${variant}`, {
      headers: { 'Authorization': `Bearer ${KEY}` },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).send(text);
    }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="openai-${req.params.id}.${variant}"`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
});

// OpenAI usage — for the spend cap guard
app.get('/openai/usage', async (req, res) => {
  const KEY = PROVIDERS.openai.getKey();
  if (!KEY) return res.status(500).json({ error: { message: 'OPENAI_API_KEY not configured' } });
  try {
    // OpenAI's usage endpoint requires admin scope for org-wide, but
    // account-level usage is at /v1/usage with date range query.
    // This is a best-effort fetch; if the key doesn't have usage scope,
    // we return what we can.
    const now = new Date();
    const yyyy = now.toISOString().slice(0,10);
    const r = await fetch(`${PROVIDERS.openai.base}/v1/usage?date=${yyyy}`, {
      headers: { 'Authorization': `Bearer ${KEY}` },
    });
    return forwardJson(r, res);
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
});

/* ============================================================================
   Gemini / Veo
   Docs: https://ai.google.dev/gemini-api/docs/video
   Shape: long-running predictLongRunning operation, poll until done.
   ============================================================================ */
app.post('/gemini/videos', async (req, res) => {
  const KEY = PROVIDERS.gemini.getKey();
  if (!KEY) return res.status(500).json({ error: { message: 'GEMINI_API_KEY not configured' } });
  try {
    const { model = 'veo-3.1-generate-preview', prompt, image_url, aspect_ratio = '16:9' } = req.body || {};
    if (!prompt) return res.status(400).json({ error: { message: 'prompt required' } });
    // Veo uses predictLongRunning under :predictLongRunning endpoint
    const r = await fetch(
      `${PROVIDERS.gemini.base}/v1beta/models/${encodeURIComponent(model)}:predictLongRunning?key=${KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{
            prompt,
            image: image_url ? { bytesBase64Encoded: '', gcsUri: '', mimeType: 'image/jpeg' } : undefined,
          }],
          parameters: { aspectRatio: aspect_ratio, sampleCount: 1, personGeneration: 'dont_allow' },
        }),
      }
    );
    return forwardJson(r, res);
  } catch (e) {
    console.error('[gemini create]', e);
    return res.status(500).json({ error: { message: e.message } });
  }
});

app.get('/gemini/videos/:op', async (req, res) => {
  const KEY = PROVIDERS.gemini.getKey();
  if (!KEY) return res.status(500).json({ error: { message: 'GEMINI_API_KEY not configured' } });
  try {
    const r = await fetch(
      `${PROVIDERS.gemini.base}/v1beta/${decodeURIComponent(req.params.op)}?key=${KEY}`
    );
    return forwardJson(r, res);
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
});

/* ---------- helpers ---------- */
async function forwardJson(r, res) {
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  // Normalize: A2E returns structured business errors as
  // {code: <nonzero>, msg, trace_id}. Forward them as HTTP 200 so the
  // front-end can read the structured error. Only pass through non-2xx
  // when the response is not parseable JSON or the upstream itself
  // returned a 5xx (real failure, not a business rejection).
  const isA2EStructuredError = j && typeof j.code === 'number' && j.code !== 0;
  const isUpstreamServerError = r.status >= 500;
  const status = (!r.ok && !isA2EStructuredError) || isUpstreamServerError
    ? r.status
    : 200;
  return res.status(status).json(j);
}

/* ---------- listen ---------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[curtis-api-proxy] listening on :${port}`));

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

/* ---------- Key resolution ----------
   The user can paste their key in the app's Settings tab and the front-end
   sends it on every request via:
     x-a2e-key:    ...
     x-openai-key: ...
     x-gemini-key: ...
   The proxy prefers the per-request key over the env var, so the operator
   doesn't need to re-deploy just to add a key. The env var is still used
   if the request doesn't include a header (back-compat with the operator's
   own testing).
   -------------------------------------------------------------------------- */
function resolveKey(providerName, req){
  const headerMap = {
    a2e:    'x-a2e-key',
    openai: 'x-openai-key',
    gemini: 'x-gemini-key',
  };
  const h = headerMap[providerName];
  const fromHeader = h ? (req.headers[h] || '').toString().trim() : '';
  if(fromHeader) return { key: fromHeader, source: 'header' };
  const fromEnv = PROVIDERS[providerName]?.getKey?.() || '';
  if(fromEnv)     return { key: fromEnv, source: 'env' };
  return { key: '', source: 'none' };
}
function keyErr(providerName){
  const label = PROVIDERS[providerName]?.label || providerName;
  return {
    error: { message: `${providerName.toUpperCase()}_API_KEY not set (env or request header)` },
    friendly: `${label} key is missing. Either paste it in the app's Settings tab, or set the env var on the proxy.`,
    retryable: false,
  };
}

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
  const { action } = req.body || {};
  if (!action) return res.status(400).json({ code: -1, message: 'Missing action' });
  const { key: KEY } = resolveKey('a2e', req);
  if (!KEY) return res.status(500).json({ code: -1, ...keyErr('a2e') });
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
   A2E status poll
   ----------------------------------------------------------------------------
   The front-end's pollUntilDone() calls this in two ways:
     - POST /a2e/status  body: { action: 'image_status'|'video_status', id }
     - GET  /a2e/status?kind=image|video&id=XXX
   Both forms route to the right A2E detail endpoint and return the result
   wrapped in {code, data, friendly, retryable} so the front-end can read it
   the same way it reads /a2e responses.
   ============================================================================ */
async function a2eStatusFetch(kind, id, req){
  if(!id) return { code: -1, message: 'id required', friendly: 'Missing job id.', retryable: false };
  // Prefer the per-request key (x-a2e-key header) so the user can paste
  // their key in the app's Settings tab without needing to set the
  // proxy's env var. Fall back to env for operator self-tests.
  const { key: KEY } = resolveKey('a2e', req || { headers: {} });
  if(!KEY) return { code: -1, ...keyErr('a2e') };
  const path = kind === 'video'
    ? `/api/v1/userImage2Video/${encodeURIComponent(id)}`
    : `/api/v1/userNanoBanana/detail/${encodeURIComponent(id)}`;
  let r;
  try {
    r = await fetch(`${PROVIDERS.a2e.base}${path}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${KEY}` },
    });
  } catch (e) {
    console.error('[a2e/status]', e);
    return { code: -1, message: e.message || 'a2e status fetch error', friendly: 'Could not reach the provider.', retryable: true };
  }
  // Normalize the response in the same way forwardJson does, but as a
  // pure function that returns the JSON instead of writing to res.
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  const isA2EStructuredError = j && typeof j.code === 'number' && j.code !== 0;
  const isUpstreamServerError = r.status >= 500;
  if(isA2EStructuredError){
    j.friendly = friendlyA2E(j);
    j.retryable = false;
  } else if(isUpstreamServerError){
    j.friendly = 'The provider is having trouble. Try again in a minute.';
    j.retryable = true;
  } else if(!r.ok){
    j.friendly = `Provider returned HTTP ${r.status}.`;
    j.retryable = r.status >= 500;
  }
  return j;
}

function handleA2eStatus(req, res){
  const kind = (req.body?.kind || req.query?.kind || '').toLowerCase();
  const id   = (req.body?.id   || req.query?.id   || '').toString();
  // The action may also tell us the kind: image_status → image, video_status → video
  const action = (req.body?.action || '').toLowerCase();
  const resolvedKind = kind || (action === 'video_status' ? 'video' : action === 'image_status' ? 'image' : '');
  if(!resolvedKind){
    return res.status(400).json({ code: -1, message: 'kind (image|video) or action (image_status|video_status) required', friendly: 'Specify kind=image or kind=video in the poll request.', retryable: false });
  }
  a2eStatusFetch(resolvedKind, id, req).then(j => res.json(j));
}

app.post('/a2e/status', handleA2eStatus);
app.get('/a2e/status',  handleA2eStatus);

/* ============================================================================
   OpenAI
   Sora 2 / Sora 2 Pro — create + poll + download
   Docs: https://developers.openai.com/api/docs/guides/video-generation
   Deprecation: 2026-09-24
   ============================================================================ */

// Create a video generation job
app.post('/openai/videos', async (req, res) => {
  const { key: KEY } = resolveKey('openai', req);
  if (!KEY) return res.status(500).json(keyErr('openai'));
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
    return res.status(500).json({
      error: { message: e.message },
      friendly: 'OpenAI request failed. Check your network and try again.',
      retryable: true,
    });
  }
});

// Poll a video job
app.get('/openai/videos/:id', async (req, res) => {
  const { key: KEY } = resolveKey('openai', req);
  if (!KEY) return res.status(500).json(keyErr('openai'));
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
  const { key: KEY } = resolveKey('openai', req);
  if (!KEY) return res.status(500).json(keyErr('openai'));
  try {
    const variant = req.query.variant || 'mp4';
    const r = await fetch(`${PROVIDERS.openai.base}/v1/videos/${encodeURIComponent(req.params.id)}/content?variant=${variant}`, {
      headers: { 'Authorization': `Bearer ${KEY}` },
    });
    if (!r.ok) {
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
      return res.status(r.status).json({
        ...j,
        friendly: friendlyOpenAI(j),
        retryable: r.status >= 500,
      });
    }
    res.setHeader('Content-Type', r.headers.get('content-type') || 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="openai-${req.params.id}.${variant}"`);
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: { message: e.message } });
  }
});

// OpenAI image generation (gpt-image-1 / dall-e-3) for the trailer stills.
// The front-end's OpenAI provider uses this to make one still per scene
// (face-locked via input_reference for dall-e-3 edits, or just prompt for
// gpt-image-1).
app.post('/openai/images', async (req, res) => {
  const { key: KEY } = resolveKey('openai', req);
  if (!KEY) return res.status(500).json(keyErr('openai'));
  try {
    const {
      prompt,
      model = 'gpt-image-1',
      size = '1024x1024',
      n = 1,
      input_reference,  // optional base64 or URL of reference image (face lock)
    } = req.body || {};
    if (!prompt) return res.status(400).json({ error: { message: 'prompt required' } });
    const body = { model, prompt, size, n };
    if (input_reference) body.input_reference = input_reference;
    const r = await fetch(`${PROVIDERS.openai.base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return forwardJson(r, res);
  } catch (e) {
    console.error('[openai images]', e);
    return res.status(500).json({
      error: { message: e.message },
      friendly: 'OpenAI image request failed. Check your network and try again.',
      retryable: true,
    });
  }
});

// OpenAI usage — for the spend cap guard
app.get('/openai/usage', async (req, res) => {
  const { key: KEY } = resolveKey('openai', req);
  if (!KEY) return res.status(500).json(keyErr('openai'));
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
  const { key: KEY } = resolveKey('gemini', req);
  if (!KEY) return res.status(500).json(keyErr('gemini'));
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
  const { key: KEY } = resolveKey('gemini', req);
  if (!KEY) return res.status(500).json(keyErr('gemini'));
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

  // Tag the error so the front-end knows whether to retry, surface a
  // friendly message, or block the run entirely.
  if(isA2EStructuredError){
    j.friendly = friendlyA2E(j);
    j.retryable = false;  // structured business errors don't get better on retry
  } else if(isUpstreamServerError){
    j.friendly = 'The provider is having trouble. Try again in a minute.';
    j.retryable = true;
  } else if(!r.ok){
    j.friendly = `Provider returned HTTP ${r.status}.`;
    j.retryable = r.status >= 500;
  }
  return res.status(status).json(j);
}

function friendlyA2E(j){
  const msg = (j.msg || j.message || '').toLowerCase();
  if(msg.includes('free user') || msg.includes('pro or max')){
    return 'Your A2E account is on the Free plan. The API requires Pro or Max. Upgrade at video.a2e.ai → Account → Plan.';
  }
  if(msg.includes('unauthorized') || msg.includes('401') || msg.includes('invalid token')){
    return 'The A2E API key is wrong or expired. Generate a new one in the A2E dashboard and paste it in Settings.';
  }
  if(msg.includes('quota') || msg.includes('insufficient')){
    return 'You\'ve run out of A2E credits. Top up at video.a2e.ai.';
  }
  if(msg.includes('rate limit') || msg.includes('too many')){
    return 'A2E is rate-limiting you. Wait a minute and try again.';
  }
  return j.msg || j.message || 'A2E returned an error.';
}

function friendlyOpenAI(j){
  const code = j?.error?.code;
  const msg = (j?.error?.message || '').toLowerCase();
  if(code === 'invalid_api_key' || msg.includes('incorrect api key') || msg.includes('invalid api key')){
    return 'The OpenAI key is wrong or revoked. Generate a new one at platform.openai.com → API keys, then paste it in Settings.';
  }
  if(msg.includes('insufficient_quota') || msg.includes('billing') || msg.includes('payment')){
    return 'OpenAI says you\'re out of credit. Add a payment method at platform.openai.com → Billing.';
  }
  if(msg.includes('sora') && (msg.includes('deprecat') || msg.includes('shutdown'))){
    return 'Sora 2 is shutting down on 2026-09-24. The proxy doesn\'t have access to the successor model yet. Use A2E for now.';
  }
  if(msg.includes('rate_limit') || msg.includes('too many requests')){
    return 'OpenAI is rate-limiting you. Wait a minute and try again.';
  }
  if(msg.includes('content_policy') || msg.includes('safety') || msg.includes('rejected')){
    return 'OpenAI rejected the prompt as unsafe. Try rewording the script.';
  }
  if(msg.includes('model') && msg.includes('not found')){
    return 'The selected OpenAI model doesn\'t exist or you don\'t have access. Try sora-2 (the cheaper one).';
  }
  return j?.error?.message || 'OpenAI returned an error.';
}

/* ---------- listen ---------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[curtis-api-proxy] listening on :${port}`));

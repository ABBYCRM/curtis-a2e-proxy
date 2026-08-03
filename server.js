/* ============================================================================
   curtis-a2e-proxy — Render Node service
   ----------------------------------------------------------------------------
   Thin proxy in front of A2E.ai. The browser cannot call video.a2e.ai
   directly (CORS). This service:
     1. Holds the A2E Bearer token in the A2E_API_KEY env var (server-side only).
     2. Accepts JSON {action, ...payload} from the Trailer Studio frontend.
     3. Forwards to the real A2E endpoint with the correct headers.
     4. Returns the A2E response untouched (so the frontend can read
        data.current_status, data.result_url, data.image_urls, etc.)
   ============================================================================ */

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));                // allow any origin (static front-end)
app.use(express.json({ limit: '10mb' }));

const A2E_BASE = process.env.A2E_BASE_URL || 'https://video.a2e.ai';
const A2E_KEY  = process.env.A2E_API_KEY;

if (!A2E_KEY) {
  console.warn('[curtis-a2e-proxy] WARNING: A2E_API_KEY env var is not set. Requests will return 500.');
}

app.get('/', (_req, res) => res.json({
  name: 'curtis-a2e-proxy',
  status: A2E_KEY ? 'ready' : 'missing-key',
  a2e_base: A2E_BASE,
  endpoints: [
    'POST /a2e  body: {action:"image_start",...}',
    'POST /a2e  body: {action:"image_status", id}',
    'POST /a2e  body: {action:"video_start",...}',
    'POST /a2e  body: {action:"video_status", id}',
  ]
}));

app.get('/healthz', (_req, res) => res.json({ ok: !!A2E_KEY }));

/* ---------- main router ---------- */
app.post('/a2e', async (req, res) => {
  if (!A2E_KEY) return res.status(500).json({ code: -1, message: 'A2E_API_KEY not configured on the proxy' });
  const { action } = req.body || {};
  if (!action) return res.status(400).json({ code: -1, message: 'Missing action' });

  try {
    let upstreamPath, upstreamBody;

    switch (action) {
      case 'image_start': {
        upstreamPath = '/api/v1/userNanoBanana/start';
        upstreamBody = {
          name: req.body.name || 'trailer-still',
          prompt: req.body.prompt,
          input_images: Array.isArray(req.body.input_images) ? req.body.input_images : [],
          aspectRatio: req.body.aspectRatio || '16:9',
          resolution: req.body.resolution || '2K',
        };
        break;
      }
      case 'image_status': {
        if (!req.body.id) return res.status(400).json({ code: -1, message: 'id required' });
        upstreamPath = `/api/v1/userNanoBanana/detail/${encodeURIComponent(req.body.id)}`;
        upstreamBody = {};
        break;
      }
      case 'video_start': {
        upstreamPath = '/api/v1/userImage2Video/start';
        upstreamBody = {
          name: req.body.name || 'trailer-clip',
          image_url: req.body.image_url,
          prompt: req.body.prompt,
          negative_prompt: req.body.negative_prompt || 'six fingers, bad hands, lowres, low quality, deformed face, blurry',
          aspectRatio: req.body.aspectRatio || '16:9',
        };
        break;
      }
      case 'video_status': {
        if (!req.body.id) return res.status(400).json({ code: -1, message: 'id required' });
        // A2E status endpoint is GET with the id in the path
        const r = await fetch(`${A2E_BASE}/api/v1/userImage2Video/${encodeURIComponent(req.body.id)}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${A2E_KEY}` },
        });
        const text = await r.text();
        let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
        return res.status(r.ok ? 200 : r.status).json(j);
      }
      default:
        return res.status(400).json({ code: -1, message: `Unknown action: ${action}` });
    }

    const upstream = await fetch(`${A2E_BASE}${upstreamPath}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${A2E_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
    });
    const text = await upstream.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
    return res.status(upstream.ok ? 200 : upstream.status).json(j);

  } catch (e) {
    console.error('[curtis-a2e-proxy] error:', e);
    return res.status(500).json({ code: -1, message: e.message || 'proxy error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[curtis-a2e-proxy] listening on :${port}`));

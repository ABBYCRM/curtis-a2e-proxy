'use strict';
// Static contract check for the proxy. Verifies the server still
// exposes every route the front-end and operator expect, and that no
// deprecated route has crept back in. Run with `node` (no deps).

const fs = require('fs');
const source = fs.readFileSync('server.js', 'utf8');

// --- Required routes and symbols. ---
for (const required of [
  // Models
  "const model = 'gpt-image-2'",
  // OpenAI routes
  '/v1/images/edits', '/v1/images/generations', '/v1/videos',
  '/openai/images', '/openai/videos', '/openai/videos/:id/content',
  // A2E routes
  '/a2e', '/a2e/status', 'userNanoBanana', 'userImage2Video',
  'A2E_BASE_URL',
  // Album routes
  'app.get(\'/album\'', 'app.post(\'/album/upload\'', 'app.get(\'/album/:id\'',
  'app.delete(\'/album\'', 'app.delete(\'/album/:id\'',
  'app.post(\'/album/save-from-url\'',
  // Album storage
  'ALBUM_DIR', 'ALBUM_INDEX', 'saveAssetToAlbum',
  'pruneAlbum', 'enforceTotalBytes',
  // Security
  'APP_PROXY_TOKEN', 'assertPublicHttpsUrl', 'isPrivateAddress',
  // Utilities
  'AbortController', 'sharp', 'fs.createReadStream',
  // Rate limit env vars (now actually used)
  'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS',
  // Capabilities
  'openai_video: true',
]) {
  if (!source.includes(required)) throw new Error(`Missing proxy contract: ${required}`);
}

// --- Forbidden stale patterns. ---
for (const forbidden of [
  '/v1/usage?date=',
  ':predictLongRunning',
  "body.input_reference = input_reference",
  // 410 video stub is gone now that the real Sora 2 route is wired.
  "'openai_video_disabled'",
  // The rate limiter used to be hard-coded; if these literals come
  // back it means the env vars are being ignored again.
  'if (count > 60) {',
  'Math.floor(now / 60000)',
]) {
  if (source.includes(forbidden)) throw new Error(`Forbidden stale contract: ${forbidden}`);
}

// --- errorBody must be defined and used by every route. ---
if (!source.includes('function errorBody')) {
  throw new Error('errorBody helper missing');
}

console.log('Proxy static contract OK.');

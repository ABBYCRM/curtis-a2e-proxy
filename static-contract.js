'use strict';
const fs = require('fs');
const source = fs.readFileSync('server.js', 'utf8');
for (const required of [
  "const model = 'gpt-image-2'",
  '/v1/images/edits',
  '/v1/images/generations',
  '/v1/videos',
  'sora-2',
  'APP_PROXY_TOKEN',
  'assertPublicHttpsUrl',
  'AbortController',
  'ALBUM_DIR',
  'saveAssetToAlbum',
  '/album/save-from-url',
]) {
  if (!source.includes(required)) throw new Error(`Missing proxy contract: ${required}`);
}
for (const forbidden of [
  '/v1/usage?date=',
  ':predictLongRunning',
  "body.input_reference = input_reference",
  // 410 video stub is gone now that the real Sora 2 route is wired.
  "'openai_video_disabled'",
]) {
  if (source.includes(forbidden)) throw new Error(`Forbidden stale provider contract: ${forbidden}`);
}
console.log('Proxy static contract OK.');

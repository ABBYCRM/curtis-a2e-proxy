'use strict';
const fs = require('fs');
const source = fs.readFileSync('server.js', 'utf8');
for (const required of [
  "const model = 'gpt-image-2'",
  '/v1/images/edits',
  '/v1/images/generations',
  'APP_PROXY_TOKEN',
  'assertPublicHttpsUrl',
  "res.status(410)",
  'AbortController',
]) {
  if (!source.includes(required)) throw new Error(`Missing proxy contract: ${required}`);
}
for (const forbidden of [
  '/v1/usage?date=',
  ':predictLongRunning',
  "body.input_reference = input_reference",
]) {
  if (source.includes(forbidden)) throw new Error(`Forbidden stale provider contract: ${forbidden}`);
}
console.log('Proxy static contract OK.');

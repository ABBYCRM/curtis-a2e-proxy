# curtis-a2e-proxy

Tiny CORS proxy + auth holder for the A2E.ai API, used by [Curtis Image Gen](https://github.com/ABBYCRM/Curtis-Image-Gen).

## Why

The browser cannot call `video.a2e.ai` directly (CORS). This service:
1. Holds the A2E Bearer token in `A2E_API_KEY` (server-side only, never sent to the browser).
2. Accepts JSON `{action, ...}` from the Trailer Studio frontend.
3. Forwards to the real A2E endpoint with the correct auth header.
4. Returns the A2E response untouched.

## Endpoints

- `GET  /`            — service info
- `GET  /healthz`     — `{ok: <bool>}`
- `POST /a2e`         — body: `{action, ...}`

### Supported actions

| action | A2E upstream | body |
|---|---|---|
| `image_start` | `POST /api/v1/userNanoBanana/start` | `{name, prompt, input_images[], aspectRatio, resolution}` |
| `image_status` | `POST /api/v1/userNanoBanana/detail/{id}` | `{id}` |
| `video_start` | `POST /api/v1/userImage2Video/start` | `{name, image_url, prompt, negative_prompt, aspectRatio}` |
| `video_status` | `GET /api/v1/userImage2Video/{id}` | `{id}` |

## Environment

| Var | Required | Default |
|---|---|---|
| `A2E_API_KEY` | yes | — |
| `A2E_BASE_URL` | no | `https://video.a2e.ai` |
| `PORT` | no | `3000` |

## Local run

```bash
npm install
A2E_API_KEY=sk_xxx npm start
```

## Deploy

Deployed to Render as a Node Web Service. Build command: `npm install`. Start command: `npm start`.

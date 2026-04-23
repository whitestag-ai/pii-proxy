# @whitestag-ai/pii-proxy-server

## 0.2.0

### Minor Changes

- f720c2f: Initial public release.

  - @whitestag-ai/pii-proxy-core: Library for PII detection, pseudonymisation, and mapping-store management
  - @whitestag-ai/pii-proxy-server: Fastify HTTP server exposing anonymize/deanonymize/safe-call endpoints with X-PII-Proxy-Key auth

  See README for quick start and architecture overview.

### Patch Changes

- Updated dependencies [f720c2f]
  - @whitestag-ai/pii-proxy-core@0.2.0

## 0.1.0

### Minor Changes

- Initial public release.
  - Fastify 4 HTTP gate on configurable port (default 4711)
  - Endpoints: `POST /anonymize`, `POST /deanonymize`, `POST /safe-call`, `GET /health`
  - `X-PII-Proxy-Key` shared-secret auth with `timingSafeEqual`
  - Monitor loop with Telegram alerts for Art. 9 blocks, classifier-down streaks, and error-rate bursts
  - Deploy assets: macOS launchd plist, Linux systemd unit, Dockerfile

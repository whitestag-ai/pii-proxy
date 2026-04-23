# @whitestag/pii-proxy-server

## 0.2.1

### Patch Changes

- 355237e: Re-trigger release pipeline with corrected `publishedPackages` gate so
  that the GHCR Docker image and PyPI artefact are produced alongside the
  npm publish. Package contents are functionally identical to 0.2.0.
- Updated dependencies [355237e]
  - @whitestag/pii-proxy-core@0.2.1

## 0.2.0

### Minor Changes

- f720c2f: Initial public release.

  - @whitestag/pii-proxy-core: Library for PII detection, pseudonymisation, and mapping-store management
  - @whitestag/pii-proxy-server: Fastify HTTP server exposing anonymize/deanonymize/safe-call endpoints with X-PII-Proxy-Key auth

  See README for quick start and architecture overview.

### Patch Changes

- Updated dependencies [f720c2f]
  - @whitestag/pii-proxy-core@0.2.0

## 0.1.0

### Minor Changes

- Initial public release.
  - Fastify 4 HTTP gate on configurable port (default 4711)
  - Endpoints: `POST /anonymize`, `POST /deanonymize`, `POST /safe-call`, `GET /health`
  - `X-PII-Proxy-Key` shared-secret auth with `timingSafeEqual`
  - Monitor loop with Telegram alerts for Art. 9 blocks, classifier-down streaks, and error-rate bursts
  - Deploy assets: macOS launchd plist, Linux systemd unit, Dockerfile

# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Instead:

- Email `security@whitestag.ai`
- PGP: (key fingerprint will be added after repo setup)

We'll acknowledge within 72 hours and aim to ship a fix within 14 days for critical issues.

## Scope

In scope:
- Pseudonymisation bypass (PII leaking through the gate)
- Mapping store key extraction
- Shared-key timing or brute-force weaknesses
- Audit-log tampering or injection
- Any CVSS ≥ 4.0 vulnerability in the HTTP server or TS/Python clients

Out of scope:
- Denial of service via classifier exhaustion (the classifier is an external dependency by design)
- Supply-chain attacks on unpinned dependencies of your own deployment
- LLM prompt injection that tricks a cloud LLM after the gate (pii-proxy does not claim to mitigate prompt injection)

## Supported versions

Only the latest minor release receives security updates during the 0.x series.

## Security assumptions

- The host running pii-proxy is trusted.
- The shared key is treated as a cryptographic secret (32+ chars, rotated on suspicion).
- The classifier model produces outputs aligned with the prompts it's given. Model jailbreaks in the classifier *could* let PII through — report such cases.

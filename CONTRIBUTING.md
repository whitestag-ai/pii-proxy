# Contributing to pii-proxy

Thanks for considering a contribution.

## Development setup

```bash
git clone https://github.com/whitestag-ai/pii-proxy.git
cd pii-proxy
pnpm install
pnpm test    # TS packages
cd python && pip install -e ".[dev]" && pytest
```

## Pull requests

1. Open an issue first for anything larger than a typo fix
2. Branch from `main`
3. Write tests (TDD — test first)
4. Run `pnpm build && pnpm test` and (if touching Python) `pytest`
5. Add a changeset: `pnpm changeset`
6. Open PR

## Commit style

- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`)
- Include the package scope: `fix(server): …`

## Classifier models

If you're adding or testing a new classifier model, include benchmark notes in `docs/MODELS.md`.

## Security-sensitive changes

PRs that touch the mapping store, shared-key handling, or the classifier pipeline must include:

1. A description of the threat model change
2. Tests for the new behaviour
3. A mention in `SECURITY.md` if it changes assumptions

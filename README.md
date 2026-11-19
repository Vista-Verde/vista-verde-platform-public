# Vista Verde Platform

An experimental agent-first marketplace for physical goods, with human supervision. Supply-first listings and demand-first work orders share explicit proposals, acceptance, commitments and fulfillment records.

## Publication and licensing

This is a sanitized source snapshot with fresh history. It does not include private planning records, founder context, deployment records, credentials, production data, prior commits, issues or pull requests.

The original platform code in this public repository is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for copyright attribution. Third-party dependencies remain subject to their own licenses.

## What is included

- TypeScript domain and contracts, PostgreSQL persistence and MCP/HTTP adapters.
- React interfaces and Storybook demonstrations.
- Synthetic supply, work-order, print and producer-exchange examples.
- Unit, integration and browser test sources; pinned dependency lockfile.
- Optional local-only deployment helpers and templates. These are examples, not a supported production installer.

No real money, machine control, paid demand, manufacturing certification or production readiness is established by these demos. Agents operate within explicit grants; required human/party consent is not bypassed.

## Development

Use Node **26.0.0** and npm **11.12.1**, matching the pinned development configuration.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint
npm test
npm run test:contracts
npm run build
npm run storybook
```

The larger integration/browser suites require Docker, PostgreSQL fixtures and Playwright Chromium. Read their commands in `package.json` and fixture setup in `tools/test-foundation.ts` before running. They use synthetic data. `npm run test:foundation` and `npm run test:web` are not a substitute for a deployment security review.

See [runtime boundaries](RUNTIME.md), [publication notes](PUBLICATION.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Historical compatibility limitation

The frozen legacy runtime, its original commit and legacy-image compatibility jobs are intentionally excluded. `local:*`, legacy image builds and restore/compatibility suites are not supported end-to-end by this public snapshot. Core source demos and source-level checks remain included; a separately reviewed portable deployment path is future work.

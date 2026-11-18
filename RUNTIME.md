# Runtime boundaries

This snapshot contains synthetic demonstration code, not a hosted service. There is no real payment execution or physical equipment control. The simulated producer exchanges quote, acceptance and job-status messages; it does not print a real part.

## Access and configuration

Owner-access sample constants use reserved example identities. The optional owner gateway is disabled by default. Configure and review trusted host, issuer, email and audience before enabling a private deployment; do not substitute unverified forwarded headers for identity. No credentials are included.

Local Kubernetes helpers are development examples for an ARM64 OrbStack environment. They are not portable installers. The backup volume path and UUID are deliberately invalid placeholders. Configure a dedicated backup target and review every helper before running `local:*`; these commands can create containers, Kubernetes resources, local secrets and backups. They must not target an existing production environment without a separate review.

The ordinary app/demo flow and tests should be used before adapting any deployment helpers. Keep loopback-only synthetic services isolated. Real customers, financial effects, files and machine integration require additional engineering, consent, threat modeling and validation.

## Historical compatibility limitation

The frozen legacy runtime, its original commit and legacy-image compatibility jobs are intentionally excluded. `local:*`, legacy image builds and restore/compatibility suites are not supported end-to-end by this public snapshot. Core source demos and source-level checks remain included; a separately reviewed portable deployment path is future work.

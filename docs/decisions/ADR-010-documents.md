# ADR-010: Documents: central files with quarantine, scanning and link-derived access

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-002, ADR-005

## Context
Student documents are private; many attachment types; uploads are an attack surface.

## Decision
`files` + `file_links`; opaque keys with tenant prefix and no PII; classes (general/sensitive/generated) in separate buckets; uploads land in quarantine, are type-sniffed and scanned (ClamAV), then promoted; access is derived from linked entities through the policy engine; signed URLs ≤5 minutes issued only after authorisation; retention policies and legal hold; sensitive reads audited.

## Options considered
Per-module attachment tables; public buckets with obscure keys; central pipeline.

## Consequences
One pipeline to secure and audit; scanning adds latency before availability.

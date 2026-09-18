# NSFW Filter Documentation

Welcome to the internal technical documentation for the NSFW Filter extension.

## Topic Ownership Map

| Document | Topic | Description |
|---|---|---|
| [`docs/architecture.md`](file:///mnt/c/Users/anara/Projects/filter-images-nsfw/docs/architecture.md) | Extension Architecture | Complete runtime flow, message types, and pipeline stages |
| [`docs/decisions/0001-migration-to-vanilla-mv3.md`](file:///mnt/c/Users/anara/Projects/filter-images-nsfw/docs/decisions/0001-migration-to-vanilla-mv3.md) | ADR-0001 | Architecture Decision Record: Migration to Vanilla Manifest V3 |
| [`README.md`](file:///mnt/c/Users/anara/Projects/filter-images-nsfw/README.md) | Project Overview | User guide, installation steps, and high-level phase roadmap |

## Standards & Constraints
- All inference runs locally in browser via ONNX Runtime Web.
- Zero-Flash Policy: Images are blurred via manifest-level CSS at `document_start`.
- No em dashes are permitted in any repository document or code file.

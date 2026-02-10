# Multimodal Module (`src/multimodal/`)

## Purpose

Normalizes inbound media/text into canonical envelopes and negotiates provider/channel capability fallbacks.

## Key Files

- `ingest.ts` - build/persist canonical envelope, delivery plan
- `outbound.ts` - outbound mode-safe rendering
- `provider-payload.ts` - provider input payload construction
- `capabilities/*` - negotiation + fallback policy + registry
- `protocol/*` - canonical protocol schemas/versioning

## Integration

Used by `MessageHandler` for ingress processing and response adaptation.

## Edit + Verify

- `pnpm run test`
- focus `src/multimodal/*.test.ts`

## Constraints

- Keep canonical protocol compatibility and persistence format aligned with `storage/db.ts` multimodal tables.

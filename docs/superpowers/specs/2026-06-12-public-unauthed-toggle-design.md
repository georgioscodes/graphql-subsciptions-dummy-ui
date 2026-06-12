# Public (unauthed) AI Planner endpoint toggle

**Date:** 2026-06-12
**Ticket:** MGA-6792 (mga-service side, already merged + deployed to dev)
**Scope:** `app/page.tsx` (single-file debug frontend)

## Background

mga-service added public, unauthenticated counterparts of the AI Planner GraphQL
operations (commit `5a26645f`, MGA-6792):

| Authed (existing)                       | Public / unauthed (new)                       |
| --------------------------------------- | --------------------------------------------- |
| `createAiPlannerSession(input)` mutation | `createPublicAiPlannerSession` mutation (no args) |
| `aiPlanner(input)` subscription          | `publicAiPlanner(input)` subscription         |

The public operations require **no** bearer token; `WebsocketInterceptor` now allows
tokenless WS connections, with method-level `@PublicEndpoint` / `@PreAuthorize` as the
gate. Flow is `UNAUTHED` — prose-only, no brand/plan/map. Same `/graphql` and
`/subscriptions` URLs. Verified live on dev (`createPublicAiPlannerSession` →
`flow: UNAUTHED`).

The schema also gained two additive fields since this frontend was written:
`AiPlannerBrief.clashCode` and `AiPlannerBroadcastRegion.polylines`.

## Design

1. **Mode toggle (header).** Add `publicMode` boolean state, surfaced as a labeled
   toggle in the header ("Public (unauthed)").
   - OFF (default): existing authed behavior — token field visible,
     `createAiPlannerSession` + `aiPlanner`, `Authorization: Bearer` sent on HTTP + WS.
   - ON: hide & disable the Gigya token field; use `createPublicAiPlannerSession`
     (no input/no header) + `publicAiPlanner`; open the WS with no `connectionParams`.

2. **Operation selection.** Branch the mutation string, subscription string, fetch
   headers, and WS `connectionParams` on `publicMode`. `createPublicAiPlannerSession`
   takes no `input`; `publicAiPlanner` reuses `AiPlannerInput`.

3. **Send-gating.** Replace the `!!gigyaToken` gate with
   `canSend = publicMode || !!gigyaToken`.

4. **Toggle resets the session.** Session IDs are flow-specific (UNAUTHED vs AUTHED),
   so flipping the toggle calls `resetSession()`. Toggle disabled mid-stream.

5. **New contract fields.** Add `clashCode` to `brief { … }` and `polylines` to
   `broadcastRegions { … }` in the subscription query. Surface in the raw frame log;
   null on the UNAUTHED flow.

## Out of scope (YAGNI)

- No structured rendering of brief/plan (frame log already shows raw JSON).
- No endpoint-URL changes (same `/graphql` + `/subscriptions`).

## Testing

Per AGENTS.md, check the Next.js 16 guide in `node_modules/next/dist/docs/` before
editing. Then run the app and drive it with the Playwright MCP server against dev:
exercise public mode (no token) → `createPublicAiPlannerSession` + `publicAiPlanner`
stream frames; confirm authed mode still requires a token and works.

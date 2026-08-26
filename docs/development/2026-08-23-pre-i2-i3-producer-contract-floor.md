# Pre-I2/I3 producer contract floor

- Status: implementation candidate
- Base: `4e515a8487163296a7c2685b87860782c5c55e23`
- Lane: S2 contract slice; security-sensitive write authority remains blocked
- Scope: Swarm repository only; official DSH is a read-only composition host

## Outcome

Freeze the smallest producer contract that future I2 Host and I3 `/swarm` RPC work can consume without reviving the retired H4 branches or implying that browser write authority exists. The slice publishes canonical versioned schemas, fixtures and their digest, then provides one internal Cordis service for capability discovery and bounded read-only Team/receipt projections.

Message, Control and cancel entry points exist only to make the negative capability explicit. They always fail with `SWARM_CAPABILITY_UNAVAILABLE` before inspecting a payload or calling any I1a operation. This candidate does not mount HTTP/RPC routes, mint browser context, authenticate a human principal, or claim I2/I3 completion.

## Official and project ownership

- Official stable seam consumed: Cordis `ctx.provide()` lifecycle and the official live root Agent registry already composed by the plugin.
- Project authority consumed: `TeamDomainPort.snapshot()` for Team reads and `HumanInteractionOverlayStore.list()` for durable receipt reads.
- Canonical Team owner remains `TeamDomainPort`; the Host projection cannot mutate it.
- Canonical HumanInteraction request/receipt owner remains the current overlay. The projection omits source, principal, scope, bodies, diagnostics, message ids and task-result ids.
- ADR-0009 stays `Proposed` and its old-binary/effect-correlation blocker remains authoritative. No old effect-correlation implementation is migrated.

## Contract

The immutable contract bundle has:

1. protocol id, version and explicit JSON Schema Draft 2020-12 dialect identity;
2. one fixed capability descriptor (`snapshot.read` and `receipt.read` available; `message.write`, `control.write` and `effect.cancel` unavailable with blocker `i1b-effect-correlation`);
3. strict JSON schemas for capability, snapshot and receipt-page results;
4. canonical fixtures for all three results plus the three unavailable effect errors;
5. SHA-256 over canonical JSON `{contract, fixturePreimage}`; the description's digest field uses the fixed `sha256:self` marker in that preimage, then the final canonical fixture replaces only that marker with the derived digest.

Any content change changes the digest and therefore creates a new producer contract candidate. The namespace is recorded as `/swarm`, but this slice mounts no network transport.

## Host service

`AgentSwarmProducerFloorService` is internal and host-only:

- every read requires caller-bound authority carrying the exact live root `Agent` object;
- the service derives workspace scope from that Agent and asks the authoritative domain for the named Team;
- snapshots are bounded projections, not stored copies;
- receipt pages are bounded, oldest-first redacted projections with an explicit `truncated` flag;
- every returned value is deeply frozen;
- closing admission rejects new reads, waits for admitted reads, then makes every method fail closed;
- write/cancel methods are permanently unavailable and have no effect dependency to call.

The plugin provides the service only after Team and HumanInteraction storage have opened. Teardown unprovides it before the overlay/domain close, so no consumer can enter after authority retirement begins.

## Verification

- schema/fixture/digest byte stability, including a fixed expected digest;
- exact-root authorization and bounded redacted projections;
- Message/Control/cancel unavailable paths do not read payloads, call Team operations or create receipts;
- Cordis provide/unprovide and admitted-read drain behavior;
- Gate A, governance, structure, lint, typecheck, targeted tests and package checks.

## Explicit non-goals and next gate

No browser context registry, principal verifier, authenticated cursor, event stream, RPC route, Client plugin, Canvas consumer, or effect execution is included. I2 may build executable context and Host write admission only after its I1 dependency is accepted. I3 may wrap the accepted I2 surface only after the Host contract and real Profile lifecycle evidence are frozen.

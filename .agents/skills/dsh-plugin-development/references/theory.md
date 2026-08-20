# DSH theory reference

## Plugin tree

A DSH process boots an ordered Cordis plugin tree assembled from Bundle layers, Profile patch, machine patch and command overlays. There is no privileged business core. Rows are identified by id, and later patches can replace configuration or disable them.

## Services

A Service is a named capability on `ctx`. Required dependencies are static declarations. Service disappearance disposes dependents and later reappearance activates them again. This makes topology and lifecycle part of correctness.

## Events

Events provide loose coupling. Session events are durable; Agent events describe live execution; capability events extend a seam. Dispatch mode matters: emit/parallel/serial/bail/waterfall have different control semantics.

## Sessions

Session events are append-only facts from which model messages, replay, resume, fork, UI and audit derive. A plugin that injects model-visible context without a supported durable record violates the model-visible/logged invariant.

## Providers

Provider registry contracts let multiple implementations coexist. A caller names or resolves a Provider and the Service validates capability before dispatch. Unsupported requests fail before publication.

## Consumers

Tools and UI are Consumers. They should not own canonical state or force transport details into Service Definitions.

## Scope

Agent-specific capabilities belong on the Agent’s scoped context. Global registration when only one Agent should see a tool is an authority leak.

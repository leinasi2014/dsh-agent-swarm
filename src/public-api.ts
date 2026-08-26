/** Stable public exports kept separate from the Host composition root. */
export { AgentSwarmRuntime } from './runtime/orchestrator-runtime.js'
export type {
  ReviewProviderInput,
  ReviewProviderResult,
  RuntimeConfig,
  SchedulerDecision,
  SchedulerSelectionInput,
  TeamReviewProvider,
  TeamSchedulerProvider,
  ToolExecutionAuthority,
} from './runtime/orchestrator-runtime.js'
export type {
  ReviewCommandEvidence,
  ReviewRootAvailability,
  ReviewRootCapabilities,
  ReviewRootOpenInput,
  ReviewRootProvider,
  ReviewRootSession,
} from './runtime/review-root.js'
export { executableReviewRootCapabilities, tempReviewRootProvider } from './runtime/review-root.js'
export { executableReview, CANDIDATE_OUTPUT_ARTIFACT } from './runtime/executable-review.js'
export type { ExecutableReviewOptions, ExecutableReviewProvider, ExecutableReviewResult } from './runtime/executable-review.js'
export { aggregateVerificationEvidence } from './runtime/verification-summary.js'
export type {
  RoutedReviewCommandEvidence,
  OpenedVerificationRoot,
  VerificationEvidenceSummary,
  VerificationRootSummary,
} from './runtime/verification-summary.js'
export {
  builtinVerificationTemplates,
  compileVerificationDeclarations,
  encodeVerificationCommand,
  parseVerificationCommand,
} from './runtime/verification-commands.js'
export type {
  BuiltinVerificationTemplate,
  RuntimeCreateTaskInput,
  VerificationCommandRoute,
  VerificationCommandTemplate,
  VerificationDeclaration,
  VerificationTemplateInvocation,
  VerificationTemplateParameterValue,
} from './runtime/verification-commands.js'
export { OrchestrationOwnership } from './runtime/orchestration-ownership.js'
export type { OrchestrationMode } from './runtime/orchestration-ownership.js'
export type {
  ExecutionLease,
  ExecutionRoot,
  ExecutionRootIsolation,
  ExecutionRootResidue,
  TeamExecutionRootProvider,
} from './runtime/execution-roots.js'
export { ExecutionRoots, EXECUTION_ROOT_MARKER, gitWorktreeExecutionRoots } from './runtime/execution-roots.js'
export { TeamBridgeWorkflowEngine, validateBridgeMeta } from './runtime/workflow/team-bridge-engine.js'
export type { BridgeEngineConfig } from './runtime/workflow/team-bridge-engine.js'
export { TeamJobProjection } from './runtime/jobs/team-job-projection.js'
export { TEAM_TASK_JOB_KIND } from './runtime/jobs/projection-derive.js'
export type { DerivedTeamJob } from './runtime/jobs/projection-derive.js'
export {
  WorkflowRunOverlayStore,
  workflowOverlayDomainSpec,
  WORKFLOW_OVERLAY_DOMAIN_NAME,
  WORKFLOW_OVERLAY_DOMAIN_VERSION,
} from './storage/workflow-run-overlay.js'
export type { WorkflowRunOverlayRecord, WorkflowRunOverlayState } from './storage/workflow-run-overlay.js'
export { TeamDomainError } from './domain/error.js'
export { deriveRestartSafeAttemptBinding, parseRestartSafeAttemptBinding } from './runtime/restart-binding.js'
export type { RestartSafeAttemptBinding } from './runtime/restart-binding.js'
export { HumanControlGateway } from './human/human-control-gateway.js'
export type { HumanControlAdmission, HumanControlGatewayDeps } from './human/human-control-gateway.js'
export { humanReviewProvider } from './human/human-review-provider.js'
export { TeamPermissionSurface, effectiveToolPolicy, mergePreToolDecision } from './runtime/permission-surface.js'
export type { ToolPolicyDeclaration } from './runtime/permission-surface.js'
export type { HumanPrincipalVerifier } from './runtime/human-provenance.js'
export type { HostContextAuthority, HostContextGrant, HostContextPort } from './human/host-context-service.js'
export { reviewerAgentReviewProvider } from './runtime/reviewer-boundary.js'
export type { ReviewerAgentProvider, ReviewerAgentVerdict } from './runtime/reviewer-boundary.js'
export { compileNodePlan, applyNodePlan } from './patterns/node-mapping.js'
export type {
  AppliedNodePlan,
  CompiledNodePlan,
  CompiledReviewGate,
  CompiledTaskInput,
  CompiledTaskOp,
  NodePlan,
  PhaseDecl,
  PipelineItemDecl,
  PlanNodeDecl,
  TaskStepDecl,
} from './patterns/node-mapping.js'
export { AttemptId, TaskId, TeamId, TeamMessageId } from './domain/types.js'
export type {
  ReviewVerificationCommand,
  TeamBudget,
  TeamMember,
  TeamMemoryEntry,
  TeamMessage,
  TeamState,
  TeamStatusSnapshot,
  TeamTask,
} from './domain/types.js'
export type {
  CreateTaskInput,
  MigrationReceipt,
  TeamAggregateStore,
  TeamDomainPort,
  TeamScope,
  TeamTransaction,
} from './domain/team-domain-port.js'
export { StorageDomainTeamStore } from './storage/storage-domain-team-store.js'
export { TEAM_DOMAIN_NAME, TEAM_DOMAIN_VERSION, teamDomainSpec } from './storage/team-spec.js'
export { FileTeamStore, resolveStateRoot } from './storage/team-store.js'
export { migrateLegacyTeamStore } from './migration/migrate-legacy-store.js'
export type { MigrationOptions, MigrationReport, MigrationTeamOutcome } from './migration/migrate-legacy-store.js'
export { CaptainLiaison } from './human/captain-liaison.js'
export { officialCaptainQuestionPresentation } from './human/official-question-presentation.js'
export {
  HumanInteractionOverlayStore,
  humanInteractionDomainSpec,
  HUMAN_INTERACTION_DOMAIN_NAME,
  HUMAN_INTERACTION_DOMAIN_VERSION,
} from './human/human-interaction-store.js'
export { HUMAN_INTERACTION_CONTROL_INTENTS, sameHumanInteractionRequest } from './human/human-interaction-contract.js'
export * from './host/producer-contract.js'
export * from './host/producer-floor-service.js'
export * from './host/host-read-service.js'
export type {
  CaptainQuestion,
  CaptainQuestionPresentation,
  HumanInteractionIntent,
  HumanInteractionOrigin,
  HumanInteractionPort,
  HumanInteractionReceipt,
  HumanInteractionReceiptPage,
  HumanInteractionReceiptPageInput,
  HumanInteractionReceiptProjection,
  HumanInteractionAdmission,
  HumanInteractionRecord,
  HumanInteractionRequest,
  HumanInteractionSource,
  HumanInteractionStatus,
  HumanInteractionTarget,
  PresentQuestionInput,
  RelayMemberQuestionInput,
} from './human/human-interaction-contract.js'

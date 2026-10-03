/**
 * handlers/index.ts
 *
 * Issue #173/#174: Handler module registry.
 * Re-exports the handler context, router, and all handler modules.
 */

export { type HandlerContext, type MessageHandler, type PlatformAdapter, withErrorHandling } from './handlerContext';
export { createMessageRouter } from './messageRouter';
export { registerNavigationHandlers } from './navigationHandlers';
export { registerGitDiffHandlers } from './gitDiffHandlers';
export { registerReplayHandlers } from './replayHandlers';
export { registerAiReviewHandlers } from './aiReviewHandlers';
export { registerCommentHandlers } from './commentHandlers';
export { registerToolHandlers } from './toolHandlers';
export {
    // Sidebar reveal helpers (used by VS Code commands in extension.ts)
    revealApiInSidebar,
    revealServiceInSidebar,
    revealClusterInSidebar,
    // Git diff context
    sendGitDiffContextToPanel,
    // File diagram
    buildFileGraphForPath,
    openFileDiagramForPath,
    openFileDiagramInPanel,
    // Flow graph
    buildFlowGraphForPath,
    openFunctionFlowForPath,
    openFunctionFlowInPanel,
    // Feature diagram
    buildFeatureGraphForService,
    openFeatureDiagram,
    openFeatureDiagramInPanel,
    // API list
    buildApiListGraph,
    buildApiListGraphForCluster,
    openApiListPanel,
    openApiListPanelInPanel,
    // Microservice diagram
    buildMicroserviceGraphCached,
    openMicroserviceDiagram,
    openMicroserviceDiagramInPanel,
    // Helpers
    servicePrefix,
} from './navigationHandlers';

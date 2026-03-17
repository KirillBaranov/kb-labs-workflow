import * as _kb_labs_perm_presets from '@kb-labs/perm-presets';

/**
 * KB Labs Mind Plugin - Manifest V3
 *
 * AI-powered code search and RAG system for semantic codebase understanding.
 *
 * Key features:
 * - Hybrid search (BM25 + vector embeddings)
 * - Agent-powered query orchestration
 * - Real-time incremental indexing
 * - Anti-hallucination verification
 */
declare const manifest: {
    schema: string;
    id: string;
    version: string;
    display: {
        name: string;
        description: string;
        tags: string[];
    };
    configSection: string;
    platform: {
        requires: string[];
        optional: string[];
    };
    permissions: _kb_labs_perm_presets.RuntimePermissionSpec;
    cli: {
        commands: {
            id: string;
            group: string;
            describe: string;
            handler: string;
            handlerPath: string;
        }[];
    };
    actions: {
        id: string;
        handler: string;
        schedule: string;
        description: string;
        enabled: boolean;
    }[];
    artifacts: {
        id: string;
        pathTemplate: string;
        description: string;
    }[];
};

export { manifest as default, manifest };

export { default as manifest } from './manifest.v3.js';
import { PlatformServices } from '@kb-labs/sdk';
import { MindConfigInput, MindConfig, MindSyncConfig } from '@kb-labs/mind-contracts';
import { MindIndexStats, MindIntent, MindQueryResult } from '@kb-labs/mind-types';
import { z } from 'zod';
export { default as runInitCommand } from './cli/commands/init.js';
export { default as runRagIndexCommand } from './cli/commands/rag-index.js';
export { default as runRagQueryCommand } from './cli/commands/rag-query.js';
export { default as runVerifyCommand } from './cli/commands/verify.js';
import '@kb-labs/perm-presets';
import '@kb-labs/shared-command-kit';

declare const MIND_PRODUCT_ID = "mind";
interface MindRuntimeService {
    index(scopeId: string): Promise<MindIndexStats>;
    query(options: {
        productId?: string;
        scopeId: string;
        text: string;
        intent?: MindIntent;
        limit?: number;
        profileId?: string;
        metadata?: Record<string, unknown>;
    }): Promise<MindQueryResult>;
}
interface MindRuntime {
    service: MindRuntimeService;
    config: MindConfigInput;
}
interface MindRuntimeOptions {
    cwd: string;
    config?: MindConfigInput | Record<string, unknown>;
    runtime?: {
        fetch?: typeof fetch;
        fs?: unknown;
        env?: (key: string) => string | undefined;
        log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
        analytics?: {
            track(event: string, properties?: Record<string, unknown>): void;
            metric(name: string, value: number, tags?: Record<string, string>): void;
        };
    };
    platform?: PlatformServices;
    onProgress?: (event: {
        stage: string;
        details?: string;
        metadata?: Record<string, unknown>;
        timestamp: number;
    }) => void;
}
declare function createMindRuntime(options: MindRuntimeOptions): Promise<MindRuntime>;

type AgentQueryMode = 'instant' | 'auto' | 'thinking';
type AgentResponse = Record<string, unknown>;
type AgentErrorResponse = {
    error: {
        code: string;
        message: string;
        recoverable: boolean;
    };
    meta: Record<string, unknown>;
};
interface RagIndexOptions {
    cwd: string;
    scopeId?: string;
    include?: string;
    exclude?: string;
    skipDeduplication?: boolean;
    platform?: PlatformServices;
    /**
     * Mind configuration (from ctx.config)
     * If provided, will be used instead of reading from file
     */
    config?: any;
}
/**
 * Information about which adapters were used during indexing
 */
interface AdapterInfo {
    vectorStore: string;
    embeddings: string;
    storage: string;
    llm: string;
    cache: string;
}
interface RagIndexStats extends MindIndexStats {
    deletedFiles?: number;
    deletedChunks?: number;
    invalidChunks?: number;
}
interface RagIndexResult {
    scopeIds: string[];
    adapters: AdapterInfo;
    stats: RagIndexStats;
}
interface RagIndexOptionsWithRuntime extends RagIndexOptions {
    runtime?: Parameters<typeof createMindRuntime>[0]['runtime'];
}
declare function runRagIndex(options: RagIndexOptions | RagIndexOptionsWithRuntime): Promise<RagIndexResult>;
interface RagQueryOptions {
    cwd: string;
    scopeId?: string;
    text: string;
    intent?: MindIntent;
    limit?: number;
    profileId?: string;
    runtime?: Parameters<typeof createMindRuntime>[0]['runtime'];
    onProgress?: (stage: string, details?: string) => void;
    platform?: PlatformServices;
    /**
     * Mind configuration (from ctx.config)
     * If provided, will be used instead of reading from file
     */
    config?: any;
}
interface RagQueryResult {
    scopeId: string;
    result: MindQueryResult;
}
declare function runRagQuery(options: RagQueryOptions): Promise<RagQueryResult>;
interface AgentRagQueryOptions {
    cwd: string;
    scopeId?: string;
    text: string;
    mode?: AgentQueryMode;
    indexRevision?: string;
    engineConfigHash?: string;
    sourcesDigest?: string;
    debug?: boolean;
    runtime?: Parameters<typeof createMindRuntime>[0]['runtime'];
    broker?: any;
    platform?: PlatformServices;
    /**
     * Mind configuration (from ctx.config)
     * If provided, will be used instead of reading from file
     */
    config?: any;
}
type AgentRagQueryResult = AgentResponse | AgentErrorResponse;
/**
 * Run agent-optimized RAG query with orchestration.
 *
 * This function uses the orchestrator pipeline:
 * 1. Detect query complexity
 * 2. Decompose into sub-queries (auto/thinking modes)
 * 3. Gather chunks from mind-engine
 * 4. Check completeness (with retry in thinking mode)
 * 5. Synthesize agent-friendly response
 * 6. Compress if needed
 *
 * @returns AgentResponse | AgentErrorResponse - clean JSON for agents
 */
declare function runAgentRagQuery(options: AgentRagQueryOptions): Promise<AgentRagQueryResult>;

/**
 * Extract Mind configuration from context
 * Provides type-safe access to mind config with validation
 */
declare function useConfig(ctx: {
    config?: any;
}): MindConfig;
/**
 * Try to extract Mind configuration from context
 * Returns null if config is not available or invalid
 */
declare function tryUseConfig(ctx: {
    config?: any;
}): MindConfig | null;
/**
 * Get sync configuration from mind config
 * Returns defaults if sync config is not provided
 */
declare function useSyncConfig(ctx: {
    config?: any;
}): MindSyncConfig;

/**
 * Analytics event types for Mind CLI
 * Centralized constants to prevent typos and enable type safety
 */
/**
 * Event type prefixes by command
 */
declare const ANALYTICS_PREFIX: {
    readonly QUERY: "mind.query";
    readonly FEED: "mind.feed";
    readonly UPDATE: "mind.update";
    readonly INIT: "mind.init";
    readonly PACK: "mind.pack";
    readonly VERIFY: "mind.verify";
};
/**
 * Event lifecycle suffixes
 */
declare const ANALYTICS_SUFFIX: {
    readonly STARTED: "started";
    readonly FINISHED: "finished";
};
/**
 * Mind analytics event types
 */
declare const ANALYTICS_EVENTS: {
    readonly QUERY_STARTED: "mind.query.started";
    readonly QUERY_FINISHED: "mind.query.finished";
    readonly FEED_STARTED: "mind.feed.started";
    readonly FEED_FINISHED: "mind.feed.finished";
    readonly UPDATE_STARTED: "mind.update.started";
    readonly UPDATE_FINISHED: "mind.update.finished";
    readonly INIT_STARTED: "mind.init.started";
    readonly INIT_FINISHED: "mind.init.finished";
    readonly PACK_STARTED: "mind.pack.started";
    readonly PACK_FINISHED: "mind.pack.finished";
    readonly VERIFY_STARTED: "mind.verify.started";
    readonly VERIFY_FINISHED: "mind.verify.finished";
};
/**
 * Type helper for analytics event types
 */
type AnalyticsEventType = typeof ANALYTICS_EVENTS[keyof typeof ANALYTICS_EVENTS];
/**
 * Actor configuration for Mind analytics
 */
declare const ANALYTICS_ACTOR: {
    readonly type: "agent";
    readonly id: "mind-cli";
};

/**
 * @module @kb-labs/mind-cli/cli/schemas
 * Input/Output schemas for CLI commands
 */

declare const InitInputSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    force: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    json: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    verbose: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    quiet: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    force: boolean;
    json: boolean;
    verbose: boolean;
    quiet: boolean;
    cwd?: string | undefined;
}, {
    cwd?: string | undefined;
    force?: boolean | undefined;
    json?: boolean | undefined;
    verbose?: boolean | undefined;
    quiet?: boolean | undefined;
}>;
type InitInput = z.infer<typeof InitInputSchema>;
declare const InitOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    mindDir: z.ZodString;
    cwd: z.ZodString;
}, "strip", z.ZodTypeAny, {
    cwd: string;
    ok: boolean;
    mindDir: string;
}, {
    cwd: string;
    ok: boolean;
    mindDir: string;
}>;
type InitOutput = z.infer<typeof InitOutputSchema>;
declare const UpdateInputSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    since: z.ZodOptional<z.ZodString>;
    timeBudget: z.ZodOptional<z.ZodNumber>;
    json: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    verbose: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    quiet: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    json: boolean;
    verbose: boolean;
    quiet: boolean;
    cwd?: string | undefined;
    since?: string | undefined;
    timeBudget?: number | undefined;
}, {
    cwd?: string | undefined;
    json?: boolean | undefined;
    verbose?: boolean | undefined;
    quiet?: boolean | undefined;
    since?: string | undefined;
    timeBudget?: number | undefined;
}>;
type UpdateInput = z.infer<typeof UpdateInputSchema>;
declare const UpdateOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    updated: z.ZodNumber;
    duration: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    ok: boolean;
    updated: number;
    duration: number;
}, {
    ok: boolean;
    updated: number;
    duration: number;
}>;
type UpdateOutput = z.infer<typeof UpdateOutputSchema>;
declare const PackInputSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    intent: z.ZodString;
    product: z.ZodOptional<z.ZodString>;
    preset: z.ZodOptional<z.ZodString>;
    budget: z.ZodOptional<z.ZodNumber>;
    withBundle: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    out: z.ZodOptional<z.ZodString>;
    seed: z.ZodOptional<z.ZodNumber>;
    json: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    verbose: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    quiet: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    json: boolean;
    verbose: boolean;
    quiet: boolean;
    intent: string;
    withBundle: boolean;
    cwd?: string | undefined;
    product?: string | undefined;
    preset?: string | undefined;
    budget?: number | undefined;
    out?: string | undefined;
    seed?: number | undefined;
}, {
    intent: string;
    cwd?: string | undefined;
    json?: boolean | undefined;
    verbose?: boolean | undefined;
    quiet?: boolean | undefined;
    product?: string | undefined;
    preset?: string | undefined;
    budget?: number | undefined;
    withBundle?: boolean | undefined;
    out?: string | undefined;
    seed?: number | undefined;
}>;
type PackInput = z.infer<typeof PackInputSchema>;
declare const PackOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    packPath: z.ZodString;
    size: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    ok: boolean;
    packPath: string;
    size: number;
}, {
    ok: boolean;
    packPath: string;
    size: number;
}>;
type PackOutput = z.infer<typeof PackOutputSchema>;
declare const FeedInputSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    intent: z.ZodOptional<z.ZodString>;
    product: z.ZodOptional<z.ZodString>;
    preset: z.ZodOptional<z.ZodString>;
    budget: z.ZodOptional<z.ZodNumber>;
    withBundle: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    since: z.ZodOptional<z.ZodString>;
    timeBudget: z.ZodOptional<z.ZodNumber>;
    noUpdate: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    out: z.ZodOptional<z.ZodString>;
    seed: z.ZodOptional<z.ZodNumber>;
    json: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    verbose: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    quiet: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    json: boolean;
    verbose: boolean;
    quiet: boolean;
    withBundle: boolean;
    noUpdate: boolean;
    cwd?: string | undefined;
    since?: string | undefined;
    timeBudget?: number | undefined;
    intent?: string | undefined;
    product?: string | undefined;
    preset?: string | undefined;
    budget?: number | undefined;
    out?: string | undefined;
    seed?: number | undefined;
}, {
    cwd?: string | undefined;
    json?: boolean | undefined;
    verbose?: boolean | undefined;
    quiet?: boolean | undefined;
    since?: string | undefined;
    timeBudget?: number | undefined;
    intent?: string | undefined;
    product?: string | undefined;
    preset?: string | undefined;
    budget?: number | undefined;
    withBundle?: boolean | undefined;
    out?: string | undefined;
    seed?: number | undefined;
    noUpdate?: boolean | undefined;
}>;
type FeedInput = z.infer<typeof FeedInputSchema>;
declare const FeedOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    packPath: z.ZodString;
    updated: z.ZodNumber;
    duration: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    ok: boolean;
    updated: number;
    duration: number;
    packPath: string;
}, {
    ok: boolean;
    updated: number;
    duration: number;
    packPath: string;
}>;
type FeedOutput = z.infer<typeof FeedOutputSchema>;
declare const QueryInputSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    query: z.ZodEnum<["impact", "scope", "exports", "externals", "chain", "meta", "docs"]>;
    file: z.ZodOptional<z.ZodString>;
    path: z.ZodOptional<z.ZodString>;
    scope: z.ZodOptional<z.ZodString>;
    product: z.ZodOptional<z.ZodString>;
    tag: z.ZodOptional<z.ZodString>;
    type: z.ZodOptional<z.ZodString>;
    filter: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    depth: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    cacheMode: z.ZodDefault<z.ZodOptional<z.ZodEnum<["ci", "local"]>>>;
    cacheTtl: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    noCache: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    paths: z.ZodDefault<z.ZodOptional<z.ZodEnum<["id", "absolute"]>>>;
    aiMode: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    toon: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    toonSidecar: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    json: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    compact: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    quiet: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    json: boolean;
    quiet: boolean;
    query: "scope" | "meta" | "impact" | "exports" | "externals" | "chain" | "docs";
    limit: number;
    depth: number;
    cacheMode: "ci" | "local";
    cacheTtl: number;
    noCache: boolean;
    paths: "id" | "absolute";
    aiMode: boolean;
    toon: boolean;
    toonSidecar: boolean;
    compact: boolean;
    scope?: string | undefined;
    cwd?: string | undefined;
    path?: string | undefined;
    type?: string | undefined;
    filter?: string | undefined;
    product?: string | undefined;
    file?: string | undefined;
    tag?: string | undefined;
}, {
    query: "scope" | "meta" | "impact" | "exports" | "externals" | "chain" | "docs";
    scope?: string | undefined;
    cwd?: string | undefined;
    json?: boolean | undefined;
    quiet?: boolean | undefined;
    path?: string | undefined;
    type?: string | undefined;
    filter?: string | undefined;
    product?: string | undefined;
    file?: string | undefined;
    tag?: string | undefined;
    limit?: number | undefined;
    depth?: number | undefined;
    cacheMode?: "ci" | "local" | undefined;
    cacheTtl?: number | undefined;
    noCache?: boolean | undefined;
    paths?: "id" | "absolute" | undefined;
    aiMode?: boolean | undefined;
    toon?: boolean | undefined;
    toonSidecar?: boolean | undefined;
    compact?: boolean | undefined;
}>;
type QueryInput = z.infer<typeof QueryInputSchema>;
declare const QueryOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    query: z.ZodString;
    result: z.ZodAny;
    toonPath: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    ok: boolean;
    query: string;
    result?: any;
    toonPath?: string | undefined;
}, {
    ok: boolean;
    query: string;
    result?: any;
    toonPath?: string | undefined;
}>;
type QueryOutput = z.infer<typeof QueryOutputSchema>;
declare const VerifyInputSchema: z.ZodObject<{
    cwd: z.ZodOptional<z.ZodString>;
    json: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    quiet: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    json: boolean;
    quiet: boolean;
    cwd?: string | undefined;
}, {
    cwd?: string | undefined;
    json?: boolean | undefined;
    quiet?: boolean | undefined;
}>;
type VerifyInput = z.infer<typeof VerifyInputSchema>;
declare const VerifyOutputSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    consistent: z.ZodBoolean;
    errors: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        message: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        message: string;
        file: string;
    }, {
        message: string;
        file: string;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    ok: boolean;
    consistent: boolean;
    errors: {
        message: string;
        file: string;
    }[];
}, {
    ok: boolean;
    consistent: boolean;
    errors: {
        message: string;
        file: string;
    }[];
}>;
type VerifyOutput = z.infer<typeof VerifyOutputSchema>;

declare const colors: {
    red: (text: string) => string;
    green: (text: string) => string;
    yellow: (text: string) => string;
    blue: (text: string) => string;
    cyan: (text: string) => string;
    gray: (text: string) => string;
    bold: (text: string) => string;
    dim: (text: string) => string;
};
declare const safeColors: {
    red: (text: string) => string;
    green: (text: string) => string;
    yellow: (text: string) => string;
    blue: (text: string) => string;
    cyan: (text: string) => string;
    gray: (text: string) => string;
    bold: (text: string) => string;
    dim: (text: string) => string;
};
declare const safeSymbols: {
    check: string;
    cross: string;
    arrow: string;
    bullet: string;
    info: string;
    warning: string;
    error: string;
};
declare class TimingTracker {
    private startTime;
    constructor();
    getElapsed(): number;
    getElapsedMs(): number;
}
declare function formatTiming(ms: number): string;
declare function box(textOrTitle: string, maybeLines?: string[] | string): string;
declare function keyValue(entries: Record<string, string | number>): string[];
declare function keyValue(key: string, value: string | number): string;
declare function createSpinner(text: string): {
    stop: (finalText?: string) => void;
};

export { ANALYTICS_ACTOR, ANALYTICS_EVENTS, ANALYTICS_PREFIX, ANALYTICS_SUFFIX, type AdapterInfo, type AgentRagQueryOptions, type AgentRagQueryResult, type AnalyticsEventType, type FeedInput, FeedInputSchema, type FeedOutput, FeedOutputSchema, type InitInput, InitInputSchema, type InitOutput, InitOutputSchema, MIND_PRODUCT_ID, type MindRuntime, type MindRuntimeOptions, type MindRuntimeService, type PackInput, PackInputSchema, type PackOutput, PackOutputSchema, type QueryInput, QueryInputSchema, type QueryOutput, QueryOutputSchema, type RagIndexOptions, type RagIndexOptionsWithRuntime, type RagIndexResult, type RagIndexStats, type RagQueryOptions, type RagQueryResult, TimingTracker, type UpdateInput, UpdateInputSchema, type UpdateOutput, UpdateOutputSchema, type VerifyInput, VerifyInputSchema, type VerifyOutput, VerifyOutputSchema, box, colors, createMindRuntime, createSpinner, formatTiming, keyValue, runAgentRagQuery, runRagIndex, runRagQuery, safeColors, safeSymbols, tryUseConfig, useConfig, useSyncConfig };

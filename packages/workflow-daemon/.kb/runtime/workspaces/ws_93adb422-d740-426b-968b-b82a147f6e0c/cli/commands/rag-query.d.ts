import * as _kb_labs_shared_command_kit from '@kb-labs/shared-command-kit';

/**
 * Mind rag-query command - semantic RAG search (V3)
 */
interface RagQueryInput {
    argv: string[];
    flags: {
        cwd?: string;
        scope?: string;
        text?: string;
        intent?: string;
        limit?: number;
        profile?: string;
        mode?: string;
        format?: string;
        json?: boolean;
        quiet?: boolean;
        agent?: boolean;
        debug?: boolean;
    };
}
declare const _default: _kb_labs_shared_command_kit.CommandHandlerV3<unknown, RagQueryInput, any>;

export { _default as default };

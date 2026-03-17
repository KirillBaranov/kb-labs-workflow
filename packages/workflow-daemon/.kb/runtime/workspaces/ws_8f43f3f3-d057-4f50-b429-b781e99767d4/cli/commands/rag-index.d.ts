import * as _kb_labs_shared_command_kit from '@kb-labs/shared-command-kit';

/**
 * Mind rag-index command - build Mind indexes (V3)
 */
interface RagIndexInput {
    argv: string[];
    flags: {
        cwd?: string;
        scope?: string;
        include?: string;
        exclude?: string;
        skipDeduplication?: boolean;
        json?: boolean;
        quiet?: boolean;
    };
}
declare const _default: _kb_labs_shared_command_kit.CommandHandlerV3<unknown, RagIndexInput, unknown>;

export { _default as default };

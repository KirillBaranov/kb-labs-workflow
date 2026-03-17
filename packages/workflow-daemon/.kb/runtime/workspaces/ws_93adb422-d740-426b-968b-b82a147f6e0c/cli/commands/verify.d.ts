import * as _kb_labs_shared_command_kit from '@kb-labs/shared-command-kit';

/**
 * Mind verify command - checks platform services readiness (V3)
 */
interface VerifyInput {
    argv: string[];
    flags: {
        json?: boolean;
        quiet?: boolean;
    };
}
declare const _default: _kb_labs_shared_command_kit.CommandHandlerV3<unknown, VerifyInput, unknown>;

export { _default as default };

import * as _kb_labs_shared_command_kit from '@kb-labs/shared-command-kit';

/**
 * Mind init command (V3)
 *
 * V3 Migration:
 * - Default export with defineCommand
 * - handler: { execute(ctx, input) }
 * - NO permissions (inherited from manifest)
 * - ctx.ui, ctx.logger, ctx.state (flat structure)
 */
interface InitInput {
    argv: string[];
    flags: {
        cwd?: string;
        force?: boolean;
        json?: boolean;
        verbose?: boolean;
        quiet?: boolean;
    };
}
declare const _default: _kb_labs_shared_command_kit.CommandHandlerV3<unknown, InitInput, unknown>;

export { _default as default };

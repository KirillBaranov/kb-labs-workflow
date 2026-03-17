import { defineCommand } from '@kb-labs/sdk';
import { initMindStructure } from '@kb-labs/mind-indexer';
import { join } from 'path';
import { promises } from 'fs';

// src/cli/commands/init.ts
var init_default = defineCommand({
  id: "mind:init",
  description: "Initialize mind workspace",
  // ❌ NO permissions here - they are in manifest.v3.ts!
  // Permissions are manifest-wide in V3
  handler: {
    async execute(ctx, input) {
      const startTime = Date.now();
      const { flags } = input;
      const cwd = flags.cwd || ctx.cwd;
      ctx.trace?.addEvent?.("mind.init.start", {
        cwd,
        command: "mind:init",
        force: flags.force
      });
      ctx.trace?.addEvent?.("mind.init.initializing", { cwd, force: flags.force });
      const mindDir = await initMindStructure({
        cwd,
        force: flags.force,
        log: (entry) => {
          if (!flags.quiet && !flags.json) {
            ctx.ui.info(`Init: ${entry.msg || entry}`);
          }
          ctx.trace?.addEvent?.("mind.init.step", { msg: entry.msg || entry });
        }
      });
      ctx.trace?.addEvent?.("mind.init.complete", {
        mindDir,
        cwd
      });
      const artifacts = [];
      const artifactPatterns = [
        { name: "Index", pattern: "index.json", description: "Main Mind index" },
        { name: "API Index", pattern: "api-index.json", description: "API index" },
        { name: "Dependencies", pattern: "deps.json", description: "Dependencies graph" },
        { name: "Recent Diff", pattern: "recent-diff.json", description: "Recent changes diff" }
      ];
      for (const { name, pattern, description } of artifactPatterns) {
        const artifactPath = join(mindDir, pattern);
        try {
          const stats = await promises.stat(artifactPath);
          artifacts.push({
            name,
            path: artifactPath,
            size: stats.size,
            modified: stats.mtime,
            description
          });
        } catch {
        }
      }
      ctx.trace?.addEvent?.("mind.init.artifacts", {
        mindDir,
        artifactsCount: artifacts.length
      });
      const timing = Date.now() - startTime;
      if (flags.json) {
        ctx.ui.info(JSON.stringify({
          ok: true,
          summary: {
            Workspace: mindDir,
            Status: "Initialized"
          },
          artifacts,
          timingMs: timing,
          data: {
            mindDir,
            cwd
          }
        }));
      } else if (!flags.quiet) {
        const artifactItems = [];
        for (const artifact of artifacts) {
          artifactItems.push(`\u2713 ${artifact.name}: ${artifact.description}`);
        }
        const sections = [
          {
            header: "Summary",
            items: [
              `Workspace: ${mindDir}`,
              `Status: Initialized`
            ]
          }
        ];
        if (artifacts.length > 0) {
          sections.push({
            header: "Created Artifacts",
            items: artifactItems
          });
        }
        ctx.ui.success("Mind workspace initialized", {
          title: "Mind Init",
          sections,
          timing
        });
      }
      return {
        exitCode: 0,
        mindDir,
        artifacts
      };
    }
  }
});

export { init_default as default };
//# sourceMappingURL=init.js.map
//# sourceMappingURL=init.js.map
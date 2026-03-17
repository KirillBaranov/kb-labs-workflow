import { defineCommand, usePlatform } from '@kb-labs/sdk';

// src/cli/commands/verify.ts
var verify_default = defineCommand({
  id: "mind:verify",
  description: "Check Mind platform services readiness",
  handler: {
    async execute(ctx, input) {
      const startTime = Date.now();
      const { flags } = input;
      ctx.trace?.addEvent?.("mind.verify.start", { command: "mind:verify" });
      const platform = usePlatform();
      const services = [];
      if (!platform) {
        const result2 = {
          exitCode: 1,
          ok: false,
          services,
          issues: ["platform context is missing"],
          meta: { timingMs: Date.now() - startTime }
        };
        if (flags.json) {
          ctx.ui.info(JSON.stringify(result2));
        } else {
          ctx.ui.error("Platform services are not available in this context");
        }
        ctx.trace?.addEvent?.("mind.verify.failed", { reason: "no-platform" });
        return result2;
      }
      const check = (name, required, available, configured, message) => {
        services.push({ service: name, required, available, configured, message });
      };
      const has = (key) => Boolean(platform[key]);
      const isConfigured = (svc) => platform.isConfigured?.(svc) ?? has(svc);
      check("vectorStore", true, has("vectorStore"), isConfigured("vectorStore"));
      check("embeddings", true, has("embeddings"), isConfigured("embeddings"));
      check("llm", false, has("llm"), isConfigured("llm"));
      check("cache", false, has("cache"), true);
      check("storage", false, has("storage"), true);
      check("analytics", false, has("analytics"), true);
      const requiredOk = services.filter((s) => s.required).every((s) => s.available && s.configured);
      const issues = services.filter((s) => s.required && (!s.available || !s.configured)).map((s) => `${s.service} is missing or not configured`);
      const timing = Date.now() - startTime;
      ctx.trace?.addEvent?.("mind.verify.complete", { ok: requiredOk, issues: issues.length });
      const result = {
        exitCode: requiredOk ? 0 : 1,
        ok: requiredOk,
        services,
        issues,
        meta: { timingMs: timing }
      };
      if (flags.json) {
        ctx.ui.info(JSON.stringify(result));
      } else if (!flags.quiet) {
        const sections = [
          {
            header: "Services",
            items: services.map((s) => {
              const status = s.available && s.configured ? "\u2713" : "\u26A0";
              return `${status} ${s.service}: ${s.available ? "available" : "missing"}${s.configured ? "" : " (not configured)"}`;
            })
          }
        ];
        if (issues.length) {
          sections.push({
            header: "Issues",
            items: issues.map((i) => `\u26A0 ${i}`)
          });
        }
        if (requiredOk) {
          ctx.ui.success("Mind platform services verified", {
            title: "Mind Verify - Platform",
            sections,
            timing
          });
        } else {
          ctx.ui.error("Mind platform services have issues");
          ctx.ui.success("Verification Details", {
            title: "Mind Verify - Platform",
            sections,
            timing
          });
        }
      }
      return result;
    }
  }
});

export { verify_default as default };
//# sourceMappingURL=verify.js.map
//# sourceMappingURL=verify.js.map
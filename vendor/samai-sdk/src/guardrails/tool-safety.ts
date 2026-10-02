import type { ToolGuardrail, ToolGuardrailContext } from "../types.js";

export interface DangerousToolGuardrailOptions {
  /** Tool names (or patterns) that are always blocked outright, e.g. "delete_database", /^shell_/. */
  blockedTools?: (string | RegExp)[];
  /** Called with the serialized args of every tool call; return a reason string to block, or undefined to allow. Use this to catch e.g. destructive flags regardless of which tool carries them. */
  isDangerous?: (ctx: ToolGuardrailContext) => string | undefined;
}

const DEFAULT_DANGEROUS_ARG_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bdrop\s+table\b/i,
  /\bdelete\s+from\b.*\bwhere\s+1\s*=\s*1\b/i,
  /\bsudo\b/i,
];

/**
 * A ready-to-use tool guardrail covering the common "prevent dangerous tool
 * calls" case: block specific tools by name, and/or block any call whose
 * arguments look destructive (shell wipes, unscoped SQL deletes, sudo, etc).
 *
 * This is a starting point, not exhaustive — for anything safety-critical,
 * prefer `requiresApproval` on the tool itself (human sign-off) over pattern
 * matching alone.
 */
export function createDangerousToolGuardrail(options: DangerousToolGuardrailOptions = {}): ToolGuardrail {
  const blockedTools = options.blockedTools ?? [];

  return (ctx: ToolGuardrailContext) => {
    for (const pattern of blockedTools) {
      const matches = typeof pattern === "string" ? ctx.toolName === pattern : pattern.test(ctx.toolName);
      if (matches) {
        return { allowed: false, reason: `tool "${ctx.toolName}" is on the blocked-tools list` };
      }
    }

    if (options.isDangerous) {
      const reason = options.isDangerous(ctx);
      if (reason) return { allowed: false, reason };
    }

    const serializedArgs = JSON.stringify(ctx.args ?? {});
    for (const pattern of DEFAULT_DANGEROUS_ARG_PATTERNS) {
      if (pattern.test(serializedArgs)) {
        return { allowed: false, reason: `arguments matched a known-destructive pattern (${pattern})` };
      }
    }

    return { allowed: true };
  };
}

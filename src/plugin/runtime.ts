// ---------------------------------------------------------------------------
// src/plugin/runtime.ts — Hook assembly for the plugin runtime.
//
// Builds the opencode hook record from the handler adapters in
// `./hooks.ts`, the delegate tool from `./delegate.ts`, and the command
// dispatcher from `../router/commands`. Each handler is wired with the
// live `PluginContext` and, where the original closure captured them,
// the load-time `activeTiersAtLoad` snapshot.
//
// This module owns no state — it is a pure factory that returns a fresh
// hooks object for each plugin instance.
//
// Phase 3 of the core-refactor-plan replaces the prior `(input: any,
// output: any)` hook callbacks with the SDK's `Hooks` shape from
// `@opencode-ai/plugin`. Each adapter still receives the same payload
// values it always did — the change is purely types-only and behaviour is
// preserved (the bodies in `src/plugin/hooks.ts` keep using optional
// chaining, so they tolerate the SDK's full input shape just as they
// tolerated the loose `any` shape).
// ---------------------------------------------------------------------------

import { tool, type Hooks } from "@opencode-ai/plugin";

import { handleCommandBefore } from "../router/commands";
import type { Preset } from "../router/config";
import { executeDelegate } from "./delegate";
import type { DelegateArgs } from "./types";
import {
  handleChatMessage,
  handleChatParams,
  handleConfig,
  handleSessionIdle,
  handleSystemTransform,
  handleTextComplete,
  handleToolExecuteAfter,
  handleToolExecuteBefore,
} from "./hooks";
import type { PluginContext } from "./context";

const DELEGATE_DESCRIPTION =
  "Delegate a task to a tier subagent (fast | medium | heavy). The subagent's result is INDEPENDENTLY VERIFIED (deterministic checks, or an independent grader at >= the producer tier in a fresh session) before it is returned. Returns an accepted result on PASS, or an honest 'unmet' status on FAIL — never a self-reported completion. Optionally pass an [acceptance]...[/acceptance] block to define the Definition of Done.";

/**
 * Build the hook record for one plugin instance. `enableDelegateTool`
 * preserves the pre-refactor gating: the delegate tool only ships when
 * the experimental config flag is set OR `MODEL_ROUTER_VERIFIED_DELEGATE=1`.
 */
export function assembleRuntimeHooks(
  ctx: PluginContext,
  activeTiersAtLoad: Preset,
  enableDelegateTool: boolean,
): Hooks {
  return {
    tool: {
      ...(enableDelegateTool
        ? {
            delegate: tool({
              description: DELEGATE_DESCRIPTION,
              args: {
                task: tool.schema
                  .string()
                  .describe("The task for the subagent to perform."),
                tier: tool.schema
                  .string()
                  .optional()
                  .describe(
                    "fast | medium | heavy. Defaults to the router default tier.",
                  ),
                acceptance: tool.schema
                  .string()
                  .optional()
                  .describe(
                    "Optional [acceptance]...[/acceptance] block defining the Definition of Done (check: / criteria: / deliverable: directives).",
                  ),
              },
              async execute(args: DelegateArgs): Promise<string> {
                return executeDelegate(ctx, args);
              },
            }),
          }
        : {}),
    },

    // Each callback keeps the SDK's narrow shape and casts down to the
    // handler's local shape only at the call site. The casts are
    // values-preserving (no `any`), so behaviour is unchanged.
    "chat.params": (input, output) =>
      handleChatParams(ctx, input as unknown as Parameters<typeof handleChatParams>[1], output as unknown as Parameters<typeof handleChatParams>[2]),

    "chat.message": (input, output) =>
      handleChatMessage(ctx, input as unknown as Parameters<typeof handleChatMessage>[1], output as unknown as Parameters<typeof handleChatMessage>[2]),

    "tool.execute.before": (input, output) =>
      handleToolExecuteBefore(ctx, input as unknown as Parameters<typeof handleToolExecuteBefore>[1], output as unknown as Parameters<typeof handleToolExecuteBefore>[2]),

    "tool.execute.after": (input, output) =>
      handleToolExecuteAfter(ctx, input as unknown as Parameters<typeof handleToolExecuteAfter>[1], output as unknown as Parameters<typeof handleToolExecuteAfter>[2]),

    "experimental.text.complete": (input, output) =>
      handleTextComplete(ctx, input as unknown as Parameters<typeof handleTextComplete>[1], output as unknown as Parameters<typeof handleTextComplete>[2]),

    event: (payload) =>
      handleSessionIdle(ctx, payload as unknown as Parameters<typeof handleSessionIdle>[1]),

    config: (opencodeConfig) =>
      handleConfig(ctx, activeTiersAtLoad, opencodeConfig as unknown as Parameters<typeof handleConfig>[2]),

    "experimental.chat.system.transform": (input, output) =>
      handleSystemTransform(ctx, input as unknown as Parameters<typeof handleSystemTransform>[1], output as unknown as Parameters<typeof handleSystemTransform>[2]),

    "command.execute.before": (input, output) =>
      handleCommandBefore(ctx, input as unknown as Parameters<typeof handleCommandBefore>[1], output as unknown as Parameters<typeof handleCommandBefore>[2]),
  };
}

/**
 * WebMCP: exposes the agent tools to the browser's own agent through `navigator.modelContext`.
 * A Chrome preview; the shape followed here is the WebMCP explainer's (`registerTool`, else
 * `provideContext`), and does nothing where the API is absent.
 */

import { agentTools, PdfAgentSession } from './tools.js';

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
  execute(input: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;
}

interface ModelContext {
  registerTool?(tool: WebMcpTool): { unregister(): void } | void;
  unregisterTool?(name: string): void;
  provideContext?(context: { tools: WebMcpTool[] }): void;
  clearContext?(): void;
}

/**
 * Registers the tools for `session`'s document. Returns a function that removes them, or `null`
 * when the browser has no WebMCP.
 */
export function registerWebMcpTools(session: PdfAgentSession): (() => void) | null {
  const context = (globalThis.navigator as { modelContext?: ModelContext } | undefined)?.modelContext;
  if (!context || (!context.registerTool && !context.provideContext)) return null;

  const tools: WebMcpTool[] = agentTools.map((tool) => ({
    name: `pdf_${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: tool.readOnly },
    async execute(input) {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await tool.run(session, input ?? {})) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  }));

  if (context.registerTool) {
    const handles = tools.map((tool) => context.registerTool!(tool));
    return () => handles.forEach((handle, i) => {
      if (handle && typeof handle.unregister === 'function') handle.unregister();
      else context.unregisterTool?.(tools[i]!.name);
    });
  }
  context.provideContext!({ tools });
  return () => context.clearContext?.();
}

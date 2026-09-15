/**
 * WebMCP: exposes the agent tools to the browser's own agent. Checked against Chrome 152, where it
 * sits behind `--enable-blink-features=WebMCP`: `document.modelContext.registerTool(tool, { signal })`,
 * removed by aborting the signal, with each result serialised as JSON. The explainer's
 * `navigator.modelContext` shape is also accepted. Does nothing where neither exists.
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
  registerTool?(tool: WebMcpTool, options?: { signal?: AbortSignal }): unknown;
  unregisterTool?(name: string): void;
  provideContext?(context: { tools: WebMcpTool[] }): void;
  clearContext?(): void;
}

/**
 * Registers the tools for `session`'s document. Returns a function that removes them, or `null`
 * when the browser has no WebMCP.
 */
export function registerWebMcpTools(session: PdfAgentSession): (() => void) | null {
  const context = (globalThis.document as { modelContext?: ModelContext } | undefined)?.modelContext
    ?? (globalThis.navigator as { modelContext?: ModelContext } | undefined)?.modelContext;
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
    const controller = new AbortController();
    const handles = tools.map((tool) => {
      const handle = context.registerTool!(tool, { signal: controller.signal });
      // Chrome returns a promise, which rejects if a tool of that name is already registered.
      if (handle instanceof Promise) handle.catch(() => undefined);
      return handle;
    });
    return () => {
      controller.abort();
      handles.forEach((handle, i) => {
        if (handle && typeof (handle as { unregister?: unknown }).unregister === 'function') (handle as { unregister(): void }).unregister();
        else context.unregisterTool?.(tools[i]!.name);
      });
    };
  }
  context.provideContext!({ tools });
  return () => context.clearContext?.();
}

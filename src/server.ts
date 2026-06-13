#!/usr/bin/env node
// Provena MCP server — exposes provenance query + declared-citation tools.
//
// Capture happens out-of-band via hooks (see hook.ts); this server is the
// read/query surface plus the one write path that needs the model's input:
// declaring a citation as it writes.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, dbPath } from "./store.ts";

const server = new McpServer({ name: "provena", version: "0.1.0" });

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

server.registerTool(
  "provena_status",
  {
    description:
      "Show how much provenance has been captured in this project (sources the model saw, artifact versions it produced, and computed links).",
    inputSchema: {},
  },
  async () => {
    const store = new Store(dbPath());
    const c = store.counts();
    store.close();
    return text(
      `Provena graph: ${c.sources} sources · ${c.artifacts} artifact versions · ${c.links} provenance links.`,
    );
  },
);

server.registerTool(
  "provena_sources",
  {
    description:
      "List the sources captured for the current session (files read, pages fetched, tool results, user instructions). Optionally filter by session id.",
    inputSchema: { session_id: z.string().optional() },
  },
  async ({ session_id }) => {
    const store = new Store(dbPath());
    const rows = session_id
      ? store.sourcesForSession(session_id)
      : store.allSources();
    store.close();
    if (!rows.length) return text("No sources captured yet.");
    const lines = rows.map(
      (s) =>
        `[${s.type}] ${s.uri} — "${s.content.replace(/\s+/g, " ").slice(0, 80)}..."`,
    );
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "provena_cite",
  {
    description:
      "Declare that a line range of a file you just wrote derives from a specific source. Use this as you generate code/docs to record provenance explicitly. The source_uri should match a captured source (a file path, URL, or 'user').",
    inputSchema: {
      path: z.string().describe("artifact file path"),
      start_line: z.number().int().positive(),
      end_line: z.number().int().positive(),
      source_uri: z.string().describe("uri of the source it derives from"),
      evidence: z
        .string()
        .optional()
        .describe("the supporting snippet from the source"),
      session_id: z.string().optional(),
    },
  },
  async ({ path, start_line, end_line, source_uri, evidence, session_id }) => {
    const store = new Store(dbPath());
    const r = store.addDeclaredCitation({
      path,
      startLine: start_line,
      endLine: end_line,
      sourceUri: source_uri,
      evidence,
      sessionId: session_id ?? "unknown",
    });
    store.close();
    return text(
      r.ok
        ? `Recorded: ${path}:${start_line}-${end_line} <- ${source_uri}${r.reason ? ` (${r.reason})` : ""}`
        : `Could not record citation: ${r.reason}`,
    );
  },
);

server.registerTool(
  "provena_why",
  {
    description:
      "Explain where a specific line of a generated file came from: the source(s) it was attributed to, the method, and confidence. Returns 'ungrounded' if no source backs that line.",
    inputSchema: {
      path: z.string(),
      line: z.number().int().positive(),
    },
  },
  async ({ path, line }) => {
    const store = new Store(dbPath());
    const { artifact, links } = store.whyLine(path, line);
    store.close();
    if (!artifact) return text(`No captured artifact for ${path}.`);
    if (!links.length)
      return text(
        `${path}:${line} — no provenance link yet. Either ungrounded (model knowledge) or attribution hasn't been run. (Embedding attribution = Phase 2.)`,
      );
    const out = links
      .map(
        (l: any) =>
          `← ${l.source_uri ?? "(unnamed source)"} [${l.source_type ?? "?"}] ` +
          `via ${l.method} (conf ${l.confidence.toFixed(2)})` +
          (l.evidence_quote ? `\n    evidence: "${l.evidence_quote}"` : ""),
      )
      .join("\n");
    return text(`${path}:${line} (artifact v${artifact.version})\n${out}`);
  },
);

server.registerTool(
  "provena_audit",
  {
    description:
      "Attribute a generated file against everything the model saw, then report coverage: which line ranges are grounded in a source, which are uncertain, and which are ungrounded (model knowledge to verify). Runs the embedding engine + LLM judge (if GEMINI_API_KEY or ANTHROPIC_API_KEY is set).",
    inputSchema: { path: z.string() },
  },
  async ({ path }) => {
    const { attribute, auditReport } = await import("./attribute.ts");
    const { judgeAvailable } = await import("./judge.ts");
    const store = new Store(dbPath());
    const out = await attribute(store, path, { useJudge: judgeAvailable() });
    store.close();
    if (!out) return text(`No captured artifact for ${path}.`);
    return text(auditReport(path, out.results));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

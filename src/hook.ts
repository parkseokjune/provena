// Capture hook — invoked by Claude Code's PostToolUse / UserPromptSubmit hooks.
//
// Claude Code pipes a JSON event on stdin. We translate the tools the model used
// into provenance records: things it READ become `source` rows; things it WROTE
// become `artifact` snapshots. This is the layer that lets us reconstruct "what
// the model saw" without any cooperation from the model itself.

import { readFileSync } from "node:fs";
import { Store } from "./store.ts";

interface HookEvent {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string; // UserPromptSubmit
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // if nothing is piped, don't hang forever
    setTimeout(() => resolve(data), 2000).unref?.();
  });
}

function asText(x: unknown): string {
  if (x == null) return "";
  if (typeof x === "string") return x;
  // tool_response shapes vary; pull the obvious text fields, else stringify.
  if (typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of ["content", "text", "result", "stdout", "output"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
  }
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function nowISO(): string {
  // hooks run as a real process, so Date is available here (unlike workflow scripts)
  return new Date().toISOString();
}

export async function runHook(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) return;
  let ev: HookEvent;
  try {
    ev = JSON.parse(raw);
  } catch {
    return; // malformed event — never break the user's session
  }

  const sessionId = ev.session_id ?? "unknown";
  const store = new Store();
  try {
    // --- user instruction -> source --------------------------------------
    if (ev.hook_event_name === "UserPromptSubmit" && ev.prompt) {
      store.addSource({
        uri: "user",
        type: "user_msg",
        content: ev.prompt,
        capturedAt: nowISO(),
        sessionId,
      });
      return;
    }

    const tool = ev.tool_name ?? "";
    const input = ev.tool_input ?? {};

    // --- writes -> artifact snapshot --------------------------------------
    if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") {
      const path = (input.file_path as string) ?? (input.path as string);
      if (!path) return;
      let content = (input.content as string) ?? "";
      try {
        content = readFileSync(path, "utf8"); // post-edit truth from disk
      } catch {
        /* fall back to tool_input.content */
      }
      if (!content) return;
      store.addArtifact({
        path,
        content,
        createdAt: nowISO(),
        generator: "claude-code",
        sessionId,
      });
      return;
    }

    // --- reads / fetches / tool output -> source --------------------------
    if (tool === "Read") {
      const path = input.file_path as string;
      const content = asText(ev.tool_response);
      if (path && content)
        store.addSource({
          uri: path,
          type: "file",
          content,
          capturedAt: nowISO(),
          sessionId,
        });
      return;
    }
    if (tool === "WebFetch") {
      const url = (input.url as string) ?? "web";
      const content = asText(ev.tool_response);
      if (content)
        store.addSource({
          uri: url,
          type: "web",
          content,
          capturedAt: nowISO(),
          sessionId,
        });
      return;
    }
    if (tool === "Grep" || tool === "Glob" || tool.startsWith("mcp__")) {
      const content = asText(ev.tool_response);
      if (content && content.length > 20)
        store.addSource({
          uri: `${tool}:${(input.pattern as string) ?? ""}`.slice(0, 200),
          type: "tool_result",
          content,
          capturedAt: nowISO(),
          sessionId,
        });
      return;
    }
  } finally {
    store.close();
  }
}

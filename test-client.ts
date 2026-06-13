// Smoke test: spin up the Provena MCP server and exercise its tools as a real
// MCP client would, against the captured test graph.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const SERVER = resolve(import.meta.dirname, "src/server.ts");

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, PROVENA_DB: "/tmp/provena-test/.provena/provenance.db" },
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  console.log(`\n>>> ${name}(${JSON.stringify(args)})`);
  console.log(r.content.map((c: any) => c.text).join("\n"));
};

await call("provena_status", {});
await call("provena_cite", {
  path: "/tmp/provena-test/auth.ts",
  start_line: 1,
  end_line: 4,
  source_uri: "/tmp/provena-test/spec.md",
  evidence: "stored hashed with HMAC-SHA256 and expire after 30 days",
  session_id: "s1",
});
await call("provena_why", { path: "/tmp/provena-test/auth.ts", line: 2 });
await call("provena_why", { path: "/tmp/provena-test/auth.ts", line: 99 });

await client.close();

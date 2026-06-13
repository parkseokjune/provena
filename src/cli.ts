#!/usr/bin/env node
// Provena CLI.
//   provena init      configure Claude Code hooks + register the MCP server
//   provena hook      (internal) consume a hook event on stdin
//   provena status    show what's been captured
//   provena sources   list captured sources
//   provena reset     wipe the local provenance graph

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, dbPath } from "./store.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "server.ts");
const CLI = resolve(HERE, "cli.ts");

// tools whose use we want to capture as provenance
const CAPTURE_MATCHER = "Write|Edit|MultiEdit|Read|WebFetch|Grep|Glob";

function readJSON(path: string): any {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function init(cwd: string) {
  const claudeDir = join(cwd, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // 1. hooks in .claude/settings.json (merge, don't clobber) ----------------
  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJSON(settingsPath);
  settings.hooks ??= {};
  const hookCmd = { type: "command", command: `node ${CLI} hook` };

  const ensureHook = (event: string, matcher?: string) => {
    settings.hooks[event] ??= [];
    const arr = settings.hooks[event] as any[];
    const already = JSON.stringify(arr).includes(`${CLI} hook`);
    if (already) return;
    arr.push(matcher ? { matcher, hooks: [hookCmd] } : { hooks: [hookCmd] });
  };
  ensureHook("PostToolUse", CAPTURE_MATCHER);
  ensureHook("UserPromptSubmit");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // 2. register the MCP server in .mcp.json ---------------------------------
  const mcpPath = join(cwd, ".mcp.json");
  const mcp = readJSON(mcpPath);
  mcp.mcpServers ??= {};
  mcp.mcpServers.provena = { command: "node", args: [SERVER] };
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");

  console.log("Provena initialized in", cwd);
  console.log("  • capture hooks  -> .claude/settings.json");
  console.log("  • MCP server     -> .mcp.json  (tools: provena_*)");
  console.log("  • provenance DB  ->", dbPath(cwd));
  console.log(
    "\nRestart Claude Code (or run `claude` here) so it picks up the hooks + MCP server.",
  );
}

function status(cwd: string) {
  const store = new Store(dbPath(cwd));
  const c = store.counts();
  store.close();
  console.log("Provena status —", dbPath(cwd));
  console.log(`  sources captured : ${c.sources}`);
  console.log(`  artifact versions: ${c.artifacts}`);
  console.log(`  provenance links : ${c.links}`);
}

function sources(cwd: string) {
  const store = new Store(dbPath(cwd));
  const rows = store.allSources();
  store.close();
  if (!rows.length) return console.log("No sources captured yet.");
  for (const s of rows) {
    const preview = s.content.replace(/\s+/g, " ").slice(0, 60);
    console.log(`[${s.type}] ${s.uri}`);
    console.log(`    ${s.captured_at}  "${preview}..."`);
  }
}

function reset(cwd: string) {
  const dir = join(cwd, ".provena");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  console.log("Provenance graph wiped:", dir);
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const cwd = process.cwd();
  switch (cmd) {
    case "init":
      return init(cwd);
    case "hook": {
      const { runHook } = await import("./hook.ts");
      return runHook();
    }
    case "status":
      return status(cwd);
    case "sources":
      return sources(cwd);
    case "audit":
    case "attribute": {
      const path = process.argv[3];
      if (!path) return console.error("usage: provena audit <file>");
      const { attribute, auditReport } = await import("./attribute.ts");
      const { judgeAvailable, judgeProvider } = await import("./judge.ts");
      const store = new Store(dbPath(cwd));
      const useJudge = judgeAvailable();
      const out = await attribute(store, path, { useJudge });
      store.close();
      if (!out) return console.error(`No captured artifact for ${path}. Has Claude written it with Provena's hooks active?`);
      console.log(auditReport(path, out.results));
      console.log(
        useJudge
          ? `\n(LLM judge: ON — ${judgeProvider()})`
          : "\n(LLM judge: OFF — set GEMINI_API_KEY or ANTHROPIC_API_KEY for borderline adjudication)",
      );
      return;
    }
    case "gate": {
      // CI gate: fail the build if any file's ungrounded ratio exceeds a budget.
      const args = process.argv.slice(3);
      const maxIdx = args.indexOf("--max-ungrounded");
      const maxUngrounded = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 30;
      const files = args.filter((a, i) => !a.startsWith("--") && i !== maxIdx + 1);
      if (!files.length) return console.error("usage: provena gate <file...> [--max-ungrounded <pct>]");
      const { attribute } = await import("./attribute.ts");
      const { judgeAvailable } = await import("./judge.ts");
      const store = new Store(dbPath(cwd));
      const useJudge = judgeAvailable();
      let failed = false;
      for (const f of files) {
        const out = await attribute(store, f, { useJudge });
        if (!out) {
          console.log(`? ${f}: no captured artifact (skipped)`);
          continue;
        }
        const n = out.results.length || 1;
        const ung = out.results.filter((r) => r.status === "ungrounded").length;
        const unc = out.results.filter((r) => r.status === "uncertain").length;
        const ungPct = (ung / n) * 100;
        const bad = ungPct > maxUngrounded;
        if (bad) failed = true;
        console.log(
          `${bad ? "✗" : "✓"} ${f}: ${ungPct.toFixed(0)}% ungrounded` +
            (unc ? `, ${((unc / n) * 100).toFixed(0)}% uncertain` : "") +
            ` (budget ${maxUngrounded}%)`,
        );
      }
      store.close();
      if (failed) {
        console.error(`\nProvena gate FAILED: ungrounded ratio over budget. Verify the flagged code or cite its sources.`);
        process.exit(1);
      }
      console.log("\nProvena gate passed.");
      return;
    }
    case "reset":
      return reset(cwd);
    default:
      console.log(
        "provena <init|status|sources|audit|reset>\n" +
          "  init          wire up Claude Code hooks + MCP server in this project\n" +
          "  status        counts of captured sources/artifacts/links\n" +
          "  sources       list captured sources\n" +
          "  audit <file>  attribute a generated file and print its coverage report\n" +
          "  gate <file...> [--max-ungrounded <pct>]  CI gate: fail if too much ungrounded code\n" +
          "  reset         wipe the local provenance graph",
      );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PiJjRuntime } from "./runtime";

export function registerEvents(pi: ExtensionAPI, runtime: PiJjRuntime) {
  pi.on("session_start", async (_event, ctx) => {
    await runtime.handleSessionStart(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await runtime.handleSessionSwitch(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await runtime.handleBeforeAgentStart(ctx);
  });

  pi.on("turn_start", async (event) => {
    await runtime.handleTurnStart(event);
  });

  pi.on("turn_end", async (event, ctx) => {
    await runtime.handleTurnEnd(event, ctx);
  });

  pi.on("session_before_fork", async (event, ctx) => {
    return runtime.handleSessionBeforeFork(event, ctx);
  });

  pi.on("session_before_tree", async (event, ctx) => {
    return runtime.handleSessionBeforeTree(event, ctx);
  });
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCommands } from "./commands";
import { registerEvents } from "./events";
import { PiJjRuntime } from "./runtime";

export default function (pi: ExtensionAPI) {
  const runtime = new PiJjRuntime(pi);
  registerEvents(pi, runtime);
  registerCommands(pi, runtime);
}

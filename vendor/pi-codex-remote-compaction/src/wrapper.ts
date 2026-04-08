import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { sessionKey, synthesizedWrapperCache } from "./state.js";
import { isRecord } from "./utils.js";

export function splitDeveloperAndUserContext(content: unknown) {
  if (typeof content !== "string") return {} as { developerPrefix?: string; userWrapper?: string };
  const marker = "# AGENTS.md instructions";
  const idx = content.indexOf(marker);
  if (idx === -1) return { developerPrefix: content };
  return {
    developerPrefix: content.slice(0, idx).trimEnd(),
    userWrapper: content.slice(idx).trim(),
  };
}

export function ensureUserWrapper(prefixInput: unknown[] | undefined, synthesizedWrapper: unknown[]) {
  const prefix = prefixInput ? [...prefixInput] : [];
  const hasUserWrapper = prefix.some((item) => isRecord(item) && item.role === "user");
  if (!hasUserWrapper && synthesizedWrapper.length > 0) {
    prefix.push(...synthesizedWrapper);
  }
  return prefix;
}

async function readFirstInstructionFile(ctx: ExtensionContext) {
  const candidates = [path.join(ctx.cwd, "AGENTS.md"), path.join(ctx.cwd, "CLAUDE.md")];
  for (const file of candidates) {
    try {
      const content = (await fs.readFile(file, "utf8")).trim();
      if (content) return { file, content };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return undefined;
}

export async function buildSynthesizedUserWrapper(ctx: ExtensionContext) {
  const key = sessionKey(ctx);
  if (synthesizedWrapperCache.has(key)) return synthesizedWrapperCache.get(key)!;
  const instructionFile = await readFirstInstructionFile(ctx);
  if (!instructionFile) {
    synthesizedWrapperCache.set(key, []);
    return [];
  }
  const shell = path.basename(process.env.SHELL || "bash");
  const currentDate = new Date().toISOString().slice(0, 10);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const text = `# ${path.basename(instructionFile.file)} instructions for ${ctx.cwd}\n\n<INSTRUCTIONS>\n${instructionFile.content}\n</INSTRUCTIONS>\n\n<environment_context>\n  <cwd>${ctx.cwd}</cwd>\n  <shell>${shell}</shell>\n  <current_date>${currentDate}</current_date>\n  <timezone>${timezone}</timezone>\n</environment_context>`;
  const wrapper = [{ type: "message", role: "user", status: "completed", content: [{ type: "input_text", text }] }];
  synthesizedWrapperCache.set(key, wrapper);
  return wrapper;
}

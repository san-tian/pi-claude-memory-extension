import fs from "node:fs/promises";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runDream, shouldAutoDream } from "./dream.js";
import { runExtraction } from "./extract.js";
import { ensureMemoryStore, scanProjectTopicHeaders, scanTopicHeaders, scanUserTopicHeaders } from "./memory-store.js";
import { buildMemoryIndexMessage, buildMemorySystemPrompt } from "./prompts.js";
import { getProjectMemoryPaths, getUserMemoryPaths } from "./paths.js";
import { buildRelevantMemoryMessage } from "./recall.js";
import { REPORT_MESSAGE_TYPE, clearState, getState, reconstructState } from "./state.js";
import { isClaudeMemorySubagentProcess } from "./subagent.js";
import { DEFAULT_MEMORY_CONFIG } from "./types.js";

const INDEX_PREVIEW_CHARS = 4000;

export default function claudeMemoryExtension(pi: ExtensionAPI) {
  const rebuild = async (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) => {
    reconstructState(ctx);
    await ensureMemoryStore(ctx.cwd);
  };

  pi.on("session_start", async (_event, ctx) => rebuild(ctx));
  pi.on("session_tree", async (_event, ctx) => rebuild(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    clearState(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (isClaudeMemorySubagentProcess()) {
      return;
    }

    const projectPaths = getProjectMemoryPaths(ctx.cwd);
    const userPaths = getUserMemoryPaths();
    await ensureMemoryStore(ctx.cwd);
    const systemPrompt = `${event.systemPrompt}\n\n${buildMemorySystemPrompt(projectPaths.rootDir, userPaths.rootDir, DEFAULT_MEMORY_CONFIG)}`;
    const recall = await buildRelevantMemoryMessage(pi, ctx, event.prompt);
    if (recall.message) {
      return {
        systemPrompt,
        message: recall.message,
      };
    }

    const preview = await readPreview(projectPaths.indexPath);
    if (!preview) {
      return { systemPrompt };
    }
    return {
      systemPrompt,
      message: {
        customType: "claude-memory-index",
        content: buildMemoryIndexMessage(projectPaths.indexPath, preview),
        display: false,
      },
    };
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (isClaudeMemorySubagentProcess()) {
      return;
    }
    const extraction = await runExtraction(pi, ctx, "auto");
    if (extraction.ok && ctx.hasUI) {
      ctx.ui.setStatus("claude-memory", `Memory extracted (${extraction.headers?.length ?? 0} topics)`);
    }

    if (!shouldAutoDream(ctx)) {
      return;
    }
    const dream = await runDream(pi, ctx, "auto");
    if (dream.ok && ctx.hasUI) {
      ctx.ui.setStatus("claude-memory", `Memory dreamed (${dream.headers?.length ?? 0} topics)`);
    }
  });

  pi.registerCommand("memory-status", {
    description: "Show persistent memory paths and current Claude-memory state",
    handler: async (_args, ctx) => {
      await ensureMemoryStore(ctx.cwd);
      const projectPaths = getProjectMemoryPaths(ctx.cwd);
      const userPaths = getUserMemoryPaths();
      const state = getState(ctx);
      const [projectHeaders, userHeaders, headers] = await Promise.all([
        scanProjectTopicHeaders(ctx.cwd),
        scanUserTopicHeaders(),
        scanTopicHeaders(ctx.cwd),
      ]);
      const statusLines = [
        `- Project root: ${projectPaths.rootDir}`,
        `- Project index: ${projectPaths.indexPath}`,
        `- Project topics: ${projectPaths.topicsDir}`,
        `- Project manifest: ${projectPaths.manifestPath}`,
        `- Global user root: ${userPaths.rootDir}`,
        `- Global user index: ${userPaths.indexPath}`,
        `- Global user topics: ${userPaths.topicsDir}`,
        `- Recall debug: ${projectPaths.recallDebugPath}`,
        `- Dream log dir: ${projectPaths.dreamLogDir}`,
        `- Project topic count: ${projectHeaders.length}`,
        `- Global user topic count: ${userHeaders.length}`,
        `- Total managed topic count: ${headers.length}`,
        `- Initialized: ${state.initialized}`,
        `- Extraction count: ${state.extractionCount}`,
        `- Tokens at last extraction: ${state.tokensAtLastExtraction}`,
        `- Last trigger entry: ${state.lastTriggerEntryId ?? "(none)"}`,
        `- Last summarized entry: ${state.lastSummarizedEntryId ?? "(none)"}`,
        `- Last dream entry: ${state.lastDreamEntryId ?? "(none)"}`,
        `- Last dream at: ${state.lastDreamAt ?? "(never)"}`,
        `- Last recall topics: ${state.lastRecallTopicIds?.join(", ") || "(none)"}`,
      ];

      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Status\n\n${statusLines.join("\n")}`,
          display: true,
          details: {
            headers,
            projectPaths,
            userPaths,
            state,
          },
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("memory-extract", {
    description: "Force a persistent memory extraction pass",
    handler: async (_args, ctx) => {
      const result = await runExtraction(pi, ctx, "manual");
      const detailLines = [
        result.ok ? `- Status: ok` : `- Status: skipped`,
        `- Topics: ${result.headers?.length ?? 0}`,
        `- Tokens: ${result.tokenCount ?? 0}`,
        result.skipped ? `- Skipped: ${result.skipped}` : undefined,
        result.error ? `- Error: ${result.error}` : undefined,
      ].filter(Boolean);

      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Extract\n\n${detailLines.join("\n")}`,
          display: true,
          details: result,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("memory-dream", {
    description: "Force a persistent memory dream consolidation pass",
    handler: async (_args, ctx) => {
      const result = await runDream(pi, ctx, "manual");
      const detailLines = [
        result.ok ? `- Status: ok` : `- Status: skipped`,
        `- Topics: ${result.headers?.length ?? 0}`,
        result.skipped ? `- Skipped: ${result.skipped}` : undefined,
        result.error ? `- Error: ${result.error}` : undefined,
      ].filter(Boolean);

      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Dream\n\n${detailLines.join("\n")}`,
          display: true,
          details: result,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("memory-recall-debug", {
    description: "Show the latest relevant-memory recall debug payload",
    handler: async (_args, ctx) => {
      const paths = getProjectMemoryPaths(ctx.cwd);
      const content = await fs.readFile(paths.recallDebugPath, "utf8").catch(() => "");
      const fallback = { message: "No recall debug payload recorded yet." };
      const body = content || JSON.stringify(fallback, null, 2);
      let details: unknown = fallback;
      if (content) {
        try {
          details = JSON.parse(content);
        } catch {
          details = { raw: content };
        }
      }
      pi.sendMessage(
        {
          customType: REPORT_MESSAGE_TYPE,
          content: `## Memory Recall Debug\n\n\`\`\`json\n${body}\n\`\`\``,
          display: true,
          details,
        },
        { triggerTurn: false },
      );
    },
  });
}

async function readPreview(filePath: string): Promise<string> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.slice(0, INDEX_PREVIEW_CHARS).trim();
  } catch {
    return "";
  }
}

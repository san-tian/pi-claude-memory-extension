#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function usage() {
  console.log(`usage: node tools/verify_auto_compaction.mjs --pi-root <pi-coding-agent-dir> --provider <provider-id> --model <model-id> [--context-window 5000]\n\nexample:\n  node tools/verify_auto_compaction.mjs --pi-root /path/to/pi-coding-agent --provider openai --model gpt-5`);
}

function parseArgs(argv) {
  const options = {
    contextWindow: 5000,
    reserveTokens: 500,
    keepRecentTokens: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    if (next === undefined) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--pi-root') options.piRoot = next;
    else if (arg === '--provider') options.provider = next;
    else if (arg === '--model') options.model = next;
    else if (arg === '--context-window') options.contextWindow = Number(next);
    else if (arg === '--reserve-tokens') options.reserveTokens = Number(next);
    else if (arg === '--keep-recent-tokens') options.keepRecentTokens = Number(next);
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help || !options.piRoot || !options.provider || !options.model) {
  usage();
  process.exit(options.help ? 0 : 1);
}

const pkg = await import(pathToFileURL(path.resolve(options.piRoot, 'dist/index.js')).href);
const { createAgentSession, AuthStorage, ModelRegistry, SessionManager, SettingsManager } = pkg;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const auth = AuthStorage.create();
const registry = ModelRegistry.create(auth);
const baseModel = registry.find(options.provider, options.model);
const model = { ...baseModel, contextWindow: options.contextWindow };
const sessionManager = SessionManager.inMemory();
const settingsManager = SettingsManager.inMemory({
  compaction: {
    enabled: true,
    reserveTokens: options.reserveTokens,
    keepRecentTokens: options.keepRecentTokens,
  },
});

const { session } = await createAgentSession({
  cwd: process.cwd(),
  model,
  authStorage: auth,
  modelRegistry: registry,
  sessionManager,
  settingsManager,
});

const events = [];
const assistantTexts = [];
session.subscribe((event) => {
  if (['compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end'].includes(event.type)) {
    events.push(event);
    console.log('EVENT', JSON.stringify(event));
  }
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    const text = (event.message.content || [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    assistantTexts.push(text);
    console.log('ASSISTANT', JSON.stringify(text));
  }
});

const filler = 'x'.repeat(2200);
for (const label of ['first', 'second', 'third']) {
  await session.prompt(`Repeat exactly: ${label}-${filler}`);
  await sleep(500);
}

const compactionsAfterFill = sessionManager.getEntries().filter((entry) => entry.type === 'compaction').length;
console.log('COMPACTIONS_AFTER_FILL', compactionsAfterFill);

await session.prompt('Reply with exactly: verified after auto compact');
await sleep(500);

const finalCompactions = sessionManager.getEntries().filter((entry) => entry.type === 'compaction').length;
const lastAssistant = assistantTexts.at(-1) || '';
const usedDefaultFallback = events.some((event) => event.type === 'compaction_end' && event.result && typeof event.result.summary === 'string');
const ok = finalCompactions >= 1 && (lastAssistant.trim() === 'verified after auto compact' || usedDefaultFallback);
console.log('RESULT', JSON.stringify({ ok, finalCompactions, lastAssistant, eventCount: events.length, usedDefaultFallback }));
session.dispose();
process.exit(ok ? 0 : 1);

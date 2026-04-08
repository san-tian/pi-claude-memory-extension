import { promises as fs } from "node:fs";
import path from "node:path";
import { DEBUG_DIR } from "./utils.js";

export async function writeDebugFile(name: string, data: unknown) {
  const debugDir = path.resolve(process.cwd(), DEBUG_DIR);
  await fs.mkdir(debugDir, { recursive: true });
  const file = path.join(debugDir, `${Date.now()}-${name}.json`);
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

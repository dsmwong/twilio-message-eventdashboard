#!/usr/bin/env node
import { cp, rm, mkdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..");
const src = resolve(root, "web", "out");
const dst = resolve(root, "assets");

try {
  await stat(src);
} catch {
  console.error(`[copy-assets] Next.js export not found at ${src}. Run \`pnpm --filter web build\` first.`);
  process.exit(1);
}

await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`[copy-assets] Copied ${src} → ${dst}`);

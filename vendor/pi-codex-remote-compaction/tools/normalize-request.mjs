#!/usr/bin/env node
import fs from 'node:fs';

const DROP_KEYS = new Set(['id', 'status', 'phase', 'encrypted_content', 'annotations', 'logprobs']);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (DROP_KEYS.has(key)) continue;
    out[key] = normalize(val);
  }
  return out;
}

function getInputEnvelope(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('request document must be an object');
  if (doc.body && typeof doc.body === 'object') return doc.body;
  return doc;
}

export function loadNormalizedInput(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const body = getInputEnvelope(raw);
  if (!Array.isArray(body.input)) throw new Error(`missing body.input in ${path}`);
  return normalize(body.input);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: normalize-request.mjs <request.json>');
    process.exit(1);
  }
  console.log(JSON.stringify(loadNormalizedInput(file), null, 2));
}

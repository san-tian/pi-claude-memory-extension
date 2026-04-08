#!/usr/bin/env node
import crypto from 'node:crypto';
import { loadNormalizedInput } from './normalize-request.mjs';

const left = process.argv[2] ?? '.pi/extensions/codex-remote-compaction/fixtures/codex/post-compaction.request.json';
const right = process.argv[3];

if (!right) {
  console.error('usage: compare_requests.mjs <left-request.json> <right-request.json>');
  process.exit(1);
}

function stableStringify(value) {
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function formatPath(pathParts) {
  return pathParts.length === 0 ? '<root>' : pathParts.join('');
}

function findFirstDiff(leftValue, rightValue, pathParts = []) {
  if (stableStringify(leftValue) === stableStringify(rightValue)) return null;

  if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
    if (!Array.isArray(leftValue) || !Array.isArray(rightValue)) {
      return { path: formatPath(pathParts), left: leftValue, right: rightValue, reason: 'type_mismatch' };
    }
    if (leftValue.length !== rightValue.length) {
      return {
        path: formatPath(pathParts),
        left: { length: leftValue.length },
        right: { length: rightValue.length },
        reason: 'array_length_mismatch',
      };
    }
    for (let i = 0; i < leftValue.length; i++) {
      const diff = findFirstDiff(leftValue[i], rightValue[i], [...pathParts, `[${i}]`]);
      if (diff) return diff;
    }
    return null;
  }

  const leftIsObject = !!leftValue && typeof leftValue === 'object';
  const rightIsObject = !!rightValue && typeof rightValue === 'object';
  if (leftIsObject || rightIsObject) {
    if (!leftIsObject || !rightIsObject) {
      return { path: formatPath(pathParts), left: leftValue, right: rightValue, reason: 'type_mismatch' };
    }
    const leftKeys = Object.keys(leftValue);
    const rightKeys = Object.keys(rightValue);
    const allKeys = [...new Set([...leftKeys, ...rightKeys])].sort();
    for (const key of allKeys) {
      if (!(key in leftValue) || !(key in rightValue)) {
        return {
          path: formatPath([...pathParts, `.${key}`]),
          left: key in leftValue ? leftValue[key] : '<missing>',
          right: key in rightValue ? rightValue[key] : '<missing>',
          reason: 'missing_key',
        };
      }
      const diff = findFirstDiff(leftValue[key], rightValue[key], [...pathParts, `.${key}`]);
      if (diff) return diff;
    }
    return null;
  }

  return { path: formatPath(pathParts), left: leftValue, right: rightValue, reason: 'value_mismatch' };
}

const leftInput = loadNormalizedInput(left);
const rightInput = loadNormalizedInput(right);
const equal = stableStringify(leftInput) === stableStringify(rightInput);
const result = {
  left,
  right,
  leftItems: leftInput.length,
  rightItems: rightInput.length,
  equal,
  leftHash: hash(leftInput),
  rightHash: hash(rightInput),
};

if (!equal) {
  result.firstDiff = findFirstDiff(leftInput, rightInput);
}

console.log(JSON.stringify(result, null, 2));
process.exit(equal ? 0 : 1);

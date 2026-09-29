/// <reference lib="webworker" />
/**
 * G-code parser worker. One parse per worker instance; the client terminates
 * it afterwards so its heap (the copied G-code bytes) is released at once.
 */
import { parseGcode } from './parse';
import { parsedBuffers } from './types';
import type { ParserRequest, ParserResponse } from './types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<ParserRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'parse') return;
  try {
    const data = parseGcode(msg.bytes, msg.options, (done, total) => {
      ctx.postMessage({ type: 'progress', id: msg.id, done, total } satisfies ParserResponse);
    });
    ctx.postMessage({ type: 'result', id: msg.id, data } satisfies ParserResponse, parsedBuffers(data) as ArrayBuffer[]);
  } catch (e) {
    ctx.postMessage({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) } satisfies ParserResponse);
  }
};

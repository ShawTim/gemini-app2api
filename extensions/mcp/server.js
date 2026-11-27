import fs from 'node:fs';
import {
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  DEFAULT_MCP_PROTOCOL_VERSION,
  createMcpDispatcher,
  jsonRpcError,
} from '../../src/gateway/mcp-core.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = SUPPORTED_MCP_PROTOCOL_VERSIONS;
export const DEFAULT_PROTOCOL_VERSION = DEFAULT_MCP_PROTOCOL_VERSION;
export const MAX_RPC_LINE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;

function readMcpVersion() {
  for (const rel of ['./package-meta.json', '../../package.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
      if (parsed?.name === 'mcp-gemini-app' && typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // Try fallback manifest path.
    }
  }
  return '0.1.6';
}

export const MCP_SERVER_VERSION = readMcpVersion();

export function createMcpServer({
  toolHandlers,
  name = 'mcp-gemini-app',
  version = MCP_SERVER_VERSION,
  maxConcurrent = DEFAULT_MAX_CONCURRENT_REQUESTS,
} = {}) {
  const { handleMessage, cancelAll } = createMcpDispatcher({ toolHandlers, name, version });

  function startStdio({
    input = process.stdin,
    output = process.stdout,
    maxLineBytes = MAX_RPC_LINE_BYTES,
  } = {}) {
    let chunks = [];
    let bufferedBytes = 0;
    let droppingOversizedLine = false;
    let closed = false;
    let activeToolCalls = 0;
    let pendingTasks = 0;
    let endWaiters = [];

    const writeResponse = (payload) => {
      if (!payload || closed) return;
      try {
        output.write(JSON.stringify(payload) + '\n');
      } catch {
        // Ignore broken pipe on client exit.
      }
    };

    const maybeResolveDone = () => {
      if (closed && pendingTasks === 0 && endWaiters.length) {
        const list = endWaiters;
        endWaiters = [];
        for (const resolve of list) resolve();
      }
    };

    const dispatchLine = (rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        writeResponse(jsonRpcError(null, -32700, 'Parse error'));
        return;
      }
      const isToolCall = parsed && typeof parsed === 'object' && parsed.method === 'tools/call';
      if (isToolCall && activeToolCalls >= maxConcurrent) {
        if (Object.hasOwn(parsed, 'id')) {
          writeResponse(jsonRpcError(parsed.id, -32001, `Too many concurrent tool calls (max ${maxConcurrent})`));
        }
        return;
      }
      if (isToolCall) activeToolCalls++;
      pendingTasks++;
      Promise.resolve()
        .then(() => handleMessage(parsed))
        .then((res) => {
          if (res) writeResponse(res);
        })
        .catch(() => {
          const id = parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'id') ? parsed.id : null;
          if (id !== null) writeResponse(jsonRpcError(id, -32603, 'Internal error'));
        })
        .finally(() => {
          if (isToolCall) activeToolCalls--;
          pendingTasks--;
          maybeResolveDone();
        });
    };

    const processChunk = (piece) => {
      let offset = 0;
      while (offset < piece.length) {
        const nl = piece.indexOf(0x0a, offset);
        if (droppingOversizedLine) {
          if (nl === -1) return;
          droppingOversizedLine = false;
          offset = nl + 1;
          continue;
        }
        const sliceEnd = nl === -1 ? piece.length : nl;
        const segment = piece.subarray(offset, sliceEnd);
        if (bufferedBytes + segment.length > maxLineBytes) {
          chunks = [];
          bufferedBytes = 0;
          writeResponse(jsonRpcError(null, -32600, 'Request line exceeds maximum size'));
          if (nl === -1) {
            droppingOversizedLine = true;
            return;
          }
          offset = nl + 1;
          continue;
        }
        if (nl === -1) {
          chunks.push(segment);
          bufferedBytes += segment.length;
          return;
        }
        const lineBuf = chunks.length ? Buffer.concat([...chunks, segment], bufferedBytes + segment.length) : segment;
        chunks = [];
        bufferedBytes = 0;
        dispatchLine(lineBuf.toString('utf8'));
        offset = nl + 1;
      }
    };

    const onData = (chunk) => {
      if (closed) return;
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      processChunk(piece);
    };

    const onEnd = () => {
      if (closed) return;
      if (!droppingOversizedLine && bufferedBytes > 0) {
        const tail = Buffer.concat(chunks, bufferedBytes).toString('utf8');
        chunks = [];
        bufferedBytes = 0;
        dispatchLine(tail);
      }
      closed = true;
      cancelAll();
      maybeResolveDone();
    };

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);

    return {
      done: new Promise((resolve) => {
        if (closed && pendingTasks === 0) resolve();
        else endWaiters.push(resolve);
      }),
      stop() {
        closed = true;
        input.off('data', onData);
        input.off('end', onEnd);
        input.off('close', onEnd);
        cancelAll();
        maybeResolveDone();
      },
    };
  }

  return {
    name,
    version,
    handleMessage,
    startStdio,
    cancelAll,
  };
}

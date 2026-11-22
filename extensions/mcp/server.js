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
  return '0.1.0';
}

export const MCP_SERVER_VERSION = readMcpVersion();

export function createMcpServer({
  toolHandlers,
  name = 'mcp-gemini-app',
  version = MCP_SERVER_VERSION,
} = {}) {
  const { handleMessage, cancelAll } = createMcpDispatcher({ toolHandlers, name, version });

  function startStdio({
    input = process.stdin,
    output = process.stdout,
    maxLineBytes = MAX_RPC_LINE_BYTES,
  } = {}) {
    let buffer = Buffer.alloc(0);
    let closed = false;
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
          pendingTasks--;
          maybeResolveDone();
        });
    };

    const onData = (chunk) => {
      if (closed) return;
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buffer.length + piece.length > maxLineBytes) {
        buffer = Buffer.alloc(0);
        writeResponse(jsonRpcError(null, -32600, 'Request line exceeds maximum size'));
        return;
      }
      buffer = buffer.length ? Buffer.concat([buffer, piece]) : piece;
      let nl;
      while ((nl = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.subarray(0, nl).toString('utf8');
        buffer = buffer.subarray(nl + 1);
        dispatchLine(line);
      }
    };

    const onEnd = () => {
      if (buffer.length) {
        const tail = buffer.toString('utf8');
        buffer = Buffer.alloc(0);
        dispatchLine(tail);
      }
      closed = true;
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

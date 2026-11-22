import fs from 'node:fs';

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
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

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function createMcpServer({
  toolHandlers,
  name = 'mcp-gemini-app',
  version = MCP_SERVER_VERSION,
} = {}) {
  if (!toolHandlers || typeof toolHandlers.callTool !== 'function' || !Array.isArray(toolHandlers.tools)) {
    throw new TypeError('toolHandlers with tools[] and callTool() is required');
  }

  const inflight = new Map();

  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }
    const hasId = Object.hasOwn(message, 'id') && message.id !== undefined;
    const id = hasId ? message.id : null;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method) {
      return hasId ? jsonRpcError(id, -32600, 'Invalid Request') : null;
    }

    const { method, params } = message;

    // Notifications (no id -> never send a JSON-RPC response)
    if (method === 'notifications/initialized') {
      return null;
    }
    if (method === 'notifications/cancelled') {
      const targetId = params?.requestId;
      if (targetId !== undefined && inflight.has(targetId)) {
        try {
          inflight.get(targetId).abort(new Error(params?.reason || 'Cancelled by client'));
        } catch {
          // Ignore abort listener errors.
        }
      }
      return null;
    }
    if (!hasId) {
      return null;
    }

    if (method === 'initialize') {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion.trim() : '';
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name,
          version,
        },
      });
    }

    if (method === 'ping') {
      return jsonRpcResult(id, {});
    }

    if (method === 'tools/list') {
      return jsonRpcResult(id, {
        tools: toolHandlers.tools,
      });
    }

    if (method === 'tools/call') {
      const toolName = typeof params?.name === 'string' ? params.name : '';
      if (!toolName) {
        return jsonRpcError(id, -32602, 'Invalid params: tool `name` is required');
      }
      const toolArgs = params?.arguments === undefined ? {} : params.arguments;
      if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
        return jsonRpcError(id, -32602, 'Invalid params: `arguments` must be an object');
      }
      const controller = new AbortController();
      inflight.set(id, controller);
      try {
        const result = await toolHandlers.callTool(toolName, toolArgs, { signal: controller.signal });
        if (controller.signal.aborted) return null;
        return jsonRpcResult(id, result);
      } catch (err) {
        if (controller.signal.aborted) return null;
        return jsonRpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: err?.message || 'Tool execution failed' }],
        });
      } finally {
        inflight.delete(id);
      }
    }

    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  function cancelAll() {
    for (const controller of inflight.values()) {
      try {
        controller.abort(new Error('Server shutting down'));
      } catch {}
    }
    inflight.clear();
  }

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

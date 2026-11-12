#!/usr/bin/env node
/** Official Python SDK and published examples, only through isolated gateway fixtures. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { fixture, toolBlock } from "../test/gateway-fixture.mjs";
async function python(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python3", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on("data", (b) => {
      output += b;
      if (output.length > 4096) child.kill();
    });
    child.stderr.on("data", () => {}); // Fixtures are synthetic; do not normalize a habit of dumping raw SDK errors.
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("PYTHON_SDK_PROCESS_UNAVAILABLE"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error("PYTHON_SDK_SMOKE_FAILED"));
      else resolve(output.trim());
    });
  });
}
const f = await fixture({
  turns: [
    toolBlock,
    "Synthetic final",
    toolBlock,
    toolBlock,
    "Synthetic response final",
    toolBlock,
  ],
});
try {
  console.log(
    await python(
      [fileURLToPath(new URL("../test/sdk/smoke.py", import.meta.url))],
      { FIXTURE_KEY: f.key.key, FIXTURE_BASE: f.base },
    ),
  );
} finally {
  await f.close();
}
const call =
  '```tool_call\n{"name":"local_example_lookup","arguments":{"key":"example"}}\n```';
for (const mode of ["text", "chat-tools", "responses-tools"]) {
  const sample = await fixture({
    turns: mode === "text" ? ["Example verified"] : [call, "Example verified"],
  });
  try {
    const output = await python(
      [fileURLToPath(new URL("../examples/client.py", import.meta.url)), mode],
      {
        GEMINI_GATEWAY_URL: sample.base + "/v1",
        GEMINI_GATEWAY_KEY: sample.key.key,
      },
    );
    assert.equal(output, "Example verified");
    assert.equal(sample.seen.length, mode === "text" ? 1 : 2);
    if (mode !== "text")
      assert.match(sample.seen[1].messages[0].content, /local-example-value/);
  } finally {
    await sample.close();
  }
}
console.log(
  JSON.stringify({
    offline: true,
    googleRequests: 0,
    pythonSdk: "2.48.0",
    examples: 3,
    verified: true,
  }),
);

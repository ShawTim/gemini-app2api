import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fixture } from "./gateway-fixture.mjs";
const call =
  '```tool_call\n{"name":"local_example_lookup","arguments":{"key":"example"}}\n```';
for (const mode of ["text", "chat-tools", "responses-tools"])
  test(
    "documented JS example: " + mode + " through actual offline gateway",
    async (t) => {
      const f = await fixture({
        turns:
          mode === "text" ? ["Example verified"] : [call, "Example verified"],
      });
      t.after(f.close);
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["examples/client.mjs", mode], {
          env: {
            ...process.env,
            GEMINI_GATEWAY_URL: f.base + "/v1",
            GEMINI_GATEWAY_KEY: f.key.key,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (b) => (output += b));
        child.stderr.on("data", () => {});
        const timer = setTimeout(() => child.kill(), 15000);
        child.on("error", reject);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, output });
        });
      });
      assert.equal(result.code, 0);
      assert.equal(result.output.trim(), "Example verified");
      assert.equal(f.seen.length, mode === "text" ? 1 : 2);
      if (mode !== "text")
        assert.match(f.seen[1].messages[0].content, /local-example-value/);
    },
  );

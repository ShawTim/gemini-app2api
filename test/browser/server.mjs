// Offline preview only. Synthetic accounts/native answers; not the product startup.
import { fixture } from "../gateway-fixture.mjs";
const f = await fixture();
console.log(
  JSON.stringify({
    synthetic: true,
    origin: f.base,
    demoPath: "/admin/?demo=1",
    googleRequests: 0,
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await f.close();
  });

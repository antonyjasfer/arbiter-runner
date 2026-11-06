// Never resolves and keeps the event loop alive, so `npm test` runs until the job's 10-minute timeout stops it.
const test = require("node:test");

test("never ends", { timeout: Infinity }, () => {
  setInterval(() => console.log(`still running at ${new Date().toISOString()}`), 60_000);
  return new Promise(() => {});
});

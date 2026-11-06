// Runs during `npm ci` in the untrusted `tests` job. Hunts for credentials and reports names only (see probe.js).
// It always exits 0: this fixture shows that install scripts find nothing worth stealing, not that they can fail a run.
const { scan } = require("./probe.js");
const found = scan((line) => console.log(`[postinstall] ${line}`));
console.log(`[postinstall] summary: ${Object.keys(found).length} wanted credential name(s) found: ${JSON.stringify(Object.keys(found))}`);

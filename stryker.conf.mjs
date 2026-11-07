// @ts-check
// Mutation testing: Stryker changes the code in small ways and runs the tests that reach each
// change. Run it through scripts/mutants.ts, which picks the lines to change.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  appendPlugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  // The same isolation `bun run test` uses.
  // timeout bounds only the dry run, the whole suite once with coverage (about a minute in CI).
  // Mutant runs use Stryker's own per-mutant timeout.
  bun: {
    // Instrumentation slows individual tests; the runner still stops hanging mutants.
    bunArgs: ["--isolate", "--timeout", "60000"],
    timeout: 600000,
  },
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // A mutant that loops forever is stopped and counted as timed out.
  timeoutMS: 10000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};

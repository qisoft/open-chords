import { spawnSync } from "node:child_process";

import { pythonCandidates } from "./python-interpreter.ts";

const scriptArguments = process.argv.slice(2);
if (scriptArguments.length === 0) throw new Error("A Python script path is required");

const override = process.env.OPEN_CHORDS_PYTHON;
const candidates = pythonCandidates(override, process.platform);

const interpreter = candidates.find(({ arguments: candidateArguments, command }) => {
  const probe = spawnSync(
    command,
    [
      ...candidateArguments,
      "-c",
      "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
    ],
    { stdio: "ignore" },
  );
  return probe.status === 0;
});

if (interpreter === undefined)
  throw new Error("Python 3.10 or newer is required to validate contracts");

const result = spawnSync(interpreter.command, [...interpreter.arguments, ...scriptArguments], {
  stdio: "inherit",
});
if (result.error !== undefined) throw result.error;
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;

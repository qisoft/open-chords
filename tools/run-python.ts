import { spawnSync } from "node:child_process";

const scriptArguments = process.argv.slice(2);
if (scriptArguments.length === 0) throw new Error("A Python script path is required");

const candidates =
  process.platform === "win32"
    ? [
        { arguments: ["-3"], command: "py" },
        { arguments: [], command: "python" },
      ]
    : [
        { arguments: [], command: "python3" },
        { arguments: [], command: "python" },
      ];

const interpreter = candidates.find(({ arguments: candidateArguments, command }) => {
  const probe = spawnSync(command, [...candidateArguments, "--version"], { stdio: "ignore" });
  return probe.status === 0;
});

if (interpreter === undefined) throw new Error("Python 3 is required to validate contracts");

const result = spawnSync(interpreter.command, [...interpreter.arguments, ...scriptArguments], {
  stdio: "inherit",
});
if (result.error !== undefined) throw result.error;
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;

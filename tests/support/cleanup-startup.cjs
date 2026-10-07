// Native CI harness: exercise the actual compiled startup branch with controlled dialog responses.
const { app, dialog } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const state = process.argv
  .find((arg) => arg.startsWith("--cleanup-test-state="))
  .slice("--cleanup-test-state=".length);
const scenario = process.argv
  .find((arg) => arg.startsWith("--cleanup-test-scenario="))
  .slice("--cleanup-test-scenario=".length);
const report = process.argv
  .find((arg) => arg.startsWith("--cleanup-test-report="))
  .slice("--cleanup-test-report=".length);
app.setPath("userData", state);
mkdirSync(join(state, "browser-state"));
app.setPath("sessionData", join(state, "browser-state"));
const prompts = [];
dialog.showMessageBox = async (request) => {
  prompts.push(request);
  writeFileSync(report, JSON.stringify(prompts));
  if (scenario === "unchecked") return { response: 1, checkboxChecked: false };
  if (request.message === "Permanently delete the selected data?")
    return { response: scenario === "cancel-final" ? 0 : 1, checkboxChecked: true };
  return {
    response: request.message.startsWith("Installed language packs") ? 1 : 0,
    checkboxChecked: true,
  };
};
require("../../dist/main/main.cjs");

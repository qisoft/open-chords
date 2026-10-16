export function installedCdpExceptionDiagnostic(details: unknown): string {
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  const exception = field(details, "exception");
  const className = field(exception, "className");
  const kind =
    typeof className === "string" &&
    [
      "Error",
      "TypeError",
      "ReferenceError",
      "SyntaxError",
      "RangeError",
      "EvalError",
      "URIError",
    ].includes(className)
      ? className
      : "unknown";
  const coordinate = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999999
      ? value
      : "unknown";
  const description = field(exception, "description");
  const firstLine =
    typeof description === "string" ? description.slice(0, 4096).split(/\r?\n/u)[0] : "";
  const categories: Record<string, string> = {
    "Error: Installed renderer prerequisites unavailable": "renderer_unavailable",
    "TypeError: Cannot read properties of null (reading 'dataset')": "null_dataset",
    "Error: Installed Choose recording button was unavailable": "choose_unavailable",
    "Error: Installed Choose recording did not enter its pending state": "pending_unobserved",
    "Error: Installed Choose pending acknowledgment was unavailable": "ack_unavailable",
    "Error: Native Cancel did not restore the empty workspace": "empty_workspace_unrestored",
    "Error: Native-selected recording did not open its committed workspace": "workspace_unopened",
  };
  const category = Object.hasOwn(categories, firstLine ?? "") ? categories[firstLine!] : "unknown";
  return `Installed CDP exception: class=${kind} line=${coordinate(field(details, "lineNumber"))} column=${coordinate(field(details, "columnNumber"))} category=${category}`;
}

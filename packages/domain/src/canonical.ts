function canonicalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => canonicalize(item, `${path}[${String(index)}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${path} contains a non-plain object`);
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item, `${path}.${key}`)]),
    );
  }
  throw new TypeError(`${path} contains an unsupported value`);
}

export function canonicalSerialize(value: unknown): string {
  return `${JSON.stringify(canonicalize(value, "$"), null, 2)}\n`;
}

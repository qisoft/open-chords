// Control characters are single UTF-16 code units, so a code-unit split keeps surrogate pairs intact.
const isControl = (unit: string) => {
  const code = unit.charCodeAt(0);
  return (code < 0x20 && unit !== "\t") || code === 0x7f;
};

export function hasControlCharacter(text: string): boolean {
  return text.split("").some(isControl);
}

export function replaceControlCharacters(text: string, replacement: string): string {
  return text
    .split("")
    .map((unit) => (isControl(unit) ? replacement : unit))
    .join("");
}

export function installedRendererExpression(expression: string): string {
  return `(async () => {
    const deadline = Date.now() + 10000;
    while ((!window.openChords || !document.documentElement) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!window.openChords || !document.documentElement) throw new Error("Installed renderer prerequisites unavailable");
    return await (${expression});
  })()`;
}

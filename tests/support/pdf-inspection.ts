import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

type StructNode = {
  role?: string;
  alt?: string;
  lang?: string;
  type?: string;
  children?: StructNode[];
};

function coordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Invalid PDF coordinate");
  return value;
}

function outline(node: StructNode): string {
  const children = (node.children ?? []).filter((child) => child.role !== undefined);
  return `${node.role ?? ""}${node.lang ? `{${node.lang}}` : ""}${node.alt ? `[${node.alt}]` : ""}${
    children.length === 0 ? "" : `(${children.map(outline).join(",")})`
  }`;
}

export async function inspectPdf(bytes: Buffer) {
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true });
  const pdf = await task.promise;
  const metadata = await pdf.getMetadata();
  const markInfo = await pdf.getMarkInfo();
  const pages = await Promise.all(
    Array.from({ length: pdf.numPages }, async (_, index) => {
      const page = await pdf.getPage(index + 1);
      const tree: StructNode = await page.getStructTree();
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      const fontIds = new Set(
        operators.fnArray.flatMap((fn, at) =>
          fn === OPS.setFont ? [String(operators.argsArray[at][0])] : [],
        ),
      );
      const fonts = [...fontIds].map((id) => {
        const font: { name: string; missingFile: boolean } = page.commonObjs.get(id);
        return { name: font.name, embedded: !font.missingFile };
      });
      return {
        structure: (tree.children?.[0]?.children ?? []).map(outline),
        text: content.items.flatMap((item) =>
          "str" in item && item.str.trim() !== "" ? [item.str] : [],
        ),
        fonts,
        textBounds: content.items.flatMap((item) =>
          "str" in item && item.str.trim() !== ""
            ? [
                {
                  left: coordinate(item.transform[4]),
                  bottom: coordinate(item.transform[5]),
                  width: item.width,
                  height: item.height,
                },
              ]
            : [],
        ),
      };
    }),
  );
  await task.destroy();
  return { info: metadata.info, markInfo, pages };
}

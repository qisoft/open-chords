import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const root = document.querySelector<HTMLElement>("#root");

if (root === null) {
  throw new Error("Renderer root is missing");
}

createRoot(root).render(
  <StrictMode>
    <main className="grid min-h-screen place-items-center bg-canvas text-foreground">
      <h1 className="text-xl font-semibold">Open Chords foundation</h1>
    </main>
  </StrictMode>,
);

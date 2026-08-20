export type PresentableDesktopWindow = {
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
};

export function presentDesktopWindow(window: PresentableDesktopWindow): void {
  if (window.isMinimized()) window.restore();
  window.focus();
}

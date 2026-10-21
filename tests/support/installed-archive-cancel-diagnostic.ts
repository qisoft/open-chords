import { z } from "zod";

const observedBoolean = z.union([z.boolean(), z.literal("unknown")]);
const observation = z.strictObject({ cancelled: observedBoolean, buttonEnabled: observedBoolean });

export async function installedArchiveCancelDiagnostic(read: () => Promise<unknown>) {
  const deadline = Symbol();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(read),
      new Promise<typeof deadline>((resolve) => {
        timer = setTimeout(() => resolve(deadline), 1000);
      }),
    ]);
    if (result === deadline)
      return "Native archive Cancel result probe: status=deadline cancelled=unknown button_enabled=unknown";
    const value = observation.parse(result);
    return `Native archive Cancel result probe: status=complete cancelled=${String(value.cancelled)} button_enabled=${String(value.buttonEnabled)}`;
  } catch {
    return "Native archive Cancel result probe: status=unavailable cancelled=unknown button_enabled=unknown";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

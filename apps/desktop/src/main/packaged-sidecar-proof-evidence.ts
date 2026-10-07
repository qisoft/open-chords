import type { NativeContainmentBroker } from "./sidecar-containment-launcher.ts";

export const CONTAINMENT_EVIDENCE_LINE_PREFIX = "Packaged sidecar proof containment evidence: ";

export function reportFirstContainmentEvidence(
  write: (line: string) => void,
): (broker: NativeContainmentBroker) => NativeContainmentBroker {
  let reported = false;
  return (broker) => ({
    async launchAndVerify(request, signal) {
      const launched = await broker.launchAndVerify(request, signal);
      if (!reported) {
        reported = true;
        write(`${CONTAINMENT_EVIDENCE_LINE_PREFIX}${JSON.stringify(launched.evidence)}\n`);
      }
      return launched;
    },
  });
}

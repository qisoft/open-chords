import { connect } from "node:net";

import {
  AcquisitionBroker,
  createNativeAcquisitionNetwork,
} from "../../apps/desktop/src/main/acquisition-broker.ts";

const port = Number(process.argv[2]);
const url = process.argv[3]!;
const network = createNativeAcquisitionNetwork((address, destinationPort) => {
  if (address !== "142.250.74.206" || destinationPort !== 443)
    throw new Error("unpinned_destination");
  return connect({ host: "127.0.0.1", port });
});
const broker = new AcquisitionBroker({
  videoId: "aqz-KE-bpKQ",
  network: {
    ...network,
    resolve: async () => ({ aliases: [], addresses: ["142.250.74.206"] }),
  },
});
try {
  const response = await broker.open({ url, method: "GET" });
  const body = await new Response(response.body).text();
  await broker.close();
  process.stdout.write(JSON.stringify({ success: true, body }));
} catch (error) {
  await broker.close();
  process.stdout.write(
    JSON.stringify({
      success: false,
      code: error instanceof Error && "code" in error ? error.code : "unknown",
    }),
  );
}

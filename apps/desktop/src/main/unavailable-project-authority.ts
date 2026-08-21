import type { ProjectAuthority } from "./desktop-command-gateway.ts";

export const unavailableProjectAuthority: ProjectAuthority = {
  commitEditTransaction: async () => ({ notFound: true }),
  getSnapshot: async () => null,
};

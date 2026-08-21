export type DesktopSecurityConfiguration = {
  contextIsolation: boolean;
  nodeIntegration: boolean;
  persistentSession: boolean;
  sandbox: boolean;
  webSecurity: boolean;
};

export const PRIMARY_RENDERER_SECURITY_CONFIGURATION = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} as const satisfies Omit<DesktopSecurityConfiguration, "persistentSession">;

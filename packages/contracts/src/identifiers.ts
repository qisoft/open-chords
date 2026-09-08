import { z } from "zod";

export const DesktopMessageIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9]*_[a-z0-9][a-z0-9_-]*$/);

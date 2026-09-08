import { z } from "zod";

export const StableIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*_[a-z0-9][a-z0-9_-]*$/)
  .meta({ id: "StableId" });

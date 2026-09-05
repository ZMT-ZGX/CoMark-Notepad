'use strict';

import { z } from 'zod';

const RegisterSchema = z.object({
  expiresInDays: z.number().positive().optional(),
  displayName: z.string().trim().max(64).optional(),
});

const VerifySchema = z.object({
  token: z.string().min(1),
});

const UpdateProfileSchema = z.object({
  // null / "" clears the name back to the anonymous user code.
  displayName: z.string().trim().max(64).nullable().optional(),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type VerifyInput = z.infer<typeof VerifySchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export { RegisterSchema, VerifySchema, UpdateProfileSchema };

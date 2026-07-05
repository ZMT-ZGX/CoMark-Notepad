'use strict';

import { z } from 'zod';

const RegisterSchema = z.object({
  expiresInDays: z.number().positive().optional(),
});

const VerifySchema = z.object({
  token: z.string().min(1),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type VerifyInput = z.infer<typeof VerifySchema>;

export { RegisterSchema, VerifySchema };

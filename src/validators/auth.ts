'use strict';

import type * as zod from 'zod';
const { z } = require('zod');

const RegisterSchema = z.object({
  expiresInDays: z.number().positive().optional(),
});

const VerifySchema = z.object({
  token: z.string().min(1),
});

export type RegisterInput = zod.infer<typeof RegisterSchema>;
export type VerifyInput = zod.infer<typeof VerifySchema>;

module.exports = { RegisterSchema, VerifySchema };

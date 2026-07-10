'use strict';

import { z } from 'zod';

const UpdateTextSchema = z.object({
  text: z.string().max(100000),
  _wsId: z.string().optional(),
  baseVersion: z.number().int().nonnegative().optional(),
});

const SetPasswordSchema = z.object({
  password: z.string().max(1024).nullable(),
  currentPassword: z.string().max(1024).optional(),
  _wsId: z.string().optional(),
});

const UnlockSchema = z.object({
  password: z.string().min(1).max(1024),
});

export type UpdateTextInput = z.infer<typeof UpdateTextSchema>;
export type SetPasswordInput = z.infer<typeof SetPasswordSchema>;
export type UnlockInput = z.infer<typeof UnlockSchema>;

export { UpdateTextSchema, SetPasswordSchema, UnlockSchema };

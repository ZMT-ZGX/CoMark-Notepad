'use strict';

import type * as zod from 'zod';
const { z } = require('zod');

const UpdateTextSchema = z.object({
  text: z.string().max(100000),
  _wsId: z.string().optional(),
});

const SetPasswordSchema = z.object({
  password: z.string().max(1024).nullable(),
  currentPassword: z.string().max(1024).optional(),
});

const UnlockSchema = z.object({
  password: z.string().min(1).max(1024),
});

export type UpdateTextInput = zod.infer<typeof UpdateTextSchema>;
export type SetPasswordInput = zod.infer<typeof SetPasswordSchema>;
export type UnlockInput = zod.infer<typeof UnlockSchema>;

module.exports = { UpdateTextSchema, SetPasswordSchema, UnlockSchema };

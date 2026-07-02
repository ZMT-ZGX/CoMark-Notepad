'use strict';

import type * as zod from 'zod';
const { z } = require('zod');

const ClearFilesSchema = z.object({
  padId: z.number().int().positive(),
  _wsId: z.string().optional(),
});

const DeleteFileSchema = z.object({
  _wsId: z.string().optional(),
});

export type ClearFilesInput = zod.infer<typeof ClearFilesSchema>;
export type DeleteFileInput = zod.infer<typeof DeleteFileSchema>;

module.exports = { ClearFilesSchema, DeleteFileSchema };

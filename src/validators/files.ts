'use strict';

import { z } from 'zod';

const ClearFilesSchema = z.object({
  padId: z.number().int().positive(),
  _wsId: z.string().optional(),
});

const DeleteFileSchema = z.object({
  _wsId: z.string().optional(),
});

export type ClearFilesInput = z.infer<typeof ClearFilesSchema>;
export type DeleteFileInput = z.infer<typeof DeleteFileSchema>;

export { ClearFilesSchema, DeleteFileSchema };

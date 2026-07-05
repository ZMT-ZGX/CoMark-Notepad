'use strict';

import { z } from 'zod';

const CreateInvitationSchema = z.object({
  maxUses: z.number().int().min(0).default(1),
  expiresInHours: z.number().positive().optional(),
});

const RedeemInvitationSchema = z.object({
  token: z.string().min(1),
});

export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;
export type RedeemInvitationInput = z.infer<typeof RedeemInvitationSchema>;

export { CreateInvitationSchema, RedeemInvitationSchema };

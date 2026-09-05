'use strict';

import { z } from 'zod';

const RedeemPassphraseSchema = z.object({
  // Bounded so a client cannot push a multi-megabyte string through the
  // constant-time comparison on every attempt.
  passphrase: z.string().min(1).max(256),
});

export type RedeemPassphraseInput = z.infer<typeof RedeemPassphraseSchema>;

export { RedeemPassphraseSchema };

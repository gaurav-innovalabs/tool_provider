// User lifecycle. Client-facing (client creates a user before requesting any connection).
// Talks directly to the store — no separate core/users.ts wrapper (removed: it was pure pass-through,
// the route is the only caller, so the indirection wasn't buying anything).

import { z } from "zod";
import { userStore } from "../core/store";
import { errorResponse } from "../lib/errors";

const requestBody = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const userRoutes = {
  "/users": {
    POST: async (req: Request) => {
      try {
        const body = requestBody.parse(await req.json().catch(() => ({})));
        const user_id = `usr_${crypto.randomUUID()}`;
        await userStore.create({
          user_id,
          user_metadata: body.metadata ?? {},
          created_at: new Date().toISOString(),
        });
        return Response.json({ user_id }, { status: 201 });
      } catch (err) {
        return errorResponse(err);
      }
    },
  },
};

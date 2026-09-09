// Trigger *subscription management* — client-facing (client asks us to start/stop watching something).
// The actual inbound event delivery (poll results being pushed out, or a third-party webhook hitting us)
// is a webhook_routes.ts concern, not this file — see that file's header comment.

export const triggerRoutes = {
  "/triggers/:app/:trigger/subscribe": {
    POST: async (req: Request & { params: { app: string; trigger: string } }) => {
      // TODO: parse { connection_id, ...delivery config } body, create a TriggerInstance (Phase 3),
      // hand it to the scheduler once one exists (TODO: src/core/triggerRunner.ts, not written yet).
      throw new Error("not implemented");
    },
  },
  // TODO(ask): unsubscribe route — DELETE /triggers/:app/:trigger/:instance_id, or POST .../unsubscribe
  // to mirror the /subscribe verb? Also: does /admin/triggers (admin_routes.ts) need to link back here,
  // i.e. should an admin be able to pause/delete a trigger instance too, or is admin strictly read-only
  // per the original spec ("nothing else")?
};

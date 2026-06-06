# Migration guide

## Upgrading from earlier versions

Existing users get **no behaviour change** on upgrade. With no `enforcement` key in `tiers.json` the plugin defaults to `mode: "off"`: routing is byte-identical, zero additional prompt tokens are injected, and no new latency is introduced.

## Adopting enforcement

Start with **advisory mode** — it evaluates and surfaces guidance without ever blocking:

1. Add to `tiers.json`:

   ```json
   {
     "enforcement": { "mode": "advisory" }
   }
   ```

   Or set `MODEL_ROUTER_ENFORCE=1` in your environment to try it for a session.
   Or run `/router enforce advisory` from the chat.

2. Observe the banners and acceptance reports in the UI. Advisory mode never blocks; it is a safe middle step.

3. When ready, move to full enforcement:

   ```json
   {
     "enforcement": { "mode": "enforced" }
   }
   ```

   Or run `/router enforce enforced`.

See `docs/CONFIG_REFERENCE.md` for the full `enforcement` block schema.

> **Scope note:** enforcement applies only to subagent/delegate sessions. The orchestrator session is never hard-blocked regardless of mode.

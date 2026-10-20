// Apply-proposal — Edge Function entry point. All request logic lives in
// ../_shared/apply-proposal-handler.js; this file only wires Deno and the Supabase service-role
// client to it. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleApplyProposal } from "../_shared/apply-proposal-handler.js";

Deno.serve((req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleApplyProposal(req, db);
});

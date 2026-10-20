// Execution Follow-up Agent — Edge Function entry point. Logic lives in ../_shared/execution-followup-handler.js.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleExecutionFollowup } from "../_shared/execution-followup-handler.js";

Deno.serve((req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleExecutionFollowup(req, db);
});

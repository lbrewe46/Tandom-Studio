// Reset Impact Agent — Edge Function entry point. Logic lives in ../_shared/reset-impact-handler.js.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleResetImpact } from "../_shared/reset-impact-handler.js";

Deno.serve((req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleResetImpact(req, db);
});

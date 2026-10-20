// User management — Edge Function entry point. Logic lives in ../_shared/manage-users-handler.js.
// Uses the service-role key (injected automatically) to send invitation emails; Admin only.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleManageUsers } from "../_shared/manage-users-handler.js";

Deno.serve((req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleManageUsers(req, db);
});

// Assortment drafting — Edge Function entry point. Logic lives in ../_shared/draft-assortment-handler.js.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleDraftAssortment } from "../_shared/draft-assortment-handler.js";

Deno.serve((req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleDraftAssortment(req, db);
});

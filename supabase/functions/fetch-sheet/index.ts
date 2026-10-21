// Google Sheet fetch for the Performance import — Edge Function entry point. Logic lives in ../_shared/fetch-sheet-handler.js.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleFetchSheet } from "../_shared/fetch-sheet-handler.js";

Deno.serve((req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleFetchSheet(req, db);
});

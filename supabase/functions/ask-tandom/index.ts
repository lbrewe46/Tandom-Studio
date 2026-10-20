// Ask Tandom — Edge Function entry point. Request logic lives in ../_shared/ask-tandom-handler.js.
// Needs one secret: supabase secrets set ANTHROPIC_API_KEY=... (the GitHub Action does this for you
// when the ANTHROPIC_API_KEY repository secret exists). Optional: ASK_TANDOM_MODEL.
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleAskTandom } from "../_shared/ask-tandom-handler.js";

const DEFAULT_MODEL = "claude-sonnet-5-5";

async function callModel({ system, messages, tools }: { system: string; messages: unknown[]; tools: unknown[] }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: Deno.env.get("ASK_TANDOM_MODEL") || DEFAULT_MODEL, max_tokens: 1024, system, messages, tools }),
  });
  if (!res.ok) throw new Error(`model API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

Deno.serve((req: Request) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return handleAskTandom(req, db, { callModel, configured: !!Deno.env.get("ANTHROPIC_API_KEY") });
});

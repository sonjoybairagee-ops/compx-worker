import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

async function createTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS public.scrape_cache (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      raw_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(source, target)
    );
  `;
  
  // Actually, we can't easily run raw DDL via Supabase JS client unless we use rpc.
  // Let's just create an RPC function or give the user the SQL.
  console.log("SQL to run in Supabase SQL Editor:");
  console.log(query);
}

createTable();

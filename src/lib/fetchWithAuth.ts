// lib/fetchWithAuth.ts
// ✅ এই function টা সব API call-এ use করো — auto token attach করে দেবে

import { supabase } from "@/lib/supabaseClient";

/**
 * Supabase Auth token সহ fetch করার helper
 * Usage: fetchWithAuth("/api/leads") or fetchWithAuth("/api/leads", { method: "POST", body: ... })
 */
export async function fetchWithAuth(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const { data: { session }, error } = await supabase.auth.getSession();

  if (error || !session) {
    throw new Error("User not logged in");
  }

  // 🔐 Fresh token নেওয়া হচ্ছে
  const token = session.access_token;

  // Bug fix #3: existing headers কে override না করে merge করা হচ্ছে
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Authorization", `Bearer ${token}`);

  return fetch(url, {
    ...options,
    headers,
  });
}

/**
 * Dashboard-এ leads fetch করার জন্য
 * Example: const leads = await fetchLeads();
 */
export async function fetchLeads() {
  const res = await fetchWithAuth("/api/leads");

  if (!res.ok) {
    // Bug fix #4: res.json() নিজেই fail করতে পারে যদি response JSON না হয়
    let errMessage = "Failed to fetch leads";
    try {
      const err = await res.json();
      errMessage = err.error || errMessage;
    } catch {
      // non-JSON error response — default message ব্যবহার হবে
    }
    throw new Error(errMessage);
  }

  const data = await res.json();
  return data.data; // leads array
}

/**
 * Extension থেকে lead POST করার জন্য
 * Example: await postLead({ name: "...", email: "..." })
 */
export async function postLead(lead: Record<string, unknown>) { // Bug fix #5: `any` → `unknown`
  const res = await fetchWithAuth("/api/leads", {
    method: "POST",
    body: JSON.stringify({ lead }),
  });

  if (!res.ok) {
    let errMessage = "Failed to save lead";
    try {
      const err = await res.json();
      errMessage = err.error || errMessage;
    } catch {
      // non-JSON error response — default message ব্যবহার হবে
    }
    throw new Error(errMessage);
  }

  return res.json();
}

/**
 * Extension থেকে bulk leads POST করার জন্য
 * Example: await postLeads([{ name: "..." }, { name: "..." }])
 */
export async function postLeads(leads: Record<string, unknown>[]) { // Bug fix #5: `any` → `unknown`
  const res = await fetchWithAuth("/api/leads", {
    method: "POST",
    body: JSON.stringify({ leads }),
  });

  if (!res.ok) {
    let errMessage = "Failed to save leads";
    try {
      const err = await res.json();
      errMessage = err.error || errMessage;
    } catch {
      // non-JSON error response — default message ব্যবহার হবে
    }
    throw new Error(errMessage);
  }

  return res.json();
}

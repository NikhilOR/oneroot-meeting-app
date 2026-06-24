import { createClient } from "@supabase/supabase-js";

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL || "";
const supabaseUrl = rawSupabaseUrl.replace(/\/$/, "");
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigError = !rawSupabaseUrl
  ? "Missing VITE_SUPABASE_URL."
  : !rawSupabaseUrl.startsWith("https://")
    ? "VITE_SUPABASE_URL must be the HTTPS Project URL, not the PostgreSQL database URL."
    : !supabaseAnonKey
      ? "Missing VITE_SUPABASE_ANON_KEY."
      : "";

export const hasSupabaseConfig = !supabaseConfigError;
export const supabase = hasSupabaseConfig ? createClient(supabaseUrl, supabaseAnonKey) : null;

function toRow(meeting) {
  return {
    id: meeting.id,
    title: meeting.title || "",
    meeting_date: meeting.date || null,
    attendees: meeting.attendees || "",
    tags: meeting.tags || [],
    body: meeting.body || "",
    actions: meeting.actions || [],
    visibility: meeting.visibility || "restricted",
    updated_at: new Date().toISOString(),
  };
}

function fromRow(row) {
  return {
    id: row.id,
    title: row.title || "",
    date: row.meeting_date || "",
    attendees: row.attendees || "",
    tags: row.tags || [],
    body: row.body || "",
    actions: row.actions || [],
    visibility: row.visibility || "restricted",
    memberIds: (row.members || row.or_meeting_members || []).map((member) => member.user_id).filter(Boolean),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertSupabase() {
  if (!hasSupabaseConfig || !supabase) throw new Error(supabaseConfigError);
}

export async function signInWithEmail(email, password) {
  assertSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  assertSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getCurrentSession() {
  assertSupabase();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthChanged(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function fetchCurrentProfile() {
  assertSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const user = userData.user;
  if (!user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, role")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const fallbackProfile = {
    id: user.id,
    full_name: user.user_metadata?.full_name || user.email?.split("@")[0] || "User",
    email: user.email || "",
    role: "member",
  };
  const { data: inserted, error: insertError } = await supabase
    .from("profiles")
    .insert(fallbackProfile)
    .select("id, full_name, email, role")
    .single();
  if (insertError) throw insertError;
  return inserted;
}

export async function fetchProfilesFromDb() {
  assertSupabase();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, email, role")
    .order("full_name", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function fetchMeetingsFromDb() {
  if (!hasSupabaseConfig) return null;
  assertSupabase();
  const { data, error } = await supabase
    .from("or_meetings")
    .select("*, members:or_meeting_members(user_id)")
    .order("meeting_date", { ascending: false });
  if (error) throw error;
  return (data || []).map(fromRow);
}

export async function upsertMeetingToDb(meeting) {
  if (!hasSupabaseConfig) return null;
  assertSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const userId = userData.user?.id;
  const row = toRow(meeting);
  if (!meeting.createdBy && userId) row.created_by = userId;

  const { data, error } = await supabase
    .from("or_meetings")
    .upsert(row, { onConflict: "id" })
    .select("*, members:or_meeting_members(user_id)")
    .single();
  if (error) throw error;

  if (Array.isArray(meeting.memberIds)) {
    const memberIds = [...new Set([...(meeting.memberIds || []), userId].filter(Boolean))];
    const { error: deleteError } = await supabase
      .from("or_meeting_members")
      .delete()
      .eq("meeting_id", row.id);
    if (deleteError) throw deleteError;

    if (memberIds.length) {
      const { error: memberError } = await supabase
        .from("or_meeting_members")
        .insert(memberIds.map((memberId) => ({ meeting_id: row.id, user_id: memberId })));
      if (memberError) throw memberError;
    }
  }

  const { data: refreshed, error: refreshError } = await supabase
    .from("or_meetings")
    .select("*, members:or_meeting_members(user_id)")
    .eq("id", row.id)
    .single();
  if (refreshError) throw refreshError;
  return fromRow(refreshed || data);
}

export async function deleteMeetingFromDb(id) {
  if (!hasSupabaseConfig) return null;
  assertSupabase();
  const { error } = await supabase.from("or_meetings").delete().eq("id", id);
  if (error) throw error;
  return true;
}

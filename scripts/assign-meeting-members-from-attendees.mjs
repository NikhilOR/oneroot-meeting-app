import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const shouldApply = process.env.APPLY === "1";

const attendeeToEmail = new Map([
  ["pranjit", "pranjit@oneroot.farm"],
  ["teja", "teja@oneroot.farm"],
  ["hemanth", "hemanth@oneroot.farm"],
  ["atish", "atish@oneroot.farm"],
  ["athish", "atish@oneroot.farm"],
  ["sunil", "sunil@oneroot.farm"],
  ["rovind", "rovind@oneroot.farm"],
  ["sanjay", "sanjay@oneroot.farm"],
  ["saravanan", "saravanan@oneroot.farm"],
  ["adarsh", "adarsh@oneroot.farm"],
  ["dileep", "dileep@oneroot.farm"],
]);

const excludedNames = new Set([
  "bharath",
  "mr.b",
  "mr b",
  "bharath dayanand",
  "bharath dayananda",
]);

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing VITE_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function splitAttendees(value) {
  return String(value || "")
    .split(",")
    .map(normalizeName)
    .filter(Boolean)
    .filter((name) => !excludedNames.has(name));
}

const { data: profiles, error: profilesError } = await supabase
  .from("profiles")
  .select("id, full_name, email, role");

if (profilesError) {
  console.error(`Could not load profiles: ${profilesError.message}`);
  process.exit(1);
}

const emailToProfile = new Map((profiles || []).map((profile) => [profile.email.toLowerCase(), profile]));

const { data: meetings, error: meetingsError } = await supabase
  .from("or_meetings")
  .select("id, title, meeting_date, attendees, visibility")
  .order("meeting_date", { ascending: false });

if (meetingsError) {
  console.error(`Could not load meetings: ${meetingsError.message}`);
  process.exit(1);
}

let assignedCount = 0;
let restrictedCount = 0;

for (const meeting of meetings || []) {
  const attendeeNames = splitAttendees(meeting.attendees);
  const memberIds = [
    ...new Set(
      attendeeNames
        .map((name) => attendeeToEmail.get(name))
        .filter(Boolean)
        .map((email) => emailToProfile.get(email)?.id)
        .filter(Boolean),
    ),
  ];

  const missingEmails = attendeeNames
    .map((name) => attendeeToEmail.get(name))
    .filter(Boolean)
    .filter((email) => !emailToProfile.has(email));

  console.log("");
  console.log(`${meeting.title || meeting.id}`);
  console.log(`  attendees: ${meeting.attendees || "(empty)"}`);
  console.log(`  matched members: ${memberIds.length}`);
  if (missingEmails.length) console.log(`  missing profiles: ${[...new Set(missingEmails)].join(", ")}`);

  if (!shouldApply) continue;

  if (memberIds.length) {
    const rows = memberIds.map((userId) => ({
      meeting_id: meeting.id,
      user_id: userId,
    }));
    const { error: memberError } = await supabase
      .from("or_meeting_members")
      .upsert(rows, { onConflict: "meeting_id,user_id" });
    if (memberError) {
      console.error(`  failed member assignment: ${memberError.message}`);
      continue;
    }
    assignedCount += rows.length;
  }

  if (meeting.visibility !== "restricted") {
    const { error: visibilityError } = await supabase
      .from("or_meetings")
      .update({ visibility: "restricted", updated_at: new Date().toISOString() })
      .eq("id", meeting.id);
    if (visibilityError) {
      console.error(`  failed visibility update: ${visibilityError.message}`);
      continue;
    }
    restrictedCount += 1;
  }
}

if (!shouldApply) {
  console.log("");
  console.log("Dry run only. Run with APPLY=1 to assign members and restrict old meetings.");
} else {
  console.log("");
  console.log(`Assigned ${assignedCount} meeting-member rows.`);
  console.log(`Restricted ${restrictedCount} meetings.`);
}

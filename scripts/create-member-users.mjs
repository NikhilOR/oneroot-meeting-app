import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const defaultPassword = process.env.DEFAULT_MEMBER_PASSWORD || "OneRoot@12345";

const users = [
  { fullName: "Pranjit", email: "pranjit@oneroot.farm" },
  { fullName: "Teja", email: "teja@oneroot.farm" },
  { fullName: "Hemanth", email: "hemanth@oneroot.farm" },
  { fullName: "Atish", email: "atish@oneroot.farm" },
  { fullName: "Sunil", email: "sunil@oneroot.farm" },
  { fullName: "Rovind", email: "rovind@oneroot.farm" },
  { fullName: "Sanjay", email: "sanjay@oneroot.farm" },
  { fullName: "Saravanan", email: "saravanan@oneroot.farm" },
  { fullName: "Adarsh", email: "adarsh@oneroot.farm" },
  { fullName: "Dileep", email: "dileep@oneroot.farm" },
];

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

for (const user of users) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: user.email,
    password: defaultPassword,
    email_confirm: true,
    user_metadata: { full_name: user.fullName },
  });

  if (error && !error.message.toLowerCase().includes("already")) {
    console.error(`Failed to create ${user.email}: ${error.message}`);
    continue;
  }

  let authUser = data?.user;
  if (!authUser) {
    const { data: listed, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) {
      console.error(`Could not look up ${user.email}: ${listError.message}`);
      continue;
    }
    authUser = listed.users.find((item) => item.email?.toLowerCase() === user.email.toLowerCase());
  }

  if (!authUser) {
    console.error(`Could not find auth user for ${user.email}.`);
    continue;
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert({
      id: authUser.id,
      full_name: user.fullName,
      email: user.email,
      role: "member",
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });

  if (profileError) {
    console.error(`Created auth user but failed profile for ${user.email}: ${profileError.message}`);
    continue;
  }

  console.log(`Ready: ${user.fullName} <${user.email}> as member`);
}

console.log(`Default password: ${defaultPassword}`);

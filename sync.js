require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs-extra");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DB_FILE = path.join(__dirname, "accounts_db.txt");

async function login() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASS;
  
  if (!email || !password) {
    console.error("✖ Missing ADMIN_EMAIL or ADMIN_PASS in .env. RLS might block data.");
    return false;
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("✖ Login Failed:", error.message);
    return false;
  }
  return true;
}

async function fetchFromSupabase() {
  await login();
  const { data, error } = await supabase.from("accounts").select("acc_no, name, balance");
  if (error) {
    console.error("Sync Fetch Error:", error.message);
    process.exit(1);
  }
  
  const content = data.map(acc => `${acc.acc_no}|${acc.name}|${acc.balance}`).join("\n");
  await fs.writeFile(DB_FILE, content);
  console.log(`✔ Synced ${data.length} accounts from Cloud Vault.`);
}

async function pushToSupabase() {
  await login();
  if (!fs.existsSync(DB_FILE)) return;
  const content = await fs.readFile(DB_FILE, "utf8");
  const lines = content.split("\n").filter(l => l.trim() !== "");
  
  for (const line of lines) {
    const [acc_no, name, balance] = line.split("|");
    const { error } = await supabase.from("accounts").upsert({
      acc_no: parseInt(acc_no),
      name: name,
      balance: parseFloat(balance)
    }, { onConflict: "acc_no" });
    
    if (error) console.error(`Error syncing acc ${acc_no}:`, error.message);
  }
  console.log("✔ Local Updates Pushed to Cloud Vault.");
}

const mode = process.argv[2];
if (mode === "--fetch") {
  fetchFromSupabase();
} else if (mode === "--push") {
  pushToSupabase();
} else {
  console.log("Usage: node sync.js [--fetch|--push]");
}

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const VitaBankEngine = require("./engine.js");
const readline = require("readline");
const chalk = require("chalk");
const fs = require("fs-extra");
const path = require("path");

// --- CORE SYSTEM CONFIG ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
const LOG_FILE = path.join(__dirname, "transactions_ledger.log");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// WASM Bridge Functions
let engine,
  create_account_func,
  deposit_func,
  withdraw_func,
  get_total_money_func,
  clear_system_func,
  get_risk_count_func;

let currentUser = null;
let isAdmin = false;
let userAccount = null;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loader(text, duration = 1000) {
  const chars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const start = Date.now();
  while (Date.now() - start < duration) {
    process.stdout.write(`\r${chalk.cyan(chars[i++ % chars.length])} ${text}`);
    await sleep(80);
  }
  process.stdout.write("\r\n");
}

async function animate(text, type = "info") {
  const colors = {
    info: chalk.cyan,
    success: chalk.green,
    error: chalk.red,
    warning: chalk.yellow,
    bank: chalk.magentaBright
  };
  const color = colors[type] || chalk.white;
  process.stdout.write(color(">> "));
  for (let char of text) {
    process.stdout.write(char);
    await sleep(15);
  }
  process.stdout.write("\n");
}

async function startEngine() {
  await loader("Loading Vaultis Base Engine (C++ / WASM)...", 1500);
  try {
    const instance = await VitaBankEngine();
    engine = instance;
    create_account_func = engine.cwrap("create_account", "number", ["number", "string", "number"]);
    deposit_func = engine.cwrap("deposit", "number", ["number", "number"]);
    withdraw_func = engine.cwrap("withdraw", "number", ["number", "number"]);
    get_total_money_func = engine.cwrap("get_total_money", "number", []);
    clear_system_func = engine.cwrap("clear_system", null, []);
    get_risk_count_func = engine.cwrap("get_below_threshold_count", "number", ["number"]);
    
    // Cloud Sync moved to post-authentication
    console.log(chalk.gray(">> Engine Core Ready."));
  } catch (err) {
    console.error(chalk.red("FATAL: Failed to initialize C++ Base Layer: " + err.message));
    process.exit(1);
  }
}

async function syncFromSource() {
  clear_system_func();
  const { data: accounts, error } = await supabase.from("accounts").select("*");
  if (error) {
    console.error(chalk.red("✖ Sync Error: " + error.message));
    return;
  }
  if (accounts) {
    console.log(chalk.gray(`\n>> Syncing ${accounts.length} identities from Cloud...`));
    accounts.forEach(acc => {
      const res = create_account_func(acc.acc_no, acc.name, acc.balance);
      if (res === -1) console.log(chalk.yellow(`   ⚠ Collision/Skip: ${acc.acc_no}`));
    });
    await fs.writeJson(ACCOUNTS_FILE, accounts, { spaces: 2 });
  }
}

async function commitTransaction(accNo, type, amount, newBalance) {
  try {
    // 1. Log to File (Audit Trail)
    const entry = `[${new Date().toLocaleString()}] ACC: ${accNo} | OP: ${type} | AMT: ${amount} | BAL: ${newBalance}\n`;
    await fs.appendFile(LOG_FILE, entry);

    // 2. Sync to Supabase
    const { error: accErr } = await supabase.from("accounts").update({ balance: newBalance }).eq("acc_no", accNo);
    
    // Ensure initial balance is recorded as a CREDIT_DEPOSIT for proper dashboard inflow tracking
    const txType = (type === "IDENTITY_CREATION") ? "CREDIT_INITIAL_DEPOSIT" : type;
    const { error: txErr } = await supabase.from("transactions").insert([{ 
      acc_no: accNo, 
      description: txType, 
      amount: (txType.includes("DEBIT") || txType.includes("OUT")) ? -amount : amount, 
      status: "SUCCESS" 
    }]);
    
    if (accErr || txErr) {
      console.log(chalk.red("✖ Cloud Sync Pending: " + (accErr?.message || txErr?.message)));
    } else {
      console.log(chalk.cyan("✔ Cloud Vault Synchronized."));
    }
  } catch (err) {
    console.log(chalk.red("✖ Transaction Logging Failure: " + err.message));
  }
}

async function init() {
  console.clear();
  console.log(chalk.magentaBright.bold(`
   ╔══════════════════════════════════════════════════════╗
   ║        VAULTIS SECURE TERMINAL BRIDGE v3.1           ║
   ║       [ BASE LAYER: C++ ENGINE / WASM BUILT ]        ║
   ╚══════════════════════════════════════════════════════╝
  `));

  await startEngine();

  rl.question(chalk.blue("System Login (Email): "), (email) => {
    rl.question(chalk.blue("Secure PIN/Pass: "), async (password) => {
      await loader("Verifying credentials with global directory...");
      
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        console.log(chalk.red("✖ Access Denied: ") + error.message);
        return process.exit(1);
      }

      currentUser = data.user;
      const { data: prof } = await supabase.from("profiles").select("is_admin").eq("id", currentUser.id).maybeSingle();
      isAdmin = prof?.is_admin || email === "alpha14@gmail.com";

      // --- SYNC DATA NOW THAT WE ARE AUTHENTICATED ---
      await syncFromSource();

      if (!isAdmin) {
        const { data: acc } = await supabase
          .from("accounts")
          .select("*")
          .eq("user_id", currentUser.id)
          .maybeSingle();
        
        if (!acc) {
          await animate("Access Denied: No banking identity linked to this email.", "error");
          process.exit(1);
        }
        userAccount = acc;
      }

      console.log(chalk.green(`\n✔ Authentication Successful. Welcome, ${isAdmin ? "System Administrator" : userAccount?.name || email}\n`));
      await sleep(1000);
      isAdmin ? await adminPortal() : await memberPortal();
    });
  });
}

async function adminPortal() {
  console.clear();
  console.log(chalk.red.bold("--- 🛡️  ADMINISTRATOR CONTROL PANEL ---"));
  console.log(chalk.white(`1. Society Liquidity Report`));
  console.log(chalk.white(`2. Identity Generation (Register)`));
  console.log(chalk.white(`3. Search Account Registry`));
  console.log(chalk.white(`4. Detailed Account Summary`));
  console.log(chalk.white(`5. System Vulnerability Check (<₹500)`));
  console.log(chalk.white(`6. System Shutdown`));

  rl.question(chalk.yellow("\nAdmin Action >> "), async (cmd) => {
    switch(cmd) {
      case "1":
        const liquidity = get_total_money_func();
        console.log(chalk.magenta(`\nTOTAL SYSTEM LIQUIDITY: ₹${liquidity.toLocaleString()}`));
        rl.question("\n[ENTER] to Return", () => adminPortal());
        break;
      case "2":
        await adminCreateAccount();
        break;
      case "3":
        await adminSearch();
        break;
      case "4":
        await adminDeepSummary();
        break;
      case "5":
        const risky = get_risk_count_func(500);
        console.log(chalk.red(`\nCRITICAL: ${risky} accounts found below regulatory threshold (₹500).`));
        rl.question("\n[ENTER] to Return", () => adminPortal());
        break;
      case "6":
        console.log(chalk.gray("Shutting down bridge..."));
        process.exit(0);
      default:
        adminPortal();
    }
  });
}

async function adminCreateAccount() {
  console.log(chalk.cyan("\n--- IDENTITY GENERATION ---"));
  rl.question("Full Name: ", (name) => {
    rl.question("Opening Balance: ", (bal) => {
      rl.question("Set Temporary 4-Digit PIN (for Web Link): ", (pin) => {
        const accNo = Math.floor(100000 + Math.random() * 900000);
        const amount = parseFloat(bal) || 0;
        
        loader("Provisioning account in C++ Engine..."); 
        const res = create_account_func(accNo, name, amount);
        
        if (res !== -1) {
          // Explicitly set user_id to null and include temp_pin for Web UI registration link
          supabase.from("accounts").insert([{ 
            acc_no: accNo, 
            name, 
            balance: amount, 
            user_id: null,
            temp_pin: pin 
          }]).then(({ error }) => {
            if (!error) {
              commitTransaction(accNo, "IDENTITY_CREATION", amount, amount);
              console.log(chalk.green(`\n✔ SUCCESS: Node ${accNo} activated for ${name}.`));
              console.log(chalk.yellow(`➡ IMPORTANT: Give the Account Number (${accNo}) and PIN (${pin}) to ${name} for Web Registration.`));
            } else {
              if (error.code === "23505") {
                console.log(chalk.red("\n✖ Duplicate Key: This entity or account number already exists."));
              } else {
                console.log(chalk.red("\n✖ Database Sync Error: " + error.message));
              }
            }
            rl.question("\n[ENTER] to Return", () => adminPortal());
          });
        } else {
          console.log(chalk.red("\n✖ Engine Error: Account number collision."));
          rl.question("\n[ENTER] to Return", () => adminPortal());
        }
      });
    });
  });
}

async function adminSearch() {
  rl.question(chalk.blue("\nTarget Account ID: "), async (id) => {
    const { data: acc } = await supabase.from("accounts").select("*").eq("acc_no", parseInt(id)).maybeSingle();
    if (acc) {
      console.log(chalk.green("\nRECORD FOUND:"));
      console.log(`- ID:      ${acc.acc_no}`);
      console.log(`- ENTITY:  ${acc.name}`);
      console.log(`- ASSETS:  ₹${acc.balance.toLocaleString()}`);
    } else console.log(chalk.red("\n✖ RECORD NOT FOUND in global registry."));
    rl.question("\n[ENTER] to Return", () => adminPortal());
  });
}

async function adminDeepSummary() {
  rl.question(chalk.blue("\nTarget Account ID: "), async (id) => {
    const { data: acc } = await supabase.from("accounts").select("*").eq("acc_no", parseInt(id)).maybeSingle();
    if (!acc) return rl.question(chalk.red("✖ ID not found. [ENTER]"), () => adminPortal());

    const { data: txs } = await supabase.from("transactions").select("*").eq("acc_no", acc.acc_no).order("created_at", { ascending: false }).limit(5);

    console.log(chalk.magenta(`\n=== ACCOUNT SUMMARY: ${acc.name} ===`));
    console.log(`Current Assets: ₹${acc.balance.toLocaleString()}`);
    console.log(chalk.gray("\nLast 5 Transactions:"));
    if (txs?.length > 0) {
      txs.forEach(t => console.log(`[${new Date(t.created_at).toLocaleDateString()}] ${t.description.padEnd(20)} | ₹${t.amount}`));
    } else console.log("No transaction history recorded.");
    
    rl.question("\n[ENTER] to Return", () => adminPortal());
  });
}

async function memberPortal() {
  console.clear();
  console.log(chalk.green.bold(`--- 💳 VAULTIS MEMBER ACCESS [${userAccount?.acc_no}] ---`));
  console.log(`1. View Personal Assets`);
  console.log(`2. Credit Transmission (Deposit)`);
  console.log(`3. Debit Request (Withdraw)`);
  console.log(`4. P2P Asset Transfer`);
  console.log(`5. Transaction Audit`);
  console.log(`6. Exit`);

  await refreshState();
  rl.question(chalk.yellow("\nSelection >> "), async (cmd) => {
    switch(cmd) {
      case "1":
        console.log(chalk.magenta(`\nCURRENT ASSETS: ₹${userAccount.balance.toLocaleString()}`));
        rl.question("\n[ENTER]", () => memberPortal());
        break;
      case "2":
        await memberDeposit();
        break;
      case "3":
        await memberWithdraw();
        break;
      case "4":
        await memberTransfer();
        break;
      case "5":
        await memberAudit();
        break;
      case "6":
        process.exit(0);
      default:
        memberPortal();
    }
  });
}

async function refreshState() {
  if (!userAccount) return;
  const { data } = await supabase.from("accounts").select("*").eq("acc_no", userAccount.acc_no).maybeSingle();
  if (data) userAccount = data;
}

async function verifyPIN() {
  const { data: profile } = await supabase.from('profiles').select('pin').eq('id', currentUser.id).maybeSingle();
  return new Promise((resolve) => {
    rl.question(chalk.yellow("\nEnter 4-Digit Secure PIN: "), (input) => {
      if (profile && input === profile.pin) {
        resolve(true);
      } else {
        console.log(chalk.red("✖ INVALID PIN. Transaction Aborted."));
        resolve(false);
      }
    });
  });
}

async function memberDeposit() {
  if (!(await verifyPIN())) return memberPortal();
  
  rl.question("Amount to Credit: ", async (amt) => {
    const amount = parseFloat(amt);
    if (amount <= 0) return memberPortal();
    
    await loader("Injecting liquidity into C++ Base Layer...");
    const newBal = deposit_func(userAccount.acc_no, amount);
    if (newBal >= 0) {
      await commitTransaction(userAccount.acc_no, "CREDIT_DEPOSIT", amount, newBal);
      console.log(chalk.green(`✔ Credit Successful. New Balance: ₹${newBal}`));
    } else {
      console.log(chalk.red(`✖ Engine Rejection: Error Code ${newBal}`));
    }
    rl.question("\n[ENTER]", () => memberPortal());
  });
}

async function memberWithdraw() {
  if (!(await verifyPIN())) return memberPortal();

  rl.question("Amount to Debit: ", async (amt) => {
    const amount = parseFloat(amt);
    if (amount <= 0) return memberPortal();

    await loader("Authorizing debit through Base Layer...");
    const res = withdraw_func(userAccount.acc_no, amount);
    
    if (res === -2.0) {
      console.log(chalk.red("✖ CRITICAL: Insufficient Liquidity."));
    } else if (res >= 0) {
      await commitTransaction(userAccount.acc_no, "DEBIT_WITHDRAWAL", amount, res);
      console.log(chalk.green(`✔ Debit Authorized. New Balance: ₹${res}`));
    } else {
      console.log(chalk.red(`✖ Engine Rejection: Error Code ${res}`));
    }
    rl.question("\n[ENTER]", () => memberPortal());
  });
}

async function memberTransfer() {
  if (!(await verifyPIN())) return memberPortal();

  rl.question("Target Receiver ID: ", async (targetID) => {
    rl.question("Transfer Amount: ", async (amt) => {
      const amount = parseFloat(amt);
      if (amount <= 0) return memberPortal();

      // Attempt to locate target in Cloud (Note: RLS might block this for members)
      const { data: target, error } = await supabase.from("accounts").select("acc_no, name").eq("acc_no", parseInt(targetID)).maybeSingle();
      
      if (error || !target) {
        console.log(chalk.red(`\n✖ TARGET IDENTITY NOT FOUND: ${targetID}`));
        console.log(chalk.gray("Note: You may only transfer to verified global accounts."));
        return rl.question("\n[ENTER]", () => memberPortal());
      }

      await loader(`Establishing bridge to ${target.name} [${target.acc_no}]...`);
      
      // Attempt local C++ Engine Transfer first
      const debitRes = withdraw_func(userAccount.acc_no, amount);
      if (debitRes === -2.0) {
        console.log(chalk.red("✖ Insufficient Funds for transfer."));
      } else if (debitRes >= 0) {
        // If found in local engine, proceed
        const creditRes = deposit_func(target.acc_no, amount);
        await commitTransaction(userAccount.acc_no, `P2P_OUT_TO_${targetID}`, amount, debitRes);
        await commitTransaction(target.acc_no, `P2P_IN_FROM_${userAccount.acc_no}`, amount, creditRes);
        console.log(chalk.green("✔ P2P Assets Transferred Successfully via Base Engine."));
      } else {
        // Fallback to Supabase RPC if local engine doesn't have the target in memory
        console.log(chalk.yellow("⚠ Target not in local cache. Escalating to Cloud RPC..."));
        const { error: rpcErr } = await supabase.rpc('transfer_funds', { 
          sender_acc: userAccount.acc_no, 
          receiver_acc: target.acc_no, 
          amount_val: amount 
        });
        
        if (!rpcErr) {
          console.log(chalk.green("✔ P2P Assets Transferred Successfully via Cloud Vault."));
        } else {
          console.log(chalk.red("✖ Transfer Failed: " + rpcErr.message));
        }
      }
      rl.question("\n[ENTER]", () => memberPortal());
    });
  });
}

async function memberAudit() {
  const { data: txs } = await supabase.from("transactions").select("*").eq("acc_no", userAccount.acc_no).order("created_at", { ascending: false }).limit(5);
  console.log(chalk.magenta("\n--- YOUR TRANSACTION AUDIT (LAST 5) ---"));
  txs?.forEach(t => console.log(`[${new Date(t.created_at).toLocaleTimeString()}] ${t.description.padEnd(20)} | ₹${t.amount}`));
  rl.question("\n[ENTER]", () => memberPortal());
}

init();

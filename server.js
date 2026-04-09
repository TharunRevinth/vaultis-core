require("dotenv").config();
const express = require("express");
const path = require("path");
const app = express();
const PORT = 3001;

const config = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
};

// Disable Caching to force the new design to show
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});

app.get("/config", (req, res) => res.json(config));

app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/js", express.static(path.join(__dirname, "js")));
app.use(express.static(__dirname));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vaultis Master Server: http://localhost:${PORT}`);
});

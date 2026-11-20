const express = require("express");
const cors = require("cors");
const { getDb } = require("../server/firebaseAdmin");
const { createAuthRouter } = require("../server/routes/auth");
const { createSiiRouter } = require("../server/routes/sii");

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));

async function handleHealth(req, res) {
  try {
    const db = getDb();
    await db.collection("saas_config").doc("master_admin").get();
    res.json({
      ok: true,
      service: "NEXUS ERP Backend (Vercel)",
      firestore: "conectado",
      masterKeyConfigurada: Boolean(process.env.NEXUS_MASTER_KEY && process.env.NEXUS_MASTER_KEY.length >= 16),
      cronSecretConfigurado: Boolean(process.env.NEXUS_CRON_SECRET && process.env.NEXUS_CRON_SECRET.length >= 16),
      timestamp: Date.now()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      service: "NEXUS ERP Backend (Vercel)",
      error: err.message
    });
  }
}

app.get("/api/health", handleHealth);
app.get("/health", handleHealth);

const authRouter = createAuthRouter();
app.use("/api/auth", authRouter);
app.use("/auth", authRouter);

const siiRouter = createSiiRouter();
app.use("/api/sii", siiRouter);
app.use("/sii", siiRouter);

// Paso 5 agregará: /api/marketplaces y /api/cron

module.exports = app;

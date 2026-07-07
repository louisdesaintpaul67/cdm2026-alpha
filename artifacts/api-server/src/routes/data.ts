import { Router } from "express";
import { Response } from "express";
import { db, usersTable, profilesDataTable, settingsTable, sessionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth, AuthRequest } from "../middlewares/auth";

const router = Router();

// ── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set<Response>();

export function broadcastEvent(payload: Record<string, unknown>): void {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

function broadcastUpdate(key: string, sourceUserId?: number): void {
  broadcastEvent({ type: "update", key, sourceUserId });
}

/**
 * GET /events
 * Server-Sent Events — pousse une notification quand un profil est mis à jour.
 * Token en query param car EventSource ne supporte pas les headers custom.
 */
router.get("/events", async (req, res): Promise<void> => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) {
    res.status(401).json({ error: "Non authentifié" });
    return;
  }

  const rows = await db
    .select({ userId: sessionsTable.userId })
    .from(sessionsTable)
    .where(eq(sessionsTable.token, token))
    .limit(1);

  if (rows.length === 0) {
    res.status(401).json({ error: "Non authentifié" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Désactive le buffering nginx/Render
  res.flushHeaders();

  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(":heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

/**
 * GET /data/version
 * Identifiant léger (timestamp epoch ms) de la dernière modification de n'importe
 * quel profil. Pensé pour être pollé très fréquemment (ex: toutes les 2-3s) à un
 * coût quasi nul, contrairement à GET /data qui renvoie tous les profils complets.
 * Le client ne recharge les données complètes que si cette valeur a changé.
 */
router.get("/data/version", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db
    .select({ updatedAt: profilesDataTable.updatedAt })
    .from(profilesDataTable)
    .orderBy(desc(profilesDataTable.updatedAt))
    .limit(1);

  res.json({ version: rows.length > 0 ? rows[0].updatedAt.getTime() : 0 });
});

/**
 * GET /data
 * Returns all profiles the caller can see.
 * - Admin: all profiles + list of admin pseudos
 * - User: all profiles (for leaderboard) + list of admin pseudos
 */
router.get("/data", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const rows = await db.select().from(profilesDataTable);

  const profiles: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    profiles[row.profileKey] = row.data as Record<string, unknown>;
  }

  const admins = await db
    .select({ pseudo: usersTable.pseudo })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));
  const adminPseudos = admins.map((a) => a.pseudo);

  const settingRows = await db
    .select({ key: settingsTable.key, value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, "allowRandomGeneration"));
  const allowRandomGeneration = settingRows.length === 0 || settingRows[0].value !== "false";

  res.json({ profiles, adminPseudos, settings: { allowRandomGeneration } });
});

/**
 * PUT /data/:key
 * Saves (upserts) a profile's JSON data.
 * - Admin can save any key (including "real" and "ia")
 * - Users can only save their own pseudo key
 * Broadcasts an SSE update to all connected clients after save.
 */
router.put("/data/:key", requireAuth, async (req: AuthRequest, res): Promise<void> => {
  const rawKey = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
  const key = decodeURIComponent(rawKey);
  const isAdmin = req.userRole === "admin";
  const ownPseudo = req.userPseudo!;

  if (!isAdmin && key !== ownPseudo) {
    res.status(403).json({ error: "Vous ne pouvez modifier que votre propre profil." });
    return;
  }

  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    res.status(400).json({ error: "Corps de requête invalide." });
    return;
  }

  const LOCK_FIELDS = ["poulesLocked", "knockoutLocked", "buteurLocked"] as const;

  const existing = await db
    .select({ id: profilesDataTable.id, data: profilesDataTable.data })
    .from(profilesDataTable)
    .where(eq(profilesDataTable.profileKey, key))
    .limit(1);

  if (existing.length > 0) {
    const existingData = (existing[0].data as Record<string, unknown>) ?? {};
    const mergedData = { ...(data as Record<string, unknown>) };

    for (const field of LOCK_FIELDS) {
      mergedData[field] = !!existingData[field];
    }

    if (existingData["poulesLocked"]) {
      mergedData["groupScores"] = existingData["groupScores"];
    }
    if (existingData["knockoutLocked"]) {
      mergedData["koScores"] = existingData["koScores"];
    }
    if (existingData["buteurLocked"]) {
      mergedData["topScorer"] = existingData["topScorer"];
    }

    await db
      .update(profilesDataTable)
      .set({ data: mergedData, updatedAt: new Date() })
      .where(eq(profilesDataTable.profileKey, key));
  } else {
    const userRows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.pseudo, key))
      .limit(1);
    const userId = userRows.length > 0 ? userRows[0].id : null;
    await db.insert(profilesDataTable).values({ profileKey: key, userId, data });
  }

  res.json({ success: true });
  broadcastUpdate(key, req.userId);
});

/**
 * POST /predictions/migrate
 * No-op migration endpoint for client compatibility.
 */
router.post("/predictions/migrate", requireAuth, async (_req, res): Promise<void> => {
  res.json({ success: true, migrated: 0 });
});

export default router;

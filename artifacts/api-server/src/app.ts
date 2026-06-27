import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Return JSON 404 for unmatched API routes (prevents SPA fallback catching /api/*)
app.use("/api/{*splat}", (_req, res) => {
  res.status(404).json({ error: "Route introuvable" });
});

// Serve the static frontend
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

// SPA fallback — serve index.html for any non-API route
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Global error handler — returns JSON for all unhandled errors
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ error: "Erreur interne du serveur" });
  },
);

export default app;

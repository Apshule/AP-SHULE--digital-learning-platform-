import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app: Express = express();
const configuredCorsOrigins = (process.env["CORS_ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedCorsOrigins = new Set([
  "https://appshule.com",
  "https://www.appshule.com",
  ...configuredCorsOrigins,
]);

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
app.use(
  cors({
    origin: (origin, callback) => {
      callback(null, !origin || allowedCorsOrigins.has(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => {
  if (req.url?.includes("/webhooks/yo/")) (req as typeof req & { rawBody?: string }).rawBody = buf.toString("utf8");
} }));
app.use(express.urlencoded({ extended: true, verify: (req, _res, buf) => {
  if (req.url?.includes("/webhooks/yo/")) (req as typeof req & { rawBody?: string }).rawBody = buf.toString("utf8");
} }));

app.use("/api", router);

// Serve the standalone index.html at root for preview
const indexPath = resolve(__dirname, "../../../index.html");
const upgradePath = resolve(__dirname, "../../../upgrade.html");
const youtubeSyncPath = resolve(__dirname, "../../../youtube-sync.html");
const skillsPath = resolve(__dirname, "../../../skills");
const skillsAdminPath = resolve(__dirname, "../../../skills-admin.html");
const educationPath = resolve(__dirname, "../../../education");
app.get("/", (req, res) => res.sendFile(indexPath));
app.get("/upgrade.html", (req, res) => res.sendFile(upgradePath));
app.get("/youtube-sync.html", (req, res) => res.sendFile(youtubeSyncPath));
app.get("/skills-admin.html", (req, res) => res.sendFile(skillsAdminPath));
app.get(["/education", "/education/"], (req, res) => res.sendFile(resolve(educationPath, "index.html")));
app.use("/skills", express.static(skillsPath));
app.use("/education", express.static(educationPath));
app.get(["/obote", "/obote/"], (req, res) => {
  res.sendFile(resolve(skillsPath, "provider-register.html"));
});
app.get("/offline-manager.js", (req, res) => res.sendFile(resolve(__dirname, "../../../offline-manager.js")));
app.get("/sw.js", (req, res) => res.sendFile(resolve(__dirname, "../../../sw.js")));
app.get("/firebase-messaging-sw.js", (req, res) => res.sendFile(resolve(__dirname, "../../../firebase-messaging-sw.js")));
app.get("/manifest.json", (req, res) => res.sendFile(resolve(__dirname, "../../../manifest.json")));
app.use("/icons", express.static(resolve(__dirname, "../../../icons")));

export default app;

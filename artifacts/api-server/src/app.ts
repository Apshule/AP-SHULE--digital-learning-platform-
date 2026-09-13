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
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the standalone index.html at root for preview
const indexPath = resolve(__dirname, "../../../index.html");
app.get("/", (req, res) => res.sendFile(indexPath));
app.get("/offline-manager.js", (req, res) => res.sendFile(resolve(__dirname, "../../../offline-manager.js")));
app.get("/sw.js", (req, res) => res.sendFile(resolve(__dirname, "../../../sw.js")));
app.get("/firebase-messaging-sw.js", (req, res) => res.sendFile(resolve(__dirname, "../../../firebase-messaging-sw.js")));
app.get("/manifest.json", (req, res) => res.sendFile(resolve(__dirname, "../../../manifest.json")));
app.use("/icons", express.static(resolve(__dirname, "../../../icons")));

export default app;

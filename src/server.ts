// etl_manual_api: endpoints para que el frontend ejecute a pedido los mismos ETLs de la API externa.
// - POST /api/etl-manual/doctors -> clinicas + doctores (carga completa)
// - POST /api/etl-manual/works   -> ordenes por fecha, dia por dia (listado + detalle de cada orden)
// Ver README.md
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { config } from "./config.js";
import { closePool } from "./db.js";
import { logger } from "./etl/common/logger.js";
import { router } from "./http/routes.js";

const app = express();

app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json());

app.use("/api/etl-manual", router);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, message: "Ruta no encontrada" });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("HTTP ERROR", err?.stack ?? err);
  res.status(500).json({ success: false, message: "Error interno del servidor" });
});

async function main() {
  const server = app.listen(config.port, () => {
    logger.info(`etl_manual_api escuchando en el puerto ${config.port} (tz=${config.tz})`);
  });

  // Cierre ordenado (pm2, docker, Ctrl+C)
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.warn(`${signal} recibido. Cerrando servidor y pool de BD...`);
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("FATAL", err?.stack ?? err);
  process.exit(1);
});

import { Router, type NextFunction, type Response } from "express";
import { config } from "../config.js";
import { authenticate, requirePermission, userIdOf, type AuthRequest } from "./auth.js";
import { HttpError, activeRun, startRun } from "../runs/runner.js";
import { lastRuns } from "../runs/runStore.js";

export const router = Router();

const permission = requirePermission(config.auth.permission);

type Handler = (req: AuthRequest, res: Response) => Promise<unknown>;

/** Errores de los handlers async -> JSON { success: false, message } */
function handle(fn: Handler) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    fn(req, res).catch((err) => {
      if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message });
      return next(err);
    });
  };
}

function usernameOf(req: AuthRequest) {
  const u = req.user?.username ?? req.user?.email;
  return typeof u === "string" ? u : null;
}

// Salud del servicio (sin token)
router.get("/health", (_req, res) => {
  res.json({ success: true, data: { ok: true, runningRunId: activeRun()?.id ?? null } });
});

router.use(authenticate, permission);

// 1) Doctores: el ETL de clinicas y doctores completo
router.post(
  "/doctors",
  handle(async (req, res) => {
    const run = await startRun({ type: "CLINICS_DOCTORS", userId: userIdOf(req), username: usernameOf(req) });
    res.status(202).json({ success: true, message: "Carga de clinicas y doctores iniciada.", data: run });
  })
);

// 2) Ordenes por fecha: por cada dia, listado (updated_since) + detalle de cada orden (/works/{id}).
//    Body: { "dateFrom": "YYYY-MM-DD", "dateTo": "YYYY-MM-DD" }
router.post(
  "/works",
  handle(async (req, res) => {
    const { dateFrom, dateTo } = req.body ?? {};
    const run = await startRun({ type: "WORKS_BY_DAY", dateFrom, dateTo, userId: userIdOf(req), username: usernameOf(req) });
    res.status(202).json({ success: true, message: "Carga de ordenes por fecha iniciada.", data: run });
  })
);

// Avance: la ejecucion en curso y la ultima de cada endpoint (en memoria)
router.get(
  "/status",
  handle(async (_req, res) => {
    res.json({ success: true, data: { running: activeRun(), last: lastRuns() } });
  })
);

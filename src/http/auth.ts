// Seguridad: mismo JWT que entrega el backend de la plataforma (POST /api/auth/login) y mismos permisos
// (tablas permissions / role_permissions / user_roles). Copia de authMiddleware.ts y authorizationMiddleware.ts
// del backend.
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { execQuery } from "../db.js";
import { config } from "../config.js";

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }

    const decoded = jwt.verify(authHeader.substring(7), config.auth.jwtSecret);
    if (typeof decoded === "string") throw new Error("token invalido");
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

export function userIdOf(req: AuthRequest): number | null {
  const id = Number(req.user?.sub);
  return Number.isFinite(id) && id > 0 ? id : null;
}

async function checkUserPermission(userId: number, permissionCode: string) {
  const rows = await execQuery<Array<{ has_permission: number }>>(
    `
      SELECT COUNT(*) AS has_permission
      FROM permissions p
      INNER JOIN role_permissions rp ON p.id = rp.permission_id
      INNER JOIN user_roles ur ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND ur.is_active = 1 AND p.code = ?
    `,
    [userId, permissionCode]
  );
  return Number(rows[0]?.has_permission ?? 0) > 0;
}

/** Permiso de la plataforma (MODULO.SUBMODULO.ACCION). ETL_PERMISSION vacio en el .env = no se revisa permiso. */
export function requirePermission(permissionCode: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!permissionCode) return next();
    try {
      const userId = userIdOf(req);
      if (!userId || !(await checkUserPermission(userId, permissionCode))) {
        return res.status(403).json({ success: false, message: "Insufficient permissions", required: [permissionCode] });
      }
      return next();
    } catch {
      return res.status(500).json({ success: false, message: "Error checking permissions" });
    }
  };
}

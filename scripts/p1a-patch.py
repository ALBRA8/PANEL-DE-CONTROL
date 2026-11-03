#!/usr/bin/env python3
"""P1-1 (doc 07 §3.4): parchea archivos TRACKED del repo sobre la rama
feature/v2-adaptacion-verticales. Los archivos NUEVOS (handoff-handlers.ts,
p1-handoff.test.ts) se escriben aparte. Falla ruidosamente si un marcador
no existe — nunca edita a ciegas."""
from pathlib import Path
import sys

def must(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FALLO: {msg}", flush=True)
        sys.exit(1)

def patch(path: str, old: str, new: str, label: str, count: int = 1) -> None:
    p = Path(path)
    t = p.read_text(encoding="utf-8")
    must(t.count(old) == count, f"{path}: ancla no única/existente ({label}): {t.count(old)}")
    p.write_text(t.replace(old, new, count), encoding="utf-8")
    print(f"{path} OK ({label})", flush=True)

# ---------- 1) prisma/schema.prisma: modelo Handoff ----------
HANDOFF_MODEL = """// P1-1 (doc 07 §3.4): acta de entrega-recepción (traspaso) entre agentes/unidades
model Handoff {
  id             String    @id @default(cuid())
  code           String    @unique
  fromAgentId    String
  toAgentId      String
  subject        String
  summary        String    @default("")
  dossierJson    String    @default("[]")
  openItemsJson  String    @default("[]")
  guaranteesJson String    @default("{}")
  // CREATED|ACKNOWLEDGED|REJECTED|CANCELLED
  status         String    @default("CREATED")
  ackedAt        DateTime?
  ackNote        String?
  traceId        String?
  sim            Boolean   @default(false)
  createdAt      DateTime  @default(now())

  @@index([toAgentId, status])
  @@index([fromAgentId])
}

model Schedule {"""
patch("prisma/schema.prisma", "model Schedule {", HANDOFF_MODEL, "modelo Handoff")

# ---------- 2) contracts.ts: contrato HandoffEnvelope ----------
ENVELOPE = """// ---------- HANDOFF (P1-1 · doc 07 §3.4 / matriz #24) ----------
/** Sobre de traspaso (entrega-recepción) entre agentes/unidades.
 *  Fail-closed: el dossier solo admite EvidenceRef verificados
 *  (source + hash + verifiedAt) y la recepción exige ACK explícito. */
export interface HandoffEnvelope {
  handoffId: string
  from: { agentId: string; code: string; role?: string }
  to: { agentId: string; code: string; role?: string }
  subject: string
  summary: string
  /** expediente traspasado — todo elemento debe estar verificado */
  dossier: EvidenceRef[]
  /** asuntos abiertos que el receptor hereda */
  openItems: string[]
  guarantees: { completeness: 'FULL' | 'PARTIAL'; declaredAt: string }
  /** la entrega no es recepción: siempre exige confirmación */
  ackRequired: true
}

// ---------- MEMORY INTERFACE (spec §18) ----------"""
patch("src/lib/eec/domain/contracts.ts",
      "// ---------- MEMORY INTERFACE (spec §18) ----------",
      ENVELOPE, "HandoffEnvelope")

# ---------- 3) registry.ts: esquemas zod de handoff.* ----------
HANDOFF_SCHEMAS = """  'handoff.create': z.object({
    fromAgentId: id,
    toAgentId: id,
    subject: z.string().min(3),
    summary: z.string().default(''),
    dossier: z.array(z.object({
      id: z.string().min(1),
      source: z.string().min(1),
      kind: z.string().min(1),
      hash: z.string().optional(),
      verifiedAt: z.string().optional(),
    })).default([]),
    openItems: z.array(z.string()).default([]),
    completeness: z.enum(['FULL', 'PARTIAL']).default('FULL'),
  }),
  'handoff.ack': z.object({ handoffId: id, note: z.string().optional() }),
  'handoff.reject': z.object({ handoffId: id, reason: z.string().min(3) }),
  'schedule.toggle': z.object({ scheduleId: id, enabled: z.boolean() }),"""
patch("src/lib/eec/commands/registry.ts",
      "  'schedule.toggle': z.object({ scheduleId: id, enabled: z.boolean() }),",
      HANDOFF_SCHEMAS, "schemas handoff.*")

# ---------- 4) domain/types.ts: riesgo de los comandos handoff ----------
patch("src/lib/eec/domain/types.ts",
      "  'notification.read': 'LOW', 'audit.correct': 'HIGH',",
      "  'notification.read': 'LOW', 'audit.correct': 'HIGH',\n  'handoff.create': 'MEDIUM', 'handoff.ack': 'LOW', 'handoff.reject': 'LOW',",
      "COMMAND_RISK handoff")

# ---------- 5) evidence.ts: exportar criterio compartido ----------
patch("src/lib/eec/security/evidence.ts",
      "function isVerifiedEvidence(e: unknown): boolean {",
      "export function isVerifiedEvidence(e: unknown): boolean {",
      "export isVerifiedEvidence")

# ---------- 6) commands/index.ts: registrar handlers ----------
patch("src/lib/eec/commands/index.ts",
      "import { registerBizHandlers } from './handlers/biz-handlers'",
      "import { registerBizHandlers } from './handlers/biz-handlers'\nimport { registerHandoffHandlers } from './handlers/handoff-handlers'",
      "import handoff-handlers")
patch("src/lib/eec/commands/index.ts",
      "  registerBizHandlers()\n",
      "  registerBizHandlers()\n  registerHandoffHandlers()\n",
      "register handoff-handlers")

# ---------- 7) workers.ts: reglas de notificación para handoff.* ----------
RULES_OLD = """    'client.stage.changed': { severity: 'INFO', title: p => `CRM: ${String(p.name ?? '')} → ${String(p.to)}` },"""
RULES_NEW = """    'client.stage.changed': { severity: 'INFO', title: p => `CRM: ${String(p.name ?? '')} → ${String(p.to)}` },
    'handoff.created': { severity: 'INFO', title: p => `Traspaso recibido: ${String(p.subject ?? p.handoffId)}` },
    'handoff.acknowledged': { severity: 'INFO', title: p => `Traspaso confirmado: ${String(p.subject ?? p.handoffId)}` },
    'handoff.rejected': { severity: 'WARNING', title: p => `Traspaso rechazado: ${String(p.subject ?? p.handoffId)}` },"""
patch("src/lib/eec/engine/workers.ts", RULES_OLD, RULES_NEW, "RULES handoff")

# ---------- verificación final ----------
final = Path("prisma/schema.prisma").read_text(encoding="utf-8")
must(final.count("model Handoff {") == 1, "modelo Handoff duplicado/ausente")
must("export function isVerifiedEvidence" in Path("src/lib/eec/security/evidence.ts").read_text(encoding="utf-8"),
     "isVerifiedEvidence no exportada")
print("P1-1 patch: TODO OK", flush=True)

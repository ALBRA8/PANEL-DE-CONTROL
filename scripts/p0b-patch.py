#!/usr/bin/env python3
"""P0-3 (doc 07 §3.3): quórum humano (minimumHumanSignoff) en Approval.
Parchea archivos TRACKED sobre feature/v2-adaptacion-verticales.
Falla ruidosamente si un marcador no existe."""
from pathlib import Path
import sys

def must(cond, msg):
    if not cond:
        print(f"FALLO: {msg}", flush=True)
        sys.exit(1)

# ---------- 1) schema.prisma: Approval gana quórum + firmas ----------
schema = Path("prisma/schema.prisma")
t = schema.read_text(encoding="utf-8")
anchor = """  // REQUESTED|APPROVED|REJECTED|EXPIRED|CANCELLED
  status        String    @default("REQUESTED")"""
repl = """  // P0-3 (doc 07 §3.3): quórum humano — firmas HUMANAS distintas requeridas
  minimumHumanSignoff Int     @default(1)
  // P0-3: firmas acumuladas [{by, at, note}] hasta alcanzar el quórum
  signaturesJson      String  @default("[]")
  // REQUESTED|APPROVED|REJECTED|EXPIRED|CANCELLED
  status        String    @default("REQUESTED")"""
must(t.count(anchor) == 1, "bloque Approval/status no único")
schema.write_text(t.replace(anchor, repl, 1), encoding="utf-8")
print("schema.prisma OK (quórum en Approval)")

# ---------- 2) registry.ts: approval.request acepta minimumHumanSignoff ----------
reg = Path("src/lib/eec/commands/registry.ts")
t = reg.read_text(encoding="utf-8")
anchor = """    resumeCommandId: z.string().optional(),
  }),
  'approval.approve':"""
repl = """    resumeCommandId: z.string().optional(),
    // P0-3 (doc 07 §3.3): quórum humano explícito de esta solicitud
    minimumHumanSignoff: z.number().int().min(1).default(1),
  }),
  'approval.approve':"""
must(t.count(anchor) == 1, "ancla approval.request no única en registry")
reg.write_text(t.replace(anchor, repl, 1), encoding="utf-8")
print("registry.ts OK")

# ---------- 3) pipeline.ts: gate exige quórum de la política ----------
pipe = Path("src/lib/eec/commands/pipeline.ts")
t = pipe.read_text(encoding="utf-8")
anchor = """      if (needsApproval) {
        const approval = await db.approval.create({
          data: {
            requestType: 'COMMAND_APPROVAL',
            subjectType: 'COMMAND',
            subjectId: cmd.id,
            title: `Aprobación requerida: ${input.type}`,
            description: `El comando ${input.type} (riesgo ${effectiveRisk}) requiere aprobación humana.`,
            risk: effectiveRisk,
            payloadJson: JSON.stringify({ commandType: input.type, payload, effectiveRisk }),
            requestedById: requesterId,
            expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
          },
        })"""
repl = """      if (needsApproval) {
        // P0-3 (doc 07 §3.3): quórum humano — la política puede exigir N firmas
        // distintas; CRITICAL exige mínimo 2 (delegación real de poder).
        let minSignoff = 1
        if (forcedApproval) {
          const pol = await db.policy.findUnique({ where: { code: forcedApproval } })
          const cond = safeParse<Record<string, unknown>>(pol?.conditionsJson ?? undefined, {})
          if (typeof cond.minHumanSignoff === 'number' && cond.minHumanSignoff >= 1) {
            minSignoff = Math.floor(cond.minHumanSignoff)
          }
        }
        if (effectiveRisk === 'CRITICAL') minSignoff = Math.max(minSignoff, 2)
        const approval = await db.approval.create({
          data: {
            requestType: 'COMMAND_APPROVAL',
            subjectType: 'COMMAND',
            subjectId: cmd.id,
            title: `Aprobación requerida: ${input.type}`,
            description: `El comando ${input.type} (riesgo ${effectiveRisk}) requiere aprobación humana.`,
            risk: effectiveRisk,
            payloadJson: JSON.stringify({ commandType: input.type, payload, effectiveRisk }),
            requestedById: requesterId,
            minimumHumanSignoff: minSignoff,
            expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
          },
        })"""
must(t.count(anchor) == 1, "bloque del gate de aprobación no único en pipeline")
pipe.write_text(t.replace(anchor, repl, 1), encoding="utf-8")
print("pipeline.ts OK (quórum en gate)")

# ---------- 4) collab-handlers.ts: quórum en approval.request/approve ----------
col = Path("src/lib/eec/commands/handlers/collab-handlers.ts")
t = col.read_text(encoding="utf-8")

anchor = """    const p = payload as {
      requestType: string; title: string; description?: string; subjectType?: string
      subjectId?: string; risk: string; payload: Record<string, unknown>
      ttlMinutes: number; requestedById?: string; resumeCommandId?: string
    }"""
repl = """    const p = payload as {
      requestType: string; title: string; description?: string; subjectType?: string
      subjectId?: string; risk: string; payload: Record<string, unknown>
      ttlMinutes: number; requestedById?: string; resumeCommandId?: string
      minimumHumanSignoff?: number
    }"""
must(t.count(anchor) == 1, "ancla de tipos approval.request no única")
t = t.replace(anchor, repl, 1)

anchor = """        payloadJson: JSON.stringify({ ...p.payload, resumeCommandId: p.resumeCommandId }),
        requestedById: p.requestedById ?? requesterId,
        expiresAt: new Date(Date.now() + p.ttlMinutes * 60_000),"""
repl = """        payloadJson: JSON.stringify({ ...p.payload, resumeCommandId: p.resumeCommandId }),
        requestedById: p.requestedById ?? requesterId,
        minimumHumanSignoff: p.minimumHumanSignoff ?? 1,
        expiresAt: new Date(Date.now() + p.ttlMinutes * 60_000),"""
must(t.count(anchor) == 1, "ancla create approval.request no única")
t = t.replace(anchor, repl, 1)

anchor = """    if (!approval) throw new Error('APPROVAL_NOT_FOUND')
    if (approval.status !== 'REQUESTED') throw new Error(`APPROVAL_NOT_PENDING:${approval.status}`)
    await db.approval.update({
      where: { id: approval.id },
      data: { status: 'APPROVED', decidedById: requesterId ?? 'operator', decidedAt: new Date(), decisionNote: p.note },
    })
    await eventBus.publish({
      event_type: 'approval.approved', source: 'eec.approvals', subject: `approval:${approval.id}`,"""
repl = """    if (!approval) throw new Error('APPROVAL_NOT_FOUND')
    if (approval.status !== 'REQUESTED') throw new Error(`APPROVAL_NOT_PENDING:${approval.status}`)
    // P0-3 (doc 07 §3.3): quórum — firmas HUMANAS DISTINTAS hasta minimumHumanSignoff.
    const signer = requesterId ?? 'operator'
    const signatures = JSON.parse(approval.signaturesJson || '[]') as Array<{ by: string; at: string; note?: string | null }>
    if (signatures.some(s => s.by === signer)) throw new Error(`APPROVAL_ALREADY_SIGNED_BY:${signer}`)
    signatures.push({ by: signer, at: new Date().toISOString(), note: p.note ?? null })
    const required = Math.max(1, approval.minimumHumanSignoff ?? 1)
    if (signatures.length < required) {
      await db.approval.update({
        where: { id: approval.id },
        data: { signaturesJson: JSON.stringify(signatures) },
      })
      await eventBus.publish({
        event_type: 'approval.signature.recorded', source: 'eec.approvals', subject: `approval:${approval.id}`,
        payload: { approvalId: approval.id, signatures: signatures.length, required, latestBy: signer }, sim,
      })
      await writeAudit({ actorId: signer, actorType: 'HUMAN', action: 'approval.signature.recorded', entityType: 'APPROVAL', entityId: approval.id, result: 'AWAITING_SIGNOFF', why: p.note, output: { signatures: signatures.length, required } })
      return { approvalId: approval.id, status: 'AWAITING_SIGNOFF', signatures: signatures.length, required }
    }
    await db.approval.update({
      where: { id: approval.id },
      data: { status: 'APPROVED', decidedById: signer, decidedAt: new Date(), decisionNote: p.note, signaturesJson: JSON.stringify(signatures) },
    })
    await eventBus.publish({
      event_type: 'approval.approved', source: 'eec.approvals', subject: `approval:${approval.id}`,"""
must(t.count(anchor) == 1, "bloque approval.approve no único")
t = t.replace(anchor, repl, 1)
col.write_text(t, encoding="utf-8")
print("collab-handlers.ts OK (quórum en approve)")
print("PATCH P0-3 COMPLETO")

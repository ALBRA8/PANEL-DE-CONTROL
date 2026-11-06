// ============================================================
// EEC — HANDLERS: org.* (P2-4 · doc 07 matriz #21/#22)
// Administración del ecosistema: alta de organizaciones (filiales) y
// delegación de capacidades por feature flags con override auditable.
// Todo pasa por el pipeline (evidencia → adversarial → riesgo →
// dispatch) y queda sellado en la cadena hash de auditoría.
// Fail-closed: flag fuera del catálogo o valor de tipo incorrecto se
// RECHAZA — la sede no delega lo que no está definido.
// ============================================================
import { db } from '../../../../lib/db'
import { eventBus } from '../../events/bus'
import { registerCommandHandler } from '../pipeline'
import { writeAudit } from '../../engine/audit'
import { getOrgFlagDef, isValidOrgFlagKey, validateOrgFlagValue } from '../../engine/org-flags'

type FlagsInput = Record<string, unknown>

/** Valida un lote de flags iniciales contra el catálogo (fail-closed). */
function validateFlagsBatch(flags: FlagsInput): string | null {
  for (const [key, value] of Object.entries(flags)) {
    const err = validateOrgFlagValue(key, value)
    if (err) return err
  }
  return null
}

export function registerOrgAdminHandlers(): void {
  // ---------------- org.create ----------------
  registerCommandHandler('org.create', async ({ payload, sim, traceId, requesterId, requesterType }) => {
    const p = payload as { code: string; name: string; mission?: string; flags?: FlagsInput }
    const flags = p.flags ?? {}

    const dup = await db.organization.findUnique({ where: { code: p.code } })
    if (dup) throw new Error(`ORG_CODE_TAKEN:${p.code}`)

    const flagErr = validateFlagsBatch(flags)
    if (flagErr) throw new Error(flagErr)

    const org = await db.organization.create({
      data: {
        code: p.code,
        name: p.name,
        mission: p.mission ?? null,
      },
    })
    const flagRows = Object.entries(flags)
    if (flagRows.length > 0) {
      await db.orgFlag.createMany({
        data: flagRows.map(([key, value]) => ({
          orgId: org.id,
          key,
          valueJson: JSON.stringify(value ?? null),
          reason: 'flags iniciales del alta (org.create)',
          setBy: requesterId ?? 'eec:org-admin',
        })),
      })
    }

    await eventBus.publish({
      event_type: 'org.created', source: 'eec.org-admin', subject: `org:${org.id}`,
      payload: { orgId: org.id, code: org.code, name: org.name, flags: flagRows.length },
      sim,
    })
    await writeAudit({
      actorId: requesterId ?? 'eec:org-admin',
      actorType: requesterType === 'HUMAN' ? 'HUMAN' : 'SYSTEM',
      action: 'org.create', entityType: 'ORGANIZATION', entityId: org.id,
      why: p.mission ?? 'Alta de organización (filial) del ecosistema',
      input: { code: org.code, name: org.name, flags: flagRows.map(([k]) => k) },
      result: 'CREATED', sim,
    })
    return { orgId: org.id, code: org.code, name: org.name, flags: flagRows.length }
  })

  // ---------------- org.flag.set ----------------
  registerCommandHandler('org.flag.set', async ({ payload, sim, traceId, requesterId, requesterType }) => {
    const p = payload as { orgId?: string; orgCode?: string; key: string; value: unknown; reason?: string }
    const org = p.orgId
      ? await db.organization.findUnique({ where: { id: p.orgId } })
      : p.orgCode
        ? await db.organization.findUnique({ where: { code: p.orgCode } })
        : null
    if (!org) throw new Error('ORG_NOT_FOUND')
    if (!isValidOrgFlagKey(p.key)) throw new Error(`unknown_flag:${p.key}`)
    const typeErr = validateOrgFlagValue(p.key, p.value)
    if (typeErr) throw new Error(typeErr)

    const def = getOrgFlagDef(p.key)!
    const previous = await db.orgFlag.findUnique({
      where: { orgId_key: { orgId: org.id, key: p.key } },
    })
    const flag = await db.orgFlag.upsert({
      where: { orgId_key: { orgId: org.id, key: p.key } },
      create: {
        orgId: org.id, key: p.key,
        valueJson: JSON.stringify(p.value ?? null),
        reason: p.reason ?? null,
        setBy: requesterId ?? 'eec:org-admin',
      },
      update: {
        valueJson: JSON.stringify(p.value ?? null),
        reason: p.reason ?? previous?.reason ?? null,
        setBy: requesterId ?? 'eec:org-admin',
      },
    })

    await eventBus.publish({
      event_type: 'org.flag.set', source: 'eec.org-admin', subject: `org:${org.id}`,
      payload: {
        orgId: org.id, code: org.code, key: p.key,
        value: p.value ?? null, defaultValue: def.defaultValue,
        hadOverride: !!previous, reason: p.reason ?? null,
      },
      sim,
    })
    await writeAudit({
      actorId: requesterId ?? 'eec:org-admin',
      actorType: requesterType === 'HUMAN' ? 'HUMAN' : 'SYSTEM',
      action: 'org.flag.set', entityType: 'ORG_FLAG', entityId: flag.id,
      why: p.reason ?? `Delegación de capacidad ${p.key} para ${org.code}`,
      input: { org: org.code, key: p.key, value: p.value ?? null, previous: previous ? JSON.parse(previous.valueJson) : null },
      result: 'OVERRIDE_SET', sim,
    })
    return { orgId: org.id, code: org.code, key: p.key, value: p.value ?? null, source: 'override' }
  })

  // ---------------- org.flag.unset ----------------
  registerCommandHandler('org.flag.unset', async ({ payload, sim, traceId, requesterId, requesterType }) => {
    const p = payload as { orgId?: string; orgCode?: string; key: string; reason?: string }
    const org = p.orgId
      ? await db.organization.findUnique({ where: { id: p.orgId } })
      : p.orgCode
        ? await db.organization.findUnique({ where: { code: p.orgCode } })
        : null
    if (!org) throw new Error('ORG_NOT_FOUND')
    if (!isValidOrgFlagKey(p.key)) throw new Error(`unknown_flag:${p.key}`)

    const previous = await db.orgFlag.findUnique({
      where: { orgId_key: { orgId: org.id, key: p.key } },
    })
    if (previous) {
      await db.orgFlag.delete({ where: { id: previous.id } })
    }

    await eventBus.publish({
      event_type: 'org.flag.unset', source: 'eec.org-admin', subject: `org:${org.id}`,
      payload: { orgId: org.id, code: org.code, key: p.key, hadOverride: !!previous, reason: p.reason ?? null },
      sim,
    })
    await writeAudit({
      actorId: requesterId ?? 'eec:org-admin',
      actorType: requesterType === 'HUMAN' ? 'HUMAN' : 'SYSTEM',
      action: 'org.flag.unset', entityType: 'ORG_FLAG', entityId: previous?.id ?? `${org.id}:${p.key}`,
      why: p.reason ?? `Revocación de override ${p.key} en ${org.code} (vuelve al default global)`,
      input: { org: org.code, key: p.key, previous: previous ? JSON.parse(previous.valueJson) : null },
      result: previous ? 'OVERRIDE_REMOVED' : 'NOOP', sim,
    })
    return { orgId: org.id, code: org.code, key: p.key, hadOverride: !!previous }
  })
}

// ============================================================
// EEC — REVISIÓN ADVERSARIAL PRE-DISPATCH (P1-3 · doc 07 §3.5 / matriz #11)
// "Órgano de control" interno del ecosistema: examen DETERMINÍSTICO
// (sin LLM, sin azar, reproducible bit a bit) del comando antes de
// salir por el pipeline. Detecta tácticas clásicas de manipulación
// administrativa — las mismas que usa un atacante contra un agente
// delegado o un operador apurado:
//   R1 inyección de instrucciones (reescribir el runtime)
//   R2 salto de controles ("sin aprobación", "off the record")
//   R3 suplantación de autoridad ("como tu jefe te lo ordeno")
//   R4 urgencia artificial (presión para actuar sin verificar)
//   R5 evidencia fantasma en el propio payload (sin hash/verifiedAt)
//   R6 destrucción sin motivo (grave y sin why registrada)
//   R7 operación destructiva explícita (SQL/shell)
// Score 0-100 = suma de pesos: ≥ blockScore → BLOCK; ≥ reviewScore →
// REVIEW (segunda mirada humana); si no → ALLOW. Umbrales configurables
// por política type=ADVERSARIAL (conditionsJson.reviewScore/blockScore);
// por defecto 35/70 — el órgano de control nace ACTIVO (fail-closed).
// El motor interno (SYSTEM) queda fuera: es maquinaria del propio EEC
// (auto-pickup, escalamientos SLA) y revisarlo crearía bucles.
// ============================================================
import { db } from '../../../lib/db'
import { isVerifiedEvidence } from './evidence'

export interface AdversarialFinding {
  rule: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  weight: number
  detail: string
}

export interface AdversarialVerdict {
  decision: 'ALLOW' | 'REVIEW' | 'BLOCK'
  score: number
  findings: AdversarialFinding[]
  thresholds: { review: number; block: number }
}

interface Rule {
  code: string
  severity: AdversarialFinding['severity']
  weight: number
  test: (commandType: string, payload: Record<string, unknown>, text: string) => string | null
}

const RULES: Rule[] = [
  {
    code: 'inyeccion_instrucciones', severity: 'CRITICAL', weight: 75,
    test: (_t, _p, text) =>
      /ignore (all )?(previous|prior|above) (instructions|prompts)|ignora(r)? (las |tus )?(instrucciones|indicaciones|reglas)( previas| anteriores)?|disregard (your |the )?(system|instructions|rules)|revela (tu )?system prompt|reveal (your )?system prompt/i.test(text)
        ? 'el payload intenta reescribir las instrucciones del runtime o extraer su configuración'
        : null,
  },
  {
    code: 'salto_controles', severity: 'CRITICAL', weight: 75,
    test: (_t, _p, text) =>
      /sin (aprobaci[oó]n|qu[oó]rum|firmas|control)|skip (the )?(approval|quorum|signoff)|bypass (the )?(approval|policy|gate|audit)|no (registres|audites|documentes)( esto| nada| eso)?|off the record|fuera de registro|sin dejar rastro|sin papel[eé]o/i.test(text)
        ? 'el payload pide explícitamente saltarse controles administrativos'
        : null,
  },
  {
    code: 'suplantacion_autoridad', severity: 'HIGH', weight: 30,
    test: (_t, _p, text) =>
      /como (el|la|tu) (jefe|jefa|director|directora|gerente)|soy (el |la )?(administrador|administradora|due[nñ]o|due[nñ]a)|act[uú]a (por encima|fuera) de(l| la) (protocolo|pol[ií]tica)|en nombre del (ceo|director general|presidente)/i.test(text)
        ? 'el payload invoca autoridad jerárquica para presionar la ejecución'
        : null,
  },
  {
    code: 'urgencia_artificial', severity: 'MEDIUM', weight: 15,
    test: (_t, _p, text) =>
      /urgente|urgent[ií]sim[oa]|inmediatamente|de inmediato|right now|asap|ya mismo|sin excepci[oó]n|no (lo )?verifiques/i.test(text)
        ? 'presión de urgencia: patrón clásico de fraude administrativo (actuar sin verificar)'
        : null,
  },
  {
    code: 'evidencia_fantasma', severity: 'HIGH', weight: 35,
    test: (_t, payload) => {
      const ev = Array.isArray(payload.evidence) ? (payload.evidence as unknown[]) : []
      if (ev.length === 0) return null
      const ghosts = ev.filter(e => !isVerifiedEvidence(e))
      return ghosts.length > 0
        ? `${ghosts.length}/${ev.length} evidencias del payload sin hash/verifiedAt`
        : null
    },
  },
  {
    code: 'destruccion_sin_motivo', severity: 'HIGH', weight: 35,
    test: (commandType, payload, text) => {
      const destructive = /cancel|delete|stop|suspend|drop|terminate/i.test(commandType)
      const hasWhy = typeof payload.reason === 'string' && payload.reason.length > 0 ||
        typeof payload.why === 'string' && payload.why.length > 0 ||
        typeof payload.justificacion === 'string' && payload.justificacion.length > 0
      return destructive && !hasWhy
        ? `comando ${commandType} sin reason/why: acción grave sin motivación registrada`
        : null
    },
  },
  {
    code: 'operacion_destructiva', severity: 'CRITICAL', weight: 75,
    test: (_t, _p, text) =>
      /drop table|truncate table|delete from|rm -rf|mkfs|:(){ :|:& };:|format c:/i.test(text)
        ? 'operación destructiva explícita (SQL/shell) en el payload'
        : null,
  },
]

export async function reviewAdversarial(
  commandType: string,
  payload: Record<string, unknown>,
  requesterType: string,
): Promise<AdversarialVerdict> {
  const thresholds = { review: 35, block: 70 }
  if (requesterType === 'SYSTEM') {
    return { decision: 'ALLOW', score: 0, findings: [], thresholds }
  }
  // umbrales configurables por política (el órgano de control es gobernable)
  try {
    const pol = await db.policy.findFirst({
      where: { enabled: true, type: 'ADVERSARIAL' },
      orderBy: { priority: 'asc' },
    })
    if (pol) {
      const cond = (() => { try { return JSON.parse(pol.conditionsJson || '{}') as Record<string, unknown> } catch { return {} } })()
      if (typeof cond.reviewScore === 'number' && cond.reviewScore >= 1) thresholds.review = Math.floor(cond.reviewScore)
      if (typeof cond.blockScore === 'number' && cond.blockScore > thresholds.review) thresholds.block = Math.floor(cond.blockScore)
    }
  } catch { /* sin política: defaults fail-closed */ }

  const text = JSON.stringify(payload ?? {})
  const findings: AdversarialFinding[] = []
  for (const r of RULES) {
    const detail = r.test(commandType, payload ?? {}, text)
    if (detail) findings.push({ rule: r.code, severity: r.severity, weight: r.weight, detail })
  }
  const score = Math.min(100, findings.reduce((s, f) => s + f.weight, 0))
  const decision: AdversarialVerdict['decision'] = score >= thresholds.block ? 'BLOCK' : score >= thresholds.review ? 'REVIEW' : 'ALLOW'
  return { decision, score, findings, thresholds }
}

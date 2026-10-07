// ============================================================
// EEC — SEED OPERACIONAL (idempotente)
// Crea: organización, HQ/locations, agentes (OFFLINE — no conectados
// hasta agent.start), permisos, tools, políticas, proyectos, workflows,
// CRM, calendario, memoria organizacional, conocimiento y schedules.
// Todo pasa por el pipeline de comandos cuando toca a la verdad operativa.
// ============================================================
import { db } from '../src/lib/db'
import { dispatchCommand, setSimulationMode } from '../src/lib/eec/commands'

async function main() {
  setSimulationMode(process.env.EEC_SIMULATION_MODE !== '0')
  const existing = await db.organization.findUnique({ where: { code: 'ACME' } })
  if (existing) {
    console.log('[seed] ya existe — skip')
    return
  }

  console.log('[seed] organización…')
  const org = await db.organization.create({
    data: { code: 'ACME', name: 'ACME Intelligence Corp', mission: 'Ejecutar operaciones con agentes supervisados por humanos' },
  })

  // ---------- Departamentos ----------
  const deptRevenue = await db.department.create({ data: { code: 'REV', name: 'Revenue & Growth', organizationId: org.id, description: 'Ventas, CRM y expansión de mercado' } })
  const deptOps = await db.department.create({ data: { code: 'OPS', name: 'Operations', organizationId: org.id, description: 'Ejecución, calidad y entrega' } })
  const deptIntel = await db.department.create({ data: { code: 'INTEL', name: 'Market Intelligence', organizationId: org.id, description: 'Investigación y análisis' } })

  // ---------- HQ / Locations (grid visual 12x8) ----------
  const L = async (code: string, name: string, type: string, x: number, y: number, deptId?: string) =>
    db.location.create({ data: { code, name, type, x, y, departmentId: deptId } })
  await L('HQ-RECEPTION', 'Recepción', 'HQ', 1, 0)
  await L('HQ-CONTROL', 'Control Center', 'CONTROL_CENTER', 5, 0)
  await L('HQ-BOARDROOM', 'Boardroom', 'BOARDROOM', 8, 0)
  await L('HQ-ARCHIVE', 'Archive', 'ARCHIVE', 11, 0)
  await L('HQ-LOUNGE', 'Lounge', 'LOUNGE', 1, 4)
  await L('HQ-WORLDGATE', 'World Gate', 'WORLD_GATE', 11, 4)
  await L('REV-DEPT', 'Revenue Floor', 'DEPARTMENT', 3, 2, deptRevenue.id)
  await L('OPS-DEPT', 'Operations Floor', 'DEPARTMENT', 6, 2, deptOps.id)
  await L('INTEL-DEPT', 'Intelligence Floor', 'DEPARTMENT', 9, 2, deptIntel.id)
  await L('OFF-VEGA', 'Oficina Vega', 'OFFICE', 2, 6)
  await L('OFF-LYRA', 'Oficina Lyra', 'OFFICE', 4, 6)
  await L('OFF-ORION', 'Oficina Orion', 'OFFICE', 6, 6)
  await L('OFF-NOVA', 'Oficina Nova', 'OFFICE', 8, 6)
  await L('OFF-ATLAS', 'Oficina Atlas', 'OFFICE', 10, 6)

  // ---------- Agentes (identidad permanente; OFFLINE hasta agent.start) ----------
  const mkAgent = (code: string, name: string, role: string, deptId: string, officeCode: string, desc: string, capabilities: string[], clearance = 'INTERNAL') =>
    dispatchCommand({
      type: 'agent.register',
      requesterType: 'SYSTEM',
      payload: { code, name, role, description: desc, provider: 'local-sim', departmentCode: undefined, officeCode, capabilities, skills: capabilities, clearance },
    }).then(async r => {
      const agentId = String(r.result?.agentId)
      const office = await db.location.findUnique({ where: { code: officeCode } })
      await db.agent.update({ where: { id: agentId }, data: { departmentId: deptId, officeId: office?.id } })
      return { agentId, code }
    })

  console.log('[seed] agentes…')
  const vega = await mkAgent('AGT-VEGA', 'Vega', 'Market Analyst', deptIntel.id, 'OFF-VEGA', 'Analista de mercado: investigación, prospecting y vigilancia competitiva', ['research', 'analysis', 'web.search', 'data.INTERNAL'])
  const lyra = await mkAgent('AGT-LYRA', 'Lyra', 'Sales Development', deptRevenue.id, 'OFF-LYRA', 'SDR: outreach, cualificación ynutrimiento de leads', ['outreach', 'crm', 'email.send', 'data.INTERNAL'])
  const orion = await mkAgent('AGT-ORION', 'Orion', 'Operations Manager', deptOps.id, 'OFF-ORION', 'Gestor de operaciones: reporting, coordinación y entregables', ['report', 'analysis', 'data.CONFIDENTIAL'], 'CONFIDENTIAL')
  const nova = await mkAgent('AGT-NOVA', 'Nova', 'Account Executive', deptRevenue.id, 'OFF-NOVA', 'AE: negociación, propuestas y cierre', ['outreach', 'report', 'crm', 'data.CONFIDENTIAL'], 'CONFIDENTIAL')
  await mkAgent('AGT-ATLAS', 'Atlas', 'QA Reviewer', deptOps.id, 'OFF-ATLAS', 'Revisor de calidad: evaluación de entregables y compliance', ['analysis', 'report'])

  const agents = { vega: vega.agentId, lyra: lyra.agentId, orion: orion.agentId, nova: nova.agentId }
  const all = await db.agent.findMany()
  const byCode = Object.fromEntries(all.map(a => [a.code, a.id]))

  // ---------- Permisos (otorgados por el operador — NUNCA self-grant, §23) ----------
  console.log('[seed] permisos…')
  const grant = (agentId: string, capability: string, resource: string, action: string) =>
    db.permission.create({ data: { agentId, capability, resource, action, effect: 'ALLOW', grantedById: 'operator' } })
  for (const id of Object.values(byCode)) {
    await grant(id, 'command.task.create', 'task', 'create')
    await grant(id, 'command.task.start', 'task', 'start')
    await grant(id, 'command.memory.write', 'memory', 'write')
    await grant(id, 'command.tool.invoke', 'tool', 'invoke')
  }
  for (const id of [byCode['AGT-VEGA'], byCode['AGT-LYRA'], byCode['AGT-NOVA']]) {
    await grant(id, 'command.client.create', 'client', 'create')
    await grant(id, 'command.client.update_stage', 'client', 'update_stage')
  }
  await grant(byCode['AGT-VEGA'], 'tool.web.search', 'tool', 'execute')
  await grant(byCode['AGT-LYRA'], 'tool.email.send', 'tool', 'execute')
  await grant(byCode['AGT-LYRA'], 'tool.crm.update', 'tool', 'execute')
  await grant(byCode['AGT-NOVA'], 'tool.crm.update', 'tool', 'execute')
  await grant(byCode['AGT-ORION'], 'tool.report.generate', 'tool', 'execute')
  await grant(byCode['AGT-VEGA'], 'tool.report.generate', 'tool', 'execute')
  await grant(byCode['AGT-ORION'], 'tool.web.search', 'tool', 'execute')
  await grant(byCode['AGT-ORION'], 'data.CONFIDENTIAL', 'data', 'read')
  await grant(byCode['AGT-NOVA'], 'data.CONFIDENTIAL', 'data', 'read')
  await grant(byCode['AGT-VEGA'], 'data.INTERNAL', 'data', 'read')
  await grant(byCode['AGT-LYRA'], 'data.INTERNAL', 'data', 'read')

  // ---------- Tools (catálogo del Capability Gateway, §17) ----------
  console.log('[seed] tools…')
  const mkTool = (code: string, name: string, capability: string, risk: string, desc: string, perms: string[]) =>
    db.tool.create({
      data: {
        code, name, capability, risk, description: desc, provider: 'builtin',
        schemasJson: JSON.stringify({ input: { type: 'object' }, output: { type: 'object' } }),
        permissionsJson: JSON.stringify(perms), timeoutMs: 20000, costEstimate: 0.01, auditPolicy: 'FULL',
      },
    })
  await mkTool('web.search', 'Web Search', 'search', 'LOW', 'Búsqueda web simulada', [])
  await mkTool('report.generate', 'Report Generator', 'documents', 'LOW', 'Generación de informes simulada', [])
  await mkTool('email.send', 'Email Sender', 'communication', 'HIGH', 'Envío de email (externo — requiere aprobación humana)', ['tool.email.send'])
  await mkTool('crm.update', 'CRM Updater', 'crm', 'MEDIUM', 'Actualización del CRM', ['tool.crm.update'])
  await mkTool('calendar.check', 'Calendar Checker', 'scheduling', 'LOW', 'Verificación de disponibilidad', [])

  // ---------- Políticas (§23, §26, §42) ----------
  console.log('[seed] políticas…')
  await db.policy.create({ data: { code: 'POL-RISK-HIGH-APPROVAL', name: 'Riesgo HIGH/CRITICAL requiere aprobación humana', type: 'RISK', effect: 'REQUIRE_APPROVAL', actionJson: '["*"]', conditionsJson: '{"minRiskRank":2}', priority: 10 } })
  await db.policy.create({ data: { code: 'POL-EMAIL-APPROVAL', name: 'Envío de emails siempre requiere aprobación', type: 'RISK', effect: 'REQUIRE_APPROVAL', actionJson: '["tool.invoke","email.send"]', conditionsJson: '{}', priority: 20 } })
  await db.policy.create({ data: { code: 'POL-DENY-SECRET-WRITE', name: 'Prohibido escribir datos SECRET sin permiso explícito', type: 'PERMISSION', effect: 'DENY', actionJson: '["memory.write"]', subjectJson: '{}', conditionsJson: '{"classification":"SECRET"}', priority: 5 } })
  await db.policy.create({ data: { code: 'POL-NOTIF-DEFAULT', name: 'Notificaciones UI por defecto', type: 'NOTIFICATION', effect: 'ALLOW', actionJson: '["agent.error","runtime.crashed","approval.requested","task.failed","client.stage.changed"]', conditionsJson: '{"channels":["UI"]}', priority: 50 } })
  await db.policy.create({ data: { code: 'POL-SUSPEND-NEEDS-HUMAN', name: 'Suspender agentes requiere revisión humana', type: 'APPROVAL', effect: 'REQUIRE_APPROVAL', actionJson: '["agent.suspend","system.simulation.toggle"]', conditionsJson: '{}', priority: 15 } })

  // ---------- Proyectos ----------
  console.log('[seed] proyectos…')
  const p1 = await db.project.create({
    data: {
      code: 'PRJ-GROWTH', name: 'Q4 Growth Sprint', objective: 'Aumentar pipeline comercial un 25% en el trimestre',
      organizationId: org.id, departmentId: deptRevenue.id, status: 'ACTIVE',
      milestonesJson: JSON.stringify([{ name: 'Base de prospectos', done: true }, { name: 'Campaña de outreach', done: false }, { name: '10 reuniones cualificadas', done: false }]),
      metricsJson: JSON.stringify({ pipelineTarget: 250000, meetingsTarget: 10 }),
      risksJson: JSON.stringify([{ risk: 'saturación de outreach', mitigation: 'límites por política' }]),
    },
  })
  const p2 = await db.project.create({
    data: {
      code: 'PRJ-INTEL', name: 'Market Radar', objective: 'Vigilancia competitiva continua del sector',
      organizationId: org.id, departmentId: deptIntel.id, status: 'ACTIVE',
      milestonesJson: JSON.stringify([{ name: 'Mapa competitivo', done: false }]),
      metricsJson: JSON.stringify({ reportsTarget: 4 }),
      risksJson: '[]',
    },
  })

  // ---------- Workflows versionados (§21) ----------
  console.log('[seed] workflows…')
  await db.workflow.create({
    data: {
      code: 'WF-ONBOARD', name: 'Client Onboarding', version: '1.1.0',
      description: 'Investiga al cliente, prepara propuesta, aprueba y registra en CRM',
      status: 'ACTIVE',
      definitionJson: JSON.stringify({
        trigger: { type: 'manual' },
        nodes: [
          { id: 'n1', name: 'Investigación de cliente', kind: 'TASK', taskKind: 'research', agentRole: 'Market Analyst', title: 'Investigar cliente nuevo', priority: 'HIGH', dependsOn: [] },
          { id: 'n2', name: 'Propuesta comercial', kind: 'TASK', taskKind: 'report', agentRole: 'Account Executive', title: 'Preparar propuesta inicial', priority: 'HIGH', dependsOn: ['n1'] },
          { id: 'n3', name: 'Aprobación de propuesta', kind: 'APPROVAL', approvalType: 'PROPOSAL_APPROVAL', title: 'Aprobar propuesta antes de enviar', risk: 'HIGH', dependsOn: ['n2'] },
          { id: 'n4', name: 'Registro en CRM', kind: 'TASK', taskKind: 'crm_update', agentRole: 'Sales Development', title: 'Registrar cliente y oportunidad en CRM', priority: 'MEDIUM', dependsOn: ['n3'] },
        ],
        completionRules: { requireAllNodes: true },
        retryPolicy: { maxRetries: 2, backoff: 'exponential' },
      }),
    },
  })
  await db.workflow.create({
    data: {
      code: 'WF-RADAR', name: 'Market Radar Scan', version: '1.0.0',
      description: 'Escaneo de mercado + informe de inteligencia',
      status: 'ACTIVE',
      definitionJson: JSON.stringify({
        trigger: { type: 'schedule' },
        nodes: [
          { id: 's1', name: 'Escaneo de mercado', kind: 'TASK', taskKind: 'research', agentRole: 'Market Analyst', title: 'Escanear señales de mercado', dependsOn: [] },
          { id: 's2', name: 'Informe de inteligencia', kind: 'TASK', taskKind: 'report', agentRole: 'Operations Manager', title: 'Sintetizar informe de mercado', dependsOn: ['s1'] },
        ],
        completionRules: { requireAllNodes: true },
        retryPolicy: { maxRetries: 1 },
      }),
    },
  })

  // ---------- CRM (§32) ----------
  console.log('[seed] CRM…')
  const mkClient = async (name: string, stage: string, segment: string, email: string, notes: string, oppName?: string, oppValue?: number, oppStage?: string) => {
    const c = await db.client.create({
      data: { name, stage, segment, contactEmail: email, notes, ownerAgentId: byCode['AGT-NOVA'], tagsJson: JSON.stringify([`segment:${segment}`]) },
    })
    await db.contact.create({ data: { clientId: c.id, name: `Contacto de ${name}`, email, role: 'Decision Maker' } })
    if (oppName) {
      await db.opportunity.create({
        data: { clientId: c.id, name: oppName, stage: oppStage ?? 'QUALIFIED', value: oppValue ?? 25000, probability: stage === 'CLIENT' ? 100 : 45, ownerAgentId: byCode['AGT-NOVA'] },
      })
    }
    await db.interaction.create({ data: { clientId: c.id, agentId: byCode['AGT-LYRA'], channel: 'EMAIL', summary: `Primer contacto con ${name} (simulado en seed)` } })
    return c
  }
  await mkClient('Globex Corp', 'QUALIFIED', 'Enterprise', 'cto@globex.example', 'Interesados en automatización de operaciones.', 'Globex Automation Suite', 85000, 'NEGOTIATION')
  await mkClient('Initech', 'CONTACTED', 'SMB', 'ops@initech.example', 'Consultaron por pricing.', 'Initech Pilot', 12000)
  await mkClient('Umbrella Health', 'OPPORTUNITY', 'Enterprise', 'dir@umbrella.example', 'RFP en proceso.', 'Umbrella Platform', 150000, 'QUALIFIED')
  await mkClient('Stark Manufacturing', 'CLIENT', 'Enterprise', 'ops@stark.example', 'Cliente activo desde Q2.', 'Stark Retainer', 60000, 'WON')
  await mkClient('Wayne Logistics', 'PROSPECT', 'Mid-Market', 'biz@wayne.example', 'Prospecto identificado por Vega.', undefined)

  // ---------- Calendario (§33) ----------
  console.log('[seed] calendario…')
  const soon = new Date(Date.now() + 90_000)
  const board = await db.location.findUnique({ where: { code: 'HQ-BOARDROOM' } })
  const meeting = await dispatchCommand({
    type: 'meeting.create',
    requesterType: 'SYSTEM',
    payload: {
      title: 'Kickoff Q4 Growth Sprint',
      objective: 'Alinear agentes y humanos sobre el sprint de crecimiento',
      agenda: ['Revisión de pipeline', 'Plan de outreach', 'Riesgos'],
      locationCode: 'HQ-BOARDROOM',
      organizerAgentId: byCode['AGT-ORION'],
      scheduledStartAt: soon.toISOString(),
      durationMinutes: 30,
      participantAgentIds: [byCode['AGT-VEGA'], byCode['AGT-LYRA'], byCode['AGT-NOVA']],
    },
  })
  await db.calendarEvent.create({
    data: {
      title: 'Deadline: informe Market Radar', type: 'DEADLINE',
      startAt: new Date(Date.now() + 26 * 3600 * 1000), timezone: 'UTC',
      relatedType: 'PROJECT', relatedId: p2.id, status: 'SCHEDULED',
    },
  })
  await db.calendarEvent.create({
    data: {
      title: 'Focus block: preparación de propuesta Globex', type: 'FOCUS_BLOCK',
      startAt: new Date(Date.now() + 4 * 3600 * 1000), endAt: new Date(Date.now() + 6 * 3600 * 1000),
      timezone: 'UTC', locationId: board?.id, status: 'SCHEDULED',
    },
  })

  // ---------- Memoria organizacional + conocimiento (§18, §19) ----------
  console.log('[seed] memoria y conocimiento…')
  await db.memoryRecord.create({
    data: {
      scope: 'ORGANIZATIONAL_MEMORY', kind: 'FACT',
      content: 'ACME opera bajo la Regla de Oro: la oficina refleja el estado real del sistema. La capa visual jamás inventa actividad operacional.',
      importance: 10, provenanceJson: JSON.stringify({ source: 'master-spec', section: '63' }),
      classification: 'INTERNAL', tagsJson: '["golden-rule","governance"]',
    },
  })
  await db.memoryRecord.create({
    data: {
      agentId: byCode['AGT-VEGA'], scope: 'LONG_TERM_MEMORY', kind: 'PREFERENCE',
      content: 'Vega prefiere resúmenes competitivos en tablas comparativas antes que prosa larga.',
      importance: 6, provenanceJson: JSON.stringify({ source: 'seed' }),
      classification: 'INTERNAL', tagsJson: '["preferences"]',
    },
  })
  await db.knowledgeItem.create({
    data: {
      title: 'Playbook de outreach 2026', sourceType: 'DOCUMENT',
      content: 'El playbook establece: máximo 3 toques por semana por prospecto, siempre con valor añadido, y registro obligatorio en CRM tras cada interacción. Los emails requieren aprobación humana por política de riesgo.',
      classification: 'INTERNAL', tagsJson: '["sales","outreach"]',
    },
  })
  await db.knowledgeItem.create({
    data: {
      title: 'Pricing corporativo Q4', sourceType: 'INTERNAL_SYSTEM',
      content: 'Tarifas enterprise Q4: licencia base 48k/año, plataforma 90k/año, soporte premium 15k/año. Descuentos máximos 12% con aprobación del director.',
      classification: 'CONFIDENTIAL', tagsJson: '["pricing","enterprise"]',
    },
  })
  await db.knowledgeItem.create({
    data: {
      title: 'Estudio del sector: automatización con agentes', sourceType: 'DOMAIN',
      content: 'El mercado de orquestación de agentes crece 40% anual. Los compradores priorizan: control humano, auditoría completa y neutralidad de proveedores. Los casos de uso top son ventas, soporte y operaciones.',
      classification: 'PUBLIC', tagsJson: '["market","research"]',
    },
  })
  await db.knowledgeItem.create({
    data: {
      title: 'Credenciales de producción (REFERENCIA PROHIBIDA)', sourceType: 'INTERNAL_SYSTEM',
      content: 'Este registro existe SOLO para demostrar el filtro de clasificación: su contenido es RESTRICTED y no aparece para agentes con clearance menor.',
      classification: 'RESTRICTED', tagsJson: '["demo","classification-filter"]',
    },
  })

  // ---------- Schedules (§22) ----------
  console.log('[seed] schedules…')
  await db.schedule.create({
    data: {
      name: 'Radar semanal', kind: 'RECURRING', expression: '*/15 * * * *',
      commandType: 'workflow.start',
      commandPayloadJson: JSON.stringify({ code: 'WF-RADAR', context: { projectCode: 'PRJ-INTEL' } }),
      enabled: true,
    },
  })
  await db.schedule.create({
    data: {
      name: 'Refresh de prospectos', kind: 'ONE_TIME', expression: new Date(Date.now() + 5 * 60_000).toISOString(),
      commandType: 'task.create',
      commandPayloadJson: JSON.stringify({
        title: 'Actualizar lista de prospectos tibios', projectCode: 'PRJ-GROWTH',
        assigneeAgentId: byCode['AGT-LYRA'], kind: 'research', priority: 'MEDIUM',
      }),
      enabled: true,
      nextRunAt: new Date(Date.now() + 5 * 60_000),
    },
  })

  // ---------- Arrancar 4 de 5 agentes (Atlas queda OFFLINE — estado honesto, §56) ----------
  console.log('[seed] conectando agentes…')
  for (const code of ['AGT-VEGA', 'AGT-LYRA', 'AGT-ORION', 'AGT-NOVA']) {
    await dispatchCommand({ type: 'agent.start', payload: { code }, requesterType: 'SYSTEM', requesterId: 'seed' })
  }

  // ---------- Cola operacional inicial ----------
  console.log('[seed] tareas iniciales…')
  await dispatchCommand({
    type: 'task.create', requesterType: 'SYSTEM',
    payload: {
      title: 'Investigar a Wayne Logistics antes del primer contacto',
      description: 'Perfil de compañía, puntos de dolor probables y ángulo de entrada.',
      projectCode: 'PRJ-GROWTH', assigneeAgentId: byCode['AGT-VEGA'],
      kind: 'research', priority: 'HIGH', risk: 'LOW', tags: ['prospecting'],
    },
  })
  await dispatchCommand({
    type: 'task.create', requesterType: 'SYSTEM',
    payload: {
      title: 'Preparar resumen competitivo para Umbrella Health',
      description: 'Diferenciales frente a competidores para la RFP.',
      projectCode: 'PRJ-GROWTH', assigneeAgentId: byCode['AGT-ORION'],
      kind: 'report', priority: 'MEDIUM', tags: ['rfp'],
    },
  })
  await dispatchCommand({
    type: 'task.create', requesterType: 'SYSTEM',
    payload: { title: 'Revisar calidad del último informe de onboarding', projectCode: 'PRJ-GROWTH', kind: 'analysis', priority: 'LOW', tags: ['qa'] },
  })

  console.log('[seed] completado ✔')
  console.log(`  meeting kickoff: ${JSON.stringify(meeting.result)}`)
}

main()
  .catch(err => { console.error('[seed] error:', err); process.exit(1) })
  .finally(() => process.exit(0))

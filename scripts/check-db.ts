import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const [org, agents, tasks, events, runs, tools, workflows, providers, clients, meetings, approvals, schedules] = await Promise.all([
    db.organization.count(), db.agent.count(), db.task.count(), db.eventRecord.count(), db.run.count(),
    db.tool.count(), db.workflow.count(), db.provider.count(), db.client.count(), db.meeting.count(),
    db.approval.count(), db.schedule.count(),
  ])
  console.log(JSON.stringify({ org, agents, tasks, events, runs, tools, workflows, providers, clients, meetings, approvals, schedules }))
  const ags = await db.agent.findMany({ select: { code: true, state: true, provider: true } })
  console.log(ags.map(a => `${a.code}:${a.state}@${a.provider}`).join(' | '))
}
main().finally(() => db.$disconnect())

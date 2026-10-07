// ============================================================
// EEC — REALTIME BRIDGE (socket.io, puerto 3030 vía gateway Caddy)
// Difunde eventos del Event Bus + snapshots de estado a la UI.
// La UI jamás escribe estado por este canal (solo comandos vía API REST).
// ============================================================
import { createServer } from 'http'
import { Server } from 'socket.io'

const EEC_API = process.env.EEC_API_URL ?? 'http://localhost:3000'
const POLL_MS = Number(process.env.EEC_POLL_MS ?? 900)
const PORT = 3030

const httpServer = createServer()
const io = new Server(httpServer, {
  // NO cambiar el path: lo usa Caddy para enrutar
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
})

interface EecEvent {
  seq: number
  id: string
  event_type: string
  subject: string
  timestamp: string
  payload: Record<string, unknown>
  sim: boolean
}

let cursor = 0
let polling = false

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${EEC_API}${path}`)
  if (!res.ok) throw new Error(`upstream ${res.status}`)
  return res.json()
}

async function pollOnce(): Promise<void> {
  if (polling) return
  polling = true
  try {
    const data = (await fetchJson(`/api/eec/events?since=${cursor}&limit=300`)) as { events: EecEvent[]; lastSeq: number }
    if (data.events.length > 0) {
      cursor = data.lastSeq
      io.emit('eec:events', data.events)
    }
  } catch {
    // upstream aún arrancando — reintenta en el próximo tick
  } finally {
    polling = false
  }
}

// carga cursor inicial al arrancar
async function initCursor(): Promise<void> {
  try {
    const data = (await fetchJson('/api/eec/events?since=0&limit=1')) as { lastSeq: number }
    cursor = data.lastSeq
    console.log(`[EEC-REALTIME] cursor inicial en seq ${cursor}`)
  } catch { /* reintenta */ }
}

io.on('connection', (socket) => {
  console.log(`[EEC-REALTIME] cliente conectado: ${socket.id}`)
  socket.emit('eec:connected', { at: new Date().toISOString(), cursor })

  socket.on('eec:sync', async () => {
    try {
      const snap = await fetchJson('/api/eec/state')
      socket.emit('eec:snapshot', snap)
    } catch { /* noop */ }
  })

  socket.on('disconnect', () => {
    console.log(`[EEC-REALTIME] cliente desconectado: ${socket.id}`)
  })
})

setInterval(() => void pollOnce(), POLL_MS)
void initCursor()
setTimeout(() => void pollOnce(), 1500)

httpServer.listen(PORT, () => {
  console.log(`[EEC-REALTIME] bridge socket.io en puerto ${PORT} → upstream ${EEC_API}`)
})

process.on('SIGTERM', () => { httpServer.close(() => process.exit(0)) })
process.on('SIGINT', () => { httpServer.close(() => process.exit(0)) })

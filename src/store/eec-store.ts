'use client'

// ============================================================
// EEC — STORE CLIENTE (zustand)
// Fuente para la UI: snapshot polleado + eventos realtime socket.io.
// La UI NUNCA muta estado local como verdad: refleja /api/eec/state.
// ============================================================
import { create } from 'zustand'
import {
  fetchState, dispatchCommand,
  type EecSnapshot, type EecEventItem, type CommandResult,
} from '@/lib/eec-client'

export type EecView =
  | 'central' | 'agents' | 'board' | 'workflows' | 'approvals'
  | 'meetings' | 'calendar' | 'crm' | 'world' | 'memory'
  | 'events' | 'ops'

interface EecStoreState {
  snapshot: EecSnapshot | null
  events: EecEventItem[]
  connected: boolean
  loading: boolean
  view: EecView
  selectedAgentId: string | null
  lastError: string | null
  setView: (v: EecView) => void
  selectAgent: (id: string | null) => void
  refresh: () => Promise<void>
  command: (type: string, payload?: Record<string, unknown>, idempotencyKey?: string) => Promise<CommandResult>
  pushEvents: (events: EecEventItem[]) => void
  setConnected: (v: boolean) => void
}

const globalForSocket = globalThis as unknown as { __eecSocketInit?: boolean; __eecPollInit?: boolean }

function throttle<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: never[]) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn(...args)
    } else if (!timer) {
      timer = setTimeout(() => { last = Date.now(); timer = null; fn(...args) }, ms - (now - last))
    }
  }) as T
}

export const useEecStore = create<EecStoreState>((set, get) => {
  const refresh = async () => {
    try {
      const snap = await fetchState()
      set({ snapshot: snap, loading: false, lastError: null })
    } catch (err) {
      set({ loading: false, lastError: err instanceof Error ? err.message : 'fetch error' })
    }
  }
  const throttledRefresh = throttle(refresh as unknown as (...args: never[]) => void, 1500) as typeof refresh

  const ensureSocket = () => {
    if (globalForSocket.__eecSocketInit || typeof window === 'undefined') return
    globalForSocket.__eecSocketInit = true
    void (async () => {
      try {
        const { io } = await import('socket.io-client')
        const socket = io('/?XTransformPort=3030', { path: '/', reconnectionDelayMax: 5000, transports: ['websocket', 'polling'] })
        socket.on('connect', () => set({ connected: true }))
        socket.on('disconnect', () => set({ connected: false }))
        socket.on('eec:events', (events: EecEventItem[]) => {
          if (Array.isArray(events) && events.length > 0) {
            get().pushEvents(events)
            throttledRefresh()
          }
        })
        socket.on('connect_error', () => set({ connected: false }))
      } catch {
        set({ connected: false })
      }
    })()
  }

  return {
    snapshot: null,
    events: [],
    connected: false,
    loading: true,
    view: 'central',
    selectedAgentId: null,
    lastError: null,

    setView: (v) => set({ view: v }),
    selectAgent: (id) => set({ selectedAgentId: id, ...(id ? { view: 'agents' as EecView } : {}) }),

    refresh,

    command: async (type, payload = {}, idempotencyKey) => {
      const res = await dispatchCommand(type, payload, idempotencyKey)
      // refresco inmediato: los comandos cambian el estado operacional
      void throttledRefresh()
      return res
    },

    pushEvents: (incoming) => {
      const current = get().events
      const merged = [...incoming.slice().reverse(), ...current]
        .filter((e, i, arr) => arr.findIndex(x => x.seq === e.seq) === i)
        .slice(0, 250)
      set({ events: merged })
    },

    setConnected: (v) => set({ connected: v }),
  }
})

/** Hook de arranque: montar una vez en el shell. */
export function useEecBootstrap(): void {
  if (typeof window !== 'undefined' && !globalForSocket.__eecPollInit) {
    globalForSocket.__eecPollInit = true
    void useEecStore.getState().refresh()
    // socket realtime
    void (async () => {
      try {
        const { io } = await import('socket.io-client')
        const socket = io('/?XTransformPort=3030', { path: '/', reconnectionDelayMax: 5000, transports: ['websocket', 'polling'] })
        socket.on('connect', () => useEecStore.getState().setConnected(true))
        socket.on('disconnect', () => useEecStore.getState().setConnected(false))
        socket.on('connect_error', () => useEecStore.getState().setConnected(false))
        socket.on('eec:events', (events: EecEventItem[]) => {
          if (Array.isArray(events) && events.length > 0) {
            useEecStore.getState().pushEvents(events)
            void useEecStore.getState().refresh()
          }
        })
      } catch {
        useEecStore.getState().setConnected(false)
      }
    })()
    // respaldo 1: polling del snapshot
    setInterval(() => { void useEecStore.getState().refresh() }, 4000)
    // respaldo 2: polling del bus de eventos cuando el WS no conecta (gateway no presente)
    let eventCursor = 0
    let eventsPolling = false
    setInterval(() => {
      if (useEecStore.getState().connected || eventsPolling) return
      eventsPolling = true
      void (async () => {
        try {
          const res = await fetch(`/api/eec/events?since=${eventCursor}&limit=150`, { cache: 'no-store' })
          if (res.ok) {
            const data = (await res.json()) as { events: EecEventItem[]; lastSeq: number }
            if (data.events.length > 0) {
              eventCursor = data.lastSeq
              useEecStore.getState().pushEvents(data.events)
            }
          }
        } catch { /* reintento */ } finally {
          eventsPolling = false
        }
      })()
    }, 3000)
  }
}

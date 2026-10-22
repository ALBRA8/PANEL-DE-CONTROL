'use client'
// ============================================================
// EEC V2 §6/§8 — AUTENTICACIÓN DEL OPERADOR (UI)
// Diálogo mínimo: la identidad la establece el servidor (cookie
// httpOnly firmada). La UI solo refleja el estado; nunca suplanta.
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import { KeyRound, LogOut, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type AuthState = { configured: boolean; authenticated: boolean; via: string | null }

export function OperatorLogin() {
  const [state, setState] = useState<AuthState | null>(null)
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/eec/auth', { cache: 'no-store' })
      const data = (await res.json()) as AuthState
      setState(data)
      return data
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onAuthRequired = () => { void refresh(); setOpen(true) }
    window.addEventListener('eec:auth-required', onAuthRequired as EventListener)
    return () => window.removeEventListener('eec:auth-required', onAuthRequired as EventListener)
  }, [refresh])

  const login = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/eec/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        setPassword('')
        setOpen(false)
        await refresh()
        window.dispatchEvent(new CustomEvent('eec:auth-ok'))
      } else {
        const j = (await res.json()) as { error?: string }
        setError(j.error === 'invalid_credentials' ? 'Credenciales inválidas' : j.error === 'auth_not_configured' ? 'Servidor sin credenciales configuradas' : `Error ${res.status}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    await fetch('/api/eec/auth', { method: 'DELETE' })
    await refresh()
  }

  if (!state) return null

  return (
    <>
      {state.authenticated ? (
        <div
          className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300"
          title={`Operador autenticado (${state.via})`}
        >
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">Operador</span>
          <button onClick={logout} className="ml-1 text-emerald-400/70 hover:text-emerald-300" title="Cerrar sesión">
            <LogOut className="h-3 w-3" aria-hidden />
          </button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          className="h-7 gap-1.5 border-amber-500/40 bg-amber-500/10 px-2 text-xs text-amber-300 hover:bg-amber-500/20"
          title="Iniciar sesión como operador"
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">Sin sesión</span>
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 text-slate-100 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
              Autenticación de operador
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-400">
              Las acciones del panel requieren identidad verificada en el servidor. La identidad no puede declararse desde el cliente.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && password) void login() }}
              placeholder="Contraseña del operador"
              autoFocus
              className="bg-slate-800 border-slate-700"
            />
            {error && <p className="text-xs text-rose-400">{error}</p>}
            <Button onClick={login} disabled={busy || !password} className="w-full bg-emerald-600 hover:bg-emerald-500">
              {busy ? 'Verificando…' : 'Iniciar sesión'}
            </Button>
            <p className="text-[10px] leading-relaxed text-slate-500">
              La contraseña se configura con EEC_OPERATOR_PASSWORD en el servidor. Nunca se almacena en el navegador.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

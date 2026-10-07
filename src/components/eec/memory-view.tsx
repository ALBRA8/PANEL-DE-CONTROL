'use client'

// ============================================================
// EEC — MEMORIA + CONOCIMIENTO (spec §18, §19)
// - Memoria por scopes: escritura DELIBERADA del operador,
//   con clasificación, importancia, tags y procedencia.
// - Conocimiento publicado + filtro de permisos por clasificación.
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Brain, Database, Info, PenLine, RefreshCw, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useEecStore } from '@/store/eec-store'
import { timeAgo } from '@/lib/eec-client'

// ---------- tipos locales (formas de la API) ----------
interface MemoryRow {
  id: string
  agentId: string | null
  scope: string
  kind: string
  content: string
  importance: number
  classification: string
  provenanceJson: string
  tagsJson: string
  expiresAt: string | null
  createdAt: string
}

interface KnowledgeRow {
  id: string
  title: string
  sourceType: string
  excerpt: string
  classification: string
  score: number
}

const SCOPES = ['SHORT_TERM_CONTEXT', 'WORKING_CONTEXT', 'LONG_TERM_MEMORY', 'ORGANIZATIONAL_MEMORY'] as const

const SCOPE_LABEL: Record<string, string> = {
  SHORT_TERM_CONTEXT: 'corto plazo',
  WORKING_CONTEXT: 'contexto de trabajo',
  LONG_TERM_MEMORY: 'memoria larga',
  ORGANIZATIONAL_MEMORY: 'memoria organizacional',
}

const CLASSIFICATION_STYLE: Record<string, string> = {
  PUBLIC: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  INTERNAL: 'bg-teal-400/10 text-teal-300 border-teal-400/30',
  CONFIDENTIAL: 'bg-amber-400/10 text-amber-300 border-amber-400/30',
  RESTRICTED: 'bg-orange-500/15 text-orange-300 border-orange-500/40',
  SECRET: 'bg-rose-600/15 text-rose-300 border-rose-600/40',
}

const SOURCE_TYPES = ['DOCUMENT', 'DATABASE', 'WEB', 'INTERNAL_SYSTEM', 'CLIENT_DATA', 'DOMAIN'] as const

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function prettyJson(raw: string | null | undefined): string {
  if (!raw) return '{}'
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** Etiqueta de expiración futura ("expira en 4m") — timeAgo solo mira al pasado. */
function untilLabel(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'expirada'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `expira en ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `expira en ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `expira en ${h}h`
  return `expira el ${new Date(iso).toLocaleDateString('es-CO')}`
}

function importanceCls(n: number): string {
  if (n >= 8) return 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30'
  if (n >= 5) return 'bg-teal-400/10 text-teal-300 border-teal-400/30'
  return 'bg-slate-500/15 text-slate-400 border-slate-500/30'
}

export default function MemoryView() {
  const command = useEecStore((s) => s.command)

  const [scope, setScope] = useState('ALL')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [memory, setMemory] = useState<MemoryRow[]>([])
  const [knowledge, setKnowledge] = useState<KnowledgeRow[]>([])
  const [loading, setLoading] = useState(true)

  // dialog: escribir memoria
  const [writeOpen, setWriteOpen] = useState(false)
  const [wScope, setWScope] = useState<string>('WORKING_CONTEXT')
  const [wContent, setWContent] = useState('')
  const [wImportance, setWImportance] = useState<number[]>([5])
  const [wClassification, setWClassification] = useState('INTERNAL')
  const [wTags, setWTags] = useState('')
  const [writing, setWriting] = useState(false)

  // dialog: publicar conocimiento
  const [publishOpen, setPublishOpen] = useState(false)
  const [pTitle, setPTitle] = useState('')
  const [pSourceType, setPSourceType] = useState<string>('DOCUMENT')
  const [pContent, setPContent] = useState('')
  const [pClassification, setPClassification] = useState('INTERNAL')
  const [pTags, setPTags] = useState('')
  const [publishing, setPublishing] = useState(false)

  const load = useCallback(async (q: string, sc: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (sc !== 'ALL') params.set('scope', sc)
      const qs = params.toString()
      const res = await fetch(`/api/eec/memory${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`memory ${res.status}`)
      const data = (await res.json()) as { memory: MemoryRow[]; knowledge: KnowledgeRow[] }
      setMemory(Array.isArray(data.memory) ? data.memory : [])
      setKnowledge(Array.isArray(data.knowledge) ? data.knowledge : [])
    } catch (err) {
      toast.error('No se pudo cargar memoria y conocimiento', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(appliedQuery, scope)
  }, [appliedQuery, scope, load])

  // ---------- escribir memoria (deliberado, spec §18) ----------
  const submitMemory = useCallback(async () => {
    if (wContent.trim().length < 3) {
      toast.error('El contenido de la memoria es obligatorio (mínimo 3 caracteres)')
      return
    }
    setWriting(true)
    try {
      const tags = wTags.split(',').map((t) => t.trim()).filter(Boolean)
      const res = await command('memory.write', {
        scope: wScope,
        content: wContent.trim(),
        importance: wImportance[0] ?? 5,
        classification: wClassification,
        tags,
      })
      if (res.ok) {
        toast.success('Memoria escrita — deliberada, auditada y con procedencia')
        setWriteOpen(false)
        setWContent('')
        setWTags('')
        setWImportance([5])
        void load(appliedQuery, scope)
      } else {
        toast.error('El pipeline rechazó memory.write', { description: res.error ?? res.status })
      }
    } catch (err) {
      toast.error('Error ejecutando memory.write', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setWriting(false)
    }
  }, [appliedQuery, command, load, scope, wClassification, wContent, wImportance, wScope, wTags])

  // ---------- publicar conocimiento ----------
  const submitKnowledge = useCallback(async () => {
    if (pTitle.trim().length < 3) {
      toast.error('El título es obligatorio (mínimo 3 caracteres)')
      return
    }
    if (pContent.trim().length < 10) {
      toast.error('El contenido es obligatorio (mínimo 10 caracteres)')
      return
    }
    setPublishing(true)
    try {
      const tags = pTags.split(',').map((t) => t.trim()).filter(Boolean)
      const res = await command('knowledge.publish', {
        title: pTitle.trim(),
        sourceType: pSourceType,
        content: pContent.trim(),
        classification: pClassification,
        tags,
      })
      if (res.ok) {
        toast.success('Conocimiento publicado en la base de conocimiento')
        setPublishOpen(false)
        setPTitle('')
        setPContent('')
        setPTags('')
        void load(appliedQuery, scope)
      } else {
        toast.error('El pipeline rechazó knowledge.publish', { description: res.error ?? res.status })
      }
    } catch (err) {
      toast.error('Error ejecutando knowledge.publish', {
        description: err instanceof Error ? err.message : 'error de red',
      })
    } finally {
      setPublishing(false)
    }
  }, [appliedQuery, pClassification, pContent, pSourceType, pTags, pTitle, command, load, scope])

  return (
    <div className="flex flex-col gap-4" aria-label="Memoria y conocimiento">
      <Tabs defaultValue="memory" className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList className="bg-slate-900/80">
            <TabsTrigger value="memory" className="text-xs sm:text-sm">Memoria</TabsTrigger>
            <TabsTrigger value="knowledge" className="text-xs sm:text-sm">Conocimiento</TabsTrigger>
          </TabsList>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void load(appliedQuery, scope) }}
            disabled={loading}
          >
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            Actualizar
          </Button>
        </div>

        {/* ================= MEMORIA ================= */}
        <TabsContent value="memory" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setAppliedQuery(query)
                }}
                onBlur={() => setAppliedQuery(query)}
                placeholder="buscar en contenido… (Enter para aplicar)"
                className="border-slate-800 bg-slate-900 pl-8 text-slate-200 placeholder:text-slate-600"
                aria-label="Buscar en memoria"
              />
            </div>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger className="w-56 border-slate-800 bg-slate-900 text-slate-200" aria-label="Scope de memoria">
                <SelectValue placeholder="scope" />
              </SelectTrigger>
              <SelectContent className="border-slate-800 bg-slate-950">
                <SelectItem value="ALL">todos los scopes</SelectItem>
                {SCOPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="font-mono text-xs">{s}</span>
                    <span className="ml-2 text-[10px] text-slate-500">{SCOPE_LABEL[s]}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={() => setWriteOpen(true)}>
              <PenLine className="size-4" aria-hidden />
              Escribir memoria
            </Button>
          </div>

          <p className="flex items-start gap-2 rounded-md border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-xs text-violet-300">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            La escritura de memoria es un acto deliberado del operador: el EEC no genera memoria
            automáticamente sin registro, clasificación y procedencia (spec §18).
          </p>

          {loading && memory.length === 0 ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-20 rounded-lg bg-slate-800/60" />
              <Skeleton className="h-20 rounded-lg bg-slate-800/60" />
              <Skeleton className="h-20 rounded-lg bg-slate-800/60" />
            </div>
          ) : memory.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Sin registros de memoria para este filtro.
            </p>
          ) : (
            <ScrollArea className="max-h-[520px] rounded-lg border border-slate-800 bg-slate-900/40">
              <div className="flex flex-col divide-y divide-slate-800/70">
                {memory.map((m) => {
                  const tags = parseTags(m.tagsJson)
                  return (
                    <div key={m.id} className="flex flex-col gap-2 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="border-slate-700 bg-slate-800/60 font-mono text-[10px] text-slate-300">
                          <Brain className="size-3" aria-hidden />
                          {m.scope}
                        </Badge>
                        <Badge variant="outline" className="font-mono text-[10px] text-slate-400">{m.kind}</Badge>
                        <Badge variant="outline" className={`text-[10px] ${CLASSIFICATION_STYLE[m.classification] ?? 'border-slate-700 text-slate-400'}`}>
                          {m.classification}
                        </Badge>
                        <Badge variant="outline" className={`font-mono text-[10px] ${importanceCls(m.importance)}`}>
                          imp {m.importance}/10
                        </Badge>
                        <span className="ml-auto text-[11px] text-slate-500" title={m.createdAt}>
                          {timeAgo(m.createdAt)}
                        </span>
                      </div>

                      <p className="whitespace-pre-wrap text-sm text-slate-200">{m.content}</p>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
                        {m.agentId && (
                          <span className="font-mono" title={m.agentId}>agente {m.agentId.slice(0, 14)}…</span>
                        )}
                        {m.expiresAt && <span className="text-amber-300/80">{untilLabel(m.expiresAt)}</span>}
                        {tags.length > 0 && (
                          <span className="flex flex-wrap gap-1">
                            {tags.map((t) => (
                              <span key={t} className="rounded border border-slate-700/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                                {t}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>

                      <Collapsible className="group/proc">
                        <CollapsibleTrigger className="flex w-fit items-center gap-1 font-mono text-[10px] uppercase text-slate-500 hover:text-slate-300">
                          procedencia
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-2 font-mono text-xs text-violet-200">
                            {prettyJson(m.provenanceJson)}
                          </pre>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </TabsContent>

        {/* ================= CONOCIMIENTO ================= */}
        <TabsContent value="knowledge" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-2xl text-xs text-slate-500">
              El retrieval filtra por clasificación ≤ clearance del agente (spec §19): el resultado depende
              del nivel de autorización con el que se consulta.
            </p>
            <Button size="sm" className="bg-violet-500 text-violet-950 hover:bg-violet-400" onClick={() => setPublishOpen(true)}>
              <Database className="size-4" aria-hidden />
              Publicar conocimiento
            </Button>
          </div>

          {loading && knowledge.length === 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Skeleton className="h-36 rounded-lg bg-slate-800/60" />
              <Skeleton className="h-36 rounded-lg bg-slate-800/60" />
            </div>
          ) : knowledge.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
              Sin conocimiento publicado todavía.
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {knowledge.map((k) => (
                <Card key={k.id} className="flex flex-col gap-2 border-slate-800 bg-slate-900/60">
                  <CardHeader className="gap-1.5 p-4 pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="font-mono text-[10px] text-teal-300">{k.sourceType}</Badge>
                      <Badge variant="outline" className={`text-[10px] ${CLASSIFICATION_STYLE[k.classification] ?? 'border-slate-700 text-slate-400'}`}>
                        {k.classification}
                      </Badge>
                      {k.score > 0 && (
                        <Badge variant="outline" className="border-emerald-400/40 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">
                          score {k.score.toFixed(2)}
                        </Badge>
                      )}
                    </div>
                    <CardTitle className="text-sm leading-snug text-slate-100">{k.title}</CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 pt-0">
                    <p className="line-clamp-3 text-xs text-slate-400">{k.excerpt}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Separator className="bg-slate-800/60" />

      {/* ---------- DIALOG ESCRIBIR MEMORIA ---------- */}
      <Dialog open={writeOpen} onOpenChange={setWriteOpen}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-emerald-300">Escribir memoria</DialogTitle>
            <DialogDescription className="text-slate-400">
              Escritura deliberada: quedará auditada y con procedencia registrada.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label className="text-slate-300">Scope</Label>
                <Select value={wScope} onValueChange={setWScope}>
                  <SelectTrigger className="border-slate-800 bg-slate-900 text-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-950">
                    {SCOPES.map((s) => (
                      <SelectItem key={s} value={s}>
                        <span className="font-mono text-xs">{s}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-slate-300">Clasificación</Label>
                <Select value={wClassification} onValueChange={setWClassification}>
                  <SelectTrigger className="border-slate-800 bg-slate-900 text-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-950">
                    {Object.keys(CLASSIFICATION_STYLE).map((c) => (
                      <SelectItem key={c} value={c}>
                        <span className="font-mono text-xs">{c}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="w-content" className="text-slate-300">Contenido <span className="text-rose-400">*</span></Label>
              <Textarea
                id="w-content"
                value={wContent}
                onChange={(e) => setWContent(e.target.value)}
                placeholder="ej: el cliente ACME prefiere reportes semanales los viernes"
                rows={3}
                className="border-slate-800 bg-slate-900 text-slate-200"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="w-importance" className="text-slate-300">
                Importancia <span className="font-mono text-emerald-300">{wImportance[0] ?? 5}/10</span>
              </Label>
              <Slider
                id="w-importance"
                min={1}
                max={10}
                step={1}
                value={wImportance}
                onValueChange={setWImportance}
                className="[&_[data-slot=slider-range]]:bg-emerald-400"
                aria-label="Importancia de la memoria"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="w-tags" className="text-slate-300">Tags (separadas por coma)</Label>
              <Input
                id="w-tags"
                value={wTags}
                onChange={(e) => setWTags(e.target.value)}
                placeholder="ej: crm:acme, preferencia:reportes"
                className="border-slate-800 bg-slate-900 font-mono text-xs text-slate-200"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setWriteOpen(false)}>Cancelar</Button>
            <Button
              className="bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
              disabled={writing || wContent.trim().length < 3}
              onClick={() => { void submitMemory() }}
            >
              {writing ? 'Escribiendo…' : 'Escribir memoria'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- DIALOG PUBLICAR CONOCIMIENTO ---------- */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="border-slate-800 bg-slate-950 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-violet-300">Publicar conocimiento</DialogTitle>
            <DialogDescription className="text-slate-400">
              Quedará disponible para retrieval de los agentes según su clearance de clasificación.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-title" className="text-slate-300">Título <span className="text-rose-400">*</span></Label>
                <Input
                  id="p-title"
                  value={pTitle}
                  onChange={(e) => setPTitle(e.target.value)}
                  placeholder="ej: política de devoluciones 2025"
                  className="border-slate-800 bg-slate-900 text-slate-200"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-slate-300">Tipo de fuente</Label>
                <Select value={pSourceType} onValueChange={setPSourceType}>
                  <SelectTrigger className="border-slate-800 bg-slate-900 text-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-950">
                    {SOURCE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        <span className="font-mono text-xs">{t}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="p-content" className="text-slate-300">Contenido <span className="text-rose-400">*</span></Label>
              <Textarea
                id="p-content"
                value={pContent}
                onChange={(e) => setPContent(e.target.value)}
                placeholder="ej: los reembolsos parciales se aprueban si el pedido tiene menos de 30 días…"
                rows={5}
                className="border-slate-800 bg-slate-900 text-slate-200"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label className="text-slate-300">Clasificación</Label>
                <Select value={pClassification} onValueChange={setPClassification}>
                  <SelectTrigger className="border-slate-800 bg-slate-900 text-slate-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-slate-800 bg-slate-950">
                    {Object.keys(CLASSIFICATION_STYLE).map((c) => (
                      <SelectItem key={c} value={c}>
                        <span className="font-mono text-xs">{c}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="p-tags" className="text-slate-300">Tags (separadas por coma)</Label>
                <Input
                  id="p-tags"
                  value={pTags}
                  onChange={(e) => setPTags(e.target.value)}
                  placeholder="ej: politicas, devoluciones"
                  className="border-slate-800 bg-slate-900 font-mono text-xs text-slate-200"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPublishOpen(false)}>Cancelar</Button>
            <Button
              className="bg-violet-500 text-violet-950 hover:bg-violet-400"
              disabled={publishing || pTitle.trim().length < 3 || pContent.trim().length < 10}
              onClick={() => { void submitKnowledge() }}
            >
              {publishing ? 'Publicando…' : 'Publicar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

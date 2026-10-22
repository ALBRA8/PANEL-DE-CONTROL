#!/usr/bin/env bun
// ============================================================
// ECHO-AGENT — agente de prueba del piloto E2E (EEC V2, §9)
//
// Proceso REAL, separado del proceso web del EEC. Determinista:
// no ejecuta órdenes arbitrarias, no depende de servicios externos.
//
// Protocolo NDJSON por stdout (contrato del adaptador local-process):
//   {"type":"progress","progress":N,"node":"…","activity":"…"}
//   {"type":"result","ok":true,"output":{…}}   ← última línea
// Health:  agent.mjs --eec-health  →  {"eec":"healthy"} + exit 0
// Cancel:  SIGTERM → {"type":"cancelled"} + exit 130
// Fallo:   input.exitCode ≠ 0, o crashBeforeResult=true (exit 2 sin result)
// Salida malformada: emitMalformed=true (línea basura antes del result)
// ============================================================
import { readFileSync } from 'node:fs'

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

// ---------- health check ----------
if (process.argv.includes('--eec-health')) {
  emit({ eec: 'healthy', agent: 'echo-agent', version: '1.0.0', pid: process.pid })
  process.exit(0)
}

// ---------- cancelación cooperativa ----------
let cancelled = false
process.on('SIGTERM', () => {
  if (cancelled) return
  cancelled = true
  emit({ type: 'cancelled', signal: 'SIGTERM' })
  process.exit(130)
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  // entrada por STDIN (JSON); NUNCA por argv/shell
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch { /* stdin vacío */ }
  let input = {}
  try {
    const parsed = JSON.parse(raw || '{}')
    input = parsed.input ?? parsed ?? {}
  } catch {
    emit({ type: 'result', ok: false, error: 'stdin_not_json' })
    process.exit(1)
  }

  const durationMs = Math.max(0, Math.min(600000, Number(input.durationMs ?? 1500)))
  const chunks = Math.max(1, Math.min(100, Number(input.chunks ?? 5)))
  const exitCode = Math.max(0, Math.min(255, Number(input.exitCode ?? 0)))
  const crashBeforeResult = input.crashBeforeResult === true
  const emitMalformed = input.emitMalformed === true

  const started = Date.now()
  for (let i = 1; i <= chunks; i++) {
    await sleep(durationMs / chunks)
    emit({
      type: 'progress',
      progress: Math.round((i / chunks) * 100),
      node: i / chunks < 0.5 ? 'EXECUTE' : 'VERIFY',
      activity: `echo-agent: trabajo determinista ${i}/${chunks} (pid ${process.pid})`,
    })
  }

  if (emitMalformed) {
    process.stdout.write('ESTA LINEA NO ES JSON {{{\n')
  }

  const result = {
    ok: exitCode === 0 && !crashBeforeResult,
    output: {
      agent: 'echo-agent',
      pid: process.pid,
      durationMsActual: Date.now() - started,
      durationMsRequested: durationMs,
      chunks,
      receivedInput: input,
      deterministic: true,
    },
  }
  if (crashBeforeResult) {
    // fallo real: el proceso muere SIN result line (resultado ambiguo para el EEC)
    process.stderr.write('echo-agent: crash simulado antes del resultado\n')
    process.exit(2)
  }
  emit({ type: 'result', ...result })
  process.exit(exitCode)
}

main().catch((e) => {
  emit({ type: 'result', ok: false, error: `unexpected:${e?.message ?? e}` })
  process.exit(1)
})

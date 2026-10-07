import EecShell from '@/components/eec/shell'

// EEC — ENTERPRISE EXECUTION & CONTROL CENTER
// Única ruta visible. El shell (client) gestiona las vistas operacionales.
// La capa visual refleja REAL STATE (API + eventos); nunca inventa actividad.

export default function Home() {
  return <EecShell />
}

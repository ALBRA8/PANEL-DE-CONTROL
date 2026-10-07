// Next.js instrumentation hook — arranca el EEC (workers + providers) una vez
// por proceso de servidor. Ver: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { bootEEC } = await import('./lib/eec/boot')
  await bootEEC()
}

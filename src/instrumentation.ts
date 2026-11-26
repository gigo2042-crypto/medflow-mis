// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Старт сервера: структурные логи (JSON в production), необязательный хук отчётов об ошибках
// (SENTRY_DSN, выключен по умолчанию), проверка конфигурации — невалидный env, процесс не стартует.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installStructuredLogging } = await import('@/lib/log')
    const { reportError } = await import('@/lib/error-report')
    installStructuredLogging({ onError: process.env.SENTRY_DSN ? (args) => void reportError(args) : undefined })
    const { assertConfig } = await import('@/lib/config')
    try {
      assertConfig()
    } catch (e) {
      console.error((e as Error).message)
      process.exit(1)
    }
    const { APP_VERSION } = await import('@/lib/version')
    console.info(`medflow started: mode=${process.env.APP_MODE === 'demo' ? 'demo' : 'production'} version=${APP_VERSION}`)
  }
}

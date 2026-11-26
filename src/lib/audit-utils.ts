// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Служебные прогоны планировщика (каждые 30–60 с) пишут аудит только при реальной работе:
// иначе журнал за сутки забивается тысячами пустых записей.
export function hadWork(...parts: Array<object | number | null | undefined>): boolean {
  for (const p of parts) {
    if (typeof p === 'number') {
      if (p > 0) return true
    } else if (p && typeof p === 'object') {
      for (const v of Object.values(p)) {
        if (typeof v === 'number' && v > 0) return true
        if (v && typeof v === "object" && hadWork(v)) return true
      }
    }
  }
  return false
}

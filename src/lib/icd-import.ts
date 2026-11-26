// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Разбор выгрузки справочника МКБ-10 из НСИ Минздрава (CSV).
// Поля паспорта справочника 1.2.643.5.1.13.13.11.1005: ID, REC_CODE, MKB_CODE, MKB_NAME,
// ID_PARENT, ADDL_CODE, ACTUAL, DATE. Разделитель — «;» или «,» (определяется по заголовку).
// Также принимается простой CSV с колонками code;name.

export interface IcdRow {
  code: string
  name: string
  parentCode: string | null
  actual: boolean
}

/** Код, который можно поставить диагнозом: рубрика или подрубрика (A00, A00.0, M54.50), не диапазон «A00-B99». */
export const ASSIGNABLE_ICD_RE = /^[A-Z]\d{2}(\.\d{1,2})?$/

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"') q = true
    else if (ch === sep) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export function parseIcdCsv(text: string): { rows: IcdRow[]; skipped: number } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) throw new Error('Пустой файл')
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ','
  const head = splitCsvLine(lines[0], sep).map((h) => h.toUpperCase())
  const col = (...names: string[]) => names.map((n) => head.indexOf(n)).find((i) => i >= 0) ?? -1
  const iCode = col('MKB_CODE', 'CODE')
  const iName = col('MKB_NAME', 'NAME')
  const iId = col('ID')
  const iParent = col('ID_PARENT')
  const iActual = col('ACTUAL')
  if (iCode < 0 || iName < 0) throw new Error('Нет колонок MKB_CODE/MKB_NAME (или code/name) в заголовке')
  const raw = lines.slice(1).map((l) => splitCsvLine(l, sep))
  const codeById = new Map<string, string>()
  if (iId >= 0) for (const r of raw) if (r[iId]) codeById.set(r[iId], (r[iCode] || '').toUpperCase())
  const rows: IcdRow[] = []
  let skipped = 0
  const seen = new Set<string>()
  for (const r of raw) {
    const code = (r[iCode] || '').toUpperCase().replace(/\s+/g, '')
    const name = (r[iName] || '').trim()
    if (!code || !name || seen.has(code)) {
      skipped++
      continue
    }
    seen.add(code)
    const actualRaw = iActual >= 0 ? (r[iActual] || '').trim().toLowerCase() : '1'
    rows.push({
      code,
      name: name.slice(0, 500),
      parentCode: iParent >= 0 && r[iParent] ? codeById.get(r[iParent]) ?? null : null,
      actual: !['0', 'false', 'нет'].includes(actualRaw),
    })
  }
  return { rows, skipped }
}

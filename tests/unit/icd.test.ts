// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Регрессия: МКБ-10 — исправлен M54.9, импорт полного справочника из выгрузки НСИ (CSV). Данные фейковые.
import { describe, expect, it } from 'vitest'
import { ICD_LIST } from '@/lib/icd'
import { ASSIGNABLE_ICD_RE, parseIcdCsv } from '@/lib/icd-import'

describe('МКБ-10', () => {
  it('M54.9 — дорсалгия, головная боль — R51', () => {
    expect(ICD_LIST.find((e) => e.code === 'M54.9')?.name).toBe('Дорсалгия неуточнённая')
    expect(ICD_LIST.find((e) => e.code === 'R51')?.name).toBe('Головная боль')
  })
  it('разбор выгрузки НСИ: родитель по ID_PARENT, ACTUAL, кавычки и «;»', () => {
    const csv = [
      'ID;REC_CODE;MKB_CODE;MKB_NAME;ID_PARENT;ADDL_CODE;ACTUAL;DATE',
      '1;XIII;M00-M99;"Болезни костно-мышечной системы";;;1;',
      '2;;M54;Дорсалгия;1;;1;',
      '3;;M54.9;"Дорсалгия неуточнённая";2;;1;',
      '4;;M54.99;"Тестовый ""устаревший"" код";2;;0;',
    ].join('\n')
    const { rows } = parseIcdCsv(csv)
    expect(rows.find((r) => r.code === 'M54.9')).toEqual({ code: 'M54.9', name: 'Дорсалгия неуточнённая', parentCode: 'M54', actual: true })
    expect(rows.find((r) => r.code === 'M54.99')).toMatchObject({ actual: false, name: 'Тестовый "устаревший" код' })
  })
  it('простой CSV code,name', () => {
    expect(parseIcdCsv('code,name\nR51,Головная боль\n').rows).toEqual([{ code: 'R51', name: 'Головная боль', parentCode: null, actual: true }])
  })
  it('без нужных колонок — ошибка', () => {
    expect(() => parseIcdCsv('a;b\n1;2')).toThrow(/MKB_CODE/)
  })
  it('диагнозом ставится рубрика/подрубрика, не диапазон', () => {
    expect(ASSIGNABLE_ICD_RE.test('M54.9')).toBe(true)
    expect(ASSIGNABLE_ICD_RE.test('R51')).toBe(true)
    expect(ASSIGNABLE_ICD_RE.test('M00-M99')).toBe(false)
  })
})

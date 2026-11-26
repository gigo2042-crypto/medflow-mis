// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Встроенный КРАТКИЙ список МКБ-10 — только для демо и пустой БД.
// В production справочник загружается из НСИ Минздрава (OID 1.2.643.5.1.13.13.11.1005):
// `npm run cli -- icd-import --file <выгрузка.csv>` → таблица IcdCode (см. src/lib/icd-db.ts).

export interface IcdEntry {
  code: string
  name: string
}

export const ICD_LIST: IcdEntry[] = [
  { code: 'K02.0', name: 'Кариес эмали (стадия пятна)' },
  { code: 'K02.1', name: 'Кариес дентина' },
  { code: 'K02.2', name: 'Кариес цемента' },
  { code: 'K03.6', name: 'Отложения (наросты) на зубах' },
  { code: 'K04.0', name: 'Пульпит' },
  { code: 'K04.4', name: 'Острый апикальный периодонтит' },
  { code: 'K04.5', name: 'Хронический апикальный периодонтит' },
  { code: 'K05.0', name: 'Острый гингивит' },
  { code: 'K05.1', name: 'Хронический гингивит' },
  { code: 'K05.3', name: 'Хронический пародонтит' },
  { code: 'K08.9', name: 'Болезнь зубов неуточнённая' },
  { code: 'K11.9', name: 'Болезнь слюнных желёз неуточнённая' },
  { code: 'K13.7', name: 'Поражения слизистой оболочки полости рта' },
  { code: 'J02.9', name: 'Фарингит неуточнённый' },
  { code: 'J03.9', name: 'Острый тонзиллит неуточнённый' },
  { code: 'J04.0', name: 'Острый ларингит' },
  { code: 'J06.9', name: 'Острая инфекция верхних дыхательных путей неуточнённая' },
  { code: 'J20.9', name: 'Острый бронхит неуточнённый' },
  { code: 'J45.9', name: 'Бронхиальная астма неуточнённая' },
  { code: 'H10.9', name: 'Конъюнктивит неуточнённый' },
  { code: 'M54.5', name: 'Боль в поясничном отделе' },
  { code: 'M54.9', name: 'Дорсалгия неуточнённая' },
  { code: 'R51', name: 'Головная боль' },
  { code: 'K29.7', name: 'Гастрит неуточнённый' },
  { code: 'K30', name: 'Функциональная диспепсия' },
  { code: 'K59.0', name: 'Запор' },
  { code: 'I10', name: 'Эссенциальная (первичная) гипертензия' },
  { code: 'E11.9', name: 'Сахарный диабет 2 типа без осложнений' },
  { code: 'Z00.0', name: 'Общий медицинский осмотр' },
  { code: 'Z00.3', name: 'Медицинский осмотр подростка' },
  { code: 'Z34.9', name: 'Наблюдение за нормальной беременностью' },
  { code: 'B34.9', name: 'Вирусная инфекция неуточнённая' },
  { code: 'L23', name: 'Аллергический контактный дерматит' },
  { code: 'R50.9', name: 'Лихорадка неуточнённая' },
  { code: 'R05', name: 'Кашель' },
  { code: 'R07.0', name: 'Боль в горле' },
]

export function searchIcd(query: string, limit = 6): IcdEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored = ICD_LIST.map((e) => {
    const code = e.code.toLowerCase()
    const name = e.name.toLowerCase()
    let s = -1
    if (code.startsWith(q)) s = 3
    else if (code.includes(q)) s = 2
    else if (name.includes(q)) s = 1
    return { e, s }
  })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.e)
}

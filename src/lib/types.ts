// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Общие типы МИС MedFlow (используются сервером и клиентом)

export type SlotStatus = 'FREE' | 'BOOKED' | 'PAST'

export interface Slot {
  start: string // ISO
  time: string // HH:MM
  end: string // HH:MM
  status: SlotStatus
  appointmentId?: string
  patientId?: string
  patientName?: string
  apptStatus?: string
  source?: string
}

export interface DoctorSchedule {
  id: string
  name: string
  specialty: string
  color: string
  workStart: string
  workEnd: string
  workDays?: string
  slotMinutes: number
  dayOff?: string | null // причина, если у врача нерабочий день
  slots: Slot[]
}

export interface PatientLite {
  id: string
  cardNumber: string
  lastName: string
  firstName: string
  middleName: string | null
  phone: string
  gender: string
  birthDate: string | null
  notes: string | null
  appointmentCount: number
  noShowCount: number
  score?: number
}

export interface TemplateItem {
  key: string
  label: string
  type: 'chips' | 'text'
  options?: string[]
  placeholder?: string
}

export interface TemplateSection {
  title: string
  items: TemplateItem[]
}

export interface ProtocolTemplateDTO {
  id: string
  name: string
  specialty: string
  type: string
  sections: TemplateSection[]
}

export interface SessionDTO {
  id: string
  userId: string
  userName: string
  role: string
  device: string
  startedAt: string
  lastActivity: string
  idleSeconds: number
}

export interface AppointmentDTO {
  id: string
  start: string
  duration: number
  status: string
  source: string
  patientId: string
  patientName: string
  patientPhone: string
  cardNumber: string
  doctorId: string
  doctorName: string
  doctorSpecialty: string
  visitId?: string | null
}

export interface RiskItem {
  appointmentId: string
  patientName: string
  doctorName: string
  start: string
  source: string
  risk: number
  riskLabel: string
  riskClass: string
  hint: string
}

export interface DashboardDTO {
  date: string
  todayTotal: number
  byStatus: Record<string, number>
  doneVisits: number
  revenueToday: number
  noShowRate14: number
  doctors: Array<{ id: string; name: string; specialty: string; booked: number; total: number; percent: number }>
  series: Array<{ day: string; label: string; count: number; noShows: number; revenue: number }>
  risks: RiskItem[]
}

export const STATUS_LABELS: Record<string, string> = {
  BOOKED: 'Записан',
  CONFIRMED: 'Подтверждён',
  ARRIVED: 'В клинике',
  DONE: 'Завершён',
  CANCELED: 'Отменён',
  NO_SHOW: 'Неявка',
}

export const SOURCE_LABELS: Record<string, string> = {
  REGISTRAR: 'Регистратура',
  WIDGET: 'Виджет',
  PHONE: 'Звонок',
  WAITLIST: 'Лист ожидания (ответ пациента)',
}

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  REGISTRAR: 'Регистратор',
  DOCTOR: 'Врач',
  MARKETER: 'Маркетолог',
  HEAD: 'Руководитель',
}

// ---- Касса и документы (ФТ-006, ФТ-007, ФТ-009) ----

export interface ServiceDTO {
  id: string
  name: string
  category: string
  price: number
  durationMinutes: number
  active: boolean
}

export interface PaymentItem {
  name: string
  price: number
  qty: number
}

export interface PaymentDTO {
  id: string
  patientId: string
  patientName: string
  cardNumber: string
  visitId: string | null
  amount: number
  method: string
  type: string
  status: string // PAID | CANCELED
  refunded: boolean
  discount: number
  fiscalStatus: string
  fiscalNumber: string | null
  fiscalError?: string | null
  fiscalReceiptUrl?: string | null
  items: PaymentItem[] | null
  note: string | null
  createdByName: string | null
  createdAt: string
}

export interface CashSummary {
  gross: number
  refunds: number
  net: number
  byMethod: Record<string, number>
  count: number
  issued: number
  queued: number
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Наличные',
  CARD: 'Карта',
  SBP: 'СБП',
}

export const FISCAL_LABELS: Record<string, string> = {
  QUEUED: 'Не фискализирован',
  PENDING: 'Отправлен в кассу',
  ISSUED: 'Чек выдан',
  ERROR: 'Ошибка кассы',
  FAILED: 'Ошибка ОФД',
  CANCELED: 'Отменена, чек не пробит',
}

export interface DocTemplateDTO {
  id: string
  code: string
  name: string
  kind: string
}

export interface SignedDocDTO {
  id: string
  patientId: string
  patientName: string
  cardNumber: string
  title: string
  kind: string
  templateName: string
  content: string
  signed: boolean
  signedAt: string | null
  createdByName: string | null
  createdAt: string
}

export interface AuditDTO {
  id: string
  action: string
  userName: string | null
  meta: string | null
  createdAt: string
}

// ---- Лист ожидания (ФТ-004, ТУ-004) ----

export interface WaitingEntryDTO {
  id: string
  position: number | null
  patientId: string
  patientName: string
  patientPhone: string
  cardNumber: string
  doctorId: string | null
  doctorName: string | null
  specialty: string | null
  serviceId: string | null
  serviceName: string | null
  daysMask: string
  fromTime: string
  toTime: string
  priority: number
  status: string
  comment: string | null
  createdAt: string
  offeredDoctorId: string | null
  offeredDoctorName: string | null
  offeredSlot: string | null
  offeredAt: string | null
  offerExpiresAt: string | null
  bookedAppointmentId: string | null
}

export interface WaitingStats {
  active: number
  offered: number
  booked: number
  declined: number
  expired: number
  conversion: number // % записавшихся из закрывшихся заявок
  total: number
}

export const WAITING_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'В очереди',
  OFFERED: 'Предложен слот',
  BOOKED: 'Записан',
  DECLINED: 'Пациент отказался',
  EXPIRED: 'Снят / истёк',
}

export const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

// ---- Напоминания (ФТ-005, ТУ-004) ----

export interface ReminderDTO {
  id: string
  appointmentId: string
  appointmentStatus: string
  patientId: string
  patientName: string
  patientPhone: string
  doctorName: string
  start: string
  level: number
  channel: string
  plannedAt: string
  sentAt: string | null
  status: string
  text: string | null
  response: string | null
  respondedAt: string | null
}

export interface ReminderStats {
  planned: number
  sent: number
  confirmed: number
  declined: number
  canceled: number
  failed: number
  dueNow: number
}

export const REMINDER_STATUS_LABELS: Record<string, string> = {
  PLANNED: 'Запланировано',
  SENT: 'Отправлено',
  FAILED: 'Ошибка отправки',
  CANCELED: 'Отменено',
}

export const CHANNEL_LABELS: Record<string, string> = {
  SMS: 'SMS',
  MAX: 'MAX',
  EMAIL: 'E-mail',
  INBOX: 'Журнал',
  // исторические значения (до перехода на MAX): Telegram/push не подключались
  TELEGRAM: 'Telegram (не подключён)',
  PUSH: 'Push (не подключён)',
}

export const LEVEL_LABELS: Record<number, string> = {
  1: 'за 48 ч',
  2: 'за 24 ч',
  3: 'за 3 ч',
}

export const RESPONSE_LABELS: Record<string, string> = {
  CONFIRMED: 'Подтвердил',
  DECLINED: 'Отменил',
}

// ---- Виджет онлайн-записи (ФТ-012, ТУ-008) ----

export interface WidgetDoctorLite {
  id: string
  name: string
  specialty: string
  nearest?: { date: string; time: string } | null
}

export interface WidgetDayDTO {
  date: string // YYYY-MM-DD
  label: string // «Сегодня · 12.05»
  doctors: Array<{ doctorId: string; slots: Array<{ start: string; time: string }> }>
}

export interface WidgetConfigDTO {
  clinicName: string
  directions: Array<{ specialty: string; doctors: WidgetDoctorLite[] }>
  services: Array<{ id: string; name: string; category: string; price: number; durationMinutes: number }>
  days: WidgetDayDTO[]
  stats: { today: number; week: number } | null // только для сотрудников
  consent: { text: string; version: string } | null // текст согласия на обработку ПДн (152-ФЗ)
  captchaSiteKey: string | null
  demo: boolean
}

// ---- Центр уведомлений (ФТ-013) ----

export interface NotificationDTO {
  id: string
  kind: string
  channel: string
  fallbackFrom?: string | null
  priority: number
  patientId: string | null
  patientName: string | null
  phone: string
  text: string
  status: string
  attempts: number
  maxAttempts: number
  nextAttemptAt: string
  sentAt: string | null
  error: string | null
  externalId: string | null
  createdAt: string
}

export interface NotifyStatsDTO {
  queued: number
  deferredQuiet: number
  sent: number
  failed: number
  blockedBlacklist: number
  blockedLimit: number
  sentToday: number
  dailyLimit: number
  quietActive: boolean
  quietEnd: string | null
  retryMinutes: number
  maxAttempts: number
}

export interface NotifySettingsDTO {
  quietFrom: string
  quietTo: string
  dailyLimit: number
  retryMinutes: number
  maxAttempts: number
}

export interface NotifyTemplateDTO {
  id: string
  code: string
  name: string
  kind: string
  channel: string
  body: string
  active: boolean
}

export interface NotifyBlacklistDTO {
  id: string
  phone: string
  reason: string | null
  createdAt: string
}

export const NOTIFY_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'В очереди',
  SENDING: 'Отправляется',
  INBOX: 'Только в журнале',
  DEFERRED_QUIET: 'Часы тишины',
  SENT: 'Доставлено',
  FAILED: 'Не доставлено',
  BLOCKED_BLACKLIST: 'Чёрный список',
  BLOCKED_LIMIT: 'Лимит тарифа',
}

export const NOTIFY_KIND_LABELS: Record<string, string> = {
  REMINDER: 'Напоминание',
  WAITLIST_OFFER: 'Приглашение из очереди',
  RISK_TOUCH: 'Касание по риску',
  MANUAL: 'Ручное',
}

export function notifyStatusClass(status: string): string {
  switch (status) {
    case 'SENT':
      return 'bg-emerald-100 text-emerald-700'
    case 'QUEUED':
      return 'bg-slate-100 text-slate-600'
    case 'DEFERRED_QUIET':
      return 'bg-violet-100 text-violet-700'
    case 'FAILED':
      return 'bg-rose-100 text-rose-700'
    case 'BLOCKED_BLACKLIST':
      return 'bg-amber-100 text-amber-800'
    case 'BLOCKED_LIMIT':
      return 'bg-orange-100 text-orange-700'
    default:
      return 'bg-slate-100 text-slate-400'
  }
}

// ---- Панель «Риски на сегодня» (ТУ-004, v2) ----

export interface RiskFactorDTO {
  label: string
  impact: number
}

export interface TodayRiskDTO {
  appointmentId: string
  patientId: string
  patientName: string
  patientPhone: string
  doctorName: string
  doctorSpecialty: string
  start: string
  status: string
  source: string
  score: number
  scoreLabel: string
  scoreClass: string
  factors: RiskFactorDTO[]
  scenarioAction: string
  scenarioHint: string
  waitlistCandidates: number
  waitlistFirst: string | null
}

export interface TodayRisksDTO {
  items: TodayRiskDTO[]
  totals: { high: number; medium: number; low: number; checked: number }
}

// ---- Складской контур v2 (ФТ-008): склады, перемещения, инвентаризация ----

export interface WarehouseDTO {
  id: string
  code: string
  name: string
  address: string | null
  kind: string
  active: boolean
  itemsCount: number // позиций с остатком > 0
  totalValue: number // стоимость запаса на складе
}

export interface StockBalanceDTO {
  id: string
  sku: string
  name: string
  category: string
  unit: string
  price: number
  minQty: number
  balances: Array<{ warehouseId: string; qty: number }> // остаток по каждому складу
  total: number // суммарный остаток
  value: number // total × price
  belowMin: boolean
}

export interface StockMovementDTO {
  id: string
  type: string
  qty: number
  price: number
  cost: number
  note: string | null
  visitId: string | null
  createdAt: string
  itemName: string
  itemUnit: string
  itemSku: string
  warehouseId: string | null
  warehouseName: string | null
  transferId: string | null
  inventoryId: string | null
}

export interface StockStats {
  items: number
  belowMin: number
  totalValue: number
  consumedToday: number
  warehouses: number
  transfersInTransit: number
  inventoryOpen: number
  inventorySurplus: number // руб. излишков по завершённым актам
  inventoryShortage: number // руб. недостач по завершённым актам
}

export interface TransferLineDTO {
  id: string
  itemId: string
  name: string
  sku: string
  unit: string
  qty: number
}

export interface TransferDocDTO {
  id: string
  number: string
  status: string // DRAFT | IN_TRANSIT | COMPLETED | CANCELED
  fromWarehouseId: string
  fromWarehouseName: string
  toWarehouseId: string
  toWarehouseName: string
  comment: string | null
  createdBy: string | null
  createdAt: string
  dispatchedAt: string | null
  completedAt: string | null
  lines: TransferLineDTO[]
}

export interface InventoryLineDTO {
  id: string
  itemId: string
  name: string
  sku: string
  unit: string
  accountedQty: number // учётный остаток
  factQty: number | null // факт; null — не посчитано
}

export interface InventoryActDTO {
  id: string
  number: string
  warehouseId: string
  warehouseName: string
  status: string // OPEN | COMPLETED
  comment: string | null
  createdBy: string | null
  createdAt: string
  completedAt: string | null
  surplusCost: number
  shortageCost: number
  lines: InventoryLineDTO[]
}

export const STOCK_MOVEMENT_LABELS: Record<string, string> = {
  IN: 'Приход',
  OUT: 'Расход',
  WRITEOFF: 'Списание',
  INVENTORY: 'Инвентаризация',
  TRANSFER_OUT: 'Перемещение (расход)',
  TRANSFER_IN: 'Перемещение (приход)',
  ADJ_IN: 'Излишки (инвент.)',
  ADJ_OUT: 'Недостача (инвент.)',
}

export const TRANSFER_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Черновик',
  IN_TRANSIT: 'В пути',
  COMPLETED: 'Принято',
  CANCELED: 'Отменено',
}

export const INVENTORY_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Идёт подсчёт',
  COMPLETED: 'Проведена',
}

// ---- Выгрузки в 1С (ИНТ-006, складской контур) ----

export interface OneCExportDTO {
  id: string
  scope: string // NOMENCLATURE | BALANCES | DOCS
  scopeLabel: string
  periodFrom: string
  periodTo: string
  status: string // QUEUED | SENT | CONFIRMED | ERROR
  attempts: number
  docsCount: number
  size: number // байт XML
  createdAt: string
  sentAt: string | null
  confirmedAt: string | null
  error: string | null
}

export const ONEC_SCOPE_LABELS: Record<string, string> = {
  NOMENCLATURE: 'Номенклатура',
  BALANCES: 'Остатки по складам',
  DOCS: 'Документы движений',
}

export const ONEC_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'В очереди',
  SENT: 'Отправлено',
  CONFIRMED: 'Принято 1С',
  ERROR: 'Ошибка (3 попытки)',
}

// ---- Планировщик регулярных отчётов ----

export interface SchedReportDef {
  key: string
  name: string
  note: string
}

export interface ReportRunDTO {
  id: string
  status: string // RUNNING | DONE | FAILED
  startedAt: string
  finishedAt: string | null
  rowsCount: number
  summary: string | null
  emailStatus: string | null // SENT | FAILED | SKIPPED
  emailTo: string | null
  error: string | null
}

export interface ReportScheduleDTO {
  id: string
  name: string
  reportKey: string
  period: string // DAILY | WEEKLY | MONTHLY
  atTime: string
  recipients: string
  active: boolean
  lastRunAt: string | null
  nextRunAt: string
  createdBy: string | null
  runs: ReportRunDTO[]
}

export const SCHEDULE_PERIOD_LABELS: Record<string, string> = {
  DAILY: 'Ежедневно',
  WEEKLY: 'Еженедельно (пн)',
  MONTHLY: 'Ежемесячно (1-е число)',
}

export const RUN_STATUS_LABELS: Record<string, string> = {
  RUNNING: 'Выполняется',
  DONE: 'Готово',
  FAILED: 'Ошибка',
}

// ---- Интеграции (ИНТ-001..018) ----

export interface IntegrationCardDTO {
  key: string
  name: string
  protocol: string
  area: string
  requirement: string
  health: 'CONFIGURED' | 'SIMULATOR' | 'MANUAL' | 'NOT_CONNECTED'
  note: string
}

export interface EgiszDocDTO {
  id: string
  visitId: string
  patientId: string
  patientName: string
  cardNumber: string | null
  doctorName: string | null
  specialty: string | null
  status: string
  smevId: string | null
  error: string | null
  attempts: number
  createdAt: string
  sentAt: string | null
  confirmedAt: string | null
}

export interface LabReferralDTO {
  id: string
  patientId: string
  patientName: string
  visitId: string | null
  lab: string
  tests: Array<{ code: string; name: string }>
  status: string
  resultText: string | null
  error: string | null
  attempts: number
  sentAt: string | null
  importedAt: string | null
  createdAt: string
}

export interface DmsClaimDTO {
  id: string
  visitId: string | null
  patientId: string
  insurer: string
  serviceName: string
  amount: number
  status: string
  denyReason: string | null
  createdAt: string
  submittedAt: string | null
  paidAt: string | null
}

export interface CallEventDTO {
  id: string
  phone: string
  patientId: string | null
  direction: string
  status: string
  duration: number
  recording: boolean
  createdAt: string
}

export interface IntegrationEventDTO {
  id: string
  system: string
  direction: string
  summary: string
  status: string
  attempts: number
  error: string | null
  createdAt: string
}

export interface PolicyDTO {
  id: string
  patientId: string
  patientName: string
  cardNumber: string
  insurer: string
  policyNumber: string
  validTill: string | null
  active: boolean
}

export const EGISZ_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'В очереди',
  SENT: 'Отправлен в СМЭВ',
  CONFIRMED: 'Зарегистрирован',
  ERROR: 'Ошибка / DLQ',
}

export const LAB_STATUS_LABELS: Record<string, string> = {
  CREATED: 'Создан',
  SENT: 'Передан в лабораторию',
  RESULT_READY: 'Результаты готовы',
  IMPORTED: 'Импортирован в ЭМК',
  ERROR: 'Ошибка / DLQ',
}

export const DMS_STATUS_LABELS: Record<string, string> = {
  CREATED: 'В реестре',
  SUBMITTED: 'Отправлен страховой',
  PAID: 'Оплачен',
  DENIED: 'Отказ страховой',
}

export const CALL_STATUS_LABELS: Record<string, string> = {
  INCOMING: 'Входящий…',
  ANSWERED: 'Принят',
  MISSED: 'Пропущен',
  TASK: 'Задача',
}

// ---- Отчётность (ОТЧ-01..36) ----

export interface ReportColumn {
  key: string
  label: string
}

export interface ReportDTO {
  code: string
  name: string
  note: string
  columns: ReportColumn[]
  rows: Array<Array<string | number>>
}

export interface CatalogItemDTO {
  code: string
  name: string
  section: string
  stage: string
  implemented: boolean
}

export type ReportsCatalog = CatalogItemDTO[]

export const REPORT_SECTIONS: Array<{ key: string; label: string }> = [
  { key: 'operations', label: 'Операции' },
  { key: 'marketing', label: 'Маркетинг' },
  { key: 'patients', label: 'Пациенты' },
  { key: 'finance', label: 'Финансы' },
  { key: 'stock', label: 'Склад' },
  { key: 'staff', label: 'Персонал' },
  { key: 'compliance', label: 'Комплаенс' },
  { key: 'predictive', label: 'Предиктив' },
]

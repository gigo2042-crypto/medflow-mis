// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
/**
 * Мини-сервис «Email-провайдер» (ИНТ-014) — демо МИС MedFlow.
 *
 * ТЗ ИНТ-014: «Email-провайдер — транзакционные письма: уведомления,
 * отчёты, приглашения; SMTP/REST провайдера; Fallback на резервный SMTP;
 * 3 попытки, далее в центр уведомлений».
 *
 * Только для демо-стенда: наружу письма НЕ отправляются, доставка имитируется.
 * Node 22+ (type stripping), без внешних зависимостей. Порт EMAIL_PROVIDER_PORT (3040).
 * Доступ к /api/* — только с заголовком X-Service-Key (SERVICE_KEY) или по Basic-auth консоли.
 *
 * REST API:
 *   POST /api/send              — принять письмо в очередь (валидация to/subject)
 *   GET  /api/messages          — список (без html/attachment) + статистика
 *   GET  /api/messages/:id     — письмо целиком (html, attachment, meta)
 *   POST /api/reset             — очистить историю
 *   POST /api/admin/fail-next   — одноразовый флаг: следующее письмо
 *                                  форсированно проваливает все попытки
 *                                  (3 основных + резервный SMTP) → FAILED
 *   GET  /api/stats             — статистика
 *   GET  /                      — демо-консоль (HTML)
 *
 * Воркер доставки (каждые 2500 мс, одно письмо за тик, старейшее первым):
 *   основной провайдер — 92% успеха; при неудаче попытки растут до 3,
 *   затем резервный SMTP — 97% успеха; окончательная неудача → FAILED,
 *   webhook статуса уходит в МИС (Центр уведомлений, ФТ-013).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Типы
// ---------------------------------------------------------------------------

export interface EmailAttachment {
  filename: string;
  base64: string;
}

export interface EmailMeta {
  [key: string]: unknown;
}

export type EmailStatus = 'QUEUED' | 'SENT' | 'FAILED';
export type EmailProvider = 'primary' | 'fallback';

export interface EmailMessage {
  id: string;
  to: string;
  subject: string;
  html: string;
  category: string;
  attachment: EmailAttachment | null;
  meta: EmailMeta | null;
  status: EmailStatus;
  attempts: number;
  provider: EmailProvider | null;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
}

export interface EmailListRow {
  id: string;
  to: string;
  subject: string;
  category: string;
  status: EmailStatus;
  attempts: number;
  provider: EmailProvider | null;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
  attachmentName: string | null;
  meta: EmailMeta | null;
}

export interface StatsPayload {
  total: number;
  queued: number;
  sent: number;
  failed: number;
  last24h: number;
}

// ---------------------------------------------------------------------------
// Константы и конфигурация
// ---------------------------------------------------------------------------

const PORT = Number(process.env.EMAIL_PROVIDER_PORT || 3040);
const MIS_URL = process.env.MIS_URL ?? 'http://localhost:3000';
// Ключ обязателен: без него сервис не стартует (чеклист п.3)
const SERVICE_KEY = process.env.SERVICE_KEY ?? '';
if (SERVICE_KEY.length < 24 || SERVICE_KEY === 'medflow-service-key') {
  console.error('[email-provider] SERVICE_KEY не задан или слабый — запуск отменён');
  process.exit(1);
}
// Пароль демо-консоли (Basic-auth, логин admin). Не задан — консоль выключена.
const CONSOLE_PASSWORD = process.env.EMAIL_CONSOLE_PASSWORD ?? '';

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function hasServiceKey(req: Request): boolean {
  return safeEq(req.headers.get('x-service-key') ?? '', SERVICE_KEY);
}

function hasConsoleAuth(req: Request): boolean {
  if (!CONSOLE_PASSWORD) return false;
  const h = req.headers.get('authorization') ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return user === 'admin' && safeEq(rest.join(':'), CONSOLE_PASSWORD);
}

const TICK_MS = 2500;          // период воркера доставки
const MAX_ATTEMPTS = 3;        // попыток основного провайдера до fallback
const PRIMARY_SUCCESS = 0.92;  // вероятность успеха основного SMTP/REST
const FALLBACK_SUCCESS = 0.97; // вероятность успеха резервного SMTP
const MAX_PERSISTED = 500;     // предел хранения писем (лишние — старейшие)

const DATA_DIR = process.env.EMAIL_PROVIDER_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), 'data');
const DATA_FILE = join(DATA_DIR, 'messages.json');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Состояние (в памяти) + персистентность
// ---------------------------------------------------------------------------

/** Письма; порядок массива = порядок поступления (старейшее первым). */
const messages: EmailMessage[] = [];

/** Одноразовый флаг /api/admin/fail-next (см. ТЗ: демо возврата в Центр уведомлений). */
let failNextFlag = false;
/** id письма, «обречённого» на полную неудачу (3 попытки + fallback провалятся). */
let doomedId: string | null = null;
/** id писем, по которым webhook уже отправлен (защита от дублей). */
const webhookDone = new Set<string>();

function idToSeq(id: string): number {
  const n = Number.parseInt(id.replace(/^EM-/, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function makeId(seq: number): string {
  return 'EM-' + String(seq).padStart(4, '0');
}

function isEmailAttachment(v: unknown): v is EmailAttachment {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return typeof a.filename === 'string' && typeof a.base64 === 'string';
}

function isEmailMessage(v: unknown): v is EmailMessage {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.to === 'string' &&
    typeof m.subject === 'string' &&
    typeof m.html === 'string' &&
    typeof m.category === 'string' &&
    (m.attachment === null || isEmailAttachment(m.attachment)) &&
    (m.meta === null || typeof m.meta === 'object') &&
    (m.status === 'QUEUED' || m.status === 'SENT' || m.status === 'FAILED') &&
    typeof m.attempts === 'number' &&
    (m.provider === null || m.provider === 'primary' || m.provider === 'fallback') &&
    typeof m.createdAt === 'string' &&
    (m.sentAt === null || typeof m.sentAt === 'string') &&
    (m.error === null || typeof m.error === 'string')
  );
}

function loadSnapshot(): EmailMessage[] {
  try {
    if (!existsSync(DATA_FILE)) return [];
    const raw: unknown = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
    if (!Array.isArray(raw)) return [];
    const parsed = raw.filter(isEmailMessage);
    // Предел хранения: при переполнении выбрасываем старейшие.
    if (parsed.length > MAX_PERSISTED) return parsed.slice(parsed.length - MAX_PERSISTED);
    return parsed;
  } catch (err) {
    console.warn('[persist] не удалось прочитать снапшот, начинаем с пустой истории:', err);
    return [];
  }
}

async function persistSnapshot(): Promise<void> {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(messages, null, 2));
  } catch (err) {
    console.warn('[persist] не удалось записать снапшот:', err);
  }
}

function capMessages(): void {
  if (messages.length > MAX_PERSISTED) {
    messages.splice(0, messages.length - MAX_PERSISTED);
  }
}

messages.push(...loadSnapshot());
capMessages();

let seq = messages.reduce((max, m) => Math.max(max, idToSeq(m.id)), 0) + 1;

// ---------------------------------------------------------------------------
// Статистика и построение строк списка
// ---------------------------------------------------------------------------

function computeStats(): StatsPayload {
  const now = Date.now();
  let queued = 0;
  let sent = 0;
  let failed = 0;
  let last24h = 0;
  for (const m of messages) {
    if (m.status === 'QUEUED') queued += 1;
    else if (m.status === 'SENT') sent += 1;
    else if (m.status === 'FAILED') failed += 1;
    const created = Date.parse(m.createdAt);
    if (Number.isFinite(created) && now - created < 24 * 60 * 60 * 1000) last24h += 1;
  }
  return { total: messages.length, queued, sent, failed, last24h };
}

function toListRow(m: EmailMessage): EmailListRow {
  return {
    id: m.id,
    to: m.to,
    subject: m.subject,
    category: m.category,
    status: m.status,
    attempts: m.attempts,
    provider: m.provider,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
    error: m.error,
    attachmentName: m.attachment ? m.attachment.filename : null,
    meta: m.meta,
  };
}

// ---------------------------------------------------------------------------
// Webhook статусов в МИС (best-effort)
// ---------------------------------------------------------------------------

async function notifyMis(msg: EmailMessage): Promise<void> {
  if (webhookDone.has(msg.id)) return; // не отправлять webhook дважды
  webhookDone.add(msg.id);

  const payload = {
    id: msg.id,
    status: msg.status === 'SENT' ? 'DELIVERED' : 'FAILED',
    to: msg.to,
    subject: msg.subject,
    category: msg.category,
    attempts: msg.attempts,
    meta: msg.meta ?? null,
  };

  try {
    const res = await fetch(`${MIS_URL}/api/integrations/email/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-key': SERVICE_KEY,
      },
      body: JSON.stringify(payload),
    });
    console.log(`[webhook] ${msg.id} ${payload.status} → ${MIS_URL}: HTTP ${res.status}`);
  } catch (err) {
    // Best-effort: ошибка webhook не должна рушить сервис.
    console.warn(`[webhook] ${msg.id} ${payload.status} → ${MIS_URL}: не доставлен`, err);
  }
}

// ---------------------------------------------------------------------------
// Воркер доставки (setInterval, 2500 мс, одно письмо за тик)
// ---------------------------------------------------------------------------

async function deliverTick(): Promise<void> {
  const msg = messages.find((m) => m.status === 'QUEUED'); // старейшее первым
  if (!msg) return;

  // Одноразовый флаг admin/fail-next привязывается к этому письму:
  // все 3 попытки основного провайдера и резервный SMTP будут неудачными.
  if (failNextFlag) {
    failNextFlag = false;
    doomedId = msg.id;
    console.log(`[worker] флаг fail-next привязан к ${msg.id}: полная неудача доставки запланирована`);
  }

  const doomed = doomedId !== null && doomedId === msg.id;
  const primaryOk = doomed ? false : Math.random() < PRIMARY_SUCCESS;

  if (primaryOk) {
    msg.status = 'SENT';
    msg.provider = 'primary';
    msg.sentAt = new Date().toISOString();
    await persistSnapshot();
    console.log(`[worker] ${msg.id} доставлено основным провайдером → ${msg.to}`);
    void notifyMis(msg);
    return;
  }

  msg.attempts += 1;

  if (msg.attempts < MAX_ATTEMPTS) {
    // Осталось в очереди — повторная попытка на следующем тике.
    await persistSnapshot();
    console.log(`[worker] ${msg.id} попытка ${msg.attempts}/${MAX_ATTEMPTS} неудачна, будет повтор`);
    return;
  }

  // Попытки основного провайдера исчерпаны → резервный SMTP.
  const fallbackOk = doomed ? false : Math.random() < FALLBACK_SUCCESS;
  if (fallbackOk) {
    msg.status = 'SENT';
    msg.provider = 'fallback';
    msg.sentAt = new Date().toISOString();
    msg.error = null;
    console.log(`[worker] ${msg.id} доставлено резервным SMTP → ${msg.to}`);
  } else {
    msg.status = 'FAILED';
    msg.provider = 'fallback'; // последним пробовали резервный SMTP
    msg.error = 'Не доставлено: 3 попытки + резервный SMTP';
    console.log(`[worker] ${msg.id} FAILED (${msg.error}) → в Центр уведомлений через webhook`);
  }

  if (doomed && doomedId === msg.id) doomedId = null;

  await persistSnapshot();
  void notifyMis(msg);
}

setInterval(() => {
  void deliverTick();
}, TICK_MS);

// ---------------------------------------------------------------------------
// HTTP-хелперы
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-service-key',
      'Cache-Control': 'no-store',
    },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// Обработчики API
// ---------------------------------------------------------------------------

async function handleSend(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Некорректный JSON в теле запроса' }, 400);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonResponse({ error: 'Ожидается JSON-объект' }, 400);
  }
  const body = raw as Record<string, unknown>;

  // Валидация: email regex + непустая тема (по ТЗ).
  const to = typeof body.to === 'string' ? body.to.trim() : '';
  if (!to || !EMAIL_RE.test(to)) {
    return jsonResponse({ error: 'Некорректный адрес получателя: поле to должно быть email' }, 400);
  }
  const subject = typeof body.subject === 'string' ? body.subject : '';
  if (!subject.trim()) {
    return jsonResponse({ error: 'Тема письма обязательна: поле subject не может быть пустым' }, 400);
  }

  let html = '';
  if (typeof body.html === 'string') html = body.html;
  else if (body.html !== undefined && body.html !== null) {
    return jsonResponse({ error: 'Поле html должно быть строкой' }, 400);
  }

  let category = 'MANUAL';
  if (typeof body.category === 'string' && body.category.trim()) category = body.category.trim();
  else if (body.category !== undefined && body.category !== null) {
    return jsonResponse({ error: 'Поле category должно быть строкой' }, 400);
  }

  let attachment: EmailAttachment | null = null;
  const att = body.attachment;
  if (att !== undefined && att !== null) {
    if (typeof att !== 'object' || Array.isArray(att)) {
      return jsonResponse({ error: 'Поле attachment должно быть объектом { filename, base64 }' }, 400);
    }
    const a = att as Record<string, unknown>;
    if (typeof a.filename !== 'string' || !a.filename.trim() || typeof a.base64 !== 'string' || !a.base64) {
      return jsonResponse({ error: 'attachment: обязательны непустые строки filename и base64' }, 400);
    }
    attachment = { filename: a.filename.trim(), base64: a.base64 };
  }

  let meta: EmailMeta | null = null;
  if (body.meta !== undefined && body.meta !== null) {
    if (typeof body.meta !== 'object' || Array.isArray(body.meta)) {
      return jsonResponse({ error: 'Поле meta должно быть объектом' }, 400);
    }
    meta = body.meta as EmailMeta;
  }

  const message: EmailMessage = {
    id: makeId(seq),
    to,
    subject,
    html,
    category,
    attachment,
    meta,
    status: 'QUEUED',
    attempts: 0,
    provider: null,
    createdAt: new Date().toISOString(),
    sentAt: null,
    error: null,
  };
  seq += 1;

  messages.push(message);
  capMessages();
  await persistSnapshot();
  console.log(`[send] ${message.id} → ${to} «${subject}» [${category}] принято в очередь`);

  return jsonResponse({ id: message.id, status: message.status }, 200);
}

function handleList(url: URL): Response {
  const limitRaw = url.searchParams.get('limit');
  let limit = 100;
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, 500);
  }

  const category = url.searchParams.get('category');
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();

  const filtered = messages.filter((m) => {
    if (category && category !== 'all' && m.category !== category) return false;
    if (q && !(m.to.toLowerCase().includes(q) || m.subject.toLowerCase().includes(q))) return false;
    return true;
  });

  // createdAt по убыванию, при равенстве — по номеру id.
  filtered.sort((a, b) => {
    const byDate = b.createdAt.localeCompare(a.createdAt);
    if (byDate !== 0) return byDate;
    return idToSeq(b.id) - idToSeq(a.id);
  });

  const rows = filtered.slice(0, limit).map(toListRow);
  return jsonResponse({ messages: rows, stats: computeStats() });
}

function handleDetail(id: string): Response {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return jsonResponse({ error: 'Письмо не найдено' }, 404);
  return jsonResponse(msg);
}

async function handleReset(): Promise<Response> {
  messages.length = 0;
  webhookDone.clear();
  failNextFlag = false;
  doomedId = null;
  await persistSnapshot();
  console.log('[reset] история писем очищена');
  return jsonResponse({ ok: true });
}

function handleFailNext(): Response {
  failNextFlag = true;
  console.log('[admin] fail-next: следующее письмо будет принудительно провалено (3 попытки + резервный SMTP)');
  return jsonResponse({ ok: true });
}

function handleStats(): Response {
  return jsonResponse(computeStats());
}

// ---------------------------------------------------------------------------
// Демо-консоль (GET /) — самодостаточный HTML без внешних ресурсов
// ---------------------------------------------------------------------------

const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Email-провайдер (ИНТ-014) · Демо-консоль</title>
<style>
  :root { --line:#e2e8f0; --accent:#059669; --accent-dark:#047857; --muted:#64748b; }
  * { box-sizing:border-box; }
  html, body { margin:0; }
  body { background:#f8fafc; color:#0f172a; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif; font-size:14px; line-height:1.5; }
  .wrap { max-width:1100px; margin:0 auto; padding:24px 16px 32px; min-height:100vh; display:flex; flex-direction:column; }
  h1 { font-size:21px; font-weight:700; margin:0 0 2px; letter-spacing:-.01em; }
  .sub { color:var(--muted); margin:0; font-size:13px; }
  h2 { font-size:15px; font-weight:600; margin:0 0 12px; }
  h3 { font-size:13px; font-weight:600; margin:16px 0 6px; color:#334155; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:20px 0 0; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card .num { font-size:24px; font-weight:700; letter-spacing:-.02em; }
  .card .lbl { font-size:11.5px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; margin-top:2px; }
  .card.green .num { color:var(--accent); }
  .card.amber .num { color:#b45309; }
  .card.rose .num { color:#be123c; }
  .panel { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; margin-top:16px; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
  .field { display:flex; flex-direction:column; gap:4px; font-size:12.5px; color:var(--muted); font-weight:600; }
  input, select, textarea { border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; color:#0f172a; background:#fff; min-height:38px; }
  textarea { resize:vertical; }
  input:focus, select:focus, textarea:focus { outline:2px solid rgba(5,150,105,.25); border-color:var(--accent); }
  .grow { flex:1 1 240px; }
  .grow input { width:100%; }
  .btn { border:1px solid var(--line); background:#fff; color:#0f172a; border-radius:8px; padding:9px 14px; font:inherit; font-weight:600; cursor:pointer; transition:background .15s,border-color .15s,color .15s; min-height:40px; }
  .btn:hover { background:#f8fafc; border-color:#cbd5e1; }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  .btn.primary:hover { background:var(--accent-dark); }
  .btn.warn { color:#be123c; border-color:#fecdd3; }
  .btn.warn:hover { background:#fff1f2; border-color:#fda4af; }
  .hint { font-size:12px; color:var(--muted); margin:10px 0 0; }
  .send-form { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .send-form .wide { grid-column:1 / -1; }
  .send-form textarea { width:100%; min-height:96px; }
  @media (max-width:640px){ .send-form { grid-template-columns:1fr; } }
  .tbl-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:9px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  tbody tr { cursor:pointer; transition:background .12s; }
  tbody tr:hover, tbody tr:focus { background:#f1f5f9; outline:none; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace; font-size:12.5px; }
  .subj { max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .nowrap { white-space:nowrap; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:11.5px; font-weight:600; white-space:nowrap; }
  .badge.QUEUED { background:#fef3c7; color:#92400e; }
  .badge.SENT { background:#d1fae5; color:#065f46; }
  .badge.FAILED { background:#ffe4e6; color:#9f1239; }
  .badge.cat { background:#f1f5f9; color:#475569; border:1px solid var(--line); }
  .empty { color:#94a3b8; text-align:center; padding:28px 0; }
  .count { color:var(--muted); font-weight:400; font-size:12.5px; }
  .msg-status { font-size:13px; min-height:20px; margin:0; }
  .msg-status.ok { color:var(--accent-dark); }
  .msg-status.err { color:#be123c; }
  .err-text { color:#be123c; }
  .overlay { position:fixed; inset:0; background:rgba(15,23,42,.45); display:flex; justify-content:flex-end; z-index:60; }
  .overlay[hidden] { display:none; }
  .sheet { background:#fff; width:min(560px,100%); height:100%; overflow-y:auto; padding:20px 22px 32px; border-left:1px solid var(--line); box-shadow:-8px 0 24px rgba(15,23,42,.08); }
  .sheet-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
  .sheet-head h2 { margin:0; }
  .kv { display:grid; grid-template-columns:140px 1fr; gap:6px 12px; margin-top:8px; }
  .kv-l { color:var(--muted); font-size:12.5px; font-weight:600; }
  .kv-v { font-size:13.5px; overflow-wrap:anywhere; }
  .preview { width:100%; height:280px; border:1px solid var(--line); border-radius:8px; background:#fff; }
  pre.meta { background:#f8fafc; border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; overflow:auto; max-height:220px; white-space:pre-wrap; margin:0; }
  .att-name { background:#f8fafc; border:1px solid var(--line); border-radius:8px; padding:6px 10px; display:inline-block; margin:0 0 10px; }
  footer { margin-top:auto; padding-top:28px; color:var(--muted); font-size:12px; }
  @media (max-width:720px){ .hide-sm { display:none; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Email-провайдер (ИНТ-014) · Демо-консоль</h1>
    <p class="sub">транзакционные письма МИС MedFlow · REST + резервный SMTP</p>
  </header>

  <section class="cards" aria-label="Статистика">
    <div class="card"><div class="num" id="st-total">0</div><div class="lbl">Всего</div></div>
    <div class="card amber"><div class="num" id="st-queued">0</div><div class="lbl">В очереди</div></div>
    <div class="card green"><div class="num" id="st-sent">0</div><div class="lbl">Отправлено</div></div>
    <div class="card rose"><div class="num" id="st-failed">0</div><div class="lbl">Ошибок</div></div>
    <div class="card"><div class="num" id="st-24h">0</div><div class="lbl">За 24 ч</div></div>
  </section>

  <section class="panel">
    <h2>Фильтры и управление</h2>
    <div class="row">
      <label class="field">Категория
        <select id="flt-cat"><option value="all">Все</option></select>
      </label>
      <label class="field grow">Поиск (to / тема)
        <input id="flt-q" type="text" placeholder="например: ivanov@… или «Отчёт»">
      </label>
      <button id="btn-reset" class="btn warn" type="button">Сбросить историю</button>
      <button id="btn-fail" class="btn" type="button">Сбой следующего письма</button>
    </div>
    <p class="hint">«Сбой следующего письма» форсирует полную неудачу доставки следующего письма (3 попытки основного провайдера + резервный SMTP завершатся ошибкой), чтобы показать возврат письма в Центр уведомлений МИС.</p>
    <p class="msg-status" id="fail-status"></p>
  </section>

  <section class="panel">
    <h2>Тестовое письмо (категория MANUAL)</h2>
    <form id="send-form" class="send-form">
      <label class="field">Кому (email)
        <input id="send-to" type="email" required placeholder="ivanov@example.com">
      </label>
      <label class="field">Тема
        <input id="send-subject" type="text" required placeholder="Приглашение на приём">
      </label>
      <label class="field wide">HTML письма
        <textarea id="send-html" rows="5" placeholder="&lt;p&gt;Уважаемый Иван И.! Вы записаны на приём…&lt;/p&gt;"></textarea>
      </label>
      <div class="row">
        <button class="btn primary" type="submit">Отправить тестовое письмо</button>
        <span class="msg-status" id="send-status"></span>
      </div>
    </form>
  </section>

  <section class="panel">
    <h2>Письма <span class="count" id="tbl-count"></span></h2>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Получатель</th>
            <th>Тема</th>
            <th class="hide-sm">Категория</th>
            <th>Статус</th>
            <th class="hide-sm">Поп.</th>
            <th class="hide-sm">Провайдер</th>
            <th>Время</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
      <div class="empty" id="tbl-empty">Писем пока нет — отправьте тестовое письмо или вызовите POST /api/send</div>
    </div>
  </section>

  <div class="overlay" id="overlay" hidden>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Детали письма">
      <div class="sheet-head">
        <h2 id="dt-id" class="mono">—</h2>
        <button class="btn" id="dt-close" type="button" aria-label="Закрыть">×</button>
      </div>
      <div class="kv" id="dt-fields"></div>
      <h3>HTML письма</h3>
      <iframe id="dt-frame" class="preview" sandbox="" title="Предпросмотр HTML письма"></iframe>
      <div id="dt-attach" hidden></div>
      <h3>meta</h3>
      <pre class="meta" id="dt-meta">null</pre>
    </div>
  </div>

  <footer>Мини-сервис :3040 · подключение к МИС — POST /api/send, webhook статусов</footer>
</div>

<script>
(function () {
  'use strict';
  var state = { category: 'all', q: '', detailId: null };
  var knownCats = {};
  var lastCatsKey = null;
  var lastFrameId = null;
  var lastFrameHtml = null;
  var STATUS_LABEL = { QUEUED: 'В очереди', SENT: 'Отправлено', FAILED: 'Ошибка' };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fetchJson(url, init) {
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).catch(function () { return { ok: false, status: 0, data: null }; });
  }

  function setStatus(el, text, cls) {
    el.textContent = text || '';
    el.className = 'msg-status' + (cls ? ' ' + cls : '');
  }

  // --- загрузка списка (с фильтрами) ---
  function load() {
    var qs = [];
    if (state.category !== 'all') qs.push('category=' + encodeURIComponent(state.category));
    if (state.q) qs.push('q=' + encodeURIComponent(state.q));
    return fetchJson('/api/messages' + (qs.length ? '?' + qs.join('&') : '')).then(function (r) {
      if (!r.ok || !r.data) return;
      var msgs = r.data.messages || [];
      for (var i = 0; i < msgs.length; i++) knownCats[msgs[i].category] = true;
      renderStats(r.data.stats);
      renderCats();
      renderTable(msgs);
      if (state.detailId) refreshDetail();
    });
  }

  function renderStats(s) {
    s = s || {};
    $('st-total').textContent = String(s.total || 0);
    $('st-queued').textContent = String(s.queued || 0);
    $('st-sent').textContent = String(s.sent || 0);
    $('st-failed').textContent = String(s.failed || 0);
    $('st-24h').textContent = String(s.last24h || 0);
  }

  function renderCats() {
    var cats = Object.keys(knownCats).sort();
    var key = cats.join('|');
    if (key !== lastCatsKey) {
      lastCatsKey = key;
      var html = '<option value="all">Все</option>';
      for (var i = 0; i < cats.length; i++) {
        html += '<option value="' + esc(cats[i]) + '">' + esc(cats[i]) + '</option>';
      }
      $('flt-cat').innerHTML = html;
    }
    if (!knownCats[state.category]) {
      state.category = 'all';
      $('flt-cat').value = 'all';
    }
  }

  function renderTable(msgs) {
    var rows = '';
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      rows += '<tr data-id="' + esc(m.id) + '" tabindex="0" role="button" aria-label="Открыть письмо ' + esc(m.id) + '">'
        + '<td class="mono">' + esc(m.id) + '</td>'
        + '<td>' + esc(m.to) + '</td>'
        + '<td class="subj">' + esc(m.subject) + '</td>'
        + '<td class="hide-sm"><span class="badge cat">' + esc(m.category) + '</span></td>'
        + '<td><span class="badge ' + esc(m.status) + '">' + esc(STATUS_LABEL[m.status] || m.status) + '</span></td>'
        + '<td class="hide-sm">' + String(m.attempts || 0) + '</td>'
        + '<td class="hide-sm">' + esc(m.provider || '—') + '</td>'
        + '<td class="nowrap">' + fmtTime(m.createdAt) + '</td>'
        + '</tr>';
    }
    $('tbody').innerHTML = rows;
    $('tbl-empty').hidden = msgs.length > 0;
    $('tbl-count').textContent = msgs.length ? '(' + msgs.length + ')' : '';
  }

  // --- детальный просмотр (сайд-панель), живёт между опросами по id ---
  function openDetail(id) {
    state.detailId = id;
    $('overlay').hidden = false;
    refreshDetail();
  }

  function refreshDetail() {
    if (!state.detailId) return;
    fetchJson('/api/messages/' + encodeURIComponent(state.detailId)).then(function (r) {
      if (!r.ok || !r.data) { closeDetail(); return; }
      renderDetail(r.data);
    });
  }

  function kv(label, valueHtml) {
    return '<div class="kv-l">' + label + '</div><div class="kv-v">' + valueHtml + '</div>';
  }

  function renderDetail(m) {
    $('dt-id').textContent = m.id + ' · ' + (STATUS_LABEL[m.status] || m.status);
    var f = '';
    f += kv('Получатель', esc(m.to));
    f += kv('Тема', esc(m.subject));
    f += kv('Категория', '<span class="badge cat">' + esc(m.category) + '</span>');
    f += kv('Статус', '<span class="badge ' + esc(m.status) + '">' + esc(STATUS_LABEL[m.status] || m.status) + '</span>');
    f += kv('Попытки', String(m.attempts || 0));
    f += kv('Провайдер', esc(m.provider || '—'));
    f += kv('Создано', fmtTime(m.createdAt));
    f += kv('Отправлено', fmtTime(m.sentAt));
    if (m.error) f += kv('Ошибка', '<span class="err-text">' + esc(m.error) + '</span>');
    $('dt-fields').innerHTML = f;

    var meta = (m.meta === null || m.meta === undefined) ? 'null' : JSON.stringify(m.meta, null, 2);
    $('dt-meta').textContent = meta;

    // iframe обновляем только при смене письма/содержимого, чтобы не мигал
    if (lastFrameId !== m.id || lastFrameHtml !== m.html) {
      $('dt-frame').srcdoc = m.html || '<p style="color:#94a3b8;font:13px -apple-system,system-ui;padding:12px">Пустое тело письма</p>';
      lastFrameId = m.id;
      lastFrameHtml = m.html;
    }

    // вложение: имя + скачивание через data:-ссылку
    var box = $('dt-attach');
    var att = m.attachment;
    if (att && att.filename) {
      box.hidden = false;
      box.innerHTML = '<h3>Вложение</h3>'
        + '<p class="att-name mono">' + esc(att.filename) + '</p>'
        + '<a id="dt-att-link" class="btn">Скачать вложение</a>';
      var a = $('dt-att-link');
      a.href = 'data:application/octet-stream;base64,' + att.base64;
      a.setAttribute('download', att.filename);
    } else {
      box.hidden = true;
      box.innerHTML = '';
    }
  }

  function closeDetail() {
    state.detailId = null;
    $('overlay').hidden = true;
    lastFrameId = null;
    lastFrameHtml = null;
  }

  // --- события ---
  $('tbody').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-id]');
    if (tr) openDetail(tr.getAttribute('data-id'));
  });
  $('tbody').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var tr = ev.target.closest('tr[data-id]');
    if (tr) { ev.preventDefault(); openDetail(tr.getAttribute('data-id')); }
  });
  $('dt-close').addEventListener('click', closeDetail);
  $('overlay').addEventListener('click', function (ev) {
    if (ev.target === $('overlay')) closeDetail();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && state.detailId) closeDetail();
  });

  $('flt-cat').addEventListener('change', function () {
    state.category = this.value;
    load();
  });
  var debounceTimer = null;
  $('flt-q').addEventListener('input', function () {
    var v = this.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { state.q = v.trim(); load(); }, 300);
  });

  $('btn-reset').addEventListener('click', function () {
    if (!confirm('Сбросить всю историю писем провайдера?')) return;
    fetchJson('/api/reset', { method: 'POST' }).then(function (r) {
      if (r.ok) {
        knownCats = {};
        lastCatsKey = null;
        closeDetail();
        load();
      }
    });
  });

  $('btn-fail').addEventListener('click', function () {
    var text = 'Форсировать полную неудачу доставки следующего письма?\\n\\nОсновной провайдер сделает 3 безуспешные попытки, резервный SMTP тоже не спасёт: письмо получит статус FAILED, webhook уйдёт в МИС, и письмо вернётся в Центр уведомлений (EMAIL_FALLBACK).';
    if (!confirm(text)) return;
    fetchJson('/api/admin/fail-next', { method: 'POST' }).then(function (r) {
      if (r.ok) setStatus($('fail-status'), 'Флаг установлен: следующее письмо будет принудительно провалено (3 попытки + резервный SMTP).', 'ok');
      else setStatus($('fail-status'), 'Не удалось установить флаг (HTTP ' + r.status + ').', 'err');
    });
  });

  $('send-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var el = $('send-status');
    setStatus(el, 'Отправка…', '');
    var payload = {
      to: $('send-to').value.trim(),
      subject: $('send-subject').value,
      html: $('send-html').value,
      category: 'MANUAL'
    };
    fetchJson('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (r.ok && r.data && r.data.id) {
        setStatus(el, 'Принято в очередь: ' + r.data.id + ' (статус ' + r.data.status + ')', 'ok');
        load();
      } else {
        setStatus(el, (r.data && r.data.error) ? r.data.error : 'Ошибка отправки (HTTP ' + r.status + ')', 'err');
      }
    });
  });

  // авто-обновление каждые 3 с; детали остаются открытыми по id
  setInterval(load, 3000);
  load();
})();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Сервер
// ---------------------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path === '/' && method === 'GET') {
        if (!CONSOLE_PASSWORD) return jsonResponse({ error: 'Консоль выключена' }, 404);
        if (!hasConsoleAuth(req)) {
          return new Response('Требуется вход', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="email-provider"' } });
        }
        return htmlResponse(CONSOLE_HTML);
      }

      if (path.startsWith('/api/')) {
        if (!hasServiceKey(req) && !hasConsoleAuth(req)) return jsonResponse({ error: 'Нужен X-Service-Key' }, 401);

        if (path === '/api/send' && method === 'POST') return await handleSend(req);
        if (path === '/api/messages' && method === 'GET') return handleList(url);

        const detailMatch = path.match(/^\/api\/messages\/([^/]+)$/);
        if (detailMatch && method === 'GET') return handleDetail(decodeURIComponent(detailMatch[1]));

        if (path === '/api/reset' && method === 'POST') return await handleReset();
        if (path === '/api/admin/fail-next' && method === 'POST') return handleFailNext();
        if (path === '/api/stats' && method === 'GET') return handleStats();

        return jsonResponse({ error: 'Маршрут не найден: ' + method + ' ' + path }, 404);
      }

      return jsonResponse({ error: 'Маршрут не найден: ' + method + ' ' + path }, 404);
    } catch (err) {
      console.error('[email-provider] необработанная ошибка:', err);
      return jsonResponse({ error: 'Внутренняя ошибка сервера' }, 500);
    }
}

// Адаптер node:http → Web Request/Response
createServer(async (nreq, nres) => {
  try {
    const chunks: Buffer[] = [];
    for await (const c of nreq) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(nreq.headers)) if (typeof v === 'string') headers.set(k, v);
    const method = nreq.method || 'GET';
    const req = new Request(`http://localhost${nreq.url || '/'}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const res = await handle(req);
    nres.writeHead(res.status, Object.fromEntries(res.headers.entries()));
    nres.end(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.error('[email-provider] adapter error:', err);
    nres.writeHead(500);
    nres.end();
  }
}).listen(PORT);

console.log(`[email-provider] ИНТ-014 запущен на :${PORT} · консоль http://localhost:${PORT}/`);
console.log(`[email-provider] webhook статусов → ${MIS_URL}/api/integrations/email/webhook`);

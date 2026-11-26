// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { isDemo } from './config'
// Серверный адаптер LLM — только бэкенд. Провайдер выбирается LLM_PROVIDER:
//   none      — AI выключен (используются детерминированные шаблоны)
//   openai    — любой OpenAI-совместимый API (LLM_BASE_URL, LLM_API_KEY, LLM_MODEL),
//               в т.ч. локальный vLLM/Ollama внутри контура клиники
//   yandexgpt — Yandex Foundation Models (YANDEX_API_KEY, YANDEX_FOLDER_ID, YANDEX_MODEL)
//   gigachat  — Сбер GigaChat (GIGACHAT_AUTH_KEY, GIGACHAT_SCOPE, GIGACHAT_MODEL)
// В модель уходят только псевдонимизированные данные (см. lib/ai-protocol.ts).
import { createHash, randomUUID } from 'crypto'
import { llmExternalAllowed, llmIsExternal } from '../../scripts/env-rules.mjs'

export type LlmProvider = 'none' | 'openai' | 'yandexgpt' | 'gigachat'

export function llmProvider(): LlmProvider {
  // Демо-стенд никуда не ходит наружу: ИИ-черновик строится локальным шаблоном
  if (isDemo()) return 'none'
  const p = (process.env.LLM_PROVIDER || 'none').toLowerCase()
  if (!['openai', 'yandexgpt', 'gigachat'].includes(p)) return 'none'
  // Внешний провайдер без явного разрешения не используется (в production старт и так не пройдёт)
  if (llmIsExternal(process.env) && !llmExternalAllowed(process.env)) return 'none'
  return p as LlmProvider
}

/** Куда уйдёт текст — для превью врачу */
export function llmTarget(): { provider: LlmProvider; external: boolean } {
  const provider = llmProvider()
  return { provider, external: provider !== 'none' && llmIsExternal(process.env) }
}

/** Хеш ровно того текста, что уйдёт в модель: врач подтверждает превью, сервер сверяет хеш перед отправкой. */
export function promptHash(system: string, user: string): string {
  return createHash('sha256').update(system).update('\u0000').update(user).digest('hex')
}

export function llmEnabled(): boolean {
  return llmProvider() !== 'none'
}

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000)

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
  return res.json()
}

async function openaiChat(system: string, user: string): Promise<string | null> {
  const base = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '')
  const data = (await postJson(
    `${base}/chat/completions`,
    { Authorization: `Bearer ${process.env.LLM_API_KEY}` },
    {
      model: process.env.LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }
  )) as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? null
}

async function yandexChat(system: string, user: string): Promise<string | null> {
  const folder = process.env.YANDEX_FOLDER_ID
  const model = process.env.YANDEX_MODEL || 'yandexgpt-lite'
  const data = (await postJson(
    process.env.YANDEX_LLM_URL || 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
    { Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`, 'x-folder-id': String(folder) },
    {
      modelUri: `gpt://${folder}/${model}/latest`,
      completionOptions: { stream: false, temperature: 0.2, maxTokens: '1500' },
      messages: [
        { role: 'system', text: system },
        { role: 'user', text: user },
      ],
    }
  )) as { result?: { alternatives?: Array<{ message?: { text?: string } }> } }
  return data.result?.alternatives?.[0]?.message?.text ?? null
}

let gigaToken: { token: string; exp: number } | null = null

async function gigachatToken(): Promise<string> {
  if (gigaToken && gigaToken.exp - 60_000 > Date.now()) return gigaToken.token
  const res = await fetch(process.env.GIGACHAT_OAUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${process.env.GIGACHAT_AUTH_KEY}`,
      RqUID: randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ scope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS' }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GigaChat OAuth HTTP ${res.status}`)
  const j = (await res.json()) as { access_token: string; expires_at: number }
  gigaToken = { token: j.access_token, exp: j.expires_at }
  return j.access_token
}

async function gigachatChat(system: string, user: string): Promise<string | null> {
  const token = await gigachatToken()
  const data = (await postJson(
    process.env.GIGACHAT_API_URL || 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
    { Authorization: `Bearer ${token}` },
    {
      model: process.env.GIGACHAT_MODEL || 'GigaChat',
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }
  )) as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? null
}

/** Запрос к LLM: системная инструкция — role 'system'. null — AI выключен или недоступен. */
export async function llm(system: string, user: string): Promise<string | null> {
  const p = llmProvider()
  if (p === 'none') return null
  try {
    const out = p === 'openai' ? await openaiChat(system, user) : p === 'yandexgpt' ? await yandexChat(system, user) : await gigachatChat(system, user)
    return out && out.trim().length > 0 ? out.trim() : null
  } catch (e) {
    console.error('[ai-client] LLM error:', (e as Error).message)
    return null
  }
}

import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './backend'
import { storageKey } from './fork'
import type { AgentThinkingLevel } from './types'

export type PiLauncherStatus = {
  available: boolean
  program: string
  path?: string
  error?: string
}

/** Nonsecret defaults only. Pi credentials, trust, and environment remain Pi-owned. */
export type PiLaunchProfile = {
  provider?: string
  model?: string
  thinkingLevel?: AgentThinkingLevel
}

const PROFILE_KEY = storageKey('piLaunchProfiles')
const MAX_PROFILES = 6
const THINKING = new Set<AgentThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const part = (value: unknown, max: number): string | undefined =>
  typeof value === 'string'
  && value.trim()
  && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : undefined

export function normalizePiLaunchProfile(value: unknown): PiLaunchProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const provider = part(record.provider, 256)
  const model = part(record.model, 1024)
  const thinkingLevel = THINKING.has(record.thinkingLevel as AgentThinkingLevel)
    ? record.thinkingLevel as AgentThinkingLevel
    : undefined
  if (!provider && !model && !thinkingLevel) return null
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  }
}

export function piLaunchProfileLabel(profile: PiLaunchProfile): string {
  const model = profile.provider && profile.model
    ? `${profile.provider}/${profile.model}`
    : profile.model ?? (profile.provider ? `${profile.provider} default` : 'Pi default')
  return profile.thinkingLevel ? `${model} · ${profile.thinkingLevel}` : model
}

const profileKey = (profile: PiLaunchProfile) =>
  JSON.stringify([profile.provider ?? '', profile.model ?? '', profile.thinkingLevel ?? ''])

export function mergePiLaunchProfile(existing: PiLaunchProfile[], candidate: PiLaunchProfile): PiLaunchProfile[] {
  const normalized = normalizePiLaunchProfile(candidate)
  if (!normalized) return existing.slice(0, MAX_PROFILES)
  const key = profileKey(normalized)
  return [normalized, ...existing.filter(profile => profileKey(profile) !== key)].slice(0, MAX_PROFILES)
}

export function loadPiLaunchProfiles(storage: Pick<Storage, 'getItem'> = localStorage): PiLaunchProfile[] {
  try {
    const parsed = JSON.parse(storage.getItem(PROFILE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const out: PiLaunchProfile[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      const profile = normalizePiLaunchProfile(item)
      if (!profile) continue
      const key = profileKey(profile)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(profile)
      if (out.length >= MAX_PROFILES) break
    }
    return out
  } catch {
    return []
  }
}

export function rememberPiLaunchProfile(
  profile: PiLaunchProfile,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): PiLaunchProfile[] {
  const next = mergePiLaunchProfile(loadPiLaunchProfiles(storage), profile)
  try {
    storage.setItem(PROFILE_KEY, JSON.stringify(next))
  } catch {
    // Profiles are a convenience; creation must not fail if storage is full.
  }
  return next
}

let launcherStatus: Promise<PiLauncherStatus> | undefined

/** Resolve the configured launcher without executing or installing it. */
export function getPiLauncherStatus(refresh = false): Promise<PiLauncherStatus> {
  if (!isTauri()) {
    return Promise.resolve({
      available: false,
      program: 'pi',
      error: 'Managed Pi agents currently require the desktop app.',
    })
  }
  if (!launcherStatus || refresh) {
    launcherStatus = invoke<PiLauncherStatus>('pi_launcher_status').catch(error => ({
      available: false,
      program: 'pi',
      error: error instanceof Error ? error.message : String(error),
    }))
  }
  return launcherStatus
}

export const PI_SETUP_GUIDANCE =
  'Install Pi yourself, make the configured launcher available on PATH, then retry. ccanvas will not install Pi or launch Claude instead.'

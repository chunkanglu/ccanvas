import config from '../../fork.config.json'

export const APP_NAME = config.appName
export const BACKEND_HTTP_URL = `http://127.0.0.1:${config.backendPort}`
export const BACKEND_WS_URL = `ws://127.0.0.1:${config.backendPort}`
export const CHECKPOINT_REF_PREFIX = config.checkpointRefPrefix

// Do not auto-import upstream localStorage: that could auto-launch its agents.
// Explicit workspace import remains available; schema migration is stage 1.
export const storageKey = (key: string): string => `${config.storageNamespace}:${key}`

import { randomBytes } from 'node:crypto'

/** Secrets live only for the Electron main-process lifetime. */
export const gatewayAdminToken = randomBytes(32).toString('base64url')
export const modelBrokerToken = randomBytes(32).toString('base64url')
export const MODEL_BROKER_TOKEN_ENV = 'ECHO_DESKTOP_MODEL_TOKEN'

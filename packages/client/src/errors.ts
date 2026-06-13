import {
  ACP_ERROR_CODES,
  isAcpErrorCode,
  type AcpErrorCode,
  type ErrorObject,
} from '@acpjs/protocol'

export class AcpClientError extends Error {
  code: AcpErrorCode
  data: unknown
  retryable: boolean

  constructor(error: ErrorObject) {
    super(error.message)
    this.name = 'AcpClientError'
    this.code = error.code
    this.data = error.data
    this.retryable = error.retryable
  }
}

export function transportClosedError(): ErrorObject {
  return {
    code: ACP_ERROR_CODES.transportClosed,
    message: 'transport is closed',
    retryable: true,
  }
}

function asErrorObject(value: unknown): ErrorObject | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as {
    code?: unknown
    message?: unknown
    data?: unknown
    retryable?: unknown
  }
  if (typeof candidate.code !== 'string' || !isAcpErrorCode(candidate.code)) {
    return undefined
  }
  return {
    code: candidate.code,
    message: typeof candidate.message === 'string' ? candidate.message : '',
    ...(candidate.data === undefined ? {} : { data: candidate.data }),
    retryable: candidate.retryable === true,
  }
}

export function toClientError(value: unknown): AcpClientError {
  if (value instanceof AcpClientError) return value
  const errorObject = asErrorObject(value)
  if (errorObject) return new AcpClientError(errorObject)
  const message =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : 'unknown error'
  return new AcpClientError({
    code: ACP_ERROR_CODES.agentError,
    message,
    retryable: false,
  })
}

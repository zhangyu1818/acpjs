import { ACPJS_ERROR_CODES, type AcpjsErrorCode } from '@acpjs/protocol'

export class AcpError extends Error {
  code: AcpjsErrorCode
  data: unknown
  retryable: boolean

  constructor(
    code: AcpjsErrorCode,
    message: string,
    options: { data?: unknown; retryable?: boolean } = {},
  ) {
    super(message)
    this.name = 'AcpError'
    this.code = code
    this.data = options.data
    this.retryable = options.retryable ?? false
  }
}

export function configInvalid(message: string, data?: unknown): AcpError {
  return new AcpError(ACPJS_ERROR_CODES.configInvalid, message, { data })
}

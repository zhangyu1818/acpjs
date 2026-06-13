import { ACP_ERROR_CODES, type AcpErrorCode } from '@acpjs/protocol'

export class AcpError extends Error {
  code: AcpErrorCode
  data: unknown
  retryable: boolean

  constructor(
    code: AcpErrorCode,
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
  return new AcpError(ACP_ERROR_CODES.configInvalid, message, { data })
}

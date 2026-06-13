export function truncateUtf8Tail(
  output: string,
  limitBytes: number,
): { output: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(output)
  if (bytes.length <= limitBytes) return { output, truncated: false }
  let start = bytes.length - limitBytes
  while (start < bytes.length) {
    const byte = bytes[start]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    start += 1
  }
  return {
    output: new TextDecoder().decode(bytes.subarray(start)),
    truncated: true,
  }
}

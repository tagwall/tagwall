export function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function colorToHex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0').toUpperCase()
}

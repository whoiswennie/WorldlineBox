export const dshVersionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

export function compareDshVersions(a: string, b: string): number {
  const [av, ...ap] = a.split('-'), [bv, ...bp] = b.split('-');
  const x = av!.split('.').map(Number), y = bv!.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  if (!ap.length || !bp.length) return bp.length - ap.length;
  const p = ap.join('-').split('.'), q = bp.join('-').split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    const left = p[i], right = q[i];
    if (left === right) continue;
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    const numericLeft = /^\d+$/.test(left), numericRight = /^\d+$/.test(right);
    if (numericLeft && numericRight) return Number(left) - Number(right);
    if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

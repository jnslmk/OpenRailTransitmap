declare module 'fontnik' {
  export function range(
    opts: { font: Buffer; start: number; end: number },
    cb: (err: Error | null, buf: Buffer) => void,
  ): void;
  export function load(font: Buffer, cb: (err: Error | null, faces: unknown[]) => void): void;
  export function composite(bufs: Buffer[], cb: (err: Error | null, buf: Buffer) => void): void;
}

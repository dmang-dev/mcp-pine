// PINE protocol client
// ─────────────────────
// Wire format (per the PINE standard):
//
//   Request:  uint32_t total_size_with_prefix | uint8_t opcode | args (LE)
//   Reply:    uint32_t total_size_with_prefix | uint8_t result_code | return data (LE)
//
//   result_code: 0x00 = OK, 0xFF = FAIL
//
// Transport (per the PINE spec):
//   - Linux:   Unix domain socket at $XDG_RUNTIME_DIR/<target>.sock.<slot> (fallback /tmp)
//   - macOS:   Unix domain socket at $TMPDIR/<target>.sock.<slot>          (fallback /tmp)
//   - Windows: TCP on 127.0.0.1:<slot>
//
// Target naming convention (the bit before .sock.<slot>):
//   - PCSX2:        "pcsx2"
//   - RPCS3:        "rpcs3"
//   - Duckstation:  "duckstation"
//
// Stateless: every request gets exactly one reply.

import net from "node:net";
import path from "node:path";

export const Op = {
  Read8:        0x00,
  Read16:       0x01,
  Read32:       0x02,
  Read64:       0x03,
  Write8:       0x04,
  Write16:      0x05,
  Write32:      0x06,
  Write64:      0x07,
  Version:      0x08,
  SaveState:    0x09,
  LoadState:    0x0A,
  Title:        0x0B,
  ID:           0x0C,
  UUID:         0x0D,
  GameVersion:  0x0E,
  Status:       0x0F,
} as const;
export type Opcode = typeof Op[keyof typeof Op];

export type EmuStatus = "running" | "paused" | "shutdown" | "unknown";

const RESULT_OK   = 0x00;
const RESULT_FAIL = 0xFF;

export interface PineConnectOptions {
  /** Default "pcsx2"; the prefix used in the Unix socket file name */
  target?: string;
  /** PINE slot — also the TCP port on Windows. Default 28011 (PCSX2 standard). */
  slot?: number;
  /** Override the host (TCP only). Default 127.0.0.1. */
  host?: string;
  /** Override the full Unix socket path (skips the standard resolution). */
  socketPath?: string;
}

/** Resolve the platform-appropriate socket descriptor for a given target/slot. */
export function resolveSocket(opts: PineConnectOptions = {}):
  | { kind: "tcp";  host: string;  port: number }
  | { kind: "unix"; path: string }
{
  const target = opts.target ?? "pcsx2";
  const slot   = opts.slot   ?? 28011;

  if (process.platform === "win32") {
    return { kind: "tcp", host: opts.host ?? "127.0.0.1", port: slot };
  }

  if (opts.socketPath) {
    return { kind: "unix", path: opts.socketPath };
  }

  // Linux uses XDG_RUNTIME_DIR; macOS and the rest use TMPDIR; both fall back to /tmp.
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    process.env.TMPDIR ??
    "/tmp";

  return { kind: "unix", path: path.join(runtimeDir, `${target}.sock.${slot}`) };
}

interface Pending {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
}

export class PineClient {
  private socket: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private queue: Pending[] = [];
  private connectPromise: Promise<void> | null = null;
  private readonly descriptor: ReturnType<typeof resolveSocket>;

  constructor(public readonly opts: PineConnectOptions = {}) {
    this.descriptor = resolveSocket(opts);
  }

  /** Human-readable target description for logs / error messages. */
  describeTarget(): string {
    if (this.descriptor.kind === "tcp")  return `tcp ${this.descriptor.host}:${this.descriptor.port}`;
    return `unix ${this.descriptor.path}`;
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      const sock = this.descriptor.kind === "tcp"
        ? net.createConnection({ host: this.descriptor.host, port: this.descriptor.port })
        : net.createConnection({ path: this.descriptor.path });

      sock.once("connect", () => { this.socket = sock; resolve(); });
      sock.once("error",   (err) => { this.connectPromise = null; reject(err); });

      sock.on("data", (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);

        // Drain as many complete reply frames as we can.
        while (this.buf.length >= 4) {
          const total = this.buf.readUInt32LE(0);
          if (total < 5)               { this.fail(new Error(`PINE reply too short (size=${total})`)); return; }
          if (this.buf.length < total) break;  // wait for more bytes

          const frame   = this.buf.subarray(4, total);  // strip size prefix
          this.buf      = this.buf.subarray(total);

          const code    = frame.readUInt8(0);
          const payload = frame.subarray(1);

          const pending = this.queue.shift();
          if (!pending) continue;  // shouldn't happen — drop spurious replies

          if (code === RESULT_OK)        pending.resolve(payload);
          else if (code === RESULT_FAIL) pending.reject(new Error(`PINE FAIL response (code 0xFF)`));
          else                            pending.reject(new Error(`PINE unknown result code 0x${code.toString(16)}`));
        }
      });

      sock.on("close", () => {
        this.socket = null;
        this.connectPromise = null;
        this.fail(new Error("connection closed"));
      });
    });
    return this.connectPromise;
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connectPromise = null;
  }

  /** Reject every in-flight call with the given error. */
  private fail(err: Error): void {
    while (this.queue.length) this.queue.shift()!.reject(err);
  }

  /**
   * Low-level: send one opcode + args, await one payload (excluding result code).
   * Times out after 10s so a peer that drops a reply doesn't hang us forever.
   * (Discovered the hard way against PCSX2 — see notes in readRange.)
   */
  async call(opcode: Opcode, args: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    if (!this.socket || this.socket.destroyed) {
      try { await this.connect(); }
      catch (err) {
        throw new Error(
          `Cannot reach PINE server (${this.describeTarget()}). ` +
          `Make sure the emulator is running with PINE enabled. ` +
          `Underlying: ${(err as Error).message}`,
        );
      }
    }

    return new Promise<Buffer>((resolve, reject) => {
      const sock = this.socket!;
      // Frame: u32 total_size (LE) | u8 opcode | args
      const total = 4 + 1 + args.length;
      const frame = Buffer.alloc(total);
      frame.writeUInt32LE(total, 0);
      frame.writeUInt8(opcode, 4);
      args.copy(frame, 5);

      let timer: NodeJS.Timeout | null = null;
      const pending: Pending = {
        resolve: (data: Buffer) => { if (timer) clearTimeout(timer); resolve(data); },
        reject:  (err: Error)   => { if (timer) clearTimeout(timer); reject(err); },
      };
      this.queue.push(pending);

      timer = setTimeout(() => {
        // Remove our entry from the queue and reject. Caveat: a late reply
        // will then be misaligned with the next expected pending slot — if
        // drops are systemic the bridge may need to reset the connection.
        this.queue = this.queue.filter((p) => p !== pending);
        reject(new Error("PINE call timed out (10s) — peer may have dropped the reply"));
      }, 10000);

      sock.write(frame, (err) => {
        if (err) {
          this.queue = this.queue.filter((p) => p !== pending);
          if (timer) clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // ── Typed helpers ────────────────────────────────────────────────────────

  async read8(addr: number): Promise<number> {
    const args = Buffer.alloc(4); args.writeUInt32LE(addr, 0);
    const r = await this.call(Op.Read8, args);
    return r.readUInt8(0);
  }
  async read16(addr: number): Promise<number> {
    const args = Buffer.alloc(4); args.writeUInt32LE(addr, 0);
    const r = await this.call(Op.Read16, args);
    return r.readUInt16LE(0);
  }
  async read32(addr: number): Promise<number> {
    const args = Buffer.alloc(4); args.writeUInt32LE(addr, 0);
    const r = await this.call(Op.Read32, args);
    return r.readUInt32LE(0);
  }
  async read64(addr: number): Promise<bigint> {
    const args = Buffer.alloc(4); args.writeUInt32LE(addr, 0);
    const r = await this.call(Op.Read64, args);
    return r.readBigUInt64LE(0);
  }

  async write8(addr: number, val: number): Promise<void> {
    const args = Buffer.alloc(5);
    args.writeUInt32LE(addr, 0);
    args.writeUInt8(val, 4);
    await this.call(Op.Write8, args);
  }
  async write16(addr: number, val: number): Promise<void> {
    const args = Buffer.alloc(6);
    args.writeUInt32LE(addr, 0);
    args.writeUInt16LE(val, 4);
    await this.call(Op.Write16, args);
  }
  async write32(addr: number, val: number): Promise<void> {
    const args = Buffer.alloc(8);
    args.writeUInt32LE(addr, 0);
    args.writeUInt32LE(val, 4);
    await this.call(Op.Write32, args);
  }
  async write64(addr: number, val: bigint): Promise<void> {
    const args = Buffer.alloc(12);
    args.writeUInt32LE(addr, 0);
    args.writeBigUInt64LE(val, 4);
    await this.call(Op.Write64, args);
  }

  /** String reply format: u32 length-prefix + bytes (no trailing NUL guarantee). */
  private async readString(opcode: Opcode): Promise<string> {
    const r = await this.call(opcode);
    const len = r.readUInt32LE(0);
    return r.subarray(4, 4 + len).toString("utf8").replace(/\0+$/, "");
  }

  async getVersion():     Promise<string> { return this.readString(Op.Version); }
  async getTitle():       Promise<string> { return this.readString(Op.Title); }
  async getId():          Promise<string> { return this.readString(Op.ID); }
  async getUuid():        Promise<string> { return this.readString(Op.UUID); }
  async getGameVersion(): Promise<string> { return this.readString(Op.GameVersion); }

  async saveState(slot: number): Promise<void> {
    const args = Buffer.alloc(1); args.writeUInt8(slot, 0);
    await this.call(Op.SaveState, args);
  }
  async loadState(slot: number): Promise<void> {
    const args = Buffer.alloc(1); args.writeUInt8(slot, 0);
    await this.call(Op.LoadState, args);
  }

  async getStatus(): Promise<EmuStatus> {
    const r = await this.call(Op.Status);
    const s = r.readUInt32LE(0);
    return s === 0 ? "running" : s === 1 ? "paused" : s === 2 ? "shutdown" : "unknown";
  }

  /**
   * Bulk read — PINE has no native range read, so we issue the largest aligned
   * load at each step (read64 on 8-byte boundaries, falling back to 32/16/8).
   *
   * IMPORTANT: PCSX2's PINE server silently drops requests when too many are
   * pipelined — empirically, ~7-9 in-flight requests is the limit before drops
   * start. Dropped replies leave the client mis-aligned (next reply gets
   * decoded as the wrong type), so we batch in groups of 4 and await each
   * batch fully before sending the next. Slower than full pipelining but
   * reliable.
   */
  async readRange(addr: number, length: number): Promise<Uint8Array> {
    if (length <= 0)        throw new Error("length must be positive");
    if (length > 4096)      throw new Error("length exceeds 4096 byte limit");

    const out = new Uint8Array(length);

    // Build the schedule of reads covering [addr, addr+length)
    type Step = { op: 1 | 2 | 4 | 8; addr: number; outOffset: number };
    const steps: Step[] = [];
    let cursor = addr;
    let outOffset = 0;
    let remaining = length;
    while (remaining > 0) {
      let n: 1 | 2 | 4 | 8;
      if      (cursor % 8 === 0 && remaining >= 8) n = 8;
      else if (cursor % 4 === 0 && remaining >= 4) n = 4;
      else if (cursor % 2 === 0 && remaining >= 2) n = 2;
      else                                          n = 1;
      steps.push({ op: n, addr: cursor, outOffset });
      cursor    += n;
      outOffset += n;
      remaining -= n;
    }

    // PCSX2's PINE server has a fragile request queue: dropping ANY request
    // (which it does silently when in-flight load is too high) leaves the
    // server's reply pipeline desynced and ALL subsequent requests time out
    // until the emulator is restarted. We've seen drops at as few as ~7 mixed
    // in-flight requests. So the safe default is fully serial. Loopback TCP
    // turns out to be fast enough that this isn't actually a problem —
    // measured ~52 ms for a full 4096-byte read against PCSX2 v2.6.3, less
    // than two emulated frames. Override via env var if you trust your
    // specific emulator's PINE implementation to be more robust than PCSX2's.
    const PIPELINE_BATCH = Number.parseInt(process.env.PINE_PIPELINE_BATCH ?? "1", 10) || 1;
    const splatInto = (op: 1|2|4|8, off: number, v: number | bigint) => {
      if (op === 1)      out[off] = v as number;
      else if (op === 2) { out[off] = (v as number) & 0xFF; out[off+1] = ((v as number) >> 8) & 0xFF; }
      else if (op === 4) {
        const n = v as number;
        out[off]   =  n        & 0xFF;
        out[off+1] = (n >>  8) & 0xFF;
        out[off+2] = (n >> 16) & 0xFF;
        out[off+3] = (n >> 24) & 0xFF;
      } else {
        const n = v as bigint;
        for (let j = 0; j < 8; j++) out[off + j] = Number((n >> BigInt(8 * j)) & 0xFFn);
      }
    };

    for (let i = 0; i < steps.length; i += PIPELINE_BATCH) {
      const batch = steps.slice(i, i + PIPELINE_BATCH);
      const promises = batch.map((s) =>
        s.op === 8 ? this.read64(s.addr) :
        s.op === 4 ? this.read32(s.addr) :
        s.op === 2 ? this.read16(s.addr) :
                     this.read8 (s.addr)
      );
      const results = await Promise.all(promises);
      for (let j = 0; j < batch.length; j++) {
        splatInto(batch[j].op, batch[j].outOffset, results[j]);
      }
    }

    return out;
  }
}

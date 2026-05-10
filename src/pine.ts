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

  /** Low-level: send one opcode + args, await one payload (excluding result code). */
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

      this.queue.push({ resolve, reject });
      sock.write(frame, (err) => {
        if (err) {
          // Pull our pending entry back out (it's at the back, but we just pushed)
          this.queue = this.queue.filter((p) => p.resolve !== resolve);
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
}

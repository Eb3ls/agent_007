import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { L1RecordA, L1RecordD, L1RecordE } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/evaluation/ -> src/ -> project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export class EvalLogger {
  private readonly _filePath: string;
  private readonly _startTs: number;
  private _fd: number | null;
  private _seq: number;

  constructor(mapName: string, runIndex: number, logsBaseDir = 'logs') {
    this._startTs = Date.now();
    this._seq = 0;

    const baseDir = path.isAbsolute(logsBaseDir)
      ? logsBaseDir
      : path.join(PROJECT_ROOT, logsBaseDir);

    const dir = path.join(baseDir, 'L1', mapName);
    fs.mkdirSync(dir, { recursive: true });

    const filename = `run_${runIndex}_${this._startTs}.jsonl`;
    this._filePath = path.join(dir, filename);

    this._fd = fs.openSync(this._filePath, 'a');
  }

  get filePath(): string {
    return this._filePath;
  }

  get startTs(): number {
    return this._startTs;
  }

  /** Log a deliberation cycle record (Type D). Increments seq counter. */
  logD(record: Omit<L1RecordD, 't' | 'seq'>): void {
    const full: L1RecordD = { t: 'D', seq: this._seq++, ...record } as L1RecordD;
    this._write(full);
  }

  /** Log an action step record (Type A). Increments seq counter. */
  logA(record: Omit<L1RecordA, 't' | 'seq'>): void {
    const full: L1RecordA = { t: 'A', seq: this._seq++, ...record } as L1RecordA;
    this._write(full);
  }

  /** Log a sparse event record (Type E). Increments seq counter. */
  logE(record: Omit<L1RecordE, 't' | 'seq'>): void {
    const full: L1RecordE = { t: 'E', seq: this._seq++, ...record } as L1RecordE;
    this._write(full);
  }

  /** Flush any pending writes and close the file descriptor. Idempotent. */
  flush(): void {
    if (this._fd !== null) {
      try {
        fs.closeSync(this._fd);
      } catch (err) {
        console.error('[EvalLogger] Error closing file descriptor:', err);
      } finally {
        this._fd = null;
      }
    }
  }

  private _write(record: L1RecordD | L1RecordA | L1RecordE): void {
    if (this._fd === null) {
      console.error('[EvalLogger] Cannot write — file descriptor is closed.');
      return;
    }
    try {
      const line = JSON.stringify(record) + '\n';
      fs.writeSync(this._fd, line);
    } catch (err) {
      console.error('[EvalLogger] Write error:', err);
    }
  }
}

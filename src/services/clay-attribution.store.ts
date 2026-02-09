import fs from 'fs';
import path from 'path';

export type ClayAttributionRecord = {
  clientId: string;
  email: string;
  dealAmount?: number | null;
  dealStage?: string | null;
  updatedAt?: string | null;
};

type StoreFileShape = {
  version: 1;
  updatedAt: string;
  records: ClayAttributionRecord[];
};

/**
 * Minimal local persistence for Clay attribution.
 *
 * Why file-backed?
 * - no new DB dependency
 * - survives process restarts
 *
 * Where it falls short:
 * - not safe for multi-instance horizontal scaling
 */
export class ClayAttributionStore {
  private byKey = new Map<string, ClayAttributionRecord>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(
    private opts: {
      filePath?: string;
      flushDebounceMs?: number;
    } = {}
  ) {}

  private get filePath() {
    return this.opts.filePath ?? path.resolve(process.cwd(), 'tmp', 'clay-attribution.json');
  }

  private keyOf(clientId: string, email: string) {
    return `${String(clientId).toLowerCase()}|${String(email).trim().toLowerCase()}`;
  }

  async init(): Promise<void> {
    // Ensure parent dir exists
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) return;

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreFileShape>;
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      for (const r of records) {
        if (!r?.clientId || !r?.email) continue;
        this.byKey.set(this.keyOf(r.clientId, r.email), {
          clientId: String(r.clientId),
          email: String(r.email),
          dealAmount: Number.isFinite(Number((r as any).dealAmount)) ? Number((r as any).dealAmount) : null,
          dealStage: (r as any).dealStage ?? null,
          updatedAt: (r as any).updatedAt ?? null
        });
      }
    } catch {
      // If file is corrupted, start fresh (don't crash dashboard)
      this.byKey.clear();
    }
  }

  get(clientId: string, email?: string | null) {
    if (!email) return null;
    return this.byKey.get(this.keyOf(clientId, email)) ?? null;
  }

  upsert(record: ClayAttributionRecord) {
    const email = String(record.email ?? '').trim();
    const clientId = String(record.clientId ?? '').trim();
    if (!email || !clientId) return;

    this.byKey.set(this.keyOf(clientId, email), {
      clientId,
      email,
      dealAmount: Number.isFinite(Number(record.dealAmount)) ? Number(record.dealAmount) : null,
      dealStage: record.dealStage ?? null,
      updatedAt: record.updatedAt ?? new Date().toISOString()
    });

    this.scheduleFlush();
  }

  listByClient(clientId: string) {
    const cid = String(clientId).toLowerCase();
    return Array.from(this.byKey.values()).filter(r => String(r.clientId).toLowerCase() === cid);
  }

  private scheduleFlush() {
    const debounce = Math.max(50, Number(this.opts.flushDebounceMs ?? 750));
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => null);
    }, debounce);
  }

  async flush(): Promise<void> {
    // de-dupe concurrent flushes
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = (async () => {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });

      const tmpPath = `${this.filePath}.tmp`;
      const data: StoreFileShape = {
        version: 1,
        updatedAt: new Date().toISOString(),
        records: Array.from(this.byKey.values())
      };
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    })();

    try {
      await this.flushInFlight;
    } finally {
      this.flushInFlight = null;
    }
  }
}

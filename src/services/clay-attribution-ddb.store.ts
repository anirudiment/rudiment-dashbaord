import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand
} from '@aws-sdk/lib-dynamodb';

import type { ClayAttributionRecord } from './clay-attribution.store';

type DynamoClayAttributionStoreOpts = {
  tableName: string;
  region?: string;
};

/**
 * DynamoDB-backed Clay attribution store.
 *
 * Keying:
 * - Partition key: pk = `${clientId}#${email}` (both lowercased)
 */
export class DynamoClayAttributionStore {
  private doc: DynamoDBDocumentClient;

  constructor(private opts: DynamoClayAttributionStoreOpts) {
    const region = opts.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
    const client = new DynamoDBClient({ region });
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true }
    });
  }

  async init(): Promise<void> {
    // no-op; table is expected to exist.
    return;
  }

  private norm(s: string) {
    return String(s ?? '').trim().toLowerCase();
  }

  private pk(clientId: string, email: string) {
    return `${this.norm(clientId)}#${this.norm(email)}`;
  }

  async get(clientId: string, email?: string | null): Promise<ClayAttributionRecord | null> {
    if (!email) return null;
    const pk = this.pk(clientId, email);
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.opts.tableName,
        Key: { pk }
      })
    );
    const item: any = out?.Item;
    if (!item) return null;
    return {
      clientId: String(item.clientId ?? clientId),
      email: String(item.email ?? email),
      dealAmount: Number.isFinite(Number(item.dealAmount)) ? Number(item.dealAmount) : null,
      dealStage: item.dealStage != null ? String(item.dealStage) : null,
      updatedAt: item.updatedAt != null ? String(item.updatedAt) : null
    };
  }

  async getMany(clientId: string, emails: Array<string | null | undefined>): Promise<Map<string, ClayAttributionRecord>> {
    const normed = Array.from(
      new Set(
        (emails ?? [])
          .map(e => (e ? this.norm(e) : ''))
          .filter(Boolean)
      )
    );

    const out = new Map<string, ClayAttributionRecord>();
    if (!normed.length) return out;

    // DynamoDB BatchGet max 100 keys.
    const chunks: string[][] = [];
    for (let i = 0; i < normed.length; i += 100) chunks.push(normed.slice(i, i + 100));

    for (const chunk of chunks) {
      const res = await this.doc.send(
        new BatchGetCommand({
          RequestItems: {
            [this.opts.tableName]: {
              Keys: chunk.map(e => ({ pk: this.pk(clientId, e) }))
            }
          }
        })
      );

      const items: any[] = (res?.Responses?.[this.opts.tableName] as any[]) ?? [];
      for (const item of items) {
        const email = this.norm(String(item?.email ?? ''));
        if (!email) continue;
        out.set(email, {
          clientId: String(item.clientId ?? clientId),
          email: String(item.email ?? email),
          dealAmount: Number.isFinite(Number(item.dealAmount)) ? Number(item.dealAmount) : null,
          dealStage: item.dealStage != null ? String(item.dealStage) : null,
          updatedAt: item.updatedAt != null ? String(item.updatedAt) : null
        });
      }
    }

    return out;
  }

  async upsert(record: ClayAttributionRecord): Promise<void> {
    const email = this.norm(String(record.email ?? ''));
    const clientId = this.norm(String(record.clientId ?? ''));
    if (!email || !clientId) return;

    const now = new Date().toISOString();
    await this.doc.send(
      new PutCommand({
        TableName: this.opts.tableName,
        Item: {
          pk: this.pk(clientId, email),
          clientId,
          email,
          dealAmount: record.dealAmount ?? null,
          dealStage: record.dealStage ?? null,
          updatedAt: record.updatedAt ?? now
        }
      })
    );
  }
}

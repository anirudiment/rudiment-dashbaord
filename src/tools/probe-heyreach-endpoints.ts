#!/usr/bin/env node
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

type Endpoint = { method: 'get' | 'post'; url: string; data?: any };

function summarize(data: any) {
  if (data == null) return null;
  if (Array.isArray(data)) {
    return { type: 'array', length: data.length, keys0: data[0] ? Object.keys(data[0]).slice(0, 15) : [] };
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    const inner = (data as any).items ?? (data as any).data ?? (data as any).result ?? (data as any).leads ?? (data as any).conversations;
    return {
      type: 'object',
      keys: keys.slice(0, 25),
      innerType: Array.isArray(inner) ? 'array' : typeof inner,
      innerLength: Array.isArray(inner) ? inner.length : undefined,
      innerKeys0: Array.isArray(inner) && inner[0] ? Object.keys(inner[0]).slice(0, 20) : undefined
    };
  }
  return { type: typeof data };
}

async function main() {
  const apiKey = process.env.CLIENT1_HEYREACH_KEY;
  if (!apiKey) throw new Error('CLIENT1_HEYREACH_KEY missing');

  const client = axios.create({
    baseURL: 'https://api.heyreach.io/api/public',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    timeout: 10_000,
    validateStatus: () => true
  });

  const endpoints: Endpoint[] = [
    // confirmed working
    { method: 'post', url: '/campaign/getAll', data: { offset: 0, limit: 1 } },
    // likely lead endpoints
    { method: 'post', url: '/lead/getAll', data: { offset: 0, limit: 1 } },
    { method: 'get', url: '/lead/getAll' },
    { method: 'post', url: '/lead/getAllLeads', data: { offset: 0, limit: 1 } },
    // likely conversation endpoints (guesses)
    { method: 'post', url: '/conversation/getAll', data: { offset: 0, limit: 1 } },
    { method: 'post', url: '/conversation/getAllV2', data: { offset: 0, limit: 1 } },
    { method: 'post', url: '/conversation/getConversationsV2', data: { offset: 0, limit: 1 } },
    { method: 'post', url: '/conversation/getAllConversations', data: { offset: 0, limit: 1 } },
    { method: 'get', url: '/conversation/getAll' },
    // webhook endpoints (guesses)
    { method: 'post', url: '/webhook/getAll', data: {} },
    { method: 'get', url: '/webhook/getAll' }
  ];

  const results: any[] = [];
  for (const ep of endpoints) {
    const res = await client.request({ method: ep.method, url: ep.url, data: ep.data });
    results.push({
      endpoint: `${ep.method.toUpperCase()} ${ep.url}`,
      status: res.status,
      summary: summarize(res.data),
      // include top-level error for quick debugging
      error: res.status >= 400 ? (res.data?.message ?? res.data?.error ?? res.data) : undefined
    });
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error(err?.message ?? err);
  process.exit(1);
});

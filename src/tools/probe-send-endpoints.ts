#!/usr/bin/env node
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

type Endpoint = { method: 'get' | 'post'; url: string; params?: Record<string, any> };

function summarize(data: any) {
  if (data == null) return null;
  if (Array.isArray(data)) {
    return {
      type: 'array',
      length: data.length,
      keys0: data[0] ? Object.keys(data[0]).slice(0, 15) : []
    };
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data);
    const inner = (data as any).data ?? (data as any).items ?? (data as any).campaigns ?? (data as any).leads ?? (data as any).replies;
    return {
      type: 'object',
      keys: keys.slice(0, 20),
      innerType: Array.isArray(inner) ? 'array' : typeof inner,
      innerLength: Array.isArray(inner) ? inner.length : undefined,
      innerKeys0: Array.isArray(inner) && inner[0] ? Object.keys(inner[0]).slice(0, 15) : undefined
    };
  }
  return { type: typeof data };
}

async function main() {
  const token = process.env.CLIENT1_EMAILBISON_KEY;
  if (!token) throw new Error('CLIENT1_EMAILBISON_KEY missing');

  const client = axios.create({
    baseURL: 'https://send.getrudiment.com',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 10_000,
    validateStatus: () => true
  });

  const endpoints: Endpoint[] = [
    { method: 'get', url: '/api/campaigns' },
    { method: 'get', url: '/api/replies' },
    { method: 'get', url: '/api/replies', params: { limit: 1 } },
    { method: 'get', url: '/api/leads' },
    { method: 'get', url: '/api/leads', params: { limit: 1 } },
    { method: 'get', url: '/api/contacts' },
    { method: 'get', url: '/api/contacts', params: { limit: 1 } },
    { method: 'get', url: '/api/messages' },
    { method: 'get', url: '/api/inbox' },
    { method: 'get', url: '/api/threads' },
    { method: 'get', url: '/api/conversations' },
    { method: 'get', url: '/api/webhooks' }
  ];

  const results: any[] = [];
  for (const ep of endpoints) {
    const res = await client.request({ method: ep.method, url: ep.url, params: ep.params });
    results.push({
      endpoint: `${ep.method.toUpperCase()} ${ep.url}${ep.params ? ' ' + JSON.stringify(ep.params) : ''}`,
      status: res.status,
      summary: summarize(res.data)
    });
  }

  // Also dump one sample reply + one sample lead (keys only + a few fields), to see how to join Reply -> Lead.
  let sample: any = {};
  try {
    const replies = await client.get('/api/replies', { params: { per_page: 1 } });
    const r = (replies.data as any)?.data?.[0];
    if (r) {
      sample.reply = {
        keys: Object.keys(r),
        pick: {
          id: r.id,
          uuid: r.uuid,
          interested: r.interested,
          automated_reply: r.automated_reply,
          date_received: r.date_received,
          scheduled_email_id: r.scheduled_email_id,
          lead_id: (r as any).lead_id,
          lead_uuid: (r as any).lead_uuid,
          campaign_id: (r as any).campaign_id,
          campaign_uuid: (r as any).campaign_uuid,
          subject: r.subject,
          text_body_preview: String(r.text_body ?? '').slice(0, 160)
        }
      };
    }
  } catch (e: any) {
    sample.replyError = e?.message ?? String(e);
  }

  try {
    const leads = await client.get('/api/leads', { params: { per_page: 1 } });
    const l = (leads.data as any)?.data?.[0];
    if (l) {
      sample.lead = {
        keys: Object.keys(l),
        pick: {
          id: l.id,
          first_name: l.first_name,
          last_name: l.last_name,
          email: l.email,
          tags: l.tags,
          status: l.status,
          created_at: l.created_at
        }
      };
    }
  } catch (e: any) {
    sample.leadError = e?.message ?? String(e);
  }

  console.log(JSON.stringify({ endpoints: results, sample }, null, 2));
}

main().catch(err => {
  console.error(err?.message ?? err);
  process.exit(1);
});

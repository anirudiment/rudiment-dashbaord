import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

/**
 * ICP (Ideal Customer Profile) Service
 *
 * Reads per-client ICP markdown files from src/data/icp/
 * and optionally fetches the client's website for fresh context.
 *
 * ICP files live at: src/data/icp/<filename>.md
 * Create one per client using the template at: src/data/icp/_template.md
 */

const ICP_DIR = path.resolve(__dirname, '../data/icp');

export interface IcpProfile {
  clientName: string;
  content: string;          // Raw markdown content
  filePath: string;
  lastModified: Date;
}

export interface WebCheckResult {
  url: string;
  title?: string;
  description?: string;
  text: string;             // Extracted visible text (first ~3000 chars)
  fetchedAt: string;
}

export class IcpService {
  /**
   * Read the ICP markdown file for a client.
   * Returns null if no file is configured or found.
   */
  static readIcpProfile(icpFileName: string, clientName: string): IcpProfile | null {
    const filePath = path.join(ICP_DIR, icpFileName);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const stat = fs.statSync(filePath);

    return {
      clientName,
      content,
      filePath,
      lastModified: stat.mtime,
    };
  }

  /**
   * List all ICP files in the icp directory.
   */
  static listIcpFiles(): string[] {
    if (!fs.existsSync(ICP_DIR)) return [];
    return fs.readdirSync(ICP_DIR).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
  }

  /**
   * Fetch a client's website and extract visible text for context.
   * Strips HTML tags and collapses whitespace.
   * Caps at ~3000 characters to keep context tight.
   */
  static async checkWebsite(url: string): Promise<WebCheckResult> {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RudimentBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      maxRedirects: 5,
    });

    const html: string = res.data ?? '';

    // Extract <title>
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : undefined;

    // Extract <meta name="description">
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const description = descMatch ? descMatch[1].trim() : undefined;

    // Strip all HTML tags and collapse whitespace
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    return {
      url,
      title,
      description,
      text,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Format ICP profile + web check result as a single context block.
   */
  static formatContext(icp: IcpProfile | null, webCheck: WebCheckResult | null): string {
    const parts: string[] = [];

    if (icp) {
      const age = Math.round((Date.now() - icp.lastModified.getTime()) / (1000 * 60 * 60 * 24));
      parts.push(`# ICP Profile: ${icp.clientName}\n_Last updated ${age} day(s) ago_\n\n${icp.content}`);
    }

    if (webCheck) {
      parts.push(
        `# Website Snapshot: ${webCheck.url}\n` +
        `_Fetched at ${new Date(webCheck.fetchedAt).toLocaleString()}_\n\n` +
        (webCheck.title ? `**Title:** ${webCheck.title}\n` : '') +
        (webCheck.description ? `**Description:** ${webCheck.description}\n\n` : '') +
        webCheck.text
      );
    }

    return parts.join('\n\n---\n\n') || 'No ICP profile or website data available.';
  }
}

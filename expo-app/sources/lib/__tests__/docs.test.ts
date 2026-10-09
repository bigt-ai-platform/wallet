import { describe, expect, it } from 'vitest';
import { docsPdfUrl, p2pPdfUrl, pdfSuffix, tzRegion } from '../docs';

describe('pdfSuffix', () => {
  it('uses no suffix for English', () => {
    expect(pdfSuffix('en')).toBe('');
  });

  it('uses .<lang> for a rendered language', () => {
    expect(pdfSuffix('zh')).toBe('.zh');
    expect(pdfSuffix('ja')).toBe('.ja');
  });

  it('falls back to the English file for unrendered languages', () => {
    expect(pdfSuffix('xx')).toBe('');
  });
});

describe('docsPdfUrl', () => {
  it('points every region at its own wallet docs bucket', () => {
    expect(docsPdfUrl('p2p.pdf')).toBe('https://s3.bigt.ai/wallet-docs-eu/demo/p2p.pdf');
    expect(docsPdfUrl('p2p.pdf', 'usa')).toBe('https://s3-us.bigt.ai/wallet-docs-us/demo/p2p.pdf');
    expect(docsPdfUrl('p2p.zh.pdf', 'asia')).toBe('https://s3-asia.bigt.ai/wallet-docs-asia/demo/p2p.zh.pdf');
  });
});

describe('p2pPdfUrl', () => {
  it('builds the language-suffixed file and normalizes BCP-47 tags', () => {
    expect(p2pPdfUrl('en')).toBe('https://s3.bigt.ai/wallet-docs-eu/demo/p2p.pdf');
    expect(p2pPdfUrl('zh')).toBe('https://s3.bigt.ai/wallet-docs-eu/demo/p2p.zh.pdf');
    expect(p2pPdfUrl('de-AT', 'usa')).toBe('https://s3-us.bigt.ai/wallet-docs-us/demo/p2p.de.pdf');
  });
});

describe('tzRegion', () => {
  it('maps timezones to the nearest docs region', () => {
    expect(tzRegion('Asia/Shanghai')).toBe('asia');
    expect(tzRegion('Australia/Sydney')).toBe('asia');
    expect(tzRegion('America/New_York')).toBe('usa');
    expect(tzRegion('Europe/Berlin')).toBe('europa');
  });
});

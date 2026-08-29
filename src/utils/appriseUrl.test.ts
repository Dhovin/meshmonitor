import { describe, it, expect } from 'vitest';
import { normalizeAppriseUrl, normalizeAppriseUrls } from './appriseUrl.js';

describe('appriseUrl — normalizeAppriseUrl', () => {
  it('converts standard discord.com webhook URLs', () => {
    const input = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789_-';
    expect(normalizeAppriseUrl(input)).toBe('discord://123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789_-');
  });

  it('converts discordapp.com webhook URLs', () => {
    const input = 'https://discordapp.com/api/webhooks/987654321/token_xyz';
    expect(normalizeAppriseUrl(input)).toBe('discord://987654321/token_xyz');
  });

  it('converts canary and ptb discord webhook URLs', () => {
    const canary = 'https://canary.discord.com/api/webhooks/11223344/token-canary';
    const ptb = 'https://ptb.discord.com/api/webhooks/55667788/token-ptb';
    expect(normalizeAppriseUrl(canary)).toBe('discord://11223344/token-canary');
    expect(normalizeAppriseUrl(ptb)).toBe('discord://55667788/token-ptb');
  });

  it('handles URLs with leading/trailing whitespace, trailing slashes, or query params', () => {
    const url = '   https://discord.com/api/webhooks/12345/token_abc/?wait=true   ';
    expect(normalizeAppriseUrl(url)).toBe('discord://12345/token_abc');
  });

  it('leaves already-formatted discord:// URLs untouched', () => {
    const input = 'discord://123456789012345678/abcdefg';
    expect(normalizeAppriseUrl(input)).toBe('discord://123456789012345678/abcdefg');
  });

  it('leaves non-Discord Apprise URLs untouched', () => {
    expect(normalizeAppriseUrl('slack://token_a/token_b/token_c')).toBe('slack://token_a/token_b/token_c');
    expect(normalizeAppriseUrl('tgram://123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ/chat_id')).toBe('tgram://123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ/chat_id');
    expect(normalizeAppriseUrl('mailto://user:pass@example.com')).toBe('mailto://user:pass@example.com');
  });

  it('handles empty or non-string input gracefully', () => {
    expect(normalizeAppriseUrl('')).toBe('');
    expect(normalizeAppriseUrl(null as any)).toBe('');
    expect(normalizeAppriseUrl(undefined as any)).toBe('');
  });
});

describe('appriseUrl — normalizeAppriseUrls', () => {
  it('normalizes a list of URLs and filters out empty lines', () => {
    const list = [
      'https://discord.com/api/webhooks/111/token1',
      '   ',
      'discord://222/token2',
      'tgram://bot_token/chat_id',
    ];
    expect(normalizeAppriseUrls(list)).toEqual([
      'discord://111/token1',
      'discord://222/token2',
      'tgram://bot_token/chat_id',
    ]);
  });

  it('handles non-array gracefully', () => {
    expect(normalizeAppriseUrls(null as any)).toEqual([]);
    expect(normalizeAppriseUrls(undefined as any)).toEqual([]);
  });
});

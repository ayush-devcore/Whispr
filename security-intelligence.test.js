import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHttpUrls, inspectUrl, inspectAttachment } from './security-intelligence.js';

test('extracts unique HTTP and HTTPS URLs and trims surrounding punctuation', () => {
  assert.deepEqual(
    extractHttpUrls('Visit https://example.com/path?x=1, then www.example.org! https://example.com/path?x=1'),
    ['https://example.com/path?x=1', 'https://www.example.org/']
  );
});

test('ignores non-web schemes and malformed URL candidates', () => {
  assert.deepEqual(extractHttpUrls('javascript:alert(1) data:text/plain,hello not a URL'), []);
});

test('caps extracted URLs at five', () => {
  const text = Array.from({ length: 8 }, (_, index) => 'https://host' + index + '.example/path').join(' ');
  assert.equal(extractHttpUrls(text).length, 5);
});

test('flags deceptive and risky URL patterns without making network requests', () => {
  const result = inspectUrl('http://paypal-login.example/verify?account=1');
  assert.equal(result.reputationStatus, 'not_checked');
  assert.ok(result.localScore >= 35);
  assert.ok(result.signals.includes('unencrypted_http'));
  assert.ok(result.signals.includes('possible_brand_impersonation'));
  assert.ok(result.signals.includes('sensitive_or_urgent_url_path'));
});

test('flags URL shorteners, punycode and embedded credentials', () => {
  assert.ok(inspectUrl('https://bit.ly/abc123').signals.includes('url_shortener'));
  assert.ok(inspectUrl('https://xn--e1afmkfd.example/').signals.includes('punycode_hostname'));
  assert.ok(inspectUrl('https://user:pass@example.com/').signals.includes('embedded_credentials'));
});

test('ordinary HTTPS host has no local heuristic signals but is not declared safe', () => {
  const result = inspectUrl('https://example.com/about');
  assert.equal(result.localScore, 0);
  assert.deepEqual(result.signals, []);
  assert.equal(result.severity, 'low');
  assert.equal(result.reputationStatus, 'not_checked');
});

test('redacts URL credentials, query values and fragments before provider analysis', () => {
  const [candidate] = extractHttpUrls('Use https://alice:secret@example.com/reset?token=super-secret#private');
  const inspected = inspectUrl(candidate);
  assert.equal(inspected.url, 'https://example.com/reset?token=%5Bredacted%5D');
  assert.ok(inspected.signals.includes('embedded_credentials'));
  assert.equal(inspected.url.includes('secret'), false);
  assert.equal(inspected.url.includes('super-secret'), false);
  assert.equal(inspected.url.includes('private'), false);
});

test('invalid URLs fail closed', () => {
  const result = inspectUrl('not a URL');
  assert.deepEqual(result.signals, ['invalid_url']);
  assert.equal(result.localScore, 100);
  assert.equal(result.severity, 'critical');
});

test('blocks executable and active-script attachment extensions', () => {
  for (const filename of ['setup.exe', 'payload.PS1', 'launch.bat', 'helper.dll', 'app.apk']) {
    assert.equal(inspectAttachment(filename).blocked, true, filename + ' should be blocked');
  }
});

test('blocks executable binary signatures even when disguised as a document', () => {
  assert.equal(inspectAttachment('invoice.pdf', Buffer.from([0x4d, 0x5a, 0x90, 0x00])).blocked, true, 'PE signature should be blocked');
  assert.equal(inspectAttachment('notes.txt', Buffer.from([0x7f, 0x45, 0x4c, 0x46])).blocked, true, 'ELF signature should be blocked');
  assert.equal(inspectAttachment('report.pdf', Buffer.from([0xfe, 0xed, 0xfa, 0xcf])).blocked, true, 'Mach-O signature should be blocked');
});

test('allows ordinary document and image signatures while making no malware claim', () => {
  assert.deepEqual(inspectAttachment('notes.txt', Buffer.from('hello')), { blocked: false, reason: null, extension: 'txt' });
  assert.equal(inspectAttachment('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])).blocked, false);
});

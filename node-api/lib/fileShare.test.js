import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  DEFAULT_QUOTA_BYTES,
  canAcceptUpload,
  contentDisposition,
  quotaBytes,
  remainingBytes,
  sanitizeOriginalName,
  storedPath,
} from './fileShare.js';

describe('quotaBytes', () => {
  it('defaults to 5 GiB', () => {
    assert.equal(quotaBytes({}), DEFAULT_QUOTA_BYTES);
    assert.equal(quotaBytes({ FILE_SHARE_QUOTA_BYTES: '' }), DEFAULT_QUOTA_BYTES);
  });

  it('reads a positive env override', () => {
    assert.equal(quotaBytes({ FILE_SHARE_QUOTA_BYTES: '1048576' }), 1048576);
  });
});

describe('canAcceptUpload', () => {
  it('rejects empty files', () => {
    const result = canAcceptUpload(0, 0, 1000);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'empty');
  });

  it('rejects a file larger than remaining space', () => {
    const result = canAcceptUpload(800, 300, 1000);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'quota');
    assert.equal(result.remaining, 200);
  });

  it('accepts a file that fits', () => {
    const result = canAcceptUpload(200, 300, 1000);
    assert.equal(result.ok, true);
    assert.equal(result.remaining, 800);
  });
});

describe('remainingBytes', () => {
  it('never goes negative', () => {
    assert.equal(remainingBytes(1500, 1000), 0);
  });
});

describe('sanitizeOriginalName', () => {
  it('strips path pieces and keeps the basename', () => {
    assert.equal(sanitizeOriginalName('../../secret.pdf'), 'secret.pdf');
    assert.equal(sanitizeOriginalName('photos/vacation.jpg'), 'vacation.jpg');
  });
});

describe('storedPath', () => {
  it('keeps files inside the storage directory', () => {
    const dir = '/data/file-share';
    assert.equal(storedPath('abc-uuid', dir), path.join(dir, 'abc-uuid'));
    assert.throws(() => storedPath('../etc/passwd', dir));
  });
});

describe('contentDisposition', () => {
  it('includes an RFC 5987 filename', () => {
    const header = contentDisposition('Family Photo.png');
    assert.match(header, /filename="Family Photo.png"/);
    assert.match(header, /filename\*=UTF-8''Family%20Photo.png/);
  });
});

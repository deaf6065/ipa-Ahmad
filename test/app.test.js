const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createApp, safeZipTarget } = require('../backend/app');

let dataDir;
let server;
let baseUrl;
let app;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entryName, content) {
  const name = Buffer.from(entryName);
  const body = Buffer.from(content);
  const checksum = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localRecord = Buffer.concat([local, name, body]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralRecord = Buffer.concat([central, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRecord.length, 12);
  end.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, end]);
}

async function upload(kind, name, bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), name);
  return fetch(`${baseUrl}/api/uploads/${kind}`, { method: 'POST', body: form });
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipa-ahmad-test-'));
  app = createApp({ dataDir, maxFileSize: 1024 * 1024 });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  app.locals.closeDatabase();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('only extracts archive entries inside the selected root', () => {
  const root = path.join(os.tmpdir(), 'archive-root');
  assert.equal(safeZipTarget(root, 'Payload/App.app/app'), path.join(root, 'Payload', 'App.app', 'app'));
  assert.throws(() => safeZipTarget(root, '../outside'), /مسار غير آمن/);
  assert.throws(() => safeZipTarget(root, '/outside'), /مسار غير آمن/);
  assert.throws(() => safeZipTarget(root, 'folder\\..\\outside'), /مسار غير آمن/);
});

test('uploads a ZIP, lists metadata, and extracts it when inspected', async () => {
  const archive = makeZip('Payload/App.app/Info.plist', '<plist/>');
  const response = await upload('zip', 'sample.zip', archive);
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.equal(uploaded.file.kind, 'zip');
  assert.equal(uploaded.file.name, 'sample.zip');

  const listing = await fetch(`${baseUrl}/api/files`).then((result) => result.json());
  assert.equal(listing.files.length, 1);
  assert.equal(listing.files[0].id, uploaded.file.id);
  assert.equal(listing.files[0].size, archive.length);

  const inspected = await fetch(`${baseUrl}/api/files/${uploaded.file.id}/inspect`, { method: 'POST' });
  assert.equal(inspected.status, 200);
  const report = await inspected.json();
  assert.equal(report.report.fileCount, 1);
  assert.deepEqual(report.report.topLevel, ['Payload']);
  assert.equal(
    await fs.readFile(path.join(dataDir, 'extracted', uploaded.file.id, 'Payload/App.app/Info.plist'), 'utf8'),
    '<plist/>'
  );
});

test('rejects an extension mismatch and a non-archive upload', async () => {
  const mismatch = await upload('ipa', 'not-ipa.zip', makeZip('file.txt', 'content'));
  assert.equal(mismatch.status, 400);

  const invalid = await upload('zip', 'broken.zip', Buffer.from('not a zip'));
  assert.equal(invalid.status, 400);
  const malformed = await upload('zip', 'malformed.zip', Buffer.from('PK\x03\x04not a complete archive'));
  assert.equal(malformed.status, 400);
  const oversized = await upload('zip', 'large.zip', Buffer.alloc(1024 * 1024 + 1));
  assert.equal(oversized.status, 413);
  const listing = await fetch(`${baseUrl}/api/files`).then((result) => result.json());
  assert.equal(listing.files.length, 1);
});

test('rejects ZIP path traversal and does not write outside the extraction directory', async () => {
  const archive = makeZip('../escaped.txt', 'must not escape');
  const response = await upload('zip', 'unsafe.zip', archive);
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  const inspected = await fetch(`${baseUrl}/api/files/${uploaded.file.id}/inspect`, { method: 'POST' });
  assert.equal(inspected.status, 400);
  await assert.rejects(fs.access(path.join(dataDir, 'escaped.txt')));
});

test('refuses to inspect a non-ZIP item', async () => {
  const response = await upload('ipa', 'app.ipa', makeZip('Payload/App', 'app'));
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  const inspected = await fetch(`${baseUrl}/api/files/${uploaded.file.id}/inspect`, { method: 'POST' });
  assert.equal(inspected.status, 400);
});

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const yauzl = require('yauzl');

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeZipTarget(root, entryName) {
  if (
    typeof entryName !== 'string' ||
    !entryName ||
    entryName.includes('\0') ||
    entryName.includes('\\') ||
    entryName.includes(':') ||
    entryName.startsWith('/') ||
    /^[a-zA-Z]:/.test(entryName)
  ) {
    throw new Error('يحتوي الأرشيف على مسار غير آمن.');
  }

  const segments = entryName.split('/');
  if (segments.includes('..')) {
    throw new Error('يحتوي الأرشيف على مسار غير آمن.');
  }

  const normalized = path.posix.normalize(entryName);
  if (normalized === '.' || normalized === '..') {
    throw new Error('يحتوي الأرشيف على مسار غير آمن.');
  }

  const base = path.resolve(root);
  const target = path.resolve(base, ...normalized.split('/'));
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error('يحتوي الأرشيف على مسار غير آمن.');
  }

  return target;
}

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, autoClose: false },
      (error, zipFile) => (error ? reject(error) : resolve(zipFile))
    );
  });
}

async function extractAndInspect(zipPath, destination, maxExtractedSize) {
  const zipFile = await openZip(zipPath);
  await fsp.rm(destination, { recursive: true, force: true });
  await fsp.mkdir(destination, { recursive: true });

  return new Promise((resolve, reject) => {
    let fileCount = 0;
    let extractedBytes = 0;
    let entryCount = 0;
    const topLevel = new Set();
    let finished = false;

    const fail = (error) => {
      if (finished) return;
      finished = true;
      zipFile.close();
      fsp.rm(destination, { recursive: true, force: true })
        .catch(() => {})
        .then(() => reject(error));
    };

    zipFile.on('error', fail);
    zipFile.on('end', () => {
      if (finished) return;
      finished = true;
      zipFile.close();
      resolve({
        fileCount,
        entryCount,
        extractedBytes,
        topLevel: [...topLevel].sort(),
      });
    });

    zipFile.on('entry', (entry) => {
      (async () => {
        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) {
          throw new Error('الأرشيف يحتوي على عدد كبير جداً من الملفات.');
        }

        const target = safeZipTarget(destination, entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0o170000) === 0o120000) {
          throw new Error('الأرشيف يحتوي على رابط رمزي غير مسموح.');
        }

        const firstPart = entry.fileName.replace(/\/$/, '').split('/')[0];
        if (firstPart) topLevel.add(firstPart);

        if (entry.fileName.endsWith('/')) {
          await fsp.mkdir(target, { recursive: true });
        } else {
          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            entry.uncompressedSize < 0 ||
            extractedBytes + entry.uncompressedSize > maxExtractedSize
          ) {
            throw new Error('حجم الملفات بعد فك الضغط يتجاوز الحد المسموح.');
          }

          await fsp.mkdir(path.dirname(target), { recursive: true });
          const source = await new Promise((resolveStream, rejectStream) => {
            zipFile.openReadStream(entry, (error, stream) =>
              error ? rejectStream(error) : resolveStream(stream)
            );
          });
          await pipeline(source, fs.createWriteStream(target, { flags: 'wx' }));
          extractedBytes += entry.uncompressedSize;
          fileCount += 1;
        }

        if (!finished) zipFile.readEntry();
      })().catch(fail);
    });

    zipFile.readEntry();
  });
}

function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const uploadsDir = path.join(dataDir, 'uploads');
  const extractedDir = path.join(dataDir, 'extracted');
  const frontendDir = path.join(__dirname, '..', 'frontend');
  const requestedMaxFileSize = options.maxFileSize || Number(process.env.MAX_FILE_SIZE);
  const maxFileSize = Number.isSafeInteger(requestedMaxFileSize) && requestedMaxFileSize > 0
    ? requestedMaxFileSize
    : DEFAULT_MAX_FILE_SIZE;

  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(extractedDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'files.sqlite'));
  const uploadPaths = new WeakMap();
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('ipa', 'zip')),
      size INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL,
      storage_name TEXT NOT NULL
    )
  `);

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.static(frontendDir));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, uploadsDir),
      filename: (req, _file, callback) => {
        const filename = crypto.randomUUID();
        uploadPaths.set(req, path.join(uploadsDir, filename));
        callback(null, filename);
      },
    }),
    limits: { fileSize: maxFileSize, files: 1 },
  });
  const createLimiter = (limit) => rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: 'تم تجاوز عدد الطلبات المسموح. حاول لاحقاً.' }),
  });
  const uploadLimiter = createLimiter(20);
  const inspectLimiter = createLimiter(30);

  app.get('/api/files', (_req, res) => {
    const files = db
      .prepare('SELECT id, original_name AS name, kind, size, uploaded_at AS uploadedAt FROM files ORDER BY uploaded_at DESC')
      .all();
    res.json({ files });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ maxFileSize });
  });

  for (const kind of ['ipa', 'zip']) {
    app.post(`/api/uploads/${kind}`, uploadLimiter, upload.single('file'), async (req, res, next) => {
      const temporaryPath = uploadPaths.get(req);
      uploadPaths.delete(req);
      if (!req.file) {
        return res.status(400).json({ error: 'اختر ملفاً لرفعه.' });
      }

      const extension = path.extname(req.file.originalname).toLowerCase();
      if (extension !== `.${kind}`) {
        await fsp.rm(temporaryPath, { force: true });
        return res.status(400).json({ error: `هذا المسار يقبل ملفات .${kind} فقط.` });
      }

      let finalPath;
      try {
        const handle = await fsp.open(temporaryPath, 'r');
        const header = Buffer.alloc(4);
        let bytesRead;
        try {
          ({ bytesRead } = await handle.read(header, 0, 4, 0));
        } finally {
          await handle.close();
        }
        const signatures = ['504b0304', '504b0506', '504b0708'];
        if (bytesRead < 4 || !signatures.includes(header.toString('hex'))) {
          await fsp.rm(temporaryPath, { force: true });
          return res.status(400).json({ error: 'محتوى الملف ليس أرشيف ZIP صالحاً.' });
        }

        let archive;
        try {
          archive = await openZip(temporaryPath);
        } catch {
          await fsp.rm(temporaryPath, { force: true });
          return res.status(400).json({ error: 'الأرشيف ZIP تالف أو غير صالح.' });
        }
        archive.close();
        const id = crypto.randomUUID();
        const storageName = `${id}.${kind}`;
        finalPath = path.join(uploadsDir, storageName);
        await fsp.rename(temporaryPath, finalPath);

        const originalName = path.basename(req.file.originalname).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
        const uploadedAt = new Date().toISOString();
        db.prepare(
          'INSERT INTO files (id, original_name, kind, size, uploaded_at, storage_name) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, originalName || `file.${kind}`, kind, req.file.size, uploadedAt, storageName);

        return res.status(201).json({
          file: { id, name: originalName || `file.${kind}`, kind, size: req.file.size, uploadedAt },
        });
      } catch (error) {
        await fsp.rm(temporaryPath, { force: true }).catch(() => {});
        if (finalPath) await fsp.rm(finalPath, { force: true }).catch(() => {});
        return next(error);
      }
    });
  }

  app.post('/api/files/:id/inspect', inspectLimiter, async (req, res, next) => {
    try {
      if (!UUID_PATTERN.test(req.params.id)) {
        return res.status(404).json({ error: 'الملف غير موجود.' });
      }
      const file = db
        .prepare('SELECT id, kind FROM files WHERE id = ?')
        .get(req.params.id);
      if (!file) return res.status(404).json({ error: 'الملف غير موجود.' });
      if (file.kind !== 'zip') {
        return res.status(400).json({ error: 'فك الضغط والفحص متاحان لملفات ZIP فقط.' });
      }

      const report = await extractAndInspect(
        path.join(uploadsDir, `${req.params.id}.zip`),
        safeZipTarget(extractedDir, req.params.id),
        maxFileSize * 2
      );
      return res.json({ report });
    } catch (error) {
      if (/[\u0600-\u06FF]/.test(error.message)) return res.status(400).json({ error: error.message });
      if (error.code === 'ENOSPC') {
        return res.status(507).json({ error: 'لا توجد مساحة تخزين كافية على الخادم لفك ضغط هذا الأرشيف.' });
      }
      return res.status(400).json({ error: 'تعذر فك الضغط؛ قد يكون الأرشيف تالفاً أو غير صالح.' });
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? `حجم الملف يتجاوز الحد الأقصى (${Math.floor(maxFileSize / 1024 / 1024)} ميغابايت).`
        : 'تعذر استقبال الملف. تحقق من الملف وحاول مرة أخرى.';
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }
    console.error(error);
    const message = error.code === 'ENOSPC'
      ? 'لا توجد مساحة تخزين كافية على الخادم لحفظ الملف.'
      : 'حدث خطأ أثناء معالجة الطلب. تحقق من الملف وحاول مرة أخرى.';
    return res.status(error.code === 'ENOSPC' ? 507 : 500).json({ error: message });
  });

  app.locals.closeDatabase = () => db.close();
  return app;
}

module.exports = { createApp, safeZipTarget, extractAndInspect, DEFAULT_MAX_FILE_SIZE };

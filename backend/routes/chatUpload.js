// chatUpload.js
// Production-ready media attachment handling for Dexa Consult chat.
// Zero external npm dependencies — built with pure Node.js fs, path, crypto, and Buffer.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ---------------- Size limits ----------------
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_AUDIO_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILE_SIZE = 20 * 1024 * 1024;  // 20 MB

// ---------------- Allowed extensions & MIMEs ----------------
const IMAGE_RULES = {
  exts: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  maxSize: MAX_IMAGE_SIZE,
};

const AUDIO_RULES = {
  exts: ['.webm', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.mp4'],
  mimes: [
    'audio/webm',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac',
    'video/webm', // MediaRecorder often produces audio wrapped in webm container
  ],
  maxSize: MAX_AUDIO_SIZE,
};

const DOC_RULES = {
  exts: [
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv',
    '.rtf', '.odt', '.ods', '.ppt', '.pptx',
  ],
  mimes: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/octet-stream', // allowed only if extension is verified doc
  ],
  maxSize: MAX_FILE_SIZE,
};

// Dangerous executable and script extensions strictly prohibited
const DANGEROUS_EXTS = [
  '.exe', '.bat', '.cmd', '.sh', '.bash', '.js', '.mjs', '.cjs',
  '.vbs', '.vb', '.scr', '.com', '.pif', '.msi', '.jar', '.py',
  '.ps1', '.html', '.htm', '.php', '.asp', '.aspx', '.cgi',
  '.dll', '.so', '.app', '.dmg', '.iso', '.bin',
];

// Helper: authenticate from Authorization header or URL token parameter
function authenticateUser(req, query = {}) {
  let user = auth.authenticateDoctor(req) || auth.authenticatePatient(req);
  if (!user && query && query.token) {
    const token = String(query.token).trim();
    user = db.doctors.where((d) => d.authToken === token)[0] ||
           db.patients.where((p) => p.authToken === token)[0] || null;
  }
  return user;
}

// Pure Node.js zero-dependency multipart/form-data parser
function parseMultipart(buffer, boundary) {
  const result = { fields: {}, files: {} };
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let start = 0;

  while (start < buffer.length) {
    const idx = buffer.indexOf(boundaryBuffer, start);
    if (idx === -1) break;

    const partStart = idx + boundaryBuffer.length;
    // Check end boundary "--"
    if (buffer.slice(partStart, partStart + 2).toString() === '--') break;

    let headerStart = partStart;
    if (buffer[headerStart] === 13 && buffer[headerStart + 1] === 10) {
      headerStart += 2;
    }

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(headerStart, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    let nextBoundary = buffer.indexOf(boundaryBuffer, bodyStart);
    if (nextBoundary === -1) nextBoundary = buffer.length;

    let bodyEnd = nextBoundary;
    if (bodyEnd >= 2 && buffer[bodyEnd - 2] === 13 && buffer[bodyEnd - 1] === 10) {
      bodyEnd -= 2;
    }

    const partBody = buffer.slice(bodyStart, bodyEnd);
    const dispMatch = headerStr.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);

    if (dispMatch) {
      const fieldName = dispMatch[1];
      const filename = dispMatch[2];
      const typeMatch = headerStr.match(/content-type:\s*([^\r\n;]+)/i);
      const mimeType = typeMatch ? typeMatch[1].trim() : 'application/octet-stream';

      if (filename !== undefined) {
        result.files[fieldName] = {
          filename,
          mimeType,
          data: partBody,
          size: partBody.length,
        };
      } else {
        result.fields[fieldName] = partBody.toString('utf8');
      }
    }

    start = nextBoundary;
  }

  return result;
}

// Validate file type, extension, MIME, and size
function validateAttachment(originalName, mimeType, size) {
  if (!originalName || typeof originalName !== 'string') {
    return { valid: false, error: 'File name is required' };
  }

  const cleanName = path.basename(originalName).replace(/[^\w\s.-]/gi, '_').trim();
  const ext = path.extname(cleanName).toLowerCase();
  const lowerMime = (mimeType || 'application/octet-stream').toLowerCase();

  // 1. Reject dangerous executable files
  if (!ext || DANGEROUS_EXTS.includes(ext)) {
    return { valid: false, error: `Files with extension "${ext || 'none'}" are prohibited for security reasons.` };
  }

  // 2. Check Image
  if (IMAGE_RULES.exts.includes(ext)) {
    if (!lowerMime.startsWith('image/')) {
      return { valid: false, error: 'MIME type does not match image extension' };
    }
    if (size > IMAGE_RULES.maxSize) {
      return { valid: false, error: 'Image size exceeds maximum limit of 10 MB' };
    }
    return { valid: true, type: 'image', cleanName, ext, mimeType: lowerMime };
  }

  // 3. Check Audio
  if (AUDIO_RULES.exts.includes(ext)) {
    if (!lowerMime.startsWith('audio/') && lowerMime !== 'video/webm') {
      return { valid: false, error: 'MIME type does not match audio extension' };
    }
    if (size > AUDIO_RULES.maxSize) {
      return { valid: false, error: 'Audio recording exceeds maximum limit of 10 MB' };
    }
    return { valid: true, type: 'audio', cleanName, ext, mimeType: lowerMime };
  }

  // 4. Check Document / File
  if (DOC_RULES.exts.includes(ext)) {
    if (size > DOC_RULES.maxSize) {
      return { valid: false, error: 'Document size exceeds maximum limit of 20 MB' };
    }
    return { valid: true, type: 'file', cleanName, ext, mimeType: lowerMime };
  }

  return { valid: false, error: `Unsupported file type: "${ext}". Allowed types: images (JPG, PNG, WEBP), audio (WEBM, MP3, WAV), documents (PDF, DOCX, XLSX, TXT).` };
}

// Read raw request buffer helper
function readRawBuffer(req) {
  if (req && req.rawBuffer) return Promise.resolve(Buffer.from(req.rawBuffer));
  if (req && Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (req && typeof req.body === 'object' && req.body !== null) {
    return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  }
  if (!req || typeof req.on !== 'function') {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// POST /api/chat/upload
async function handleUpload(req, res, query = {}) {
  // 1. Authentication mandatory
  const user = authenticateUser(req, query);
  if (!user) {
    return { status: 401, body: { error: 'Authentication required. Please log in.' } };
  }

  let fileBuffer = null;
  let originalName = '';
  let mimeType = '';
  let sessionId = null;

  const contentType = (req.headers && req.headers['content-type']) || '';

  if (contentType.includes('multipart/form-data')) {
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!boundaryMatch) {
      return { status: 400, body: { error: 'Invalid multipart boundary' } };
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const rawBuffer = await readRawBuffer(req);
    const parsed = parseMultipart(rawBuffer, boundary);

    sessionId = parsed.fields.sessionId || null;
    const fileEntry = parsed.files.file || Object.values(parsed.files)[0];
    if (!fileEntry) {
      return { status: 400, body: { error: 'No file was uploaded' } };
    }

    fileBuffer = fileEntry.data;
    originalName = fileEntry.filename;
    mimeType = fileEntry.mimeType;
  } else {
    // JSON body with base64 data
    let jsonBody = {};
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      jsonBody = req.body;
    } else {
      const rawBuffer = await readRawBuffer(req);
      try {
        jsonBody = JSON.parse(rawBuffer.toString('utf8'));
      } catch (e) {
        return { status: 400, body: { error: 'Malformed JSON payload' } };
      }
    }

    sessionId = jsonBody.sessionId || null;
    originalName = jsonBody.fileName || jsonBody.originalName || '';
    mimeType = jsonBody.mimeType || 'application/octet-stream';

    if (!jsonBody.fileData) {
      return { status: 400, body: { error: 'No fileData provided' } };
    }

    // Strip optional data:mime;base64, prefix
    const base64Clean = jsonBody.fileData.replace(/^data:[^;]+;base64,/, '');
    try {
      fileBuffer = Buffer.from(base64Clean, 'base64');
    } catch (e) {
      return { status: 400, body: { error: 'Invalid base64 file data' } };
    }
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    return { status: 400, body: { error: 'Uploaded file is empty' } };
  }

  // 2. Validate session ownership if sessionId provided
  if (sessionId) {
    const session = db.sessions.find(sessionId);
    if (!session) {
      return { status: 404, body: { error: 'Session not found' } };
    }
    const isDoc = session.doctorId === user.id;
    const isPat = session.patientId === user.id;
    if (!isDoc && !isPat) {
      return { status: 403, body: { error: 'You are not a participant in this consultation' } };
    }
  }

  // 3. Validate MIME type, extension, and file size
  const val = validateAttachment(originalName, mimeType, fileBuffer.length);
  if (!val.valid) {
    return { status: 400, body: { error: val.error } };
  }

  // 4. Generate unique server-side filename (never use original filename for path)
  const uniqueId = db.genId();
  const storedFileName = `${Date.now()}_${uniqueId}${val.ext}`;
  const targetPath = path.join(UPLOADS_DIR, storedFileName);

  // Prevent directory traversal
  const resolvedTarget = path.resolve(targetPath);
  if (!resolvedTarget.startsWith(path.resolve(UPLOADS_DIR))) {
    return { status: 400, body: { error: 'Invalid file path' } };
  }

  // Write file securely
  fs.writeFileSync(resolvedTarget, fileBuffer);

  // 5. Store metadata in db.attachments
  const role = user.rates ? 'doctor' : 'patient';
  const record = db.attachments.insert({
    sessionId: sessionId || null,
    uploaderId: user.id,
    uploaderRole: role,
    storedFileName,
    originalName: val.cleanName,
    type: val.type,
    mimeType: val.mimeType,
    size: fileBuffer.length,
    url: `/api/chat/attachment/${uniqueId}`,
  });

  return {
    status: 201,
    body: {
      attachment: {
        id: record.id,
        sessionId: record.sessionId,
        type: record.type,
        originalName: record.originalName,
        mimeType: record.mimeType,
        size: record.size,
        url: record.url,
      },
    },
  };
}

// GET /api/chat/attachment/:fileId
function serveAttachment(req, res, fileId, query = {}, getCorsOrigin) {
  // 1. Mandatory authentication
  const user = authenticateUser(req, query);
  if (!user) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': getCorsOrigin(req),
      Vary: 'Origin',
    });
    return res.end(JSON.stringify({ error: 'Authentication required to access attachments' }));
  }

  // 2. Lookup attachment record
  const record = db.attachments.find(fileId) || db.attachments.where((a) => a.storedFileName.includes(fileId))[0];
  if (!record) {
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': getCorsOrigin(req),
      Vary: 'Origin',
    });
    return res.end(JSON.stringify({ error: 'Attachment not found' }));
  }

  // 3. Ownership / session check: only participants can view
  if (record.sessionId) {
    const session = db.sessions.find(record.sessionId);
    if (session) {
      const isDoc = session.doctorId === user.id;
      const isPat = session.patientId === user.id;
      if (!isDoc && !isPat) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': getCorsOrigin(req),
          Vary: 'Origin',
        });
        return res.end(JSON.stringify({ error: 'Forbidden: You do not have access to this consultation attachment' }));
      }
    }
  } else if (record.uploaderId !== user.id) {
    res.writeHead(403, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': getCorsOrigin(req),
      Vary: 'Origin',
    });
    return res.end(JSON.stringify({ error: 'Forbidden: You do not have access to this attachment' }));
  }

  // 4. Verify file path on disk
  const filePath = path.join(UPLOADS_DIR, record.storedFileName);
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(path.resolve(UPLOADS_DIR)) || !fs.existsSync(resolvedPath)) {
    res.writeHead(404, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': getCorsOrigin(req),
      Vary: 'Origin',
    });
    return res.end(JSON.stringify({ error: 'File not found on server' }));
  }

  // 5. Send file with proper headers
  const isDownload = Boolean(query && (query.download === '1' || query.download === 'true'));
  const disp = isDownload ? 'attachment' : 'inline';
  const safeName = encodeURIComponent(record.originalName || 'file');

  const stat = fs.statSync(resolvedPath);
  res.writeHead(200, {
    'Content-Type': record.mimeType || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `${disp}; filename="${safeName}"; filename*=UTF-8''${safeName}`,
    'Access-Control-Allow-Origin': getCorsOrigin(req),
    'Cache-Control': 'private, max-age=3600',
    Vary: 'Origin',
  });

  const stream = fs.createReadStream(resolvedPath);
  stream.pipe(res);
}

module.exports = {
  handleUpload,
  serveAttachment,
  validateAttachment,
  parseMultipart,
  UPLOADS_DIR,
};

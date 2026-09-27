// Tiny JSON-file storage under ./data. Everything stays on this computer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// CAT_DATA_DIR lets tools and tests keep their files away from your real data.
const DATA = process.env.CAT_DATA_DIR ? path.resolve(process.env.CAT_DATA_DIR) : path.join(__dirname, '..', 'data');

function safe(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 120);
}

function file(...parts) {
  const p = path.join(DATA, ...parts.map(safe));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function readJson(parts, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file(...parts), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(parts, value) {
  const p = file(...parts);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, p);
}

function listJson(dir) {
  const d = path.join(DATA, safe(dir));
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

module.exports = { readJson, writeJson, listJson, hash, safe, DATA };

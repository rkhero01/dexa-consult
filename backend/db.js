// db.js
// Minimal JSON-file data layer. Zero dependencies, works out of the box.
// When you plug this into your real website backend, swap the
// readAll()/writeAll() functions below for your actual DB (Postgres/Mongo/MySQL)
// — every route file only calls db.<collection>.find/insert/update/where, so
// the swap is isolated to this one file. Nothing else needs to change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  doctors: path.join(DATA_DIR, 'doctors.json'),
  patients: path.join(DATA_DIR, 'patients.json'),
  sessions: path.join(DATA_DIR, 'sessions.json'),
  transactions: path.join(DATA_DIR, 'transactions.json'),
};

function readAll(collection) {
  const file = FILES[collection];
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8').trim();
  return raw ? JSON.parse(raw) : [];
}

function writeAll(collection, arr) {
  fs.writeFileSync(FILES[collection], JSON.stringify(arr, null, 2));
}

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function makeCollection(name) {
  return {
    all() {
      return readAll(name);
    },
    find(id_) {
      return readAll(name).find((x) => x.id === id_) || null;
    },
    where(predicate) {
      return readAll(name).filter(predicate);
    },
    insert(obj) {
      const arr = readAll(name);
      const record = { id: id(), createdAt: new Date().toISOString(), ...obj };
      arr.push(record);
      writeAll(name, arr);
      return record;
    },
    update(id_, patch) {
      const arr = readAll(name);
      const idx = arr.findIndex((x) => x.id === id_);
      if (idx === -1) return null;
      arr[idx] = { ...arr[idx], ...patch, updatedAt: new Date().toISOString() };
      writeAll(name, arr);
      return arr[idx];
    },
  };
}

module.exports = {
  doctors: makeCollection('doctors'),
  patients: makeCollection('patients'),
  sessions: makeCollection('sessions'),
  transactions: makeCollection('transactions'),
  genId: id,
};

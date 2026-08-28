// Claude Code'un KENDI oturum registry'si: ~/.claude/sessions/<PID>.json
//
// ⛔ SALT OKUNUR. Bu dizin Claude Code'a ait, buraya hicbir sey yazilmaz
// (upstream'in bug'i tam olarak buydu). Bizim state'imiz lib/state.js'te.
//
// ✅ Olculdu (docs/DATA-SOURCES.md): 33/33 kayitta pid, sessionId, cwd,
// startedAt, kind, entrypoint var. `name` alani da var ama nameSource 33/33
// "derived" ve degeri "vscode-dd" gibi turetilmis — BASLIK DEGIL, rozet degeri
// olarak bile kullanmiyoruz.
//
// ⛔ Ayni dizindeki <PID>.<hash>.key dosyalarina DOKUNULMAZ.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pidYasiyor } = require('./platform/win32');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// Bir kaydin gorunur alanlari. messagingSocketPath gibi alanlar bilerek disarida.
function kaydiSadelestir(j) {
  return {
    pid: j.pid,
    sessionId: j.sessionId,
    cwd: j.cwd || '',
    startedAt: j.startedAt || 0,
    kind: j.kind || '',
    entrypoint: j.entrypoint || '',
    surum: j.version || '',
    // ⚠️ turetilmis ad; baslik zincirine GIRMEZ (docs/DATA-SOURCES.md §1)
    turetilmisAd: j.name || '',
    adKaynagi: j.nameSource || '',
  };
}

// Canli oturumlar. Ayni sessionId birden fazla kayitta gorulebiliyor
// (olculdu: c3d4e5f6 hem claude-vscode hem cli kaydinda) -> tekille.
function canliOturumlar() {
  let dosyalar;
  try {
    dosyalar = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }

  const bySession = new Map();
  for (const f of dosyalar) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch (e) {
      continue; // yarim yazilmis / bozuk kayit monitor'u cokertmez
    }
    if (!j || !j.sessionId || !j.pid) continue;

    const kayit = kaydiSadelestir(j);
    kayit.canli = pidYasiyor(kayit.pid);

    const eski = bySession.get(kayit.sessionId);
    // Once canli olan, sonra daha yeni baslayan kazanir
    if (!eski || (kayit.canli && !eski.canli) ||
        (kayit.canli === eski.canli && kayit.startedAt > eski.startedAt)) {
      bySession.set(kayit.sessionId, kayit);
    }
  }

  return [...bySession.values()].filter((s) => s.canli);
}

// Olu PID'li kayitlar da lazim olabilir (temizlik, tanilama)
function tumKayitlar() {
  let dosyalar;
  try {
    dosyalar = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
  const cikti = [];
  for (const f of dosyalar) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (j && j.sessionId) {
        const k = kaydiSadelestir(j);
        k.canli = pidYasiyor(k.pid);
        cikti.push(k);
      }
    } catch (e) { /* yoksay */ }
  }
  return cikti;
}

module.exports = { canliOturumlar, tumKayitlar, SESSIONS_DIR };

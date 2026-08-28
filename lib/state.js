// Faz 1 — state artik SESSION bazli.
//
// Yeni konum: ~/.claude/monitor/state/<sessionId>.json
// ⛔ ~/.claude/sessions/ Claude Code'un kendi registry'si, oraya YAZILMAZ.
//
// ⚠️ Eski konum ~/.claude/claude-monitor-status/<proje>.json SALT OKUNUR olarak
// hala okunuyor. Gerekce: makinede halihazirda kurulu hook'lar oraya yaziyor;
// boylece hic hook kurmadan (settings.json'a dokunmadan) durum bilgisi
// gorunebiliyor. Bu dosyalar proje bazli oldugu icin ayni workspace'teki N
// sohbet birbirini eziyor — ama iclerinde sessionId TASIYORLAR, o yuzden
// dogru satira eslenebiliyorlar.

const fs = require('fs');
const path = require('path');
const os = require('os');

const YENI_DIR = path.join(os.homedir(), '.claude', 'monitor', 'state');
const ESKI_DIR = path.join(os.homedir(), '.claude', 'claude-monitor-status');

function dizinOku(dir) {
  const cikti = [];
  let dosyalar;
  try {
    dosyalar = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return cikti;
  }
  for (const f of dosyalar) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && typeof j === 'object') cikti.push({ dosya: path.join(dir, f), j });
    } catch (e) {
      // yarim yazilmis dosya monitor'u cokertmez (kabul kriteri 7)
    }
  }
  return cikti;
}

// sessionId -> durum kaydi. Yeni dizin eskiyi EZER.
function durumHaritasi() {
  const harita = new Map();

  const ekle = (j, kaynak) => {
    const sid = j.sessionId;
    if (!sid) return;
    const zaman = j.updatedAt || j.timestamp || 0;
    const eski = harita.get(sid);
    if (eski && eski.kaynak === 'yeni' && kaynak === 'eski') return;
    if (eski && eski.zaman > zaman && eski.kaynak === kaynak) return;
    harita.set(sid, {
      kaynak,
      zaman,
      status: j.status || '',
      lastAction: j.lastAction || j.message || '',
      firstPrompt: j.firstPrompt || '',
      cwd: j.cwd || '',
    });
  };

  for (const { j } of dizinOku(ESKI_DIR)) ekle(j, 'eski');
  for (const { j } of dizinOku(YENI_DIR)) ekle(j, 'yeni');
  return harita;
}

// Atomik yazma: tmp + rename. Monitor 2 sn'de bir okuyor, yari yazilmis
// dosya gormemeli.
function durumYaz(kayit) {
  if (!kayit || !kayit.sessionId) return false;
  fs.mkdirSync(YENI_DIR, { recursive: true });
  const hedef = path.join(YENI_DIR, kayit.sessionId + '.json');
  const tmp = hedef + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(kayit), 'utf8');
  fs.renameSync(tmp, hedef);
  return true;
}

// ⛔ SILME YOK (calisma alani kurali 4): bayat state dosyasi silinmez,
// _eski/ altina TASINIR. Cagiran, hangi dosyalarin tasindigini gorur.
function bayatlariTasi(canliSessionIdler, bayatMs) {
  const tasinan = [];
  const arsiv = path.join(YENI_DIR, '_eski');
  const simdi = Date.now();
  for (const { dosya, j } of dizinOku(YENI_DIR)) {
    const zaman = j.updatedAt || j.timestamp || 0;
    const canli = j.sessionId && canliSessionIdler.has(j.sessionId);
    if (canli || simdi - zaman < bayatMs) continue;
    try {
      fs.mkdirSync(arsiv, { recursive: true });
      fs.renameSync(dosya, path.join(arsiv, path.basename(dosya)));
      tasinan.push(path.basename(dosya));
    } catch (e) { /* yoksay */ }
  }
  return tasinan;
}

module.exports = { durumHaritasi, durumYaz, bayatlariTasi, YENI_DIR, ESKI_DIR };

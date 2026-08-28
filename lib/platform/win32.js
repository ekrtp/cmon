// Windows'a bagli isler. Fork'un tek platform dosyasi (plan: "Yapilmayacaklar").
//
// ⭐ Upstream her 2 saniyede bir `powershell.exe` ayaga kaldirip WMI ile process
// tariyordu. Gerek yok: canliligi ogrenmek icin `process.kill(pid, 0)` yeter —
// sinyal gondermez, yalnizca process'in var olup olmadigini sorar.

// PID yasiyor mu. ESRCH -> yok. EPERM -> VAR ama bizim yetkimiz yok (yine canli).
function pidYasiyor(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = { pidYasiyor };

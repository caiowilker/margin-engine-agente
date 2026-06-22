// Dashboard operacional HTML — zero dependências externas
function calcularStatusGeral(alertas) {
  const disco = alertas.espacoDisco || {};
  const discoCritico = ["xml", "pdf", "backup"].some(
    (k) => disco[k]?.status === "critico",
  );
  if (
    alertas.acbr === "offline" ||
    discoCritico ||
    alertas.manifestOk === false
  ) {
    return "CRÍTICO";
  }
  const discoBaixo = ["xml", "pdf", "backup"].some(
    (k) => disco[k]?.status === "baixo",
  );
  if (
    alertas.acbr === "degradado" ||
    discoBaixo ||
    (alertas.incertos || 0) > 0 ||
    (alertas.recuperando || 0) > 0 ||
    (alertas.incertosComBackoff || 0) > 0
  ) {
    return "DEGRADADO";
  }
  return "OPERACIONAL";
}

function corStatus(status) {
  if (status === "OPERACIONAL") return "#16a34a";
  if (status === "DEGRADADO") return "#ca8a04";
  return "#dc2626";
}

function montarAlertasPayload(deps) {
  const wd = deps.watchdog.statusWatchdog();
  const alertas = deps.filaFiscal.contadoresAlertas();
  const espacoDisco = deps.fiscalStorage.statusDiscoPorTipo();
  const acbrDet = deps.acbr.obterStatusDetalhe(wd.degraded);
  return {
    statusGeral: null,
    filaFiscal: alertas.filaFiscal,
    pendentes: deps.filaFiscal.status().pendentes,
    processando: alertas.processando,
    incertos: alertas.incertos,
    recuperando: alertas.recuperando,
    incertosComBackoff: alertas.incertosComBackoff,
    falhasUltimas24h: alertas.falhasUltimas24h,
    acbr: acbrDet.estado,
    acbrAtualizadoEm: acbrDet.atualizadoEm,
    espacoDisco,
    ultimasEmissoes: deps.filaFiscal.listarUltimasEmissoes(10),
    versao: deps.versao,
    manifestOk: deps.manifestUpdater.isManifestOk(),
    timestamp: new Date().toISOString(),
  };
}

function renderDashboardHtml(payload) {
  const statusGeral = calcularStatusGeral(payload);
  const cor = corStatus(statusGeral);
  const emissoesRows = (payload.ultimasEmissoes || [])
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.numeroVenda || "-")}</td><td>${escapeHtml(e.status)}</td><td>${escapeHtml(e.timestamp || "-")}</td><td>${escapeHtml(e.chaveTruncada || "-")}</td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="10"/>
<title>PDV Margin Engine — Dashboard</title>
<style>
  body{font-family:Segoe UI,system-ui,sans-serif;margin:0;padding:16px;background:#0f172a;color:#e2e8f0}
  h1{margin:0 0 4px;font-size:1.4rem}
  .sub{color:#94a3b8;font-size:.85rem;margin-bottom:16px}
  .badge{display:inline-block;padding:8px 16px;border-radius:8px;font-weight:700;font-size:1.1rem;color:#fff;background:${cor}}
  table{width:100%;border-collapse:collapse;margin:12px 0;font-size:.9rem}
  th,td{border:1px solid #334155;padding:8px;text-align:left}
  th{background:#1e293b}
  .card{background:#1e293b;border-radius:8px;padding:12px;margin:12px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
  button{background:#2563eb;color:#fff;border:none;padding:10px 16px;border-radius:6px;cursor:pointer;font-size:.9rem}
  button:hover{background:#1d4ed8}
  .ok{color:#4ade80}.warn{color:#facc15}.crit{color:#f87171}
</style>
</head>
<body>
<h1>Agente Local — Dashboard Operacional</h1>
<p class="sub">Atualização automática a cada 10s · v${escapeHtml(payload.versao)} · ${escapeHtml(payload.timestamp)}</p>
<div class="badge">${statusGeral}</div>
<div class="grid">
  <div class="card"><strong>Fila pendente</strong><br/>${payload.pendentes ?? 0}</div>
  <div class="card"><strong>Processando</strong><br/>${payload.processando ?? 0}</div>
  <div class="card"><strong>Incertos</strong><br/>${payload.incertos ?? 0}</div>
  <div class="card"><strong>Recuperando</strong><br/>${payload.recuperando ?? 0}</div>
  <div class="card"><strong>Falhas 24h</strong><br/>${payload.falhasUltimas24h ?? 0}</div>
  <div class="card"><strong>Backoff</strong><br/>${payload.incertosComBackoff ?? 0}</div>
</div>
<div class="card">
  <strong>ACBr:</strong> <span class="${payload.acbr === "online" ? "ok" : payload.acbr === "degradado" ? "warn" : "crit"}">${escapeHtml(payload.acbr)}</span>
  · último status: ${escapeHtml(payload.acbrAtualizadoEm || "n/d")}
</div>
<div class="card">
  <strong>Disco</strong>
  <table>
    <tr><th>Tipo</th><th>Livre (MB)</th><th>Status</th></tr>
    <tr><td>XML</td><td>${payload.espacoDisco?.xml?.livresMB ?? "-"}</td><td>${payload.espacoDisco?.xml?.status ?? "-"}</td></tr>
    <tr><td>PDF</td><td>${payload.espacoDisco?.pdf?.livresMB ?? "-"}</td><td>${payload.espacoDisco?.pdf?.status ?? "-"}</td></tr>
    <tr><td>Backup</td><td>${payload.espacoDisco?.backup?.livresMB ?? "-"}</td><td>${payload.espacoDisco?.backup?.status ?? "-"}</td></tr>
  </table>
</div>
<div class="card">
  <strong>Últimas 10 emissões</strong>
  <table>
    <tr><th>Venda</th><th>Status</th><th>Timestamp</th><th>Chave</th></tr>
    ${emissoesRows || "<tr><td colspan='4'>Nenhuma emissão registrada</td></tr>"}
  </table>
</div>
<div class="card">
  <strong>Manifest:</strong> ${payload.manifestOk ? '<span class="ok">OK</span>' : '<span class="crit">INCOMPLETO</span>'}
</div>
<button type="button" id="btnRecovery">Forçar Recovery Agora</button>
<span id="recoveryMsg" style="margin-left:12px;color:#94a3b8"></span>
<script>
document.getElementById('btnRecovery').addEventListener('click', function(){
  var token = window.prompt('X-Agent-Token (obrigatório para recovery):');
  if(!token){ return; }
  var msg = document.getElementById('recoveryMsg');
  msg.textContent = 'Executando...';
  fetch('/diagnostico/recovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': token }
  }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok,j:j}; }); })
  .then(function(x){
    if(x.ok){ msg.textContent = 'Recovery: ' + (x.j.jobsReprocessados||0) + ' job(s)'; }
    else { msg.textContent = x.j.erro || 'Falha no recovery'; }
  }).catch(function(e){ msg.textContent = e.message; });
});
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  calcularStatusGeral,
  montarAlertasPayload,
  renderDashboardHtml,
  escapeHtml,
};

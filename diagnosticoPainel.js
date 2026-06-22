// Painel operacional fiscal — HTML inline, zero dependências
const { calcularStatusGeral, escapeHtml } = require("./diagnosticoDashboard");

function renderPainelHtml(payload) {
  const statusGeral = calcularStatusGeral(payload);
  const versao = escapeHtml(payload.versao || "?");
  const ts = escapeHtml(payload.timestamp || new Date().toISOString());

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Margin Engine — Centro de Operações Fiscal</title>
<style>
:root{
  --bg:#0b1220;--surface:#131c2e;--surface2:#1a2740;--border:#2a3a55;
  --text:#e8eef7;--muted:#8fa3bf;--accent:#10b981;--accent2:#059669;
  --warn:#fbbf24;--crit:#f87171;--info:#38bdf8;--radius:12px;
}
*{box-sizing:border-box}
body{margin:0;font-family:"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--info);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1200px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{margin:0;font-size:1.35rem;font-weight:800}
.sub{color:var(--muted);font-size:.82rem;margin-top:4px}
.badge{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;font-weight:700;font-size:.85rem}
.badge-op{background:#14532d;color:#bbf7d0}
.badge-deg{background:#713f12;color:#fde68a}
.badge-crit{background:#7f1d1d;color:#fecaca}
.token-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:14px}
.token-bar input{flex:1;min-width:180px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:8px 10px;border-radius:8px;font-size:.85rem}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.tab{padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--muted);cursor:pointer;font-size:.85rem;font-weight:600}
.tab.active{background:var(--accent);border-color:var(--accent2);color:#fff}
.panel{display:none}.panel.active{display:block}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
.card h3{margin:0 0 10px;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.metric{font-size:1.6rem;font-weight:800;line-height:1.1}
.metric-sub{font-size:.78rem;color:var(--muted);margin-top:4px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
.btn{border:none;border-radius:8px;padding:9px 14px;font-size:.82rem;font-weight:600;cursor:pointer;font-family:inherit}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:var(--accent2)}
.btn-secondary{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
.btn-warn{background:#92400e;color:#fde68a}.btn-danger{background:#991b1b;color:#fecaca}
.btn-info{background:#0c4a6e;color:#bae6fd}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th,td{border-bottom:1px solid var(--border);padding:8px 6px;text-align:left;vertical-align:top}
th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.72rem;font-weight:700}
.chip-ok{background:#14532d;color:#86efac}
.chip-warn{background:#713f12;color:#fde68a}
.chip-crit{background:#7f1d1d;color:#fecaca}
.chip-muted{background:#334155;color:#cbd5e1}
.msg{margin-top:10px;padding:10px 12px;border-radius:8px;font-size:.82rem;display:none}
.msg.show{display:block}
.msg-ok{background:#14532d;color:#bbf7d0}
.msg-err{background:#7f1d1d;color:#fecaca}
.msg-info{background:#0c4a6e;color:#bae6fd}
.links{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}
.link-card{display:block;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px}
.link-card strong{display:block;font-size:.85rem;margin-bottom:4px}
.link-card span{font-size:.75rem;color:var(--muted)}
.preflight-item{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:.82rem}
footer{margin-top:20px;color:var(--muted);font-size:.75rem;text-align:center}
@media(max-width:640px){.metric{font-size:1.25rem}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Centro de Operações — Agente Fiscal</h1>
      <p class="sub">Margin Engine PDV · v${versao} · ${ts}</p>
    </div>
    <div id="statusBadge" class="badge badge-op">${escapeHtml(statusGeral)}</div>
  </header>

  <div class="token-bar">
    <label for="agentToken" style="font-size:.82rem;color:var(--muted);white-space:nowrap">X-Agent-Token</label>
    <input id="agentToken" type="password" placeholder="Token do PDV (salvo nesta sessão)" autocomplete="off"/>
    <button type="button" class="btn btn-secondary" id="btnSaveToken">Salvar</button>
    <button type="button" class="btn btn-info" id="btnRefreshAll">Atualizar tudo</button>
  </div>

  <nav class="tabs" role="tablist">
    <button type="button" class="tab active" data-tab="visao">Visão geral</button>
    <button type="button" class="tab" data-tab="fila">Fila fiscal</button>
    <button type="button" class="tab" data-tab="fiscal">Preflight NF-e/NFC-e</button>
    <button type="button" class="tab" data-tab="apis">APIs JSON</button>
  </nav>

  <section id="panel-visao" class="panel active">
    <div class="grid" id="gridVisao"></div>
    <div class="card">
      <h3>Ações rápidas</h3>
      <div class="actions">
        <button type="button" class="btn btn-primary" data-action="recovery">Forçar recovery SEFAZ</button>
        <button type="button" class="btn btn-secondary" data-action="retomar">Retomar fila</button>
        <button type="button" class="btn btn-warn" data-action="pausar">Pausar fila</button>
        <button type="button" class="btn btn-danger" data-action="limpar">Cancelar emissões pendentes</button>
      </div>
      <div id="msgVisao" class="msg"></div>
    </div>
    <div class="card">
      <h3>Últimas emissões</h3>
      <div style="overflow-x:auto"><table><thead><tr><th>Venda</th><th>Status</th><th>Atualizado</th><th>Chave</th></tr></thead><tbody id="tblEmissoes"></tbody></table></div>
    </div>
  </section>

  <section id="panel-fila" class="panel">
    <div class="grid" id="gridFila"></div>
    <div class="card">
      <h3>Gestão da fila</h3>
      <div class="actions">
        <button type="button" class="btn btn-primary" data-action="recovery">Recovery consulta chave</button>
        <button type="button" class="btn btn-secondary" data-action="retomar">Retomar worker</button>
        <button type="button" class="btn btn-warn" data-action="pausar">Pausar worker</button>
        <button type="button" class="btn btn-danger" data-action="limpar">Limpar pendentes/incertos</button>
        <button type="button" class="btn btn-secondary" data-action="purge">Purge histórico antigo</button>
      </div>
      <div id="msgFila" class="msg"></div>
    </div>
    <div class="card">
      <h3>Jobs na fila (últimos 80)</h3>
      <div style="overflow-x:auto"><table><thead><tr><th>ID</th><th>Tipo</th><th>Venda</th><th>Status</th><th>Tent.</th><th>Erro</th><th>Criado</th></tr></thead><tbody id="tblFila"></tbody></table></div>
    </div>
  </section>

  <section id="panel-fiscal" class="panel">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">Preflight completo (ACBr + certificado + CSC)</h3>
        <button type="button" class="btn btn-secondary" data-action="preflight-refresh">Atualizar preflight</button>
      </div>
      <div id="preflightBody" style="margin-top:12px;color:var(--muted);font-size:.85rem">Carregando...</div>
      <div id="msgFiscal" class="msg"></div>
    </div>
    <div class="card" id="numeracaoCard" style="margin-top:12px"><h3>Numeração NFC-e</h3><div id="numeracaoBody"></div></div>
  </section>

  <section id="panel-apis" class="panel">
    <div class="card">
      <h3>Endpoints JSON (com token quando indicado)</h3>
      <div class="links">
        <a class="link-card" href="/diagnostico/painel"><strong>Painel HTML</strong><span>/diagnostico/painel</span></a>
        <a class="link-card" href="/diagnostico/dashboard"><strong>Dashboard legado</strong><span>/diagnostico/dashboard</span></a>
        <a class="link-card" href="/diagnostico/saude"><strong>Saúde</strong><span>/diagnostico/saude</span></a>
        <a class="link-card" href="/diagnostico/alertas"><strong>Alertas</strong><span>/diagnostico/alertas</span></a>
        <span class="link-card"><strong>Diagnóstico completo</strong><span>GET /diagnostico (token)</span></span>
        <span class="link-card"><strong>Status PDV</strong><span>GET /status (token)</span></span>
        <span class="link-card"><strong>Fiscal preflight</strong><span>GET /diagnostico/fiscal (token)</span></span>
        <span class="link-card"><strong>Fila fiscal</strong><span>GET /fila/fiscal (token)</span></span>
        <span class="link-card"><strong>Métricas</strong><span>GET /diagnostico/metricas (token)</span></span>
      </div>
    </div>
  </section>

  <footer>Atualização automática a cada 12s · Use o token do PDV para ações destrutivas</footer>
</div>
<script>
(function(){
  var TOKEN_KEY = "me_agent_token";
  var tokenInput = document.getElementById("agentToken");
  var saved = sessionStorage.getItem(TOKEN_KEY);
  if (saved) tokenInput.value = saved;

  function token(){ return tokenInput.value.trim(); }
  function headers(json){
    var h = json ? {"Content-Type":"application/json"} : {};
    var t = token();
    if (t) h["X-Agent-Token"] = t;
    return h;
  }
  function showMsg(id, text, kind){
    var el = document.getElementById(id);
    el.textContent = text;
    el.className = "msg show msg-" + (kind || "info");
  }
  function chip(status){
    var s = String(status||"").toUpperCase();
    var cls = "chip-muted";
    if (s === "CONCLUIDO" || s === "CONCLUIDO_RECUPERADO" || s === "100") cls = "chip-ok";
    else if (s === "INCERTO" || s === "RECUPERANDO" || s === "FALHA_TEMPORARIA" || s === "PROCESSANDO" || s === "PENDENTE") cls = "chip-warn";
    else if (s.indexOf("FALHA") >= 0 || s === "CRÍTICO" || s === "CRITICO") cls = "chip-crit";
    return '<span class="chip '+cls+'">'+s+'</span>';
  }
  function metricCard(title, value, sub){
    return '<div class="card"><h3>'+title+'</h3><div class="metric">'+value+'</div>'+(sub?'<div class="metric-sub">'+sub+'</div>':'')+'</div>';
  }

  document.getElementById("btnSaveToken").onclick = function(){
    sessionStorage.setItem(TOKEN_KEY, token());
    showMsg("msgVisao", "Token salvo nesta sessão.", "ok");
  };

  document.querySelectorAll(".tab").forEach(function(btn){
    btn.onclick = function(){
      document.querySelectorAll(".tab").forEach(function(b){ b.classList.remove("active"); });
      document.querySelectorAll(".panel").forEach(function(p){ p.classList.remove("active"); });
      btn.classList.add("active");
      document.getElementById("panel-" + btn.dataset.tab).classList.add("active");
      if (location.hash !== "#" + btn.dataset.tab) location.hash = btn.dataset.tab;
    };
  });
  if (location.hash){
    var tab = location.hash.replace("#","");
    var tbtn = document.querySelector('.tab[data-tab="'+tab+'"]');
    if (tbtn) tbtn.click();
  }

  async function fetchJson(url, opts){
    var r = await fetch(url, opts || {});
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) throw new Error(j.erro || j.message || ("HTTP "+r.status));
    return j;
  }

  async function loadAlertas(){
    return fetchJson("/diagnostico/alertas");
  }
  async function loadFila(){
    return fetchJson("/fila/fiscal?limit=80", { headers: headers(false) });
  }
  async function loadFiscal(){
    return fetchJson("/diagnostico/fiscal", { headers: headers(false) });
  }
  async function loadMetricas(){
    try { return await fetchJson("/diagnostico/metricas", { headers: headers(false) }); }
    catch(e){ return null; }
  }

  function renderVisao(a, m){
    var sg = a.statusGeral || "OPERACIONAL";
    var badge = document.getElementById("statusBadge");
    badge.textContent = sg;
    badge.className = "badge " + (sg === "OPERACIONAL" ? "badge-op" : sg === "DEGRADADO" ? "badge-deg" : "badge-crit");
    document.getElementById("gridVisao").innerHTML =
      metricCard("Fila pendente", a.pendentes ?? 0) +
      metricCard("Incertos", a.incertos ?? 0, "recovery automático") +
      metricCard("Recuperando", a.recuperando ?? 0) +
      metricCard("ACBr", a.acbr || "?", a.acbrAtualizadoEm || "") +
      metricCard("Falhas 24h", a.falhasUltimas24h ?? 0) +
      metricCard("Taxa sucesso", (a.metricas && a.metricas.taxaSucessoPercent != null ? a.metricas.taxaSucessoPercent + "%" : "—"));
    var rows = (a.ultimasEmissoes || []).map(function(e){
      return "<tr><td>"+(e.numeroVenda||"-")+"</td><td>"+chip(e.status)+"</td><td>"+(e.timestamp||"-")+"</td><td style='font-family:monospace;font-size:.72rem'>"+(e.chaveTruncada||"-")+"</td></tr>";
    }).join("");
    document.getElementById("tblEmissoes").innerHTML = rows || "<tr><td colspan='4'>Nenhuma emissão</td></tr>";
  }

  function renderFila(f){
    var st = f || {};
    document.getElementById("gridFila").innerHTML =
      metricCard("Pendentes", st.pendentes ?? 0) +
      metricCard("Incertos", st.incerto ?? 0) +
      metricCard("Recuperando", st.recuperando ?? 0) +
      metricCard("Falhas perm.", st.falhas ?? 0) +
      metricCard("Temporárias", st.falhasTemporarias ?? 0) +
      metricCard("Worker", st.pausada ? "PAUSADO" : "ATIVO");
    var itens = st.itens || [];
    document.getElementById("tblFila").innerHTML = itens.map(function(j){
      var err = (j.erro || "").slice(0, 120);
      return "<tr><td>"+j.id+"</td><td>"+j.tipo+"</td><td>"+(j.numero_venda||"-")+"</td><td>"+chip(j.status)+"</td><td>"+(j.tentativas||0)+"</td><td title='"+err.replace(/'/g,"")+"'>"+err+"</td><td>"+(j.criado_em||"-")+"</td></tr>";
    }).join("") || "<tr><td colspan='7'>Fila vazia</td></tr>";
  }

  function renderPreflight(f){
    var pf = f.preflight || {};
    var html = "";
    html += "<div class='preflight-item'><span>Emissão fiscal</span><strong>"+(f.emissaoFiscal ? "Ativa" : "Desativada")+"</strong></div>";
    html += "<div class='preflight-item'><span>Preflight OK</span><strong>"+(pf.ok ? "Sim" : "Não")+"</strong></div>";
    if (pf.erro) html += "<div class='preflight-item'><span>Erro</span><strong style='color:var(--crit)'>"+pf.erro+"</strong></div>";
    if (pf.checklist && pf.checklist.length){
      pf.checklist.forEach(function(c){
        html += "<div class='preflight-item'><span>"+c.item+"</span><strong>"+(c.ok ? "✓" : "✗")+" "+(c.detalhe||"")+"</strong></div>";
      });
    }
    if (pf.sefaz) html += "<div class='preflight-item'><span>SEFAZ</span><strong>cStat "+(pf.sefaz.cStat||"?")+" — "+(pf.sefaz.xMotivo||"")+"</strong></div>";
    document.getElementById("preflightBody").innerHTML = html || "Sem dados";
    var num = f.numeracao || {};
    document.getElementById("numeracaoBody").innerHTML =
      "<div class='preflight-item'><span>Série</span><strong>"+(num.serie||"-")+"</strong></div>"+
      "<div class='preflight-item'><span>Último número</span><strong>"+(num.ultimoNumero ?? "-")+"</strong></div>";
  }

  async function refreshAll(){
    try {
      var alertas = await loadAlertas();
      var metricas = await loadMetricas();
      renderVisao(alertas, metricas);
    } catch(e){ showMsg("msgVisao", e.message, "err"); }
    try {
      var fila = await loadFila();
      renderFila(fila);
    } catch(e){ showMsg("msgFila", "Fila: "+e.message+" (token?)", "err"); }
    try {
      var fiscal = await loadFiscal();
      renderPreflight(fiscal);
    } catch(e){ document.getElementById("preflightBody").textContent = "Preflight: "+e.message; }
  }

  document.getElementById("btnRefreshAll").onclick = refreshAll;

  async function postAction(path, body){
    return fetchJson(path, { method:"POST", headers: headers(true), body: JSON.stringify(body || {}) });
  }

  document.querySelectorAll("[data-action]").forEach(function(btn){
    btn.onclick = async function(){
      var action = btn.dataset.action;
      if (!token() && action !== "preflight-refresh"){
        showMsg("msgVisao", "Informe o X-Agent-Token para esta ação.", "err");
        return;
      }
      try {
        if (action === "recovery"){
          var r = await postAction("/diagnostico/recovery");
          showMsg("msgVisao", "Recovery: "+(r.jobsReprocessados||0)+" job(s) processado(s).", "ok");
          showMsg("msgFila", "Recovery concluído.", "ok");
        } else if (action === "retomar"){
          await postAction("/fila/fiscal/reprocessar");
          showMsg("msgFila", "Fila retomada.", "ok");
        } else if (action === "pausar"){
          await postAction("/fila/fiscal/pausar");
          showMsg("msgFila", "Fila pausada.", "ok");
        } else if (action === "limpar"){
          if (!confirm("Cancelar TODAS as emissões pendentes/incertos? Isso não desfaz notas já autorizadas na SEFAZ.")) return;
          var motivo = prompt("Motivo do cancelamento:", "Cancelado pelo operador no painel") || "Cancelado manualmente";
          var c = await postAction("/fila/fiscal/limpar", { motivo: motivo });
          showMsg("msgFila", "Cancelados: "+(c.cancelados||0)+" job(s).", "ok");
        } else if (action === "purge"){
          if (!confirm("Executar purge de histórico antigo (concluídos, resultados, arquivos)?")) return;
          var p = await postAction("/fila/fiscal/purge");
          showMsg("msgFila", "Purge: fila="+(p.filaFiscal&&p.filaFiscal.filaRemovidos||0)+", docs="+(p.filaFiscal&&p.filaFiscal.documentosRemovidos||0), "ok");
        } else if (action === "preflight-refresh"){
          await postAction("/diagnostico/preflight/refresh");
          showMsg("msgFiscal", "Cache de preflight invalidado.", "ok");
        }
        await refreshAll();
      } catch(e){
        showMsg("msgFila", e.message, "err");
        showMsg("msgVisao", e.message, "err");
      }
    };
  });

  refreshAll();
  setInterval(refreshAll, 12000);
})();
</script>
</body>
</html>`;
}

module.exports = { renderPainelHtml };

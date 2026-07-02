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
.log-box{background:#0a0f18;border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:Consolas,"Courier New",monospace;font-size:.72rem;line-height:1.45;max-height:520px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#c8d6e8}
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
      <h1>Margin Engine — Diagnóstico</h1>
      <p class="sub">Centro de operações · v${versao} · ${ts}</p>
    </div>
    <div id="statusBadge" class="badge badge-op">${escapeHtml(statusGeral)}</div>
  </header>

  <div class="token-bar">
    <label for="agentToken" style="font-size:.82rem;color:var(--muted);white-space:nowrap">Código de acesso do caixa</label>
    <input id="agentToken" type="password" placeholder="Informe o código exibido ao ativar o PDV" autocomplete="off"/>
    <button type="button" class="btn btn-secondary" id="btnSaveToken">Salvar</button>
    <button type="button" class="btn btn-info" id="btnRefreshAll">Atualizar tudo</button>
  </div>

  <nav class="tabs" role="tablist">
    <button type="button" class="tab active" data-tab="visao">Visão geral</button>
    <button type="button" class="tab" data-tab="fila">Fila fiscal</button>
    <button type="button" class="tab" data-tab="fiscal">Preflight NF-e/NFC-e</button>
    <button type="button" class="tab" data-tab="config">Configuração fiscal</button>
    <button type="button" class="tab" data-tab="impressora">Impressora</button>
    <button type="button" class="tab" data-tab="logs">Registro de eventos</button>
  </nav>

  <section id="panel-visao" class="panel active">
    <div class="grid" id="gridVisao"></div>
    <div class="card">
      <h3>Ações rápidas</h3>
      <div class="actions">
        <button type="button" class="btn btn-primary" data-action="recovery">Forçar recovery SEFAZ</button>
        <button type="button" class="btn btn-secondary" data-action="retomar">Retomar fila</button>
        <button type="button" class="btn btn-warn" data-action="pausar">Pausar fila</button>
        <button type="button" class="btn btn-danger" data-action="limpar">Cancelar pendentes</button>
        <button type="button" class="btn btn-info" id="btnExportDiag">Exportar diagnóstico</button>
        <button type="button" class="btn btn-secondary" id="btnOpenLogs">Abrir pasta de logs</button>
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
        <h3 style="margin:0">Verificação fiscal completa (certificado + CSC)</h3>
        <button type="button" class="btn btn-secondary" data-action="preflight-refresh">Atualizar preflight</button>
      </div>
      <div id="preflightBody" style="margin-top:12px;color:var(--muted);font-size:.85rem">Carregando...</div>
      <div id="msgFiscal" class="msg"></div>
    </div>
    <div class="card" id="numeracaoCard" style="margin-top:12px"><h3>Numeração NFC-e</h3><div id="numeracaoBody"></div></div>
  </section>

  <section id="panel-config" class="panel">
    <div class="card">
      <h3 style="margin:0 0 8px">Configuração fiscal</h3>
      <p class="sub" style="margin:0 0 14px">Ambiente SEFAZ, certificado A1, CSC e UF — salvos automaticamente neste agente.</p>
      <div id="configStatus" style="margin-bottom:12px;font-size:.82rem;color:var(--muted)">Carregando...</div>
      <form id="formFiscalConfig" style="display:grid;gap:12px;max-width:640px">
        <label style="display:grid;gap:4px;font-size:.82rem">
          <span>Ambiente SEFAZ</span>
          <select id="cfgAmbiente" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text)">
            <option value="homologacao">Homologação (testes)</option>
            <option value="producao">Produção (notas reais)</option>
          </select>
        </label>
        <label style="display:grid;gap:4px;font-size:.82rem">
          <span>UF emitente</span>
          <input id="cfgUf" maxlength="2" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text);width:80px"/>
        </label>
        <label style="display:grid;gap:4px;font-size:.82rem">
          <span>Certificado digital (arquivo A1)</span>
          <input id="cfgCertPath" placeholder="Selecione ou informe o arquivo do certificado" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text)"/>
        </label>
        <label style="display:grid;gap:4px;font-size:.82rem">
          <span>Senha do certificado</span>
          <input id="cfgCertSenha" type="password" placeholder="Deixe em branco para manter a atual" autocomplete="new-password" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text)"/>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label style="display:grid;gap:4px;font-size:.82rem">
            <span>Id CSC NFC-e</span>
            <input id="cfgIdCsc" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text)"/>
          </label>
          <label style="display:grid;gap:4px;font-size:.82rem">
            <span>Token CSC</span>
            <input id="cfgCsc" type="password" placeholder="Deixe em branco para manter" style="padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);color:var(--text)"/>
          </label>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:.82rem">
          <input id="cfgEmissao" type="checkbox"/>
          <span>Emissão fiscal ativa neste caixa</span>
        </label>
        <div class="actions">
          <button type="submit" class="btn btn-primary">Salvar configuração</button>
          <button type="button" class="btn btn-secondary" id="btnReloadConfig">Recarregar</button>
        </div>
      </form>
      <div id="msgConfig" class="msg"></div>
    </div>
  </section>

  <section id="panel-impressora" class="panel">
    <div class="card">
      <h3 style="margin:0 0 8px">Impressora térmica — detecção automática</h3>
      <p class="sub" style="margin:0 0 14px">USB, spooler Windows (RAW) ou rede TCP (porta 9100). O agente detecta ao iniciar; use os botões abaixo para forçar agora.</p>
      <div id="printerStatus" style="margin-bottom:12px;font-size:.82rem;color:var(--muted)">Carregando...</div>
      <div class="actions">
        <button type="button" class="btn btn-primary" id="btnPrinterDetect">Detectar impressora</button>
        <button type="button" class="btn btn-secondary" id="btnPrinterTest">Imprimir teste</button>
        <button type="button" class="btn btn-secondary" id="btnPrinterReload">Atualizar status</button>
      </div>
      <div id="msgPrinter" class="msg"></div>
    </div>
  </section>

  <section id="panel-logs" class="panel">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <h3 style="margin:0">Rastro fiscal (últimas 500 linhas)</h3>
        <div class="actions" style="margin:0">
          <button type="button" class="btn btn-secondary" id="btnLogsRefresh">Atualizar</button>
          <label style="font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:6px">
            <input type="checkbox" id="chkLogsAuto" checked/> Auto 5s
          </label>
        </div>
      </div>
      <p class="sub" style="margin:8px 0">Logs do Margin Engine na pasta <code style="color:var(--info)" id="logsPathHint">Logs</code> dos dados locais.</p>
      <div id="logsMeta" style="font-size:.75rem;color:var(--muted);margin-bottom:8px">Carregando...</div>
      <pre id="logsBody" class="log-box">Carregando logs...</pre>
      <div id="msgLogs" class="msg"></div>
    </div>
  </section>

  <footer>Atualização automática a cada 12s · Use o código de acesso do caixa para ações sensíveis</footer>
</div>
<script>
(function(){
  var TOKEN_KEY = "me_agent_token";
  function contemTermoTecnico(t){
    return /acbr|dll|\.ini|json|stack|programdata|program files|127\.0\.0\.1|econnreset|erro interno/i.test(String(t||""));
  }
  function sanitizarLinhaLog(s){
    var t = String(s||"").trim();
    if (!t) return "";
    if (contemTermoTecnico(t)) return sanitizarErroLinha(t);
    if (/\\|\/[a-z]/i.test(t) && /users|home|programdata|margin-engine/i.test(t)) return sanitizarErroLinha(t);
    return t.length > 180 ? t.slice(0, 177) + "…" : t;
  }
  function sanitizarErroLinha(s){
    var t = String(s||"").trim();
    if (!t || contemTermoTecnico(t)) return "Pendência fiscal — consulte Diagnóstico";
    if (/timeout/i.test(t)) return "Tempo esgotado — tente novamente";
    if (/sefaz|cstat|rejei/i.test(t)) return "SEFAZ não autorizou — aguarde e reenvie";
    if (/ncm|cfop|cst/i.test(t)) return "Dados fiscais incompletos no cadastro";
    if (/certificado/i.test(t)) return "Problema no certificado digital";
    return t.length > 100 ? t.slice(0, 97) + "…" : t;
  }
  function textoOperador(err){
    return sanitizarErroLinha(err) + " — Consulte Diagnóstico ou contate o suporte.";
  }
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
      if (btn.dataset.tab === "logs") void refreshLogsPanel();
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
    if (!r.ok) throw new Error(textoOperador(j.erro || j.problema || j.message || ("Falha na comunicação ("+r.status+")")));
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
  async function loadLogsFiscal(){
    return fetchJson("/diagnostico/logs/fiscal?lines=500", { headers: headers(false) });
  }
  async function loadMetricas(){
    try { return await fetchJson("/diagnostico/metricas", { headers: headers(false) }); }
    catch(e){ return null; }
  }

  function renderVisao(a, m){
    var ent = a.enterprise || {};
    var sg = ent.statusGeral || a.statusGeral || "ONLINE";
    var badge = document.getElementById("statusBadge");
    badge.textContent = sg;
    var badgeCls = "badge-op";
    if (sg === "DEGRADADO" || sg === "RECUPERANDO" || sg === "ATUALIZANDO") badgeCls = "badge-deg";
    else if (sg === "CONTINGÊNCIA" || sg === "CONTINGENCIA") badgeCls = "badge-deg";
    else if (sg === "OFFLINE" || sg === "CRÍTICO" || sg === "CRITICO") badgeCls = "badge-crit";
    badge.className = "badge " + badgeCls;

    var fiscal = ent.fiscal || {};
    var imp = ent.impressora || {};
    var banco = ent.banco || {};
    var svc = ent.servico || {};
    var upd = ent.atualizador || {};
    var logs = a.logsEnterprise || ent.logs || {};

    document.getElementById("gridVisao").innerHTML =
      metricCard("Driver fiscal", fiscal.driver || "—", fiscal.emissaoFiscal ? "Emissão ativa" : "Modo não fiscal") +
      metricCard("Última autorização", fiscal.ultimaAutorizacao ? "OK" : "—", fiscal.ultimaAutorizacao || "") +
      metricCard("Tempo médio", fiscal.tempoMedioMs != null ? Math.round(fiscal.tempoMedioMs) + " ms" : "—") +
      metricCard("Impressora", imp.ok ? "Online" : "Verificar", imp.modelo || imp.porta || "") +
      metricCard("Banco", banco.ok ? "OK" : "Erro", banco.tamanho ? Math.round(banco.tamanho/1024) + " KB" : "") +
      metricCard("Serviço", svc.rodando ? ("PID " + svc.pid) : "—", svc.uptime || "") +
      metricCard("Atualizador", upd.versaoDisponivel ? ("v" + upd.versaoDisponivel) : "Atualizado", upd.canal || "stable") +
      metricCard("Fila pendente", (ent.fila && ent.fila.pendentes != null) ? ent.fila.pendentes : (a.pendentes ?? 0)) +
      metricCard("Incertos", (ent.fila && ent.fila.incertos != null) ? ent.fila.incertos : (a.incertos ?? 0), "recovery automático");
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
      var err = sanitizarErroLinha(j.erro || "");
      return "<tr><td>"+j.id+"</td><td>"+j.tipo+"</td><td>"+(j.numero_venda||"-")+"</td><td>"+chip(j.status)+"</td><td>"+(j.tentativas||0)+"</td><td title='"+err.replace(/'/g,"")+"'>"+err+"</td><td>"+(j.criado_em||"-")+"</td></tr>";
    }).join("") || "<tr><td colspan='7'>Fila vazia</td></tr>";
  }

  function renderPreflight(f){
    var pf = f.preflight || {};
    var html = "";
    html += "<div class='preflight-item'><span>Emissão fiscal</span><strong>"+(f.emissaoFiscal ? "Ativa" : "Desativada")+"</strong></div>";
    html += "<div class='preflight-item'><span>Preflight OK</span><strong>"+(pf.ok ? "Sim" : "Não")+"</strong></div>";
    if (pf.erro) html += "<div class='preflight-item'><span>Problema</span><strong style='color:var(--crit)'>"+sanitizarErroLinha(pf.erro)+"</strong></div>";
    if (pf.checklist && pf.checklist.length){
      pf.checklist.forEach(function(c){
        var det = c.detalhe ? sanitizarErroLinha(c.detalhe) : "";
        html += "<div class='preflight-item'><span>"+c.item+"</span><strong>"+(c.ok ? "✓" : "✗")+" "+det+"</strong></div>";
      });
    }
    if (pf.sefaz) html += "<div class='preflight-item'><span>SEFAZ</span><strong>cStat "+(pf.sefaz.cStat||"?")+" — "+(pf.sefaz.xMotivo||"")+"</strong></div>";
    document.getElementById("preflightBody").innerHTML = html || "Sem dados";
    var num = f.numeracao || {};
    document.getElementById("numeracaoBody").innerHTML =
      "<div class='preflight-item'><span>Série</span><strong>"+(num.serie||"-")+"</strong></div>"+
      "<div class='preflight-item'><span>Último número</span><strong>"+(num.ultimoNumero ?? "-")+"</strong></div>";
  }

  async function loadFiscalConfig(){
    return fetchJson("/config/fiscal");
  }

  function renderFiscalConfig(cfg){
    document.getElementById("cfgAmbiente").value = cfg.ambienteSefaz || "homologacao";
    document.getElementById("cfgUf").value = cfg.uf || "MG";
    document.getElementById("cfgCertPath").value = cfg.certificado && cfg.certificado.arquivo ? "Certificado configurado" : "";
    document.getElementById("cfgCertPath").dataset.fullPath = (cfg.certificado && cfg.certificado.arquivo) || "";
    document.getElementById("cfgCertSenha").value = "";
    document.getElementById("cfgIdCsc").value = (cfg.nfce && cfg.nfce.idCsc) || "000001";
    document.getElementById("cfgCsc").value = "";
    document.getElementById("cfgEmissao").checked = !!cfg.emissaoFiscal;
    var st = [];
    var driverLabel = (cfg.driver === "lib" || cfg.driver === "acbr-lib") ? "emissor integrado" : (cfg.driver || "?");
    var ambLabel = cfg.ambienteSefaz === "producao" ? "Produção" : "Homologação";
    st.push("Modo: <strong>"+driverLabel+"</strong>");
    st.push("Ambiente: <strong>"+ambLabel+"</strong>");
    if (cfg.paths){
      st.push("Motor fiscal: "+(cfg.paths.libExiste?"pronto":"pendente"));
      st.push("Configuração: "+(cfg.paths.iniExiste?"carregada":"ausente"));
    }
    if (cfg.certificado){
      st.push("Cert: "+(cfg.certificado.arquivoExiste?"✓ encontrado":"✗ não encontrado")+(cfg.certificado.senhaConfigurada?" · senha OK":""));
    }
    document.getElementById("configStatus").innerHTML = st.join(" · ");
  }

  async function refreshConfigPanel(){
    try {
      var cfg = await loadFiscalConfig();
      renderFiscalConfig(cfg);
    } catch(e){
      document.getElementById("configStatus").textContent = textoOperador(e.message);
    }
  }

  async function loadPrinterStatus(){
    return fetchJson("/impressora/status?detect=1", { headers: headers(false) });
  }

  function renderPrinterStatus(st){
    var lines = [];
    lines.push("Conectada: <strong>"+(st.conectada ? "Sim" : "Não")+"</strong>");
    if (st.provider) lines.push("Driver: <strong>"+nomeProviderAmigavel(st.provider)+"</strong>");
    if (st.tipo) lines.push("Tipo: <strong>"+st.tipo+"</strong>");
    if (st.detectada) {
      var d = st.detectada;
      var detLabel = typeof d === "string" ? sanitizarErroLinha(d) : (d.nome || "Impressora detectada");
      lines.push("Detectada: <strong>"+detLabel+"</strong>");
    }
    if (st.driver && st.driver.mode) {
      var modo = st.driver.mode === "native" ? "integrado" : (st.driver.mode === "parity" ? "alternativo" : "padrão");
      lines.push("Emissor: <strong>"+modo+"</strong>");
    }
    document.getElementById("printerStatus").innerHTML = lines.join(" · ");
  }

  function nomeProviderAmigavel(p){
    var s = String(p||"").toLowerCase();
    if (!s || contemTermoTecnico(s)) return "Impressora configurada";
    if (s.indexOf("pos") >= 0 || s.indexOf("escpos") >= 0) return "Impressora térmica";
    if (s.indexOf("windows") >= 0) return "Impressora do Windows";
    return "Impressora configurada";
  }

  async function refreshPrinterPanel(){
    try {
      var st = await loadPrinterStatus();
      renderPrinterStatus(st);
    } catch(e){
      document.getElementById("printerStatus").textContent = textoOperador(e.message);
    }
  }

  document.getElementById("btnPrinterReload").onclick = function(){ void refreshPrinterPanel(); };
  document.getElementById("btnPrinterDetect").onclick = async function(){
    if (!token()){ showMsg("msgPrinter", "Informe o X-Agent-Token.", "err"); return; }
    try {
      var r = await postAction("/impressora/detectar");
      showMsg("msgPrinter", "Detectada: "+((r.impressora && r.impressora.nome) || r.config && r.config.porta || "OK"), "ok");
      await refreshPrinterPanel();
    } catch(e){ showMsg("msgPrinter", e.message, "err"); }
  };
  document.getElementById("btnPrinterTest").onclick = async function(){
    if (!token()){ showMsg("msgPrinter", "Informe o X-Agent-Token.", "err"); return; }
    try {
      await postAction("/impressora/teste");
      showMsg("msgPrinter", "Teste enviado à impressora.", "ok");
      await refreshPrinterPanel();
    } catch(e){ showMsg("msgPrinter", e.message, "err"); }
  };

  document.getElementById("btnReloadConfig").onclick = refreshConfigPanel;
  document.getElementById("formFiscalConfig").onsubmit = async function(ev){
    ev.preventDefault();
    if (!token()){
      showMsg("msgConfig", "Informe o X-Agent-Token para salvar.", "err");
      return;
    }
    var body = {
      ambienteSefaz: document.getElementById("cfgAmbiente").value,
      uf: document.getElementById("cfgUf").value,
      certificadoArquivo: document.getElementById("cfgCertPath").dataset.fullPath || document.getElementById("cfgCertPath").value,
      nfceIdCsc: document.getElementById("cfgIdCsc").value,
      emissaoFiscal: document.getElementById("cfgEmissao").checked
    };
    var senha = document.getElementById("cfgCertSenha").value;
    var csc = document.getElementById("cfgCsc").value;
    if (senha) body.certificadoSenha = senha;
    if (csc) body.nfceCsc = csc;
    if (body.ambienteSefaz === "producao" && !confirm("ATENÇÃO: ambiente PRODUÇÃO emite notas fiscais REAIS na SEFAZ. Confirmar?")) return;
    try {
      var r = await fetch("/config/fiscal", { method:"PUT", headers: headers(true), body: JSON.stringify(body) });
      var j = await r.json().catch(function(){ return {}; });
      if (!r.ok) throw new Error(textoOperador(j.erro || j.problema || ("Falha na comunicação ("+r.status+")")));
      renderFiscalConfig(j.config || j);
      showMsg("msgConfig", "Configuração fiscal salva.", "ok");
      fiscalPreflightInvalidate();
    } catch(e){
      showMsg("msgConfig", textoOperador(e.message), "err");
    }
  };

  async function fiscalPreflightInvalidate(){
    try { await postAction("/diagnostico/preflight/refresh"); } catch(_){}
  }

  async function refreshLogsPanel(){
    try {
      var data = await loadLogsFiscal();
      var lines = (data.lines || []).map(sanitizarLinhaLog).filter(Boolean);
      document.getElementById("logsBody").textContent = lines.length ? lines.join("\\n") : "(sem eventos recentes — emita uma nota para gerar registro)";
      document.getElementById("logsMeta").textContent =
        "Total: " + (data.total || lines.length) + " evento(s) · máx " + (data.maxLines || 500);
    } catch(e){
      document.getElementById("logsBody").textContent = textoOperador(e.message);
      document.getElementById("logsMeta").textContent = "";
    }
  }

  document.getElementById("btnLogsRefresh").onclick = function(){ void refreshLogsPanel(); };
  var logsAutoTimer = null;
  function syncLogsAutoTimer(){
    if (logsAutoTimer) { clearInterval(logsAutoTimer); logsAutoTimer = null; }
    var chk = document.getElementById("chkLogsAuto");
    if (chk && chk.checked) {
      logsAutoTimer = setInterval(function(){
        var panel = document.getElementById("panel-logs");
        if (panel && panel.classList.contains("active")) void refreshLogsPanel();
      }, 5000);
    }
  }
  document.getElementById("chkLogsAuto").onchange = syncLogsAutoTimer;

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
    } catch(e){ document.getElementById("preflightBody").textContent = textoOperador(e.message); }
  }

  document.getElementById("btnRefreshAll").onclick = function(){
    void refreshAll();
    void refreshConfigPanel();
    void refreshPrinterPanel();
  };

  document.getElementById("btnExportDiag").onclick = async function(){
    try {
      var r = await fetch("/diagnostico/pacote", { headers: headers(false) });
      if (!r.ok) throw new Error("HTTP "+r.status);
      var blob = await r.blob();
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "margin-engine-diagnostico.zip";
      a.click();
      showMsg("msgVisao", "Pacote de diagnóstico baixado.", "ok");
    } catch(e){
      showMsg("msgVisao", "Exportar: "+e.message+" (informe o token se necessário)", "err");
    }
  };

  document.getElementById("btnOpenLogs").onclick = async function(){
    try {
      if (token()){
        await fetchJson("/diagnostico/logs/abrir-pasta", { method:"POST", headers: headers(true), body: "{}" });
        showMsg("msgVisao", "Pasta de logs aberta no explorador.", "ok");
        return;
      }
      var a = await loadAlertas();
      var pasta = (a.logsEnterprise && a.logsEnterprise.pastaLogs) || "pasta de logs do Margin Engine";
      showMsg("msgVisao", "Pasta de logs: "+pasta, "info");
    } catch(e){
      showMsg("msgVisao", e.message, "err");
    }
  };

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
  refreshConfigPanel();
  syncLogsAutoTimer();
  setInterval(refreshAll, 12000);
})();
</script>
</body>
</html>`;
}

module.exports = { renderPainelHtml };

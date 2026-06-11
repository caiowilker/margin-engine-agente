// ============================================================
// PDV Margin Engine — Modulo Impressora Termica v5.0
//
// v5.0 — Auto-detect robusto (Windows + USB + Rede)
//   - Modo auto (padrao): tenta Windows spooler, rede TCP e USB
//   - Windows spooler RAW funciona como servico (LocalSystem)
//   - Detecta impressoras termicas por nome/porta
//   - Fallback em cadeia com cache de 30s
//   - Endpoints /impressora/listar e /impressora/detectar
// ============================================================

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { execFileSync } = require("child_process");

const escpos = require("escpos");

let escposUSB;
let escposNetwork;
try {
  escposUSB = require("escpos-usb");
  escpos.USB = escposUSB;
} catch (_) {}
try {
  escposNetwork = require("escpos-network");
  escpos.Network = escposNetwork;
} catch (_) {}

const IS_WIN = process.platform === "win32";
const PRINTER_TYPE = (process.env.PRINTER_TYPE || "auto").toLowerCase();
const PRINTER_HOST = (process.env.PRINTER_HOST || "").trim();
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || "9100", 10);
const PRINTER_NAME = (process.env.PRINTER_NAME || "").trim();

const TERMICA_RX =
  /epson|elgin|bematech|daruma|tanca|jetway|thermal|tm-|mp-|i9|i7|pos|cupom|nfce|receipt|termica/i;

const REDE_PORTAS = [9100, 9101, 515];
const CACHE_TTL_MS = 30000;
const AGENT_PORT = parseInt(process.env.PORT || "9100", 10);

let cacheDescoberta = null;
let cacheDescobertaEm = 0;
let ultimaImpressoraUsada = null;
let printLock = Promise.resolve();

function comLockImpressao(fn) {
  const exec = printLock.then(() => fn());
  printLock = exec.catch(() => {});
  return exec;
}

// ── Device em memoria (gera buffer ESC/POS) ───────────────────────────────────
class MemoryDevice {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this._open = false;
  }

  open(cb) {
    this._open = true;
    this.buffer = Buffer.alloc(0);
    cb(null);
  }

  write(data, cb) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (cb) cb(null);
  }

  close(cb) {
    this._open = false;
    if (cb) cb(null);
  }
}

function gerarBuffer(renderFn) {
  return new Promise((resolve, reject) => {
    const device = new MemoryDevice();
    device.open((err) => {
      if (err) return reject(err);
      try {
        const printer = new escpos.Printer(device, { encoding: "CP860" });
        renderFn(printer);
        const finalizar = () => device.close(() => resolve(device.buffer));
        if (typeof printer.close === "function") {
          printer.close(finalizar);
        } else {
          finalizar();
        }
      } catch (e) {
        try {
          device.close();
        } catch (_) {}
        reject(e);
      }
    });
  });
}

// ── Listar impressoras Windows ────────────────────────────────────────────────
function listarImpressorasWindows() {
  if (!IS_WIN) return [];
  try {
    const raw = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Printer | Select-Object Name,PortName,DriverName,Default | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (_) {
    return [];
  }
}

function escolherImpressoraWindows(lista) {
  if (!lista.length) return null;

  if (PRINTER_NAME) {
    const exata = lista.find(
      (p) => p.Name && p.Name.toLowerCase() === PRINTER_NAME.toLowerCase(),
    );
    if (exata) return exata;
    const parcial = lista.find(
      (p) => p.Name && p.Name.toLowerCase().includes(PRINTER_NAME.toLowerCase()),
    );
    if (parcial) return parcial;
  }

  const termicas = lista.filter(
    (p) =>
      TERMICA_RX.test(p.Name || "") ||
      TERMICA_RX.test(p.DriverName || "") ||
      /USB|COM|WSD|TCP|IP_/i.test(p.PortName || ""),
  );

  const padrao = lista.find((p) => p.Default);
  return termicas[0] || padrao || lista[0];
}

function enviarRawWindows(nomeImpressora, buffer) {
  const tmpBin = path.join(os.tmpdir(), `pdv-print-${Date.now()}.bin`);
  const tmpCfg = path.join(os.tmpdir(), `pdv-print-${Date.now()}.json`);
  fs.writeFileSync(tmpBin, buffer);
  fs.writeFileSync(
    tmpCfg,
    JSON.stringify({ printer: nomeImpressora, file: tmpBin }),
    "utf8",
  );

  const scriptPath = path.join(os.tmpdir(), "pdv-raw-print.ps1");
  if (!fs.existsSync(scriptPath)) {
    fs.writeFileSync(
      scriptPath,
      `$cfg = Get-Content -Raw $args[0] | ConvertFrom-Json
$bytes = [System.IO.File]::ReadAllBytes($cfg.file)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDatatype;
  }
  [DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
}
'@
$h = [IntPtr]::Zero
if (-not [RawPrinterHelper]::OpenPrinter($cfg.printer, [ref]$h, [IntPtr]::Zero)) {
  throw "Nao foi possivel abrir a impressora: $($cfg.printer)"
}
try {
  $di = New-Object RawPrinterHelper+DOCINFOA
  $di.pDocName = "PDV Cupom"
  $di.pDatatype = "RAW"
  if (-not [RawPrinterHelper]::StartDocPrinter($h, 1, $di)) { throw "StartDocPrinter falhou" }
  try {
    if (-not [RawPrinterHelper]::StartPagePrinter($h)) { throw "StartPagePrinter falhou" }
    $p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
    $written = 0
    if (-not [RawPrinterHelper]::WritePrinter($h, $p, $bytes.Length, [ref]$written)) { throw "WritePrinter falhou" }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($p)
    [RawPrinterHelper]::EndPagePrinter($h) | Out-Null
  } finally { [RawPrinterHelper]::EndDocPrinter($h) | Out-Null }
} finally { [RawPrinterHelper]::ClosePrinter($h) | Out-Null }
Remove-Item $cfg.file -Force -ErrorAction SilentlyContinue
`,
      "utf8",
    );
  }

  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, tmpCfg],
      { timeout: 30000, windowsHide: true },
    );
    return true;
  } finally {
    try {
      fs.unlinkSync(tmpCfg);
    } catch (_) {}
    try {
      fs.unlinkSync(tmpBin);
    } catch (_) {}
  }
}

function enviarRede(host, port, buffer, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      fn(val);
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => {
      socket.write(buffer, (err) => {
        if (err) return finish(reject, err);
        socket.end();
        finish(resolve, true);
      });
    });
    socket.on("error", (err) =>
      finish(reject, new Error(`Rede ${host}:${port} — ${err.message}`)),
    );
    socket.on("timeout", () =>
      finish(reject, new Error(`Rede ${host}:${port} — timeout`)),
    );
  });
}

function testarRede(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => {
      done = true;
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      if (!done) resolve(false);
    });
    socket.on("timeout", () => {
      if (!done) resolve(false);
    });
  });
}

function extrairIpPorta(portName) {
  if (!portName) return null;
  const ipMatch = portName.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (!ipMatch) return null;
  return ipMatch[1];
}

function obterHostsRede() {
  const hosts = [];
  if (PRINTER_HOST) hosts.push(PRINTER_HOST);

  // Extrai IP de impressoras Windows (ex: IP_192.168.1.50, 192.168.1.50)
  for (const p of listarImpressorasWindows()) {
    const ip = extrairIpPorta(p.PortName);
    if (ip) hosts.push(ip);
  }

  // Nunca escaneia localhost — seria o proprio agente na porta 9100
  return [...new Set(hosts.filter(Boolean))];
}

async function detectarRede() {
  const hosts = obterHostsRede();
  if (!hosts.length) return null;

  const portas = [
    ...new Set(
      [PRINTER_PORT, ...REDE_PORTAS].filter(
        (p) => p && !Number.isNaN(p) && p !== AGENT_PORT,
      ),
    ),
  ];

  for (const host of hosts) {
    for (const port of portas) {
      if (await testarRede(host, port, 1500)) {
        return { metodo: "network", host, porta: port, nome: `${host}:${port}` };
      }
    }
  }
  return null;
}

function detectarUsb() {
  if (!escposUSB) return null;
  try {
    const devices = escpos.USB.findPrinter();
    if (!devices || !devices.length) return null;
    return {
      metodo: "usb",
      dispositivos: devices.length,
      nome: PRINTER_NAME || `USB (${devices.length} dispositivo(s))`,
    };
  } catch (_) {
    return null;
  }
}

function detectarWindows() {
  const lista = listarImpressorasWindows();
  const escolhida = escolherImpressoraWindows(lista);
  if (!escolhida) return null;
  return {
    metodo: "windows",
    nome: escolhida.Name,
    porta: escolhida.PortName,
    driver: escolhida.DriverName,
    padrao: !!escolhida.Default,
    candidatos: lista.length,
  };
}

async function detectarImpressora(force = false) {
  const agora = Date.now();
  if (!force && cacheDescoberta && agora - cacheDescobertaEm < CACHE_TTL_MS) {
    return cacheDescoberta;
  }

  const candidatos = [];
  const win = detectarWindows();
  if (win) candidatos.push(win);
  const usb = detectarUsb();
  if (usb) candidatos.push(usb);
  const rede = await detectarRede();
  if (rede) candidatos.push(rede);

  let escolhida = null;
  if (PRINTER_TYPE === "windows" && win) escolhida = win;
  else if (PRINTER_TYPE === "usb" && usb) escolhida = usb;
  else if (PRINTER_TYPE === "network" && rede) escolhida = rede;
  else if (PRINTER_TYPE === "network" && PRINTER_HOST)
    escolhida = { metodo: "network", host: PRINTER_HOST, porta: PRINTER_PORT, nome: `${PRINTER_HOST}:${PRINTER_PORT}` };
  else if (IS_WIN && win) escolhida = win;
  else if (rede) escolhida = rede;
  else if (usb) escolhida = usb;
  else if (win) escolhida = win;

  const resultado = {
    ok: !!escolhida,
    tipoConfigurado: PRINTER_TYPE,
    impressora: escolhida,
    candidatos,
    ultimaUsada: ultimaImpressoraUsada,
    plataforma: process.platform,
  };

  cacheDescoberta = resultado;
  cacheDescobertaEm = agora;
  return resultado;
}

async function enviarBuffer(buffer) {
  const erros = [];
  const tentativas = [];

  const add = (metodo, fn) => tentativas.push({ metodo, fn });

  if (PRINTER_TYPE === "windows" || PRINTER_TYPE === "auto") {
    add("windows", async () => {
      const win = detectarWindows();
      if (!win) throw new Error("Nenhuma impressora Windows encontrada.");
      enviarRawWindows(win.nome, buffer);
      ultimaImpressoraUsada = { metodo: "windows", nome: win.nome };
    });
  }

  if (PRINTER_TYPE === "network" || PRINTER_TYPE === "auto") {
    add("network", async () => {
      const rede = await detectarRede();
      const alvo = rede || (PRINTER_HOST
        ? { host: PRINTER_HOST, porta: PRINTER_PORT }
        : null);
      if (!alvo) throw new Error("Impressora de rede inacessivel.");
      await enviarRede(alvo.host, alvo.porta, buffer);
      ultimaImpressoraUsada = {
        metodo: "network",
        host: alvo.host,
        porta: alvo.porta,
      };
    });
  }

  if (PRINTER_TYPE === "usb" || PRINTER_TYPE === "auto") {
    add("usb", () =>
      new Promise((resolve, reject) => {
        if (!escposUSB) return reject(new Error("escpos-usb nao instalado."));
        const devices = escpos.USB.findPrinter();
        if (!devices || !devices.length)
          return reject(new Error("Nenhuma impressora USB encontrada."));
        const device = new escpos.USB(devices[0]);
        device.open((err) => {
          if (err) return reject(err);
          device.write(buffer, (wErr) => {
            device.close(() => {
              if (wErr) return reject(wErr);
              ultimaImpressoraUsada = { metodo: "usb" };
              resolve(true);
            });
          });
        });
      }),
    );
  }

  const ordem =
    PRINTER_TYPE === "windows"
      ? ["windows"]
      : PRINTER_TYPE === "network"
        ? ["network", "windows", "usb"]
        : PRINTER_TYPE === "usb"
          ? ["usb", "windows", "network"]
          : IS_WIN
            ? ["windows", "network", "usb"]
            : ["usb", "network", "windows"];

  for (const metodo of ordem) {
    const t = tentativas.find((x) => x.metodo === metodo);
    if (!t) continue;
    try {
      await t.fn();
      cacheDescoberta = null;
      return { ok: true, metodo, ultima: ultimaImpressoraUsada };
    } catch (err) {
      erros.push(`${metodo}: ${err.message}`);
    }
  }

  throw new Error(
    "Nenhuma impressora disponivel.\n" +
      erros.map((e) => `  - ${e}`).join("\n") +
      "\nDica: instale o driver da impressora no Windows ou configure PRINTER_NAME / PRINTER_HOST no .env",
  );
}

async function imprimirRender(renderFn) {
  return comLockImpressao(async () => {
    const buffer = await gerarBuffer(renderFn);
    return enviarBuffer(buffer);
  });
}

// ── Helpers de layout ─────────────────────────────────────────────────────────
function helpers() {
  const largura = 42;
  const linha = (txt) => txt.padEnd(largura, " ").slice(0, largura);
  const sep = () => "-".repeat(largura);
  const centro = (txt) => {
    const pad = Math.max(0, Math.floor((largura - txt.length) / 2));
    return " ".repeat(pad) + txt;
  };
  const moeda = (v) =>
    `R$ ${Number(v || 0)
      .toFixed(2)
      .replace(".", ",")}`;
  const direita = (esq, dir) => {
    const espaco = Math.max(1, largura - esq.length - dir.length);
    return esq + " ".repeat(espaco) + dir;
  };
  const fmt = (v) =>
    "R$ " +
    Number(v).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  return { largura, linha, sep, centro, moeda, direita, fmt };
}

function renderCupom(printer, payload) {
  const { linha, sep, centro, moeda, direita } = helpers();
  const empresa = payload.empresa || {};
  const itens = payload.itens || [];
  const ibpt = payload.ibpt;
  const isFiscal = !!(payload.chaveNfe && payload.chaveNfe.trim());

  printer
    .font("a")
    .align("ct")
    .style("b")
    .size(1, 1)
    .text(empresa.nomeFantasia || empresa.razaoSocial || "ESTABELECIMENTO")
    .style("normal")
    .size(0, 0);

  if (empresa.cnpj) printer.text(`CNPJ: ${empresa.cnpj}`);
  if (empresa.endereco) printer.text(empresa.endereco);
  if (empresa.cidade)
    printer.text(`${empresa.cidade}${empresa.uf ? " - " + empresa.uf : ""}`);
  if (empresa.telefone) printer.text(`Tel: ${empresa.telefone}`);

  printer.align("lt").text(sep()).style("b");
  printer.text(centro(isFiscal ? "CUPOM FISCAL NFC-e" : "CUPOM NAO FISCAL"));
  printer.style("normal").text(sep());

  printer.text(
    `No: ${payload.numeroVenda || ""}    ${new Date(payload.emitidoEm || Date.now()).toLocaleString("pt-BR")}`,
  );
  if (payload.operador) printer.text(`Operador: ${payload.operador}`);
  if (payload.nomeCliente && payload.nomeCliente !== "Consumidor")
    printer.text(`Cliente: ${payload.nomeCliente}`);
  if (payload.cpfCliente) printer.text(`CPF: ${payload.cpfCliente}`);
  printer.text(sep());

  printer.text(linha("ITEM  DESCRICAO           QTD    TOTAL"));
  printer.text(sep());

  itens.forEach((item, i) => {
    const num = String(i + 1).padStart(2, "0");
    const nome = (item.nome || "").slice(0, 20).padEnd(20);
    const qtd = String(item.quantidade || 1).padStart(3);
    const total = moeda(item.total || item.precoUnitario * item.quantidade);
    printer.text(`${num}    ${nome} ${qtd}  ${total}`);
    printer.text(`       ${moeda(item.precoUnitario)}/un`);
  });

  printer.text(sep());

  if (payload.desconto && payload.desconto > 0) {
    printer.text(
      direita("Subtotal:", moeda((payload.total || 0) + (payload.desconto || 0))),
    );
    printer
      .style("b")
      .text(direita("Desconto:", "- " + moeda(payload.desconto)))
      .style("normal");
  }
  printer
    .style("b")
    .size(0, 1)
    .text(direita("TOTAL:", moeda(payload.total)))
    .size(0, 0)
    .style("normal");

  if (payload.formaPagamento) {
    printer.text(
      direita(
        "Pagamento:",
        (payload.labelPagamento || payload.formaPagamento).toUpperCase(),
      ),
    );
  }
  if (payload.valorRecebido && payload.valorRecebido > payload.total) {
    const troco = payload.valorRecebido - payload.total;
    printer.text(direita("Recebido:", moeda(payload.valorRecebido)));
    printer.style("b").text(direita("Troco:", moeda(troco))).style("normal");
  }

  printer.text(sep());

  if (ibpt && ibpt.total > 0) {
    const pct =
      typeof ibpt.percentualTotal === "number"
        ? ibpt.percentualTotal.toFixed(2) + "%"
        : "-";
    printer
      .align("lt")
      .text(sep())
      .text("Valor aprox. dos tributos desta operacao")
      .text("conforme Lei Fed. 12.741/13 (IBPT):")
      .text(direita(`Total: ${pct}`, moeda(ibpt.total)));
    if (ibpt.federal > 0) printer.text(direita("  Federal:", moeda(ibpt.federal)));
    if (ibpt.estadual > 0) printer.text(direita("  Estadual:", moeda(ibpt.estadual)));
    if (ibpt.municipal > 0) printer.text(direita("  Municipal:", moeda(ibpt.municipal)));
    printer.text(sep());
  }

  if (isFiscal) {
    printer
      .align("ct")
      .style("b")
      .text("DOCUMENTO FISCAL NFC-e")
      .style("normal")
      .text(`Chave: ${payload.chaveNfe}`)
      .text(`NF: ${payload.numeroNfe || ""} Serie: ${payload.serieNfe || "001"}`)
      .text("")
      .text("Consulte em: nfce.fazenda.gov.br");
    if (payload.qrcodeNfe) {
      try {
        printer.qrimage(payload.qrcodeNfe, { type: "png", mode: "dhdw", size: 3 });
      } catch (_) {
        printer.text("[QR Code indisponivel]");
      }
    }
  } else if (payload.origem === "offline") {
    printer
      .align("ct")
      .text(sep())
      .text("** VENDA OFFLINE **")
      .text(`N: ${payload.numeroVenda || ""}`)
      .text("Sera sincronizada quando a internet retornar.");
  } else {
    printer
      .align("ct")
      .text(sep())
      .style("b")
      .text("*** CUPOM NAO FISCAL ***")
      .style("normal")
      .text("Documento sem validade fiscal.")
      .text(`Ref. interno: ${payload.numeroVenda || ""}`);
  }

  printer
    .align("ct")
    .text(sep())
    .text(new Date().toLocaleString("pt-BR"))
    .text("Obrigado pela preferencia!")
    .text("")
    .text("")
    .text("")
    .cut();
}

function renderFechamento(printer, payload) {
  const { sep: linha, fmt, direita } = helpers();

  printer
    .font("a")
    .align("ct")
    .style("b")
    .size(1, 1)
    .text(payload.empresa?.nome || "PDV")
    .style("normal")
    .size(0, 0);

  if (payload.empresa?.cnpj) printer.text("CNPJ: " + payload.empresa.cnpj);
  if (payload.empresa?.endereco) printer.text(payload.empresa.endereco);

  printer.text(linha()).style("b").text("FECHAMENTO DE CAIXA").style("normal").text(linha());

  printer
    .align("lt")
    .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
    .text("Operador: " + payload.operador)
    .text("Abertura: " + (payload.aberturaEm || "-"))
    .text("Fecham. : " + payload.fechamentoEm);

  if (payload.minutosAberto) {
    const h = Math.floor(payload.minutosAberto / 60);
    const m = payload.minutosAberto % 60;
    printer.text(
      "Tempo   : " + (h > 0 ? h + "h " : "") + String(m).padStart(2, "0") + "min",
    );
  }

  printer.align("ct").text(linha()).style("b").text("RESUMO DO DIA").style("normal");
  printer
    .align("lt")
    .text("Vendas      : " + payload.quantidadeVendas)
    .text("Faturamento : " + fmt(payload.totalVendas))
    .text("Lucro total : " + fmt(payload.totalLucro))
    .text("Margem media: " + Number(payload.margemMedia).toFixed(1) + "%");

  printer.align("ct").text(linha()).style("b").text("POR FORMA DE PAGAMENTO").style("normal");

  const formas = payload.resumoPorForma || {};
  Object.entries(formas)
    .sort(([, a], [, b]) => b.total - a.total)
    .forEach(([forma, d]) => {
      const label =
        {
          dinheiro: "Dinheiro",
          pix: "PIX",
          credito: "Credito",
          debito: "Debito",
          fiado: "Fiado",
          voucher: "Voucher",
        }[forma] || forma;
      printer
        .align("lt")
        .text(
          label.padEnd(10) +
            fmt(d.total).padStart(10) +
            (" " + d.quantidade + " venda(s)").padStart(12),
        );
    });

  printer
    .align("ct")
    .text(linha())
    .style("b")
    .text("CONFERENCIA DE CAIXA")
    .style("normal")
    .align("lt")
    .text("Fundo abertura: " + fmt(payload.valorAbertura))
    .text("Valor contado : " + fmt(payload.valorContado));

  const diff = payload.diferenca;
  const diffStr =
    Math.abs(diff) < 0.02
      ? "OK — caixa confere"
      : diff > 0
        ? "Sobra: " + fmt(diff)
        : "Falta: " + fmt(Math.abs(diff));
  printer.text("Diferenca     : " + diffStr);

  if (payload.observacao) {
    printer.align("ct").text(linha()).align("lt").text("Obs: " + payload.observacao);
  }

  printer
    .align("ct")
    .text(linha())
    .text("Caixa encerrado em " + payload.fechamentoEm)
    .feed(4)
    .cut();
}

function renderMovimentoCaixa(printer, payload) {
  const { sep: linha, fmt } = helpers();
  const tipoLabel = payload.tipo === "suprimento" ? "SUPRIMENTO" : "SANGRIA";

  printer
    .font("a")
    .align("ct")
    .style("b")
    .size(1, 1)
    .text(tipoLabel + " DE CAIXA")
    .style("normal")
    .size(0, 0)
    .text(linha())
    .align("lt")
    .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
    .text("Operador: " + payload.operador)
    .text("Data/Hr : " + payload.emitidoEm)
    .align("ct")
    .text(linha())
    .style("b")
    .align("lt")
    .text("Valor   : " + fmt(payload.valor))
    .style("normal")
    .text("Motivo  : " + payload.motivo)
    .text("Saldo   : " + fmt(payload.saldoAtual))
    .align("ct")
    .text(linha())
    .feed(3)
    .cut();
}

// ── API publica ───────────────────────────────────────────────────────────────
async function testar(force = false) {
  try {
    const info = await detectarImpressora(force);
    return info.ok;
  } catch (_) {
    return false;
  }
}

async function getInfo(force = false) {
  return detectarImpressora(force);
}

function listar() {
  const windows = listarImpressorasWindows().map((p) => ({
    nome: p.Name,
    porta: p.PortName,
    driver: p.DriverName,
    padrao: !!p.Default,
    termicaProvavel:
      TERMICA_RX.test(p.Name || "") || TERMICA_RX.test(p.DriverName || ""),
  }));

  let usb = [];
  if (escposUSB) {
    try {
      const devices = escpos.USB.findPrinter() || [];
      usb = devices.map((_, i) => ({ indice: i, metodo: "usb" }));
    } catch (_) {}
  }

  return {
    tipoConfigurado: PRINTER_TYPE,
    nomeConfigurado: PRINTER_NAME || null,
    hostConfigurado: PRINTER_HOST || null,
    portaConfigurada: PRINTER_PORT,
    windows,
    usb,
    ultimaUsada: ultimaImpressoraUsada,
  };
}

function imprimirCupom(payload) {
  return imprimirRender((printer) => renderCupom(printer, payload));
}

function imprimirFechamento(payload) {
  return imprimirRender((printer) => renderFechamento(printer, payload));
}

function imprimirMovimentoCaixa(payload) {
  return imprimirRender((printer) => renderMovimentoCaixa(printer, payload));
}

function abrirGaveta() {
  const buffer = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  return comLockImpressao(() => enviarBuffer(buffer));
}

module.exports = {
  testar,
  getInfo,
  listar,
  detectar: () => detectarImpressora(true),
  imprimirCupom,
  abrirGaveta,
  imprimirFechamento,
  imprimirMovimentoCaixa,
};

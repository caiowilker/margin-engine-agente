// ============================================================
// PDV Margin Engine — Módulo Impressora Térmica v4.2
//
// v4.2 — Troca console.log por logger estruturado (pino)
//   Todos os logs de erro/info agora vão para o arquivo
//   rotativo em vez de stdout avulso.
//
// v4.1 — Título do cupom muda conforme o modo:
//   - Sem chaveNfe: "CUPOM NAO FISCAL" (padrão)
//   - Com chaveNfe: "CUPOM FISCAL NFC-e" (cabeçalho correto)
//   Rodapé diferencia: fiscal imprime chave completa e instrução;
//   não fiscal imprime aviso sem validade fiscal.
//
// v4.0 — Sprint 1.1: IBPT no cupom (Lei 12.741/2012)
//   Seção obrigatória de carga tributária aproximada.
//
// Suporta:
//   - USB  (Windows: detecta automaticamente)
//   - Rede (TCP/IP — impressoras compartilhadas na LAN)
// ============================================================

require("dotenv").config();

const escpos = require("escpos");
const logger = require("./logger");

let escposUSB, escposNetwork;
try {
  escposUSB = require("escpos-usb");
  escpos.USB = escposUSB;
} catch (_) {}
try {
  escposNetwork = require("escpos-network");
  escpos.Network = escposNetwork;
} catch (_) {}

const PRINTER_TYPE = (process.env.PRINTER_TYPE || "usb").toLowerCase();
const PRINTER_HOST = process.env.PRINTER_HOST || "192.168.1.100";
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || "9101");
const PRINTER_NAME = process.env.PRINTER_NAME || "";

// ─────────────────────────────────────────────────────────────────────────────
// ── Obter device ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function obterDevice() {
  if (PRINTER_TYPE === "network") {
    if (!escposNetwork) throw new Error("escpos-network nao instalado.");
    return new escpos.Network(PRINTER_HOST, PRINTER_PORT);
  }

  if (!escposUSB) throw new Error("escpos-usb nao instalado.");
  const devices = escpos.USB.findPrinter();
  if (!devices || devices.length === 0) {
    throw new Error("Nenhuma impressora USB encontrada.");
  }
  return devices.length === 1 || !PRINTER_NAME
    ? new escpos.USB(devices[0])
    : new escpos.USB(
        devices.find((d) => d.deviceDescriptor?.iProduct === PRINTER_NAME) ||
          devices[0],
      );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Testar conexão ────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function testar() {
  return new Promise((resolve) => {
    try {
      const device = obterDevice();
      device.open((err) => {
        if (err) {
          logger.warn(
            { err: err.message },
            "impressora: falha ao abrir na verificacao",
          );
          resolve(false);
          return;
        }
        device.close();
        resolve(true);
      });
    } catch (err) {
      logger.warn({ err: err.message }, "impressora: device nao encontrado");
      resolve(false);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Imprimir cupom ────────────────────────────────────────────────────────────
// payload: CupomFiscal (veja pdv.types.ts)
// ─────────────────────────────────────────────────────────────────────────────
function imprimirCupom(payload) {
  return new Promise((resolve, reject) => {
    let device;
    try {
      device = obterDevice();
    } catch (err) {
      logger.error(
        { err: err.message },
        "impressora: nao foi possivel obter device",
      );
      return reject(err);
    }

    device.open((err) => {
      if (err) {
        logger.error(
          { err: err.message },
          "impressora: falha ao abrir para cupom",
        );
        return reject(new Error("Falha ao abrir impressora: " + err.message));
      }

      try {
        const printer = new escpos.Printer(device, { encoding: "CP860" });
        const empresa = payload.empresa || {};
        const itens = payload.itens || [];
        const ibpt = payload.ibpt;
        const largura = 42;

        const isFiscal = !!(payload.chaveNfe && payload.chaveNfe.trim());

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

        // ── Cabeçalho da empresa ─────────────────────────────────────────────
        printer
          .font("a")
          .align("ct")
          .style("b")
          .size(1, 1)
          .text(
            empresa.nomeFantasia || empresa.razaoSocial || "ESTABELECIMENTO",
          )
          .style("normal")
          .size(0, 0);

        if (empresa.cnpj) printer.text(`CNPJ: ${empresa.cnpj}`);
        if (empresa.endereco) printer.text(empresa.endereco);
        if (empresa.cidade)
          printer.text(
            `${empresa.cidade}${empresa.uf ? " - " + empresa.uf : ""}`,
          );
        if (empresa.telefone) printer.text(`Tel: ${empresa.telefone}`);

        printer.align("lt").text(sep()).style("b");

        if (isFiscal) {
          printer.text(centro("CUPOM FISCAL NFC-e"));
        } else {
          printer.text(centro("CUPOM NAO FISCAL"));
        }

        printer.style("normal").text(sep());

        printer.text(
          `N: ${payload.numeroVenda || ""}    ${new Date(payload.emitidoEm || Date.now()).toLocaleString("pt-BR")}`,
        );
        if (payload.operador) printer.text(`Operador: ${payload.operador}`);
        if (payload.nomeCliente && payload.nomeCliente !== "Consumidor") {
          printer.text(`Cliente: ${payload.nomeCliente}`);
        }
        if (payload.cpfCliente) printer.text(`CPF: ${payload.cpfCliente}`);
        printer.text(sep());

        // ── Cabeçalho da tabela de itens ────────────────────────────────────
        printer.text(linha("ITEM  DESCRICAO           QTD    TOTAL"));
        printer.text(sep());

        // ── Itens ────────────────────────────────────────────────────────────
        itens.forEach((item, i) => {
          const num = String(i + 1).padStart(2, "0");
          const nome = (item.nome || "").slice(0, 20).padEnd(20);
          const qtd = String(item.quantidade || 1).padStart(3);
          const total = moeda(
            item.total || item.precoUnitario * item.quantidade,
          );
          printer.text(`${num}    ${nome} ${qtd}  ${total}`);
          printer.text(`       ${moeda(item.precoUnitario)}/un`);
        });

        printer.text(sep());

        // ── Totais ───────────────────────────────────────────────────────────
        if (payload.desconto && payload.desconto > 0) {
          printer.text(
            direita(
              "Subtotal:",
              moeda((payload.total || 0) + (payload.desconto || 0)),
            ),
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
          printer
            .style("b")
            .text(direita("Troco:", moeda(troco)))
            .style("normal");
        }

        printer.text(sep());

        // ── IBPT — Lei 12.741/2012 ───────────────────────────────────────────
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

          if (ibpt.federal > 0)
            printer.text(direita(`  Federal:`, moeda(ibpt.federal)));
          if (ibpt.estadual > 0)
            printer.text(direita(`  Estadual:`, moeda(ibpt.estadual)));
          if (ibpt.municipal > 0)
            printer.text(direita(`  Municipal:`, moeda(ibpt.municipal)));
          printer.text(sep());
        }

        // ── Dados NFC-e / rodapé ─────────────────────────────────────────────
        if (isFiscal) {
          printer
            .align("ct")
            .style("b")
            .text("DOCUMENTO FISCAL NFC-e")
            .style("normal")
            .text(`Chave: ${payload.chaveNfe}`)
            .text(
              `NF: ${payload.numeroNfe || ""} Serie: ${payload.serieNfe || "001"}`,
            )
            .text("")
            .text("Consulte em: nfce.fazenda.gov.br");

          if (payload.qrcodeNfe) {
            try {
              printer.qrimage(payload.qrcodeNfe, {
                type: "png",
                mode: "dhdw",
                size: 3,
              });
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

        // ── Rodapé ───────────────────────────────────────────────────────────
        printer
          .align("ct")
          .text(sep())
          .text(new Date().toLocaleString("pt-BR"))
          .text("Obrigado pela preferencia!")
          .text("")
          .text("")
          .text("")
          .cut()
          .close(() => {
            logger.info(
              { numeroVenda: payload.numeroVenda },
              "impressora: cupom impresso",
            );
            resolve(true);
          });
      } catch (err) {
        try {
          device.close();
        } catch (_) {}
        logger.error(
          { err: err.message },
          "impressora: erro ao imprimir cupom",
        );
        reject(err);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Abrir gaveta ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
function abrirGaveta() {
  return new Promise((resolve, reject) => {
    let device;
    try {
      device = obterDevice();
    } catch (err) {
      logger.error(
        { err: err.message },
        "impressora: nao foi possivel obter device para gaveta",
      );
      return reject(err);
    }

    device.open((err) => {
      if (err) {
        logger.error(
          { err: err.message },
          "impressora: falha ao abrir para gaveta",
        );
        return reject(
          new Error("Falha ao abrir impressora para gaveta: " + err.message),
        );
      }
      const printer = new escpos.Printer(device);
      printer.cashdraw(2).close(() => {
        logger.info("impressora: gaveta aberta");
        resolve(true);
      });
    });
  });
}

// ── Relatório de fechamento de caixa ─────────────────────────────────────────
function imprimirFechamento(payload) {
  return new Promise((resolve, reject) => {
    let device;
    try {
      device = obterDevice();
    } catch (err) {
      logger.error(
        { err: err.message },
        "impressora: nao foi possivel obter device para fechamento",
      );
      return reject(err);
    }

    device.open((err) => {
      if (err) {
        logger.error(
          { err: err.message },
          "impressora: falha ao abrir para fechamento",
        );
        return reject(new Error("Falha ao abrir impressora: " + err.message));
      }

      try {
        const printer = new escpos.Printer(device, { encoding: "CP860" });
        const fmt = (v) =>
          "R$ " +
          Number(v).toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
        const linha = "--------------------------------";

        printer
          .font("a")
          .align("ct")
          .style("b")
          .size(1, 1)
          .text(payload.empresa?.nome || "PDV")
          .style("normal")
          .size(0, 0);

        if (payload.empresa?.cnpj)
          printer.text("CNPJ: " + payload.empresa.cnpj);
        if (payload.empresa?.endereco) printer.text(payload.empresa.endereco);

        printer
          .text(linha)
          .style("b")
          .text("FECHAMENTO DE CAIXA")
          .style("normal")
          .text(linha);

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
            "Tempo   : " +
              (h > 0 ? h + "h " : "") +
              String(m).padStart(2, "0") +
              "min",
          );
        }

        printer
          .align("ct")
          .text(linha)
          .style("b")
          .text("RESUMO DO DIA")
          .style("normal");

        printer
          .align("lt")
          .text("Vendas      : " + payload.quantidadeVendas)
          .text("Faturamento : " + fmt(payload.totalVendas))
          .text("Lucro total : " + fmt(payload.totalLucro))
          .text(
            "Margem media: " + Number(payload.margemMedia).toFixed(1) + "%",
          );

        printer
          .align("ct")
          .text(linha)
          .style("b")
          .text("POR FORMA DE PAGAMENTO")
          .style("normal");

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
          .text(linha)
          .style("b")
          .text("CONFERENCIA DE CAIXA")
          .style("normal")
          .align("lt")
          .text("Fundo abertura: " + fmt(payload.valorAbertura))
          .text("Valor contado : " + fmt(payload.valorContado));

        const diff = payload.diferenca;
        const diffStr =
          Math.abs(diff) < 0.02
            ? "OK - caixa confere"
            : diff > 0
              ? "Sobra: " + fmt(diff)
              : "Falta: " + fmt(Math.abs(diff));
        printer.text("Diferenca     : " + diffStr);

        if (payload.observacao) {
          printer
            .align("ct")
            .text(linha)
            .align("lt")
            .text("Obs: " + payload.observacao);
        }

        printer
          .align("ct")
          .text(linha)
          .text("Caixa encerrado em " + payload.fechamentoEm)
          .feed(4)
          .cut()
          .close(() => {
            logger.info(
              { operador: payload.operador },
              "impressora: fechamento impresso",
            );
            resolve(true);
          });
      } catch (err) {
        try {
          device.close();
        } catch (_) {}
        logger.error(
          { err: err.message },
          "impressora: erro ao imprimir fechamento",
        );
        reject(err);
      }
    });
  });
}

// ── Comprovante de suprimento / sangria ──────────────────────────────────────
function imprimirMovimentoCaixa(payload) {
  return new Promise((resolve, reject) => {
    let device;
    try {
      device = obterDevice();
    } catch (err) {
      logger.error(
        { err: err.message },
        "impressora: nao foi possivel obter device para movimento",
      );
      return reject(err);
    }

    device.open((err) => {
      if (err) {
        logger.error(
          { err: err.message },
          "impressora: falha ao abrir para movimento de caixa",
        );
        return reject(new Error("Falha ao abrir impressora: " + err.message));
      }

      try {
        const printer = new escpos.Printer(device, { encoding: "CP860" });
        const fmt = (v) =>
          "R$ " +
          Number(v).toLocaleString("pt-BR", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
        const linha = "--------------------------------";
        const tipoLabel =
          payload.tipo === "suprimento" ? "SUPRIMENTO" : "SANGRIA";

        printer
          .font("a")
          .align("ct")
          .style("b")
          .size(1, 1)
          .text(tipoLabel + " DE CAIXA")
          .style("normal")
          .size(0, 0)
          .text(linha)
          .align("lt")
          .text("Caixa   : " + (payload.numeroCaixa || "Principal"))
          .text("Operador: " + payload.operador)
          .text("Data/Hr : " + payload.emitidoEm)
          .align("ct")
          .text(linha)
          .style("b")
          .align("lt")
          .text("Valor   : " + fmt(payload.valor))
          .style("normal")
          .text("Motivo  : " + payload.motivo)
          .text("Saldo   : " + fmt(payload.saldoAtual))
          .align("ct")
          .text(linha)
          .feed(3)
          .cut()
          .close(() => {
            logger.info(
              { tipo: payload.tipo, valor: payload.valor },
              "impressora: movimento de caixa impresso",
            );
            resolve(true);
          });
      } catch (err) {
        try {
          device.close();
        } catch (_) {}
        logger.error(
          { err: err.message },
          "impressora: erro ao imprimir movimento de caixa",
        );
        reject(err);
      }
    });
  });
}

module.exports = {
  testar,
  imprimirCupom,
  abrirGaveta,
  imprimirFechamento,
  imprimirMovimentoCaixa,
};

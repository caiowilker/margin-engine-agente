/**
 * Métricas oficiais de layout do cupom (Etapa 12-3).
 *
 * Oficial: linhas e dots (por bloco e total).
 * mmEst: apenas ESTIMADO (fator teórico Font A @203 dpi).
 */

const DOTS_POR_LINHA_FONTE_A = 24; // 203 dpi × ~3,0 mm
const MM_POR_LINHA_TEORICO = 3.0; // 24/203×25,4 ≈ 3,00
const QR_MM_EST = 28;
const QR_DOTS_EST = Math.round((QR_MM_EST / 25.4) * 203); // ≈224

/**
 * Linhas "visíveis" no papel (tags de controle não avançam sozinhas).
 * @param {string} tags
 */
function visibleLines(tags) {
  const raw = String(tags || "").split(/\r?\n/);
  const out = [];
  for (const line of raw) {
    const t = line.trim();
    if (!t) {
      out.push({ kind: "blank", text: "" });
      continue;
    }
    if (t === "{{ME_QR_BMP}}") {
      out.push({ kind: "qr", text: t });
      continue;
    }
    const stripped = t
      .replace(/<\/?[a-zA-Z0-9_]+(?:\s[^>]*)?>/g, "")
      .replace(/\{\{ME_QR_BMP\}\}/g, "")
      .trim();
    if (!stripped && /^<\/?[a-zA-Z]/.test(t)) {
      if (/corte/i.test(t)) out.push({ kind: "cut", text: t });
      else out.push({ kind: "ctrl", text: t });
      continue;
    }
    out.push({ kind: "text", text: stripped || t });
  }
  return out;
}

/**
 * Classifica linhas visíveis em blocos (mesmo mapa da 12-2).
 * @param {ReturnType<typeof visibleLines>} lines
 */
function classifyBlock(lines) {
  const blocks = [];
  let cur = { id: "pre", lines: [] };
  const push = (id) => {
    if (cur.lines.length) blocks.push(cur);
    cur = { id, lines: [] };
  };

  let phase = "header";
  for (const L of lines) {
    if (L.kind === "ctrl" || L.kind === "cut") continue;
    const t = L.text;
    const up = t.toUpperCase();

    if (phase === "header") {
      if (/CUPOM FISCAL|CUPOM NAO FISCAL|DANFE/.test(up)) {
        push("emitente");
        cur = { id: "titulo_modo", lines: [L] };
        phase = "titulo";
        continue;
      }
      cur.id = "emitente";
      cur.lines.push(L);
      continue;
    }
    if (phase === "titulo") {
      if (/^NRO:/.test(up) || /^====/.test(t)) {
        if (/^====/.test(t)) {
          cur.lines.push(L);
          push("titulo_modo");
          phase = "meta";
          cur = { id: "meta_venda", lines: [] };
          continue;
        }
        push("titulo_modo");
        cur = { id: "meta_venda", lines: [L] };
        phase = "meta";
        continue;
      }
      cur.lines.push(L);
      continue;
    }
    if (phase === "meta") {
      if (
        /^DESCRICAO|^----/.test(up) &&
        cur.lines.some((x) => /NRO:|DATA:|CLIENTE:|CPF:/.test(x.text.toUpperCase()))
      ) {
        if (/^----/.test(t) || /^DESCRICAO/.test(up)) {
          push("meta_venda");
          cur = { id: "itens", lines: [L] };
          phase = "itens";
          continue;
        }
      }
      if (/^DESCRICAO/.test(up)) {
        push("meta_venda");
        cur = { id: "itens", lines: [L] };
        phase = "itens";
        continue;
      }
      cur.lines.push(L);
      continue;
    }
    if (phase === "itens") {
      if ((/^SUBTOTAL:|^TOTAL:|^====/.test(up) && !/^----/.test(t)) || /^TOTAL:/.test(up)) {
        push("itens");
        cur = { id: "totais", lines: [L] };
        phase = "totais";
        continue;
      }
      cur.lines.push(L);
      continue;
    }
    if (phase === "totais") {
      if (/^PAGAMENTO:/.test(up)) {
        push("totais");
        cur = { id: "pagamentos", lines: [L] };
        phase = "pagamentos";
        continue;
      }
      cur.lines.push(L);
      continue;
    }
    if (phase === "pagamentos") {
      if (/TRIBUTOS|IBPT|Lei 12\.741|FEDERAL|ESTADUAL|MUNICIPAL/i.test(t)) {
        push("pagamentos");
        cur = { id: "tributos", lines: [L] };
        phase = "tributos";
        continue;
      }
      if (
        /DOCUMENTO FISCAL|NFC-E:|CHAVE DE ACESSO|VOLUMES:/i.test(up) &&
        !/^PAGAMENTO:/.test(up)
      ) {
        if (/VOLUMES:/.test(up)) {
          cur.lines.push(L);
          continue;
        }
        push("pagamentos");
        cur = { id: "chave_protocolo", lines: [L] };
        phase = "chave";
        continue;
      }
      if (/OBRIGADO|VOLTE SEMPRE|PDV MARGIN/i.test(up)) {
        push("pagamentos");
        cur = { id: "rodape", lines: [L] };
        phase = "rodape";
        continue;
      }
      cur.lines.push(L);
      continue;
    }
    if (phase === "tributos") {
      if (/DOCUMENTO FISCAL|NFC-E:|CHAVE DE ACESSO/i.test(up)) {
        push("tributos");
        cur = { id: "chave_protocolo", lines: [L] };
        phase = "chave";
        continue;
      }
      cur.lines.push(L);
      continue;
    }
    if (phase === "chave") {
      if (L.kind === "qr" || /CONSULTA VIA QR|CONSULTE PELA CHAVE/i.test(up)) {
        if (cur.id !== "qr_mensagens") {
          push("chave_protocolo");
          cur = { id: "qr_mensagens", lines: [L] };
          phase = "qr";
        } else cur.lines.push(L);
        continue;
      }
      if (/OBRIGADO|VOLTE SEMPRE|PDV MARGIN/i.test(up)) {
        push("chave_protocolo");
        cur = { id: "rodape", lines: [L] };
        phase = "rodape";
        continue;
      }
      cur.lines.push(L);
      continue;
    }
    if (phase === "qr") {
      if (/OBRIGADO|VOLTE SEMPRE|PDV MARGIN/i.test(up)) {
        push("qr_mensagens");
        cur = { id: "rodape", lines: [L] };
        phase = "rodape";
        continue;
      }
      cur.lines.push(L);
      continue;
    }
    if (phase === "rodape") {
      cur.lines.push(L);
      continue;
    }
    cur.lines.push(L);
  }
  push(cur.id);
  return blocks.filter((b) => b.lines.length);
}

function blockStats(blocks) {
  return blocks.map((b) => {
    const nText = b.lines.filter((l) => l.kind === "text" || l.kind === "blank").length;
    const nQr = b.lines.filter((l) => l.kind === "qr").length;
    const dots = nText * DOTS_POR_LINHA_FONTE_A + nQr * QR_DOTS_EST;
    const mmEst = nText * MM_POR_LINHA_TEORICO + nQr * QR_MM_EST;
    return {
      id: b.id,
      linhas: nText,
      dots,
      qr: nQr,
      mmEst: Math.round(mmEst * 10) / 10,
      sample: b.lines
        .filter((l) => l.kind === "text")
        .slice(0, 2)
        .map((l) => l.text),
    };
  });
}

/**
 * Mede um dump de tags ACBr.
 * @param {string} tags
 */
function medirTags(tags) {
  const vis = visibleLines(tags);
  const textLike = vis.filter(
    (v) => v.kind === "text" || v.kind === "blank" || v.kind === "qr",
  );
  const blocos = blockStats(classifyBlock(vis));
  const linhas = textLike.filter((l) => l.kind !== "qr").length;
  const qrCount = textLike.filter((l) => l.kind === "qr").length;
  const dots = linhas * DOTS_POR_LINHA_FONTE_A + qrCount * QR_DOTS_EST;
  const mmEst =
    Math.round((linhas * MM_POR_LINHA_TEORICO + qrCount * QR_MM_EST) * 10) / 10;
  return {
    linhas,
    dots,
    hasQr: qrCount > 0,
    qrCount,
    mmEst,
    mmEstNota:
      `ESTIMADO — fator ${MM_POR_LINHA_TEORICO} mm/linha Font A @203dpi ` +
      `(${DOTS_POR_LINHA_FONTE_A} dots/linha); QR≈${QR_MM_EST} mm / ${QR_DOTS_EST} dots. ` +
      `Não afirmar economia em mm real sem régua.`,
    fator: {
      mmPorLinha: MM_POR_LINHA_TEORICO,
      dotsPorLinha: DOTS_POR_LINHA_FONTE_A,
      qrMmEst: QR_MM_EST,
      qrDotsEst: QR_DOTS_EST,
      dpi: 203,
    },
    blocos,
  };
}

/**
 * Compara antes × depois (percentual sobre linhas/dots).
 * @param {ReturnType<typeof medirTags>} antes
 * @param {ReturnType<typeof medirTags>} depois
 */
function compararMetricas(antes, depois) {
  const pct = (a, b) => (a === 0 ? 0 : Math.round(((a - b) / a) * 1000) / 10);
  const porBloco = {};
  const ids = new Set([
    ...antes.blocos.map((b) => b.id),
    ...depois.blocos.map((b) => b.id),
  ]);
  for (const id of ids) {
    const a = antes.blocos.find((b) => b.id === id) || {
      linhas: 0,
      dots: 0,
      qr: 0,
    };
    const d = depois.blocos.find((b) => b.id === id) || {
      linhas: 0,
      dots: 0,
      qr: 0,
    };
    porBloco[id] = {
      linhasAntes: a.linhas,
      linhasDepois: d.linhas,
      dotsAntes: a.dots,
      dotsDepois: d.dots,
      qrAntes: a.qr,
      qrDepois: d.qr,
      reducaoLinhasPct: pct(a.linhas, d.linhas),
      reducaoDotsPct: pct(a.dots, d.dots),
      mmEstAntes: a.mmEst ?? null,
      mmEstDepois: d.mmEst ?? null,
    };
  }
  return {
    linhasAntes: antes.linhas,
    linhasDepois: depois.linhas,
    dotsAntes: antes.dots,
    dotsDepois: depois.dots,
    reducaoLinhasPct: pct(antes.linhas, depois.linhas),
    reducaoDotsPct: pct(antes.dots, depois.dots),
    mmEstAntes: antes.mmEst,
    mmEstDepois: depois.mmEst,
    mmEstDelta: Math.round((antes.mmEst - depois.mmEst) * 10) / 10,
    mmEstNota: antes.mmEstNota,
    qrAntes: antes.qrCount,
    qrDepois: depois.qrCount,
    porBloco,
  };
}

/**
 * Texto comercial extraído (sem tags/separadores) — para regressão de dados.
 * @param {string} tags
 */
function extrairTextoComercial(tags) {
  return visibleLines(tags)
    .filter((l) => l.kind === "text")
    .map((l) => l.text.replace(/\s+/g, " ").trim())
    .filter((t) => t && !/^[=\-]+$/.test(t));
}

/**
 * Tokens de dados que devem permanecer (valores numéricos / chaves).
 * @param {string} tags
 */
function extrairTokensDados(tags) {
  const text = extrairTextoComercial(tags).join("\n");
  const tokens = new Set();
  for (const m of text.matchAll(/R\$\s*[\d.,]+/g)) tokens.add(m[0]);
  for (const m of text.matchAll(/\b\d{11,44}\b/g)) tokens.add(m[0]);
  for (const m of text.matchAll(/\bPDV\d+\b/gi)) tokens.add(m[0].toUpperCase());
  for (const m of text.matchAll(/CNPJ:\s*[\d./-]+/gi)) tokens.add(m[0].toUpperCase());
  return [...tokens].sort();
}

module.exports = {
  DOTS_POR_LINHA_FONTE_A,
  MM_POR_LINHA_TEORICO,
  QR_MM_EST,
  QR_DOTS_EST,
  visibleLines,
  classifyBlock,
  medirTags,
  compararMetricas,
  extrairTextoComercial,
  extrairTokensDados,
};

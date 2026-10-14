#!/usr/bin/env node
/**
 * B6 — Dual-run IBS/CBS: oráculo aritmético local × calculadora RTC offline (SERPRO).
 *
 * Uso:
 *   # com RTC já no ar (perfil offline):
 *   RTC_BASE_URL=http://localhost:18080/api node scripts/dual-run-ibs-cbs-rtc.mjs
 *
 *   # ou binário customizado (stdin JSON → stdout JSON):
 *   RTC_CALC_CMD='...' node scripts/dual-run-ibs-cbs-rtc.mjs
 *
 * CRT 1/2/3 no payload é só rótulo de cenário (a API RTC usa cClassTrib/CST).
 */
import { spawnSync } from "node:child_process";

const TOL = 0.01;
const BASE = (process.env.RTC_BASE_URL || "").replace(/\/$/, "");

/** 12 operações — CRT 1/2/3, cClassTrib 000001 (tributação integral), fato 2026. */
const CASOS = [
  { id: "C01", crt: 1, vOperacao: 100.0, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C02", crt: 1, vOperacao: 250.5, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C03", crt: 1, vOperacao: 999.99, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C04", crt: 2, vOperacao: 100.0, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C05", crt: 2, vOperacao: 480.0, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C06", crt: 2, vOperacao: 1500.0, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C07", crt: 3, vOperacao: 100.0, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C08", crt: 3, vOperacao: 700.0, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C09", crt: 3, vOperacao: 1234.56, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C10", crt: 3, vOperacao: 50.01, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C11", crt: 1, vOperacao: 33.33, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
  { id: "C12", crt: 3, vOperacao: 88.88, pCbs: 0.9, pIbsUf: 0.1, pIbsMun: 0.0 },
];

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

function motorProprio(caso) {
  const base = money(caso.vOperacao);
  return {
    vCBS: money((base * caso.pCbs) / 100),
    vIBSUF: money((base * caso.pIbsUf) / 100),
    vIBSMun: money((base * caso.pIbsMun) / 100),
  };
}

function payloadRtc(caso) {
  return {
    id: `dual-${caso.id}`,
    versao: "1.0.0",
    dhFatoGerador: "2026-06-15T10:00:00-03:00",
    municipio: 3106200,
    uf: "MG",
    tpDoc: 55,
    itens: [
      {
        numero: 1,
        ncm: "19059090",
        quantidade: 1,
        unidade: "UN",
        cst: "000",
        cClassTrib: "000001",
        baseCalculo: caso.vOperacao,
      },
    ],
  };
}

function parseRtcResponse(json) {
  const tot = json?.total?.tribCalc?.IBSCBSTot;
  if (!tot) throw new Error("resposta RTC sem total.tribCalc.IBSCBSTot");
  return {
    vCBS: money(tot.gCBS?.vCBS),
    vIBSUF: money(tot.gIBS?.gIBSUF?.vIBSUF),
    vIBSMun: money(tot.gIBS?.gIBSMun?.vIBSMun),
  };
}

async function rtcHttp(caso) {
  const url = `${BASE}/calculadora/regime-geral`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payloadRtc(caso)),
  });
  const text = await res.text();
  if (!res.ok) {
    return { disponivel: false, motivo: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  try {
    return { disponivel: true, ...parseRtcResponse(JSON.parse(text)) };
  } catch (e) {
    return { disponivel: false, motivo: e.message };
  }
}

function rtcCmd(caso) {
  const cmd = process.env.RTC_CALC_CMD;
  if (!cmd) return { disponivel: false, motivo: "RTC_CALC_CMD / RTC_BASE_URL não definidos" };
  const r = spawnSync(cmd, {
    input: JSON.stringify(payloadRtc(caso)),
    encoding: "utf8",
    shell: true,
    timeout: 30000,
  });
  if (r.error) return { disponivel: false, motivo: String(r.error.message || r.error) };
  if (r.status !== 0) {
    return { disponivel: false, motivo: `exit ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 200)}` };
  }
  try {
    return { disponivel: true, ...parseRtcResponse(JSON.parse(r.stdout)) };
  } catch (e) {
    return { disponivel: false, motivo: `JSON inválido: ${e.message}` };
  }
}

function within(a, b) {
  return Math.abs(a - b) <= TOL;
}

async function main() {
  console.log("Dual-run IBS/CBS — tolerância R$", TOL.toFixed(2));
  console.log(`Casos: ${CASOS.length} (CRT 1/2/3) | RTC_BASE_URL=${BASE || "(nenhuma)"}`);

  const probe = BASE ? await rtcHttp(CASOS[0]) : rtcCmd(CASOS[0]);
  if (!probe.disponivel) {
    console.log("Calculadora RTC offline NÃO disponível.");
    console.log(`Motivo: ${probe.motivo}`);
    console.log("Suba o JAR offline (perfil offline) e defina RTC_BASE_URL, ou RTC_CALC_CMD.");
    for (const c of CASOS) {
      console.log(JSON.stringify({ caso: c, motorProprio: motorProprio(c) }));
    }
    process.exit(2);
  }

  let falhas = 0;
  for (const c of CASOS) {
    const proprio = motorProprio(c);
    const rtc = BASE ? await rtcHttp(c) : rtcCmd(c);
    if (!rtc.disponivel) {
      console.log(`${c.id} SKIP — ${rtc.motivo}`);
      falhas += 1;
      continue;
    }
    const ok =
      within(proprio.vCBS, rtc.vCBS) &&
      within(proprio.vIBSUF, rtc.vIBSUF) &&
      within(proprio.vIBSMun, rtc.vIBSMun);
    if (!ok) falhas += 1;
    console.log(
      `${c.id} CRT${c.crt} ${ok ? "OK" : "DIVERGE"} ` +
        `próprio=${JSON.stringify(proprio)} rtc=${JSON.stringify({
          vCBS: rtc.vCBS,
          vIBSUF: rtc.vIBSUF,
          vIBSMun: rtc.vIBSMun,
        })}`,
    );
  }
  console.log(`\nFalhas: ${falhas}`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

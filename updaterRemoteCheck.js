// Consulta de versão remota do agente — usada por auto-update e checagem manual.

const { isUpgrade, isSameVersion, isDowngrade } = require("./updaterVersion");

const CODIGOS_REDE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENETUNREACH",
]);

function formatarErroConexao(err) {
  const code = err?.code || "";
  const msg = String(err?.message || err || "");
  if (CODIGOS_REDE.has(code) || /fetch failed|network|timeout|socket/i.test(msg)) {
    return "Não foi possível verificar — sem conexão com o servidor.";
  }
  return `Não foi possível verificar — ${msg}`;
}

function montarRespostaBase(updaterState, versaoAtual, extras = {}) {
  return {
    versaoAtual,
    versaoDisponivel: updaterState.versaoDisponivel,
    ultimaVerificacao: updaterState.ultimaVerificacao,
    podeAplicar: false,
    autoUpdate: !!extras.autoUpdate,
    changelog: updaterState.changelog,
    ...extras,
  };
}

/**
 * Consulta GET /pdv/agente/versao no backend.
 * Anti-downgrade: versão remota inferior à instalada é recusada (paridade Inno).
 */
async function consultarVersaoRemota(opts) {
  const {
    versaoAtual,
    updaterState,
    lerConfig,
    manifestUpdater,
    logUpdater = null,
    aplicarAutomaticamente = false,
    aplicarAtualizacao = null,
    fetchFn = require("node-fetch"),
    autoUpdate = false,
  } = opts;

  if (!manifestUpdater.isManifestOk()) {
    const motivo =
      manifestUpdater.getManifestBootMotivo() ||
      "manifest.json com SHA-256 incompleto";
    updaterState.ultimoErro = motivo;
    logUpdater?.error?.(
      { acao: "verificar_atualizacao", resultado: "recusado", err: motivo },
      "Verificação recusada — manifest incompleto",
    );
    return {
      ok: false,
      resultado: "erro",
      mensagem: `Verificação bloqueada — ${motivo}`,
      ...montarRespostaBase(updaterState, versaoAtual, { autoUpdate }),
    };
  }

  const cfg = await lerConfig();
  if (!cfg.backendUrl || !cfg.backendToken) {
    const mensagem =
      "Agente não ativado ou sem credenciais do backend — não é possível verificar atualizações.";
    updaterState.ultimoErro = mensagem;
    return {
      ok: false,
      resultado: "erro",
      mensagem,
      ...montarRespostaBase(updaterState, versaoAtual, { autoUpdate }),
    };
  }

  try {
    const resp = await fetchFn(`${cfg.backendUrl}/pdv/agente/versao`, {
      headers: { Authorization: `Bearer ${cfg.backendToken}` },
      timeout: 8000,
    });

    if (!resp.ok) {
      const mensagem = `Não foi possível verificar — servidor retornou erro (HTTP ${resp.status}).`;
      updaterState.ultimoErro = mensagem;
      return {
        ok: false,
        resultado: "erro",
        mensagem,
        ...montarRespostaBase(updaterState, versaoAtual, { autoUpdate }),
      };
    }

    const { versao, urlDownload, changelog, sha256 } = await resp.json();
    updaterState.ultimaVerificacao = new Date().toISOString();
    updaterState.ultimoErro = null;
    updaterState.pendingUrlDownload = urlDownload || null;
    updaterState.pendingSha256 = sha256 || null;

    if (!versao || isSameVersion(versao, versaoAtual)) {
      updaterState.versaoDisponivel = null;
      updaterState.changelog = null;
      updaterState.pendingUrlDownload = null;
      updaterState.pendingSha256 = null;
      return {
        ok: true,
        resultado: "atualizado",
        mensagem: `Versão v${versaoAtual} — você está na versão mais recente.`,
        ...montarRespostaBase(updaterState, versaoAtual, { autoUpdate }),
      };
    }

    if (isDowngrade(versao, versaoAtual)) {
      updaterState.versaoDisponivel = null;
      updaterState.changelog = null;
      updaterState.pendingUrlDownload = null;
      updaterState.pendingSha256 = null;
      const mensagem =
        `Downgrade bloqueado — servidor ofereceu v${versao}, instalada v${versaoAtual}. ` +
        `Publique uma versão igual ou superior no backend.`;
      logUpdater?.warn?.(
        {
          acao: "verificar_atualizacao",
          resultado: "downgrade_bloqueado",
          versaoRemota: versao,
          versaoAtual,
        },
        "Update remoto recusado — anti-downgrade",
      );
      return {
        ok: true,
        resultado: "atualizado",
        mensagem,
        ...montarRespostaBase(updaterState, versaoAtual, { autoUpdate }),
      };
    }

    updaterState.versaoDisponivel = versao;
    updaterState.changelog = changelog || null;

    const podeAplicar =
      !updaterState.atualizando &&
      !!urlDownload &&
      !!sha256 &&
      manifestUpdater.isManifestOk() &&
      isUpgrade(versao, versaoAtual);

    if (aplicarAutomaticamente && urlDownload && aplicarAtualizacao && podeAplicar) {
      try {
        await aplicarAtualizacao(urlDownload, versao, sha256, {
          force: false,
          origem: "auto",
        });
        return {
          ok: true,
          resultado: "aplicando",
          mensagem: `Atualização para v${versao} em andamento.`,
          versaoDisponivel: versao,
          podeAplicar: false,
          autoUpdate,
          changelog: updaterState.changelog,
          ultimaVerificacao: updaterState.ultimaVerificacao,
        };
      } catch (applyErr) {
        if (applyErr?.code === "UPDATE_BUSY") {
          return {
            ok: true,
            resultado: "disponivel",
            mensagem: applyErr.message,
            versaoAtual,
            versaoDisponivel: versao,
            ultimaVerificacao: updaterState.ultimaVerificacao,
            podeAplicar: true,
            autoUpdate,
            changelog: updaterState.changelog,
            bloqueios: applyErr.bloqueios || [],
          };
        }
        throw applyErr;
      }
    }

    if (!urlDownload || !sha256) {
      return {
        ok: true,
        resultado: "disponivel",
        mensagem: `Nova versão v${versao} disponível, mas o servidor não forneceu pacote para download.`,
        versaoAtual,
        versaoDisponivel: versao,
        ultimaVerificacao: updaterState.ultimaVerificacao,
        podeAplicar: false,
        autoUpdate,
        changelog: updaterState.changelog,
      };
    }

    return {
      ok: true,
      resultado: "disponivel",
      mensagem: `Nova versão v${versao} disponível (atual: v${versaoAtual}).`,
      versaoAtual,
      versaoDisponivel: versao,
      ultimaVerificacao: updaterState.ultimaVerificacao,
      podeAplicar,
      autoUpdate,
      changelog: updaterState.changelog,
    };
  } catch (err) {
    const mensagem = formatarErroConexao(err);
    updaterState.ultimoErro = mensagem;
    logUpdater?.warn?.(
      { acao: "verificar_atualizacao", resultado: "falha", err },
      "Falha ao verificar atualização",
    );
    return {
      ok: false,
      resultado: "erro",
      mensagem,
      ...montarRespostaBase(updaterState, versaoAtual, { autoUpdate }),
    };
  }
}

module.exports = {
  consultarVersaoRemota,
  formatarErroConexao,
};

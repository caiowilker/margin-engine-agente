/**
 * Sincroniza imagem local do agente para a nuvem (idempotente por hash).
 */
async function sincronizarImagemParaNuvem(cfg, produtoId, base64, nome) {
  const backendUrl = String(cfg.backendUrl || "").replace(/\/$/, "");
  const token = cfg.backendToken;
  if (!backendUrl || !token || !base64) return { ok: false, skipped: true };

  const resp = await fetch(
    `${backendUrl}/pdv/produtos/${encodeURIComponent(produtoId)}/imagem/sync`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ base64, nome: nome || "imagem" }),
    },
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    return { ok: false, status: resp.status, erro: err.erro || err.message || resp.statusText };
  }

  const data = await resp.json().catch(() => ({}));
  return { ok: true, imagem: data };
}

module.exports = { sincronizarImagemParaNuvem };

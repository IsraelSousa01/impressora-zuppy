/**
 * scripts/sign.js — hook de assinatura de código do electron-builder.
 *
 * É chamado uma vez pra CADA binário do build (o .exe do app, o elevate.exe,
 * o uninstaller e o instalador NSIS final).
 *
 * >>> ENQUANTO NÃO HOUVER CERTIFICADO, ISTO É NO-OP <<<
 * Sem env var de assinatura, o hook só loga e retorna — o build sai SEM
 * assinatura, exatamente como hoje. Quando você comprar o certificado, define
 * as env vars (localmente ou nos secrets do GitHub Actions) e NADA aqui muda.
 *
 * Escolha UM dos dois caminhos:
 *
 * ── Caminho 1: Azure Trusted Signing (recomendado — ~US$10/mês, nuvem, CI) ──
 *   Instale a CLI:   npm i -D @azure/trusted-signing-cli
 *   Env vars (service principal do Azure + dados da conta):
 *     AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 *     TRUSTED_SIGNING_ENDPOINT   ex: https://weu.codesigning.azure.net
 *     TRUSTED_SIGNING_ACCOUNT    nome da conta de Trusted Signing
 *     TRUSTED_SIGNING_PROFILE    nome do certificate profile
 *
 * ── Caminho 2: qualquer outro provedor (Certum SimplySign, DigiCert ─────────
 *    KeyLocker, SSL.com CodeSignTool, token USB via signtool, etc.) ──────────
 *   Env var WIN_SIGN_COMMAND com o comando completo; use {file} onde entra o
 *   caminho do arquivo. Ex.:
 *     WIN_SIGN_COMMAND=signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /n "Zuppy Food" {file}
 *   (o signtool vem com o Windows SDK; precisa estar no PATH)
 *
 * ⚠️ NUNCA commite credenciais — elas vivem só em env vars.
 *
 * Obs.: se um dia você preferir o caminho tradicional CSC (certificado em
 * arquivo/token via as env vars CSC_LINK/CSC_KEY_PASSWORD nativas do
 * electron-builder), REMOVA a linha `sign: ./scripts/sign.js` do
 * electron-builder.yml — aí o electron-builder assina sozinho, sem este hook.
 */
const { execFileSync, execSync } = require("node:child_process")

module.exports = async function sign(configuration) {
  const file = configuration && configuration.path
  if (!file) return

  // ── Caminho 2: comando genérico (tem prioridade se definido) ──────────────
  const customCommand = process.env.WIN_SIGN_COMMAND
  if (customCommand) {
    const cmd = customCommand.includes("{file}")
      ? customCommand.replace(/\{file\}/g, `"${file}"`)
      : `${customCommand} "${file}"`
    console.log(`[sign] WIN_SIGN_COMMAND → ${file}`)
    execSync(cmd, { stdio: "inherit" })
    return
  }

  // ── Caminho 1: Azure Trusted Signing ──────────────────────────────────────
  const endpoint = process.env.TRUSTED_SIGNING_ENDPOINT
  const account = process.env.TRUSTED_SIGNING_ACCOUNT
  const profile = process.env.TRUSTED_SIGNING_PROFILE
  if (endpoint && account && profile) {
    console.log(`[sign] Azure Trusted Signing → ${file}`)
    // execFileSync (sem shell): caminhos com espaço vão como arg único.
    const npx = process.platform === "win32" ? "npx.cmd" : "npx"
    execFileSync(
      npx,
      ["trusted-signing-cli", "-e", endpoint, "-a", account, "-c", profile, file],
      { stdio: "inherit" }
    )
    return
  }

  // ── Sem credencial → NO-OP (build não assinado, comportamento atual) ──────
  console.log(`[sign] sem credencial de assinatura — pulando (não assinado): ${file}`)
}

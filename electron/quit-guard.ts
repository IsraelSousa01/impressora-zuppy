/**
 * electron/quit-guard.ts
 * Texto da confirmação do "Sair" da bandeja (decisão pura; o dialog é do tray).
 *
 * O app roda escondido na bandeja e é ele que imprime os pedidos: sair sem
 * querer deixa a cozinha sem comanda até alguém abrir o app de novo. A caixa
 * diz isso com todas as letras e deixa "Continuar imprimindo" como botão
 * padrão (Enter e Esc não saem).
 *
 * Só a bandeja passa por aqui. O encerramento do Windows e o `quitAndInstall`
 * da atualização (na janela segura) NÃO pedem confirmação.
 */

export interface QuitConfirmation {
  message: string
  detail: string
  buttons: [string, string]
  /** Botão selecionado ao abrir (Enter): continuar imprimindo. */
  defaultId: 0
  /** Botão do Esc / fechar a caixa: continuar imprimindo. */
  cancelId: 0
  /** Índice do botão que realmente sai. */
  quitButtonIndex: 1
}

/**
 * `null` = não precisa perguntar (app sem pareamento: não imprime nada, sair
 * não custa pedido nenhum).
 */
export function buildQuitConfirmation(state: {
  configured: boolean
  queueLength: number
}): QuitConfirmation | null {
  if (!state.configured) return null

  const queueLine =
    state.queueLength === 0
      ? ''
      : state.queueLength === 1
        ? ' 1 comanda ainda não imprimiu; ela sai quando o app voltar.'
        : ` ${state.queueLength} comandas ainda não imprimiram; elas saem quando o app voltar.`

  return {
    message: 'Se você sair, os pedidos deixam de imprimir',
    detail:
      'O Zuppy Impressora é quem imprime os pedidos desta loja. Enquanto ele estiver fechado, nenhuma comanda sai.' +
      queueLine +
      ' Para voltar a imprimir, abra o Zuppy Impressora de novo.',
    buttons: ['Continuar imprimindo', 'Sair mesmo'],
    defaultId: 0,
    cancelId: 0,
    quitButtonIndex: 1,
  }
}

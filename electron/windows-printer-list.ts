import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)
const COMMAND_TIMEOUT_MS = 8_000

const WINDOWS_PRINTER_COMMANDS = [
  'powershell.exe -NoProfile -NonInteractive -Command "Get-Printer | Select-Object -ExpandProperty Name"',
  'powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance -ClassName Win32_Printer | Select-Object -ExpandProperty Name"',
] as const

export type PrinterCommandRunner = (
  command: string,
  options: { timeout: number },
) => Promise<{ stdout: string }>

/** Normaliza a saída textual dos enumeradores de impressora do Windows. */
export function parseWindowsPrinterNames(stdout: string): string[] {
  const names = new Set<string>()

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    const name = line.replace(/^Name=/i, '').trim()
    if (name && !/^Name$/i.test(name)) names.add(name)
  }

  return [...names]
}

/**
 * Lista as impressoras instaladas sem depender do WMIC, removido/descontinuado
 * em instalações recentes do Windows. O segundo comando cobre máquinas onde
 * o módulo PrintManagement não está disponível.
 */
export async function listWindowsPrinterNames(
  runCommand: PrinterCommandRunner = execAsync,
  onCommandError: (command: string, error: unknown) => void = () => undefined,
): Promise<string[]> {
  for (const command of WINDOWS_PRINTER_COMMANDS) {
    try {
      const { stdout } = await runCommand(command, { timeout: COMMAND_TIMEOUT_MS })
      return parseWindowsPrinterNames(stdout)
    } catch (error) {
      onCommandError(command, error)
    }
  }

  return []
}

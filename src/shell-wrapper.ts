export const CONTAINER_WORKSPACE = 'C:\\workspace'

export enum Shell {
    bash = 'bash --noprofile --norc -eo pipefail {0}',
    pwsh = 'pwsh -NoLogo -Command ". \'{0}\'"',
    python = 'python {0}',
    cmd = '%ComSpec% /D /E:ON /V:OFF /S /C "{0}"',
    powershell = 'powershell -NoLogo -Command ". \'{0}\'"'
}

type ScriptGen = (file: string, out: string) => string
type ScriptSuffix = string
type ShellInfo = [ScriptGen, ScriptSuffix]

export function get_shell_info(shell: Shell): ShellInfo {
    const defaultGen: ScriptGen = (file: string, out: string): string => {
        return `type "${file}" > "${out}"`
    }
    switch (shell) {
        case Shell.bash:
            return [defaultGen, 'sh']
        case Shell.pwsh:
        case Shell.powershell:
            return [
                (file: string, out: string): string => {
                    return `
(
    echo $ErrorActionPreference = 'stop'
    type "${file}"
    echo.
    echo if ((Test-Path -LiteralPath variable:\\LASTEXITCODE^)^) { exit $LASTEXITCODE }
) > "${out}"`
                },
                'ps1'
            ]
        case Shell.python:
            return [defaultGen, 'py']
        case Shell.cmd:
            return [defaultGen, 'cmd']
    }
}

export const wrapper = (
    shell_name: string,
    shell: Shell,
    container_id: string,
    container_workspace: string,
    helper_script_path: string,
    node_executable_path: string
): string => {
    const [gen, suffix] = get_shell_info(shell)
    const script_path = `${container_workspace}\\%~nx1.${suffix}`
    return `
@echo off
setlocal enabledelayedexpansion
${gen('%1', `%GITHUB_WORKSPACE%\\%~nx1.${suffix}`)}
"${node_executable_path}" "${helper_script_path}" --container-id "${container_id}" --shell-name "${shell_name}" --script-path "${script_path}" --host-workspace "%GITHUB_WORKSPACE%"
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%
`.replaceAll('\n', '\r\n')
}

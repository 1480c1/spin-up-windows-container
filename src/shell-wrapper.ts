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
    shell: Shell,
    container_id: string,
    container_workspace: string
): string => {
    const [gen, suffix] = get_shell_info(shell)
    const command = shell.replace('{0}', `${container_workspace}\\%~nx1.${suffix}`)
    return `
@echo off
setlocal enabledelayedexpansion
${gen('%1', `%GITHUB_WORKSPACE%\\%~nx1.${suffix}`)}
set "ENV_FILE=%TEMP%\\container_env_%RANDOM%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%.txt"
set | findstr /v /i "^PATH=" > "%ENV_FILE%"
echo GITHUB_WORKSPACE=${container_workspace} >> "%ENV_FILE%"
docker exec -i -w "${container_workspace}" --env-file "%ENV_FILE%" "${container_id}" ${command}
set "EXIT_CODE=%ERRORLEVEL%"
del "%ENV_FILE%" 2>nul
exit /b %EXIT_CODE%
`.replaceAll('\n', '\r\n')
}

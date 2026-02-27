export const CONTAINER_WORKSPACE = 'C:\\workspace'
export const ENV_SCRIPT_NAME = 'generate-container-env.ps1'

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

export const env_script = (): string => {
    return `
param(
    [Parameter(Mandatory = $true)]
    [string]$EnvFile,

    [Parameter(Mandatory = $true)]
    [string]$ContainerID,

    [Parameter(Mandatory = $false)]
    [string[]]$ExcludeVars = @('PATH')
)

$ErrorActionPreference = 'Stop'

# Get environment variables excluding specified variables
Get-ChildItem env: | Where-Object { $ExcludeVars -notcontains $_.Name } | ForEach-Object {
    "$($_.Name)=$($_.Value)"
} | Set-Content -Encoding UTF8 $EnvFile

# Get existing container environment variables
$containerEnvOutput = docker exec "$ContainerID" cmd /D /E:ON /V:OFF /S /C 'set' 2>$null
$container_workspace = ''
if ($LastExitCode -eq 0) {
    # Filter out variables that already exist in the container
    $containerVars = @{}
    $containerEnvOutput | ForEach-Object {
        if ($_ -match '^([^=]+)=') {
            $containerVars[$matches[1]] = $true
        }
    }

    # Extract GITHUB_WORKSPACE if it exists
    if ($containerVars.ContainsKey('GITHUB_WORKSPACE')) {
        $container_workspace = ($containerEnvOutput | Where-Object { $_ -match '^GITHUB_WORKSPACE=' }) -replace '^GITHUB_WORKSPACE='
    }

    (Get-Content $EnvFile) | Where-Object {
        if ($_ -match '^([^=]+)=') {
            -not $containerVars.ContainsKey($matches[1])
        } else {
            $true
        }
    } | Set-Content -Encoding UTF8 $EnvFile
}

# Convert paths in environment variables from host workspace to container workspace
$oldPath = $env:GITHUB_WORKSPACE
$newPath = $container_workspace
$oldPathFwd = $oldPath -replace '\\\\', '/'
$newPathFwd = $newPath -replace '\\\\', '/'

(Get-Content $EnvFile) | ForEach-Object {
    $_ -replace [regex]::Escape($oldPath), $newPath -replace [regex]::Escape($oldPathFwd), $newPathFwd
} | Set-Content -Encoding UTF8 $EnvFile

# Add GITHUB_WORKSPACE override
"GITHUB_WORKSPACE=\${container_workspace}" | Add-Content -Encoding UTF8 $EnvFile
`.replaceAll('\n', '\r\n')
}

export const wrapper = (
    shell: Shell,
    container_id: string,
    container_workspace: string,
    script_dir: string
): string => {
    const [gen, suffix] = get_shell_info(shell)
    const command = shell.replace('{0}', `${container_workspace}\\%~nx1.${suffix}`)
    return `
@echo off
setlocal enabledelayedexpansion
${gen('%1', `%GITHUB_WORKSPACE%\\%~nx1.${suffix}`)}
set "ENV_FILE=%TEMP%\\container_env_%RANDOM%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "${script_dir}\\${ENV_SCRIPT_NAME}" -EnvFile "%ENV_FILE%" -ContainerID "${container_id}"
if errorlevel 1 (
    echo Failed to generate environment file
    exit /b 1
)
docker exec -i -w "${container_workspace}" --env-file "%ENV_FILE%" "${container_id}" ${command}
set "EXIT_CODE=%ERRORLEVEL%"
del "%ENV_FILE%" 2>nul
exit /b %EXIT_CODE%
`.replaceAll('\n', '\r\n')
}

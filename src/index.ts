import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

async function docker_pull(image: string): Promise<string | null> {
    core.startGroup(`Pulling Docker image: ${image}`)
    let image_id = ''
    const checkOptions: exec.ExecOptions = {
        listeners: {
            stdout: (data: Buffer) => {
                image_id += data.toString()
            }
        }
    }
    if ((await exec.exec('docker', ['pull', '-q', image], checkOptions)) == 0) {
        core.info(`Successfully pulled Docker image: ${image}`)
        core.endGroup()
        return image_id.trim()
    }
    // The return code of docker images is 0 even if the image is not found, so we need to check the output to determine if the image exists locally
    await exec.exec('docker', ['images', '-q', image], checkOptions)
    image_id = image_id.trim()
    if (image_id.length > 0) {
        core.info(`Using pre-existing Docker image: ${image}`)
        core.endGroup()
        return image_id
    }
    core.setFailed(`Docker image not found locally: ${image}`)
    core.endGroup()
    return null
}

const container_workspace = 'C:\\workspace'

async function docker_run(image: string): Promise<string> {
    core.startGroup(`Running Docker container from image: ${image}`)
    const github_workspace = process.env.GITHUB_WORKSPACE
    if (!github_workspace) {
        core.setFailed('GITHUB_WORKSPACE environment variable is not set.')
        core.endGroup()
        return ''
    }
    let container_id = ''
    const options: exec.ExecOptions = {
        listeners: {
            stdout: (data: Buffer) => {
                container_id += data.toString()
            }
        }
    }
    if (
        (await exec.exec(
            'docker',
            [
                'run',
                '--rm',
                '-d',
                '-v',
                `${github_workspace}:${container_workspace}`,
                '-w',
                container_workspace,
                '-e',
                `GITHUB_WORKSPACE=${container_workspace}`,
                image,
                'powershell',
                '-Command',
                'while (1) { Start-Sleep -Seconds 2147483 }'
            ],
            options
        )) !== 0
    ) {
        core.setFailed(`Failed to run Docker container from image: ${image}`)
        core.endGroup()
        return ''
    }
    container_id = container_id.trim()
    core.setOutput('container_id', container_id)
    core.endGroup()
    return container_id
}

enum Shell {
    bash = 'bash --noprofile --norc -eo pipefail {0}',
    pwsh = 'pwsh -NoLogo -Command ". \'{0}\'"',
    python = 'python {0}',
    cmd = '%ComSpec% /D /E:ON /V:OFF /S /C "CALL "{0}""',
    powershell = 'powershell -NoLogo -Command ". \'{0}\'"'
}

type ScriptGen = (file: string, out: string) => string
type ScriptSuffix = string
type ShellInfo = [ScriptGen, ScriptSuffix]

function get_shell_info(shell: Shell): ShellInfo {
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

const wrapper = (shell: Shell, container_id: string, container_workspace: string): string => {
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

async function setup_container_wrappers(path_dir: string, container_id: string): Promise<void> {
    core.startGroup(`Setting up wrapper with ID: ${container_id}`)
    for (const [shell_name, shell_command] of Object.entries(Shell)) {
        const wrapper_content = wrapper(shell_command, container_id, container_workspace)
        const wrapper_path = path.join(path_dir, `${shell_name}-in-container.cmd`)
        core.info(`Creating wrapper for ${shell_name} at ${wrapper_path} with ${shell_command}`)
        fs.writeFileSync(wrapper_path, wrapper_content)
    }

    core.addPath(path_dir)
    core.endGroup()
}

async function run(): Promise<void> {
    try {
        if (process.platform !== 'win32') {
            core.setFailed('This action can only be run on Windows runners.')
            return
        }
        const temp_dir = process.env.RUNNER_TEMP
        if (!temp_dir) {
            core.setFailed('RUNNER_TEMP environment variable is not set.')
            return
        }
        const image: string = core.getInput('image').trim()
        if (!image) {
            core.setFailed('Image name is required.')
            return
        }

        const path_dir = path.join(temp_dir, 'container-wrapper')
        fs.mkdirSync(path_dir, { recursive: true })
        const container_id_store = path.join(path_dir, '.container_id')

        if (fs.existsSync(container_id_store)) {
            core.warning(
                'A container ID file already exists. This may indicate that a container is still running from a previous execution. Attempting to clean up before proceeding.'
            )
            const container_id = fs.readFileSync(container_id_store, 'utf-8').trim()
            if (container_id) {
                core.info(`Attempting to stop existing container with ID: ${container_id}`)
                await exec.exec('docker', ['stop', '-t', '10', container_id])
            }
            fs.rmSync(path_dir, { recursive: true, force: true })
            fs.mkdirSync(path_dir, { recursive: true })
        }

        const final_image = await docker_pull(image)
        if (!final_image) {
            return
        }
        const container_id = await docker_run(final_image)

        fs.writeFileSync(container_id_store, container_id)
        await setup_container_wrappers(path_dir, container_id)
    } catch (error: unknown) {
        if (error instanceof Error) {
            core.setFailed(error.message)
        } else {
            core.setFailed(String(error))
        }
    }
}

run()

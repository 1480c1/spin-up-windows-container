import { s as setFailed, g as getInput, w as warning, i as info, e as exec, a as startGroup, b as endGroup, c as setOutput, d as addPath } from './core-lMgWmY_i.js';
import * as fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import 'os';
import 'crypto';
import 'fs';
import 'path';
import 'http';
import 'https';
import 'net';
import 'tls';
import 'events';
import 'assert';
import 'util';
import 'node:assert';
import 'node:net';
import 'node:http';
import 'node:stream';
import 'node:buffer';
import 'node:util';
import 'node:querystring';
import 'node:events';
import 'node:diagnostics_channel';
import 'node:tls';
import 'node:zlib';
import 'node:perf_hooks';
import 'node:util/types';
import 'node:worker_threads';
import 'node:url';
import 'node:async_hooks';
import 'node:console';
import 'node:dns';
import 'string_decoder';
import 'child_process';
import 'timers';

const CONTAINER_WORKSPACE = 'C:\\workspace';
var Shell;
(function (Shell) {
    Shell["bash"] = "bash --noprofile --norc -eo pipefail {0}";
    Shell["pwsh"] = "pwsh -NoLogo -Command \". '{0}'\"";
    Shell["python"] = "python {0}";
    Shell["cmd"] = "%ComSpec% /D /E:ON /V:OFF /S /C \"{0}\"";
    Shell["powershell"] = "powershell -NoLogo -Command \". '{0}'\"";
})(Shell || (Shell = {}));
function get_shell_info(shell) {
    const defaultGen = (file, out) => {
        return `type "${file}" > "${out}"`;
    };
    switch (shell) {
        case Shell.bash:
            return [defaultGen, 'sh'];
        case Shell.pwsh:
        case Shell.powershell:
            return [
                (file, out) => {
                    return `
(
    echo $ErrorActionPreference = 'stop'
    type "${file}"
    echo if ((Test-Path -LiteralPath variable:\\LASTEXITCODE^)^) { exit $LASTEXITCODE }
) > "${out}"`;
                },
                'ps1'
            ];
        case Shell.python:
            return [defaultGen, 'py'];
        case Shell.cmd:
            return [defaultGen, 'cmd'];
    }
}
const wrapper = (shell, container_id, container_workspace) => {
    const [gen, suffix] = get_shell_info(shell);
    const command = shell.replace('{0}', `${container_workspace}\\%~nx1.${suffix}`);
    return `
@echo off
setlocal enabledelayedexpansion
${gen('%1', `%GITHUB_WORKSPACE%\\%~nx1.${suffix}`)}
set "ENV_FILE=%TEMP%\\container_env_%RANDOM%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%.txt"
set "FILTERED_ENV_FILE=%TEMP%\\container_env_filtered_%RANDOM%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%.txt"
set "CONTAINER_ENV_FILE=%TEMP%\\container_env_existing_%RANDOM%_%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%.txt"
set | findstr /v /i "^PATH=" > "%ENV_FILE%"
docker exec "${container_id}" cmd /D /E:ON /V:OFF /S /C "set" > "%CONTAINER_ENV_FILE%"
if not errorlevel 1 (
    for /f "usebackq tokens=1 delims==" %%E in ("%CONTAINER_ENV_FILE%") do (
        findstr /v /r /i "^%%E=" "%ENV_FILE%" > "%FILTERED_ENV_FILE%"
        move /y "%FILTERED_ENV_FILE%" "%ENV_FILE%" >nul
    )
)
echo GITHUB_WORKSPACE=${container_workspace} >> "%ENV_FILE%"
docker exec -i -w "${container_workspace}" --env-file "%ENV_FILE%" "${container_id}" ${command}
set "EXIT_CODE=%ERRORLEVEL%"
del "%ENV_FILE%" 2>nul
del "%FILTERED_ENV_FILE%" 2>nul
del "%CONTAINER_ENV_FILE%" 2>nul
exit /b %EXIT_CODE%
`.replaceAll('\n', '\r\n');
};

async function docker_pull(image) {
    startGroup(`Pulling Docker image: ${image}`);
    if ((await exec('docker', ['pull', '-q', image])) == 0) {
        info(`Successfully pulled Docker image: ${image}`);
        endGroup();
        return image;
    }
    // The return code of docker images is 0 even if the image is not found,
    // so we need to check the output to determine if the image exists locally.
    let image_id = '';
    const imageCheckOptions = {
        listeners: {
            stdout: (data) => {
                image_id += data.toString();
            }
        }
    };
    await exec('docker', ['images', '-q', image], imageCheckOptions);
    image_id = image_id.trim();
    if (image_id.length > 0) {
        info(`Using pre-existing Docker image: ${image}`);
        endGroup();
        return image;
    }
    setFailed(`Docker image not found locally: ${image}`);
    endGroup();
    return null;
}
async function docker_run(image) {
    startGroup(`Running Docker container from image: ${image}`);
    const github_workspace = process.env.GITHUB_WORKSPACE;
    if (!github_workspace) {
        setFailed('GITHUB_WORKSPACE environment variable is not set.');
        endGroup();
        return '';
    }
    let container_id = '';
    const options = {
        listeners: {
            stdout: (data) => {
                container_id += data.toString();
            }
        }
    };
    if ((await exec('docker', [
        'run',
        '--rm',
        '-d',
        '-v',
        `${github_workspace}:${CONTAINER_WORKSPACE}`,
        '-w',
        CONTAINER_WORKSPACE,
        '-e',
        `GITHUB_WORKSPACE=${CONTAINER_WORKSPACE}`,
        image,
        'powershell',
        '-Command',
        'while (1) { Start-Sleep -Seconds 2147483 }'
    ], options)) !== 0) {
        setFailed(`Failed to run Docker container from image: ${image}`);
        endGroup();
        return '';
    }
    container_id = container_id.trim();
    setOutput('container_id', container_id);
    endGroup();
    return container_id;
}
async function setup_container_wrappers(path_dir, container_id) {
    startGroup(`Setting up wrapper with ID: ${container_id}`);
    for (const [shell_name, shell_command] of Object.entries(Shell)) {
        const wrapper_content = wrapper(shell_command, container_id, CONTAINER_WORKSPACE);
        const wrapper_path = path.join(path_dir, `${shell_name}-in-container.cmd`);
        info(`Creating wrapper for ${shell_name} at ${wrapper_path} with ${shell_command}`);
        fs.writeFileSync(wrapper_path, wrapper_content);
    }
    addPath(path_dir);
    endGroup();
}
async function run() {
    try {
        if (process.platform !== 'win32') {
            setFailed('This action can only be run on Windows runners.');
            return;
        }
        const temp_dir = process.env.RUNNER_TEMP;
        if (!temp_dir) {
            setFailed('RUNNER_TEMP environment variable is not set.');
            return;
        }
        const image = getInput('image').trim();
        if (!image) {
            setFailed('Image name is required.');
            return;
        }
        const path_dir = path.join(temp_dir, 'container-wrapper');
        fs.mkdirSync(path_dir, { recursive: true });
        const container_id_store = path.join(path_dir, '.container_id');
        if (fs.existsSync(container_id_store)) {
            warning('A container ID file already exists. This may indicate that a container is still running from a previous execution. Attempting to clean up before proceeding.');
            const container_id = fs.readFileSync(container_id_store, 'utf-8').trim();
            if (container_id) {
                info(`Attempting to stop existing container with ID: ${container_id}`);
                await exec('docker', ['stop', '-t', '10', container_id]);
            }
            fs.rmSync(path_dir, { recursive: true, force: true });
            fs.mkdirSync(path_dir, { recursive: true });
        }
        const final_image = await docker_pull(image);
        if (!final_image) {
            return;
        }
        const container_id = await docker_run(final_image);
        if (!container_id) {
            return;
        }
        fs.writeFileSync(container_id_store, container_id);
        await setup_container_wrappers(path_dir, container_id);
    }
    catch (error) {
        if (error instanceof Error) {
            setFailed(error.message);
        }
        else {
            setFailed(String(error));
        }
    }
}
run();
//# sourceMappingURL=index.js.map

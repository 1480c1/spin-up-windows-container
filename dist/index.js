import { s as setFailed, g as getInput, c as create_docker_client, w as warning, i as info, a as stop_container, b as close_docker_client, d as startGroup, p as pull_image, e as endGroup, f as image_exists_locally, h as create_and_start_container, j as setOutput, k as addPath, l as get_image_os_version, m as debug, n as error } from './docker-client-eesSGNkd.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import 'string_decoder';
import 'child_process';
import 'timers';
import 'node:net';
import 'node:tls';
import 'node:assert';
import 'node:http';
import 'node:stream';
import 'node:buffer';
import 'node:util';
import 'node:querystring';
import 'node:events';
import 'node:diagnostics_channel';
import 'node:zlib';
import 'node:perf_hooks';
import 'node:util/types';
import 'node:worker_threads';
import 'node:url';
import 'node:async_hooks';
import 'node:console';
import 'node:dns';
import 'node:stream/web';

const CONTAINER_WORKSPACE = 'C:\\workspace';
const ENV_SCRIPT_NAME = 'generate-container-env.ps1';
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
    echo.
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
const env_script = () => {
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
`.replaceAll('\n', '\r\n');
};
const wrapper = (shell, container_id, container_workspace, script_dir) => {
    const [gen, suffix] = get_shell_info(shell);
    const command = shell.replace('{0}', `${container_workspace}\\%~nx1.${suffix}`);
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
`.replaceAll('\n', '\r\n');
};

async function can_use_proc_isolation(client, imageName) {
    try {
        // 1. Get Host Build Version via PowerShell
        const hostBuildStr = os.release(); // produces a string in the form of '10.0.26200', we need the 3rd segment for the build number
        const hostBuild = parseInt(hostBuildStr.split('.')[2]);
        // 2. Get Image OS Version via Docker API
        const imageOsVersion = await get_image_os_version(client, imageName);
        // Image version format is usually "10.0.26100.4061" - we need the 3rd segment
        const imageBuild = parseInt(imageOsVersion.split('.')[2]);
        debug(`Host Build: ${hostBuild} | Image Build: ${imageBuild}`);
        // 3. Compatibility Logic
        if (hostBuild === imageBuild) {
            debug('Perfect match. Process isolation is supported.');
            return true;
        }
        if (hostBuild > imageBuild) {
            // Down-level compatibility requires Windows 11 (22000+) or Server 2022 (20348+)
            if (hostBuild >= 20348) {
                debug('Host supports down-level process isolation.');
                return true;
            }
            warning('Host is older than Windows 11/Server 2022. Exact version match required for process isolation. Expect performance degradation if running this image, and some features may not work as expected.');
            return false;
        }
        error('Image build is newer than Host build. Running this image is not supported. Will attempt to run it, but expect it to fail.');
    }
    catch (error) {
        setFailed(`Failed to inspect image: ${error instanceof Error ? error.message : error}`);
    }
    return false;
}
async function docker_pull(client, image) {
    startGroup(`Pulling Docker image: ${image}`);
    try {
        await pull_image(client, image);
        info(`Successfully pulled Docker image: ${image}`);
        endGroup();
        return image;
    }
    catch {
        // Continue to local image fallback check.
    }
    if (await image_exists_locally(client, image)) {
        info(`Using pre-existing Docker image: ${image}`);
        endGroup();
        return image;
    }
    setFailed(`Docker image not found locally: ${image}`);
    endGroup();
    return null;
}
async function docker_run(client, image) {
    startGroup(`Running Docker container from image: ${image}`);
    const github_workspace = process.env.GITHUB_WORKSPACE;
    if (!github_workspace) {
        setFailed('GITHUB_WORKSPACE environment variable is not set.');
        endGroup();
        return '';
    }
    const isolation = (await can_use_proc_isolation(client, image)) ? 'process' : 'hyperv';
    info(`Using ${isolation} isolation for container.`);
    try {
        const container_id = await create_and_start_container(client, image, github_workspace, CONTAINER_WORKSPACE, isolation, os.availableParallelism(), Math.round(os.totalmem() * 0.8));
        setOutput('container_id', container_id);
        endGroup();
        return container_id;
    }
    catch {
        setFailed(`Failed to run Docker container from image: ${image}`);
        endGroup();
        return '';
    }
}
async function setup_container_wrappers(path_dir, container_id) {
    startGroup(`Setting up wrapper with ID: ${container_id}`);
    // Generate the PowerShell environment script
    const env_script_content = env_script();
    const env_script_path = path.join(path_dir, ENV_SCRIPT_NAME);
    info(`Creating environment generation script at ${env_script_path}`);
    fs.writeFileSync(env_script_path, env_script_content);
    // Generate wrapper scripts for each shell
    for (const [shell_name, shell_command] of Object.entries(Shell)) {
        const wrapper_content = wrapper(shell_command, container_id, CONTAINER_WORKSPACE, path_dir);
        const wrapper_path = path.join(path_dir, `${shell_name}-in-container.cmd`);
        info(`Creating wrapper for ${shell_name} at ${wrapper_path} with ${shell_command}`);
        fs.writeFileSync(wrapper_path, wrapper_content);
    }
    addPath(path_dir);
    endGroup();
}
async function run() {
    let dockerClient = null;
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
        dockerClient = await create_docker_client();
        const path_dir = path.join(temp_dir, 'container-wrapper');
        fs.mkdirSync(path_dir, { recursive: true });
        const container_id_store = path.join(path_dir, '.container_id');
        if (fs.existsSync(container_id_store)) {
            warning('A container ID file already exists. This may indicate that a container is still running from a previous execution. Attempting to clean up before proceeding.');
            const container_id = fs.readFileSync(container_id_store, 'utf-8').trim();
            if (container_id) {
                info(`Attempting to stop existing container with ID: ${container_id}`);
                await stop_container(dockerClient, container_id, 10);
            }
            fs.rmSync(path_dir, { recursive: true, force: true });
            fs.mkdirSync(path_dir, { recursive: true });
        }
        const final_image = await docker_pull(dockerClient, image);
        if (!final_image) {
            return;
        }
        const container_id = await docker_run(dockerClient, final_image);
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
    finally {
        if (dockerClient) {
            await close_docker_client(dockerClient);
        }
    }
}
run();
//# sourceMappingURL=index.js.map

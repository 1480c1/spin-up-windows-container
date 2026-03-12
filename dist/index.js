import { s as setFailed, g as getInput, w as warning, i as info, a as startGroup, e as endGroup, b as setOutput, c as addPath, d as debug, f as error } from './core-CxI4fOvG.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { c as create_docker_client, s as stop_container, a as close_docker_client, p as pull_image, i as image_exists_locally, b as create_and_start_container, g as get_image_os_version } from './docker-client-B4BHouVy.js';
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
import 'node:async_hooks';
import 'node:console';
import 'node:dns';
import 'node:stream/web';
import 'node:fs/promises';

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
const wrapper = (shell_name, shell, container_id, container_workspace, helper_script_path, node_executable_path) => {
    const [gen, suffix] = get_shell_info(shell);
    const script_path = `${container_workspace}\\%~nx1.${suffix}`;
    return `
@echo off
setlocal enabledelayedexpansion
${gen('%1', `%GITHUB_WORKSPACE%\\%~nx1.${suffix}`)}
"${node_executable_path}" "${helper_script_path}" --container-id "${container_id}" --shell-name "${shell_name}" --script-path "${script_path}" --host-workspace "%GITHUB_WORKSPACE%"
set "EXIT_CODE=%ERRORLEVEL%"
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
    const runtime_dir = path.dirname(fileURLToPath(import.meta.url));
    const helper_script_path = path.join(runtime_dir, 'container-exec.js');
    // Generate wrapper scripts for each shell
    for (const [shell_name, shell_command] of Object.entries(Shell)) {
        const wrapper_content = wrapper(shell_name, shell_command, container_id, CONTAINER_WORKSPACE, helper_script_path, process.execPath);
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

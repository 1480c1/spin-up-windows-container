import { s as setFailed, g as getInput, w as warning, i as info, a as startGroup, e as endGroup, b as setOutput, c as addPath, d as debug, f as error } from './core-BVPvmuQY.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { c as createDockerClient, s as stopContainer, a as closeDockerClient, p as pullImage, i as imageExistsLocally, b as createAndStartContainer, g as getImageOsVersion } from './docker-client-k4oheuFb.js';
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

const DRIVE_LETTER_RE = /^[A-Za-z]:[\\/]/;
/**
 * Replace the drive letter in a Windows path with C so the path is
 * usable inside a Windows container (only C:\ is guaranteed).
 */
function normalizeWindowsContainerDestinationPath(p) {
    if (DRIVE_LETTER_RE.test(p)) {
        return 'C' + p.slice(1);
    }
    return p;
}
/** Environment variables whose values are file paths we need to bind-mount. */
const GITHUB_PATH_VARS = [
    'GITHUB_OUTPUT',
    'GITHUB_ENV',
    'GITHUB_PATH',
    'GITHUB_STEP_SUMMARY'
];
function getEnvAndBinds() {
    const workspace = process.env.GITHUB_WORKSPACE;
    if (!workspace) {
        throw new Error('GITHUB_WORKSPACE environment variable is not set.');
    }
    const containerWorkspace = normalizeWindowsContainerDestinationPath(workspace);
    // Collect unique host directories we need to bind-mount.
    const hostDirs = new Set();
    hostDirs.add(workspace);
    const runnerTemp = process.env.RUNNER_TEMP;
    if (runnerTemp) {
        hostDirs.add(runnerTemp);
    }
    for (const varName of GITHUB_PATH_VARS) {
        const value = process.env[varName];
        if (value) {
            hostDirs.add(path.dirname(value));
        }
    }
    // De-duplicate: remove any dir that is a subdirectory of another.
    const sorted = [...hostDirs].sort((a, b) => a.length - b.length);
    const roots = [];
    for (const dir of sorted) {
        const normalizedDir = dir.toLowerCase().replaceAll('/', '\\');
        const isChild = roots.some((root) => {
            const normalizedRoot = root.toLowerCase().replaceAll('/', '\\');
            return (normalizedDir.startsWith(normalizedRoot + '\\\\') ||
                normalizedDir === normalizedRoot);
        });
        if (!isChild) {
            roots.push(dir);
        }
    }
    const binds = roots.map((hostDir) => `${hostDir}:${normalizeWindowsContainerDestinationPath(hostDir)}`);
    const env = [`GITHUB_WORKSPACE=${containerWorkspace}`];
    return { binds, env, containerWorkspace };
}
async function canUseProcIsolation(client, imageName) {
    try {
        // 1. Get Host Build Version via PowerShell
        const hostBuildStr = os.release(); // produces a string in the form of '10.0.26200', we need the 3rd segment for the build number
        const hostBuild = parseInt(hostBuildStr.split('.')[2]);
        // 2. Get Image OS Version via Docker API
        const imageOsVersion = await getImageOsVersion(client, imageName);
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
async function dockerPull(client, image) {
    startGroup(`Pulling Docker image: ${image}`);
    try {
        await pullImage(client, image);
        info(`Successfully pulled Docker image: ${image}`);
        endGroup();
        return image;
    }
    catch (pullError) {
        warning(`Failed to pull Docker image '${image}': ${pullError instanceof Error ? pullError.message : pullError}. Checking for local copy…`);
    }
    try {
        if (await imageExistsLocally(client, image)) {
            info(`Using pre-existing local Docker image: ${image}`);
            endGroup();
            return image;
        }
    }
    catch (inspectError) {
        warning(`Failed to inspect local image '${image}': ${inspectError instanceof Error ? inspectError.message : inspectError}`);
    }
    setFailed(`Docker image '${image}' could not be pulled and was not found locally. Ensure the image name is correct and that the Docker daemon is running.`);
    endGroup();
    return null;
}
async function dockerRun(client, image) {
    startGroup(`Running Docker container from image: ${image}`);
    let envAndBinds;
    try {
        envAndBinds = getEnvAndBinds();
    }
    catch (error) {
        setFailed(`Failed to compute container bindings: ${error instanceof Error ? error.message : error}`);
        endGroup();
        return { containerId: '', containerWorkspace: '' };
    }
    const { binds, env, containerWorkspace } = envAndBinds;
    info(`Container workspace: ${containerWorkspace}`);
    for (const bind of binds) {
        info(`Bind mount: ${bind}`);
    }
    const isolation = (await canUseProcIsolation(client, image)) ? 'process' : 'hyperv';
    info(`Using ${isolation} isolation for container.`);
    try {
        const containerId = await createAndStartContainer(client, image, binds, env, containerWorkspace, isolation, os.availableParallelism(), Math.round(os.totalmem() * 0.8));
        setOutput('container_id', containerId);
        endGroup();
        return { containerId, containerWorkspace };
    }
    catch (error) {
        setFailed(`Failed to create/start container from image '${image}': ${error instanceof Error ? error.message : error}`);
        endGroup();
        return { containerId: '', containerWorkspace: '' };
    }
}
async function setupContainerWrappers(pathDir, containerId, containerWorkspace) {
    startGroup(`Setting up wrapper with ID: ${containerId}`);
    const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
    const helperScriptPath = path.join(runtimeDir, 'container-exec.js');
    // Generate wrapper scripts for each shell
    for (const [shellName, shellCommand] of Object.entries(Shell)) {
        const wrapperContent = wrapper(shellName, shellCommand, containerId, containerWorkspace, helperScriptPath, process.execPath);
        const wrapperPath = path.join(pathDir, `${shellName}-in-container.cmd`);
        info(`Creating wrapper for ${shellName} at ${wrapperPath} with ${shellCommand}`);
        fs.writeFileSync(wrapperPath, wrapperContent);
    }
    addPath(pathDir);
    endGroup();
}
async function run() {
    let dockerClient = null;
    try {
        if (process.platform !== 'win32') {
            setFailed('This action can only be run on Windows runners.');
            return;
        }
        const tempDir = process.env.RUNNER_TEMP;
        if (!tempDir) {
            setFailed('RUNNER_TEMP environment variable is not set.');
            return;
        }
        const image = getInput('image').trim();
        if (!image) {
            setFailed('Image name is required.');
            return;
        }
        dockerClient = await createDockerClient();
        const pathDir = path.join(tempDir, 'container-wrapper');
        fs.mkdirSync(pathDir, { recursive: true });
        const containerIdStore = path.join(pathDir, '.container_id');
        if (fs.existsSync(containerIdStore)) {
            warning('A container ID file already exists. This may indicate that a container is still running from a previous execution. Attempting to clean up before proceeding.');
            const containerId = fs.readFileSync(containerIdStore, 'utf-8').trim();
            if (containerId) {
                info(`Attempting to stop existing container with ID: ${containerId}`);
                await stopContainer(dockerClient, containerId, 10);
            }
            fs.rmSync(pathDir, { recursive: true, force: true });
            fs.mkdirSync(pathDir, { recursive: true });
        }
        const finalImage = await dockerPull(dockerClient, image);
        if (!finalImage) {
            return;
        }
        const { containerId, containerWorkspace } = await dockerRun(dockerClient, finalImage);
        if (!containerId) {
            return;
        }
        fs.writeFileSync(containerIdStore, containerId);
        await setupContainerWrappers(pathDir, containerId, containerWorkspace);
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
            await closeDockerClient(dockerClient);
        }
    }
}
// Only execute when this module is the entry point (not when imported in tests).
const isMain = process.argv[1] &&
    fileURLToPath(import.meta.url).replace(/\.[jt]s$/, '') ===
        process.argv[1].replace(/\.[jt]s$/, '');
if (isMain) {
    run();
}

export { getEnvAndBinds, normalizeWindowsContainerDestinationPath };
//# sourceMappingURL=index.js.map

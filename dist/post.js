import { w as warning, i as info, a as startGroup, e as endGroup } from './core-BVPvmuQY.js';
import path from 'node:path';
import process from 'node:process';
import fs__default from 'node:fs';
import { c as createDockerClient, s as stopContainer, a as closeDockerClient } from './docker-client-k4oheuFb.js';
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
import 'node:os';
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
import 'node:fs/promises';

async function run() {
    let dockerClient = null;
    const tempDir = process.env.RUNNER_TEMP;
    if (!tempDir) {
        warning('RUNNER_TEMP environment variable is not set. Skipping cleanup.');
        return;
    }
    const pathDir = path.join(tempDir, 'container-wrapper');
    const containerIdStore = path.join(pathDir, '.container_id');
    if (!fs__default.existsSync(containerIdStore)) {
        info('No container ID file found. No cleanup necessary.');
        return;
    }
    const containerId = fs__default.readFileSync(containerIdStore, 'utf-8').trim();
    if (!containerId) {
        fs__default.rmSync(pathDir, { recursive: true, force: true });
        warning('Container ID file is empty. Skipping cleanup.');
        return;
    }
    startGroup(`Cleaning up Docker container with ID: ${containerId}`);
    try {
        dockerClient = await createDockerClient();
        await stopContainer(dockerClient, containerId, 10);
        info(`Successfully stopped Docker container with ID: ${containerId}`);
    }
    catch (error) {
        warning(`Failed to stop Docker container '${containerId}': ${error instanceof Error ? error.message : error}`);
    }
    finally {
        if (dockerClient) {
            await closeDockerClient(dockerClient);
        }
    }
    fs__default.rmSync(pathDir, { recursive: true, force: true });
    endGroup();
}
run();
//# sourceMappingURL=post.js.map

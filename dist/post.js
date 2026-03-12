import { w as warning, i as info, a as startGroup, e as endGroup } from './core-CH5IDQSy.js';
import path from 'node:path';
import process from 'node:process';
import fs__default from 'node:fs';
import { c as create_docker_client, s as stop_container, a as close_docker_client } from './docker-client-C63Y0xAs.js';
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

async function run() {
    let dockerClient = null;
    const temp_dir = process.env.RUNNER_TEMP;
    if (!temp_dir) {
        warning('RUNNER_TEMP environment variable is not set. Skipping cleanup.');
        return;
    }
    const path_dir = path.join(temp_dir, 'container-wrapper');
    const container_id_store = path.join(path_dir, '.container_id');
    if (!fs__default.existsSync(container_id_store)) {
        info('No container ID file found. No cleanup necessary.');
        return;
    }
    const container_id = fs__default.readFileSync(container_id_store, 'utf-8').trim();
    if (!container_id) {
        fs__default.rmSync(path_dir, { recursive: true, force: true });
        warning('Container ID file is empty. Skipping cleanup.');
        return;
    }
    startGroup(`Cleaning up Docker container with ID: ${container_id}`);
    try {
        dockerClient = await create_docker_client();
        await stop_container(dockerClient, container_id, 10);
        info(`Successfully stopped Docker container with ID: ${container_id}`);
    }
    catch {
        warning(`Failed to stop Docker container with ID: ${container_id}`);
    }
    finally {
        if (dockerClient) {
            await close_docker_client(dockerClient);
        }
    }
    fs__default.rmSync(path_dir, { recursive: true, force: true });
    endGroup();
}
run();
//# sourceMappingURL=post.js.map

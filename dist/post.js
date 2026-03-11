import { w as warning, i as info, a as startGroup, e as exec, b as endGroup } from './core-DLBmXFts.js';
import path from 'node:path';
import process from 'node:process';
import fs__default from 'node:fs';
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

async function run() {
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
    if ((await exec('docker', ['stop', '-t', '10', container_id])) !== 0) {
        warning(`Failed to stop Docker container with ID: ${container_id}`);
    }
    else {
        info(`Successfully stopped Docker container with ID: ${container_id}`);
    }
    fs__default.rmSync(path_dir, { recursive: true, force: true });
    endGroup();
}
run();
//# sourceMappingURL=post.js.map

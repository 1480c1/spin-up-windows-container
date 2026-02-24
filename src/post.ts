import * as core from '@actions/core'
import * as exec from '@actions/exec'
import path from 'node:path'
import process from 'node:process'
import fs from 'node:fs'

async function run(): Promise<void> {
    const temp_dir = process.env.RUNNER_TEMP
    if (!temp_dir) {
        core.warning('RUNNER_TEMP environment variable is not set. Skipping cleanup.')
        return
    }
    const path_dir = path.join(temp_dir, 'container-wrapper')
    const container_id_store = path.join(path_dir, '.container_id')
    if (!fs.existsSync(container_id_store)) {
        core.info('No container ID file found. No cleanup necessary.')
        return
    }
    const container_id = fs.readFileSync(container_id_store, 'utf-8').trim()
    if (!container_id) {
        fs.rmSync(path_dir, { recursive: true, force: true })
        core.warning('Container ID file is empty. Skipping cleanup.')
        return
    }

    core.startGroup(`Cleaning up Docker container with ID: ${container_id}`)
    if ((await exec.exec('docker', ['stop', '-t', '10', container_id])) !== 0) {
        core.warning(`Failed to stop Docker container with ID: ${container_id}`)
    } else {
        core.info(`Successfully stopped Docker container with ID: ${container_id}`)
    }
    fs.rmSync(path_dir, { recursive: true, force: true })
    core.endGroup()
}

run()

import * as core from '@actions/core'
import path from 'node:path'
import process from 'node:process'
import fs from 'node:fs'
import {
    close_docker_client,
    create_docker_client,
    stop_container,
    type ActionDockerClient
} from './docker-client.js'

async function run(): Promise<void> {
    let dockerClient: ActionDockerClient | null = null
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
    try {
        dockerClient = await create_docker_client()
        await stop_container(dockerClient, container_id, 10)
        core.info(`Successfully stopped Docker container with ID: ${container_id}`)
    } catch {
        core.warning(`Failed to stop Docker container with ID: ${container_id}`)
    } finally {
        if (dockerClient) {
            await close_docker_client(dockerClient)
        }
    }
    fs.rmSync(path_dir, { recursive: true, force: true })
    core.endGroup()
}

run()

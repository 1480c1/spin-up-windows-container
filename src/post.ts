import * as core from '@actions/core'
import path from 'node:path'
import process from 'node:process'
import fs from 'node:fs'
import {
    closeDockerClient,
    createDockerClient,
    stopContainer,
    type ActionDockerClient
} from './docker-client.js'

async function run(): Promise<void> {
    let dockerClient: ActionDockerClient | null = null
    const tempDir = process.env.RUNNER_TEMP
    if (!tempDir) {
        core.warning('RUNNER_TEMP environment variable is not set. Skipping cleanup.')
        return
    }
    const pathDir = path.join(tempDir, 'container-wrapper')
    const containerIdStore = path.join(pathDir, '.container_id')
    if (!fs.existsSync(containerIdStore)) {
        core.info('No container ID file found. No cleanup necessary.')
        return
    }
    const containerId = fs.readFileSync(containerIdStore, 'utf-8').trim()
    if (!containerId) {
        fs.rmSync(pathDir, { recursive: true, force: true })
        core.warning('Container ID file is empty. Skipping cleanup.')
        return
    }

    core.startGroup(`Cleaning up Docker container with ID: ${containerId}`)
    try {
        dockerClient = await createDockerClient()
        await stopContainer(dockerClient, containerId, 10)
        core.info(`Successfully stopped Docker container with ID: ${containerId}`)
    } catch (error) {
        core.warning(
            `Failed to stop Docker container '${containerId}': ${error instanceof Error ? error.message : error}`
        )
    } finally {
        if (dockerClient) {
            await closeDockerClient(dockerClient)
        }
    }
    fs.rmSync(pathDir, { recursive: true, force: true })
    core.endGroup()
}

run()

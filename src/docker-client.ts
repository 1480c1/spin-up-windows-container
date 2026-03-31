import { DockerClient } from '@docker/node-sdk'
import { type Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export type ActionDockerClient = DockerClient

type DockerConnectionOptions = {
    dockerHost: string
    certificates?: string
}

type DockerContextMeta = {
    Name?: string
    Endpoints?: {
        docker?: {
            Host?: string
        }
    }
}

type DockerConfig = {
    currentContext?: string
}

// Docker CLI contexts can emit npipe hosts as npipe:////./pipe/<name>,
// while @docker/node-sdk currently expects npipe://./pipe/<name>.
export function normalizeDockerHostForNodeSdk(dockerHost: string | undefined): string | undefined {
    if (!dockerHost) {
        return dockerHost
    }

    if (dockerHost.startsWith('npipe:////./pipe/')) {
        return `npipe://./pipe/${dockerHost.slice('npipe:////./pipe/'.length)}`
    }

    return dockerHost
}

function isFilePath(value: string): boolean {
    return value.toLowerCase().endsWith('.json')
}

function getConfigPaths(env: NodeJS.ProcessEnv): {
    dockerConfigDir: string
    configFilePath: string
} {
    const dockerConfigEnv = env.DOCKER_CONFIG
    if (!dockerConfigEnv) {
        const dockerConfigDir = path.join(homedir(), '.docker')
        return {
            dockerConfigDir,
            configFilePath: path.join(dockerConfigDir, 'config.json')
        }
    }

    if (isFilePath(dockerConfigEnv)) {
        return {
            dockerConfigDir: path.dirname(dockerConfigEnv),
            configFilePath: dockerConfigEnv
        }
    }

    return {
        dockerConfigDir: dockerConfigEnv,
        configFilePath: path.join(dockerConfigEnv, 'config.json')
    }
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
    try {
        const content = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(content) as T
    } catch {
        return undefined
    }
}

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath)
        return true
    } catch {
        return false
    }
}

async function resolveContextEndpoint(
    dockerConfigDir: string,
    contextName: string
): Promise<DockerConnectionOptions | undefined> {
    const contextsMetaDir = path.join(dockerConfigDir, 'contexts', 'meta')
    let contextDirs: Dirent[]
    try {
        contextDirs = await fs.readdir(contextsMetaDir, { withFileTypes: true })
    } catch {
        return undefined
    }

    for (const contextDir of contextDirs) {
        if (!contextDir.isDirectory()) {
            continue
        }

        const metaPath = path.join(contextsMetaDir, contextDir.name, 'meta.json')
        const meta = await readJsonFile<DockerContextMeta>(metaPath)
        if (!meta || meta.Name !== contextName) {
            continue
        }

        const host = normalizeDockerHostForNodeSdk(meta.Endpoints?.docker?.Host)
        if (!host) {
            return undefined
        }

        const tlsPath = path.join(dockerConfigDir, 'contexts', 'tls', contextDir.name)
        const certificates = (await pathExists(tlsPath)) ? tlsPath : undefined
        return { dockerHost: host, certificates }
    }

    return undefined
}

export async function resolveDockerConnectionOptions(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): Promise<DockerConnectionOptions> {
    const envDockerHost = normalizeDockerHostForNodeSdk(env.DOCKER_HOST)
    if (envDockerHost) {
        return {
            dockerHost: envDockerHost,
            certificates: env.DOCKER_TLS_CERTDIR
        }
    }

    const { dockerConfigDir, configFilePath } = getConfigPaths(env)
    const dockerConfig = await readJsonFile<DockerConfig>(configFilePath)
    const contextName = env.DOCKER_CONTEXT || dockerConfig?.currentContext
    if (contextName && contextName !== 'default') {
        const contextEndpoint = await resolveContextEndpoint(dockerConfigDir, contextName)
        if (contextEndpoint) {
            return contextEndpoint
        }
    }

    return {
        dockerHost:
            platform === 'win32' ? 'npipe://./pipe/docker_engine' : 'unix:/var/run/docker.sock'
    }
}

export async function createDockerClient(): Promise<ActionDockerClient> {
    const connection = await resolveDockerConnectionOptions()
    let client: ActionDockerClient
    try {
        client = await DockerClient.fromDockerHost(connection.dockerHost, connection.certificates)
    } catch (error) {
        throw new Error(
            `Failed to create Docker client for host '${connection.dockerHost}': ${error instanceof Error ? error.message : error}`,
            { cause: error }
        )
    }
    try {
        await client.systemPing()
    } catch (error) {
        await client.close()
        throw new Error(
            `Docker daemon at '${connection.dockerHost}' is not responding: ${error instanceof Error ? error.message : error}`,
            { cause: error }
        )
    }
    return client
}

export async function closeDockerClient(client: ActionDockerClient): Promise<void> {
    await client.close()
}

export async function getImageOsVersion(
    client: ActionDockerClient,
    imageName: string
): Promise<string> {
    const imageInspect = await client.imageInspect(imageName)
    if (!imageInspect.OsVersion) {
        throw new Error(`Image ${imageName} does not have an OsVersion field.`)
    }
    return imageInspect.OsVersion
}

export async function pullImage(client: ActionDockerClient, image: string): Promise<void> {
    await client.imageCreate({ fromImage: image }).wait()
}

export async function imageExistsLocally(
    client: ActionDockerClient,
    image: string
): Promise<boolean> {
    try {
        await client.imageInspect(image)
        return true
    } catch {
        return false
    }
}

export async function createAndStartContainer(
    client: ActionDockerClient,
    image: string,
    binds: string[],
    env: string[],
    containerWorkspace: string,
    isolation: 'process' | 'hyperv',
    hypervCpuCount: number,
    hypervMemoryBytes: number
): Promise<string> {
    const response = await client.containerCreate({
        Image: image,
        WorkingDir: containerWorkspace,
        Env: env,
        Cmd: ['powershell', '-Command', 'while (1) { Start-Sleep -Seconds 2147483 }'],
        HostConfig: {
            AutoRemove: true,
            Isolation: isolation,
            Binds: binds,
            ...(isolation === 'hyperv' ? { CpuCount: hypervCpuCount } : {}),
            ...(isolation === 'hyperv' ? { Memory: hypervMemoryBytes } : {})
        }
    })

    await client.containerStart(response.Id)
    return response.Id.trim()
}

export async function stopContainer(
    client: ActionDockerClient,
    containerId: string,
    timeoutSeconds: number
): Promise<void> {
    await client.containerStop(containerId, { timeout: timeoutSeconds })
}

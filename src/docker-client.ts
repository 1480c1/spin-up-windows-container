import { DockerClient } from '@docker/node-sdk'
import fs from 'node:fs/promises'
import { type Dirent } from 'node:fs'
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
export function normalize_docker_host_for_node_sdk(
    dockerHost: string | undefined
): string | undefined {
    if (!dockerHost) {
        return dockerHost
    }

    if (dockerHost.startsWith('npipe:////./pipe/')) {
        return `npipe://./pipe/${dockerHost.slice('npipe:////./pipe/'.length)}`
    }

    return dockerHost
}

function is_file_path(value: string): boolean {
    return value.toLowerCase().endsWith('.json')
}

function get_config_paths(env: NodeJS.ProcessEnv): {
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

    if (is_file_path(dockerConfigEnv)) {
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

async function read_json_file<T>(filePath: string): Promise<T | undefined> {
    try {
        const content = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(content) as T
    } catch {
        return undefined
    }
}

async function path_exists(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath)
        return true
    } catch {
        return false
    }
}

async function resolve_context_endpoint(
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
        const meta = await read_json_file<DockerContextMeta>(metaPath)
        if (!meta || meta.Name !== contextName) {
            continue
        }

        const host = normalize_docker_host_for_node_sdk(meta.Endpoints?.docker?.Host)
        if (!host) {
            return undefined
        }

        const tlsPath = path.join(dockerConfigDir, 'contexts', 'tls', contextDir.name)
        const certificates = (await path_exists(tlsPath)) ? tlsPath : undefined
        return { dockerHost: host, certificates }
    }

    return undefined
}

export async function resolve_docker_connection_options(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): Promise<DockerConnectionOptions> {
    const envDockerHost = normalize_docker_host_for_node_sdk(env.DOCKER_HOST)
    if (envDockerHost) {
        return {
            dockerHost: envDockerHost,
            certificates: env.DOCKER_TLS_CERTDIR
        }
    }

    const { dockerConfigDir, configFilePath } = get_config_paths(env)
    const dockerConfig = await read_json_file<DockerConfig>(configFilePath)
    const contextName = env.DOCKER_CONTEXT || dockerConfig?.currentContext
    if (contextName && contextName !== 'default') {
        const contextEndpoint = await resolve_context_endpoint(dockerConfigDir, contextName)
        if (contextEndpoint) {
            return contextEndpoint
        }
    }

    return {
        dockerHost:
            platform === 'win32' ? 'npipe://./pipe/docker_engine' : 'unix:/var/run/docker.sock'
    }
}

export async function create_docker_client(): Promise<ActionDockerClient> {
    const connection = await resolve_docker_connection_options()
    const client = await DockerClient.fromDockerHost(connection.dockerHost, connection.certificates)
    await client.systemPing()
    return client
}

export async function close_docker_client(client: ActionDockerClient): Promise<void> {
    await client.close()
}

export async function get_image_os_version(
    client: ActionDockerClient,
    imageName: string
): Promise<string> {
    const imageInspect = await client.imageInspect(imageName)
    if (!imageInspect.OsVersion) {
        throw new Error(`Image ${imageName} does not have an OsVersion field.`)
    }
    return imageInspect.OsVersion
}

export async function pull_image(client: ActionDockerClient, image: string): Promise<void> {
    await client.imageCreate({ fromImage: image }).wait()
}

export async function image_exists_locally(
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

export async function create_and_start_container(
    client: ActionDockerClient,
    image: string,
    workspaceBind: string,
    containerWorkspace: string,
    isolation: 'process' | 'hyperv',
    hypervCpuCount: number,
    hypervMemoryBytes: number
): Promise<string> {
    const response = await client.containerCreate({
        Image: image,
        WorkingDir: containerWorkspace,
        Env: [`GITHUB_WORKSPACE=${containerWorkspace}`],
        Cmd: ['powershell', '-Command', 'while (1) { Start-Sleep -Seconds 2147483 }'],
        HostConfig: {
            AutoRemove: true,
            Isolation: isolation,
            Binds: [`${workspaceBind}:${containerWorkspace}`],
            ...(isolation === 'hyperv' ? { CpuCount: hypervCpuCount } : {}),
            ...(isolation === 'hyperv' ? { Memory: hypervMemoryBytes } : {})
        }
    })

    await client.containerStart(response.Id)
    return response.Id.trim()
}

export async function stop_container(
    client: ActionDockerClient,
    containerId: string,
    timeoutSeconds: number
): Promise<void> {
    await client.containerStop(containerId, { timeout: timeoutSeconds })
}

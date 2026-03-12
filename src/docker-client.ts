import { DockerClient } from '@docker/node-sdk'

export type ActionDockerClient = DockerClient

type PullImageReference = {
    fromImage: string
    tag?: string
}

function parse_image_for_pull(image: string): PullImageReference {
    const digestIndex = image.indexOf('@')
    if (digestIndex !== -1) {
        return { fromImage: image }
    }

    const colonIndex = image.lastIndexOf(':')
    const slashIndex = image.lastIndexOf('/')
    if (colonIndex > slashIndex) {
        return {
            fromImage: image.slice(0, colonIndex),
            tag: image.slice(colonIndex + 1)
        }
    }

    return { fromImage: image }
}

export async function create_docker_client(): Promise<ActionDockerClient> {
    const client = await DockerClient.fromDockerConfig()
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
    const reference = parse_image_for_pull(image)
    const pullStream = client.imageCreate(reference)
    await pullStream.wait()
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

import * as core from '@actions/core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
    closeDockerClient,
    createAndStartContainer,
    createDockerClient,
    getImageOsVersion,
    imageExistsLocally,
    pullImage,
    stopContainer,
    type ActionDockerClient
} from './docker-client.js'
import { Shell, wrapper } from './shell-wrapper.js'

const DRIVE_LETTER_RE = /^[A-Za-z]:[\\/]/

/**
 * Replace the drive letter in a Windows path with C so the path is
 * usable inside a Windows container (only C:\ is guaranteed).
 */
export function normalizeWindowsContainerDestinationPath(p: string): string {
    if (DRIVE_LETTER_RE.test(p)) {
        return 'C' + p.slice(1)
    }
    return p
}

/** Environment variables whose values are file paths we need to bind-mount. */
const GITHUB_PATH_VARS = [
    'GITHUB_OUTPUT',
    'GITHUB_ENV',
    'GITHUB_PATH',
    'GITHUB_STEP_SUMMARY'
] as const

export function getEnvAndBinds(): {
    binds: string[]
    env: string[]
    containerWorkspace: string
} {
    const workspace = process.env.GITHUB_WORKSPACE
    if (!workspace) {
        throw new Error('GITHUB_WORKSPACE environment variable is not set.')
    }

    const containerWorkspace = normalizeWindowsContainerDestinationPath(workspace)

    // Collect unique host directories we need to bind-mount.
    const hostDirs = new Set<string>()
    hostDirs.add(workspace)

    const runnerTemp = process.env.RUNNER_TEMP
    if (runnerTemp) {
        hostDirs.add(runnerTemp)
    }

    for (const varName of GITHUB_PATH_VARS) {
        const value = process.env[varName]
        if (value) {
            hostDirs.add(path.dirname(value))
        }
    }

    // De-duplicate: remove any dir that is a subdirectory of another.
    const sorted = [...hostDirs].sort((a, b) => a.length - b.length)
    const roots: string[] = []
    for (const dir of sorted) {
        const normalizedDir = dir.toLowerCase().replaceAll('/', '\\')
        const isChild = roots.some((root) => {
            const normalizedRoot = root.toLowerCase().replaceAll('/', '\\')
            return (
                normalizedDir.startsWith(normalizedRoot + '\\\\') ||
                normalizedDir === normalizedRoot
            )
        })
        if (!isChild) {
            roots.push(dir)
        }
    }

    const binds = roots.map(
        (hostDir) => `${hostDir}:${normalizeWindowsContainerDestinationPath(hostDir)}`
    )

    const env = [`GITHUB_WORKSPACE=${containerWorkspace}`]

    return { binds, env, containerWorkspace }
}

async function canUseProcIsolation(
    client: ActionDockerClient,
    imageName: string
): Promise<boolean> {
    try {
        // 1. Get Host Build Version via PowerShell
        const hostBuildStr = os.release() // produces a string in the form of '10.0.26200', we need the 3rd segment for the build number
        const hostBuild = parseInt(hostBuildStr.split('.')[2])

        // 2. Get Image OS Version via Docker API
        const imageOsVersion = await getImageOsVersion(client, imageName)

        // Image version format is usually "10.0.26100.4061" - we need the 3rd segment
        const imageBuild = parseInt(imageOsVersion.split('.')[2])

        core.debug(`Host Build: ${hostBuild} | Image Build: ${imageBuild}`)

        // 3. Compatibility Logic
        if (hostBuild === imageBuild) {
            core.debug('Perfect match. Process isolation is supported.')
            return true
        }

        if (hostBuild > imageBuild) {
            // Down-level compatibility requires Windows 11 (22000+) or Server 2022 (20348+)
            if (hostBuild >= 20348) {
                core.debug('Host supports down-level process isolation.')
                return true
            }
            core.warning(
                'Host is older than Windows 11/Server 2022. Exact version match required for process isolation. Expect performance degradation if running this image, and some features may not work as expected.'
            )
            return false
        }

        core.error(
            'Image build is newer than Host build. Running this image is not supported. Will attempt to run it, but expect it to fail.'
        )
    } catch (error) {
        core.setFailed(`Failed to inspect image: ${error instanceof Error ? error.message : error}`)
    }
    return false
}

async function dockerPull(client: ActionDockerClient, image: string): Promise<string | null> {
    core.startGroup(`Pulling Docker image: ${image}`)
    try {
        await pullImage(client, image)
        core.info(`Successfully pulled Docker image: ${image}`)
        core.endGroup()
        return image
    } catch (pullError) {
        core.warning(
            `Failed to pull Docker image '${image}': ${pullError instanceof Error ? pullError.message : pullError}. Checking for local copy…`
        )
    }

    try {
        if (await imageExistsLocally(client, image)) {
            core.info(`Using pre-existing local Docker image: ${image}`)
            core.endGroup()
            return image
        }
    } catch (inspectError) {
        core.warning(
            `Failed to inspect local image '${image}': ${inspectError instanceof Error ? inspectError.message : inspectError}`
        )
    }
    core.setFailed(
        `Docker image '${image}' could not be pulled and was not found locally. Ensure the image name is correct and that the Docker daemon is running.`
    )
    core.endGroup()
    return null
}

async function dockerRun(
    client: ActionDockerClient,
    image: string
): Promise<{ containerId: string; containerWorkspace: string }> {
    core.startGroup(`Running Docker container from image: ${image}`)

    let envAndBinds: ReturnType<typeof getEnvAndBinds>
    try {
        envAndBinds = getEnvAndBinds()
    } catch (error) {
        core.setFailed(
            `Failed to compute container bindings: ${error instanceof Error ? error.message : error}`
        )
        core.endGroup()
        return { containerId: '', containerWorkspace: '' }
    }

    const { binds, env, containerWorkspace } = envAndBinds
    core.info(`Container workspace: ${containerWorkspace}`)
    for (const bind of binds) {
        core.info(`Bind mount: ${bind}`)
    }

    const isolation = (await canUseProcIsolation(client, image)) ? 'process' : 'hyperv'
    core.info(`Using ${isolation} isolation for container.`)

    try {
        const containerId = await createAndStartContainer(
            client,
            image,
            binds,
            env,
            containerWorkspace,
            isolation,
            os.availableParallelism(),
            Math.round(os.totalmem() * 0.8)
        )
        core.setOutput('container_id', containerId)
        core.endGroup()
        return { containerId, containerWorkspace }
    } catch (error) {
        core.setFailed(
            `Failed to create/start container from image '${image}': ${error instanceof Error ? error.message : error}`
        )
        core.endGroup()
        return { containerId: '', containerWorkspace: '' }
    }
}

async function setupContainerWrappers(
    pathDir: string,
    containerId: string,
    containerWorkspace: string
): Promise<void> {
    core.startGroup(`Setting up wrapper with ID: ${containerId}`)

    const runtimeDir = path.dirname(fileURLToPath(import.meta.url))
    const helperScriptPath = path.join(runtimeDir, 'container-exec.js')

    // Generate wrapper scripts for each shell
    for (const [shellName, shellCommand] of Object.entries(Shell)) {
        const wrapperContent = wrapper(
            shellName,
            shellCommand,
            containerId,
            containerWorkspace,
            helperScriptPath,
            process.execPath
        )
        const wrapperPath = path.join(pathDir, `${shellName}-in-container.cmd`)
        core.info(`Creating wrapper for ${shellName} at ${wrapperPath} with ${shellCommand}`)
        fs.writeFileSync(wrapperPath, wrapperContent)
    }

    core.addPath(pathDir)
    core.endGroup()
}

async function run(): Promise<void> {
    let dockerClient: ActionDockerClient | null = null
    try {
        if (process.platform !== 'win32') {
            core.setFailed('This action can only be run on Windows runners.')
            return
        }
        const tempDir = process.env.RUNNER_TEMP
        if (!tempDir) {
            core.setFailed('RUNNER_TEMP environment variable is not set.')
            return
        }
        const image: string = core.getInput('image').trim()
        if (!image) {
            core.setFailed('Image name is required.')
            return
        }

        dockerClient = await createDockerClient()

        const pathDir = path.join(tempDir, 'container-wrapper')
        fs.mkdirSync(pathDir, { recursive: true })
        const containerIdStore = path.join(pathDir, '.container_id')

        if (fs.existsSync(containerIdStore)) {
            core.warning(
                'A container ID file already exists. This may indicate that a container is still running from a previous execution. Attempting to clean up before proceeding.'
            )
            const containerId = fs.readFileSync(containerIdStore, 'utf-8').trim()
            if (containerId) {
                core.info(`Attempting to stop existing container with ID: ${containerId}`)
                await stopContainer(dockerClient, containerId, 10)
            }
            fs.rmSync(pathDir, { recursive: true, force: true })
            fs.mkdirSync(pathDir, { recursive: true })
        }

        const finalImage = await dockerPull(dockerClient, image)
        if (!finalImage) {
            return
        }
        const { containerId, containerWorkspace } = await dockerRun(dockerClient, finalImage)
        if (!containerId) {
            return
        }

        fs.writeFileSync(containerIdStore, containerId)
        await setupContainerWrappers(pathDir, containerId, containerWorkspace)
    } catch (error: unknown) {
        if (error instanceof Error) {
            core.setFailed(error.message)
        } else {
            core.setFailed(String(error))
        }
    } finally {
        if (dockerClient) {
            await closeDockerClient(dockerClient)
        }
    }
}

// Only execute when this module is the entry point (not when imported in tests).
const isMain =
    process.argv[1] &&
    fileURLToPath(import.meta.url).replace(/\.[jt]s$/, '') ===
        process.argv[1].replace(/\.[jt]s$/, '')
if (isMain) {
    run()
}
